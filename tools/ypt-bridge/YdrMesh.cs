// Mesh extraction for the ydr2glb command: turns a Drawable that CodeWalker.Core has parsed into plain glTF-ready
// arrays (positions, normals, UVs, triangle indices). Only CodeWalker's public API is used (Drawable, DrawableModel,
// DrawableGeometry, VertexData/VertexDeclaration, Skeleton); nothing of CodeWalker's source is copied here.
//
// Conventions
//   * GTA is Z-up, +Y forward, right-handed, metres. glTF is Y-up, -Z forward, right-handed, metres.
//     (x, y, z) -> (x, z, -y) is a proper rotation (determinant +1), so it does not change triangle winding.
//   * Nothing is scaled. Positions keep CodeWalker's metres.

using System.Buffers.Binary;
using CodeWalker.GameFiles;
using SdxMatrix = SharpDX.Matrix;

namespace VfxForge.YptBridge;

internal enum LodLevel { High, Med, Low, VLow }

internal static class Lods
{
    public static readonly LodLevel[] All = { LodLevel.High, LodLevel.Med, LodLevel.Low, LodLevel.VLow };

    public static string Name(LodLevel l) => l switch
    {
        LodLevel.High => "high",
        LodLevel.Med => "med",
        LodLevel.Low => "low",
        _ => "vlow",
    };

    public static DrawableModel[]? Models(Drawable d, LodLevel l) => l switch
    {
        LodLevel.High => d.DrawableModels?.High,
        LodLevel.Med => d.DrawableModels?.Med,
        LodLevel.Low => d.DrawableModels?.Low,
        _ => d.DrawableModels?.VLow,
    };
}

/// One geometry, in glTF axes, with its winding already corrected.
internal sealed class MeshGeometry
{
    public required int GeometryIndex { get; init; }
    public required float[] Positions { get; init; }
    public float[]? Normals { get; init; }
    public float[]? Uvs { get; init; }
    public required ushort[] Indices { get; init; }
    public required bool WindingFlipped { get; init; }
    public string? ShaderName { get; init; }
    public int VertexCount => Positions.Length / 3;
    public int TriangleCount => Indices.Length / 3;
}

internal sealed class MeshModel
{
    public required int Index { get; init; }
    public List<MeshGeometry> Geometries { get; } = new();
}

/// Everything extracted for one LOD.
internal sealed class LodMesh
{
    public required LodLevel Level { get; init; }
    /// True when the LOD holds at least one geometry that can be exported (also true for a LOD that is over the size cap).
    public bool Renderable { get; set; }
    public bool TooLarge { get; set; }
    public long DeclaredVertices { get; set; }
    public List<MeshModel> Models { get; } = new();
    public List<string> Warnings { get; } = new();
    public List<string> Shaders { get; } = new();
    public bool BoneTransformsApplied { get; set; }
    public int Geometries { get; set; }
    public int Vertices { get; set; }
    public int Triangles { get; set; }
    public int WindingFlipped { get; set; }
    public float[] BoundsMin { get; set; } = new float[3];
    public float[] BoundsMax { get; set; } = new float[3];
}

/// Model-space placement of rigid (non-skinned) models that are bound to a skeleton bone.
///
/// A drawable's skeleton stores one local rest matrix per bone (Skeleton.Transformations, relative to the parent bone)
/// and the parent of each bone (Skeleton.ParentIndices). A rigid model bound to bone b is drawn at b's rest pose in
/// model space, i.e. its local matrix composed with every ancestor's up to the root. With SharpDX's row-vector
/// convention (p' = (x, y, z, 1) * M, translation in M41..M43) that is
///     M = Local(b) * Local(parent(b)) * ... * Local(root)
/// multiplied in exactly that order (it matches where CodeWalker's model viewer draws such parts). The 4th column of a
/// stored matrix is not part of the affine transform and is replaced by (0, 0, 0, 1). Normals use the upper 3x3.
/// Skinned models (HasSkin != 0) are left in their bind pose (no matrix).
internal sealed class BonePlacement
{
    private readonly SdxMatrix[]? locals;
    private readonly short[]? parents;

    public bool HasSkeleton { get; }

    public BonePlacement(Skeleton? skeleton)
    {
        HasSkeleton = skeleton != null;
        locals = skeleton?.Transformations;
        parents = skeleton?.ParentIndices;
    }

    /// Returns the matrix to apply to a model, or null when none applies (no skeleton transforms, or a skinned model).
    public SdxMatrix? Place(DrawableModel model, string label, List<string> warnings)
    {
        if (model.HasSkin > 0) return null;
        int bone = model.BoneIndex;
        if (locals == null)
        {
            if (HasSkeleton && bone != 0)
                warnings.Add($"{label} is bound to bone {bone} but the skeleton has no bone transforms; it could not be placed and stays at its own origin.");
            return null;
        }
        if (bone >= locals.Length)
            warnings.Add($"{label} is bound to bone {bone} but the skeleton has only {locals.Length} transforms; it is left at its own origin.");

        // the bone itself, then its ancestors; a parent index outside the parent table ends the chain, and a repeated
        // bone means the table is cyclic
        var chain = new List<int> { bone };
        var visited = new HashSet<int> { bone };
        for (int p = ParentOf(bone); p >= 0 && p < (parents?.Length ?? 0); p = ParentOf(p))
        {
            if (!visited.Add(p))
            {
                warnings.Add($"{label}: the bone parent chain of bone {bone} loops; the model is not placed by its bone.");
                return null;
            }
            chain.Add(p);
        }

        var m = Local(chain[0]);
        for (int i = 1; i < chain.Count; i++) m = SdxMatrix.Multiply(m, Local(chain[i]));

        if (!IsFinite(m))
        {
            warnings.Add($"{label}: the bone matrix of bone {bone} contains non-finite values; the model is not placed by its bone.");
            return null;
        }
        return m;
    }

    private int ParentOf(int bone) => parents != null && bone < parents.Length ? parents[bone] : -1;

    /// The stored local matrix as an affine transform (missing entries are the identity).
    private SdxMatrix Local(int bone)
    {
        var m = locals != null && bone < locals.Length ? locals[bone] : SdxMatrix.Identity;
        m.Column4 = SharpDX.Vector4.UnitW;
        return m;
    }

    /// Determinant of the upper 3x3: negative when the placement mirrors the model (which reverses triangle winding).
    public static float Determinant3(SdxMatrix m) =>
        m.M11 * (m.M22 * m.M33 - m.M23 * m.M32) - m.M12 * (m.M21 * m.M33 - m.M23 * m.M31) + m.M13 * (m.M21 * m.M32 - m.M22 * m.M31);

    public static bool IsIdentity(SdxMatrix m, float eps = 1e-6f) =>
        Math.Abs(m.M11 - 1) <= eps && Math.Abs(m.M22 - 1) <= eps && Math.Abs(m.M33 - 1) <= eps && Math.Abs(m.M44 - 1) <= eps &&
        Math.Abs(m.M12) <= eps && Math.Abs(m.M13) <= eps && Math.Abs(m.M14) <= eps &&
        Math.Abs(m.M21) <= eps && Math.Abs(m.M23) <= eps && Math.Abs(m.M24) <= eps &&
        Math.Abs(m.M31) <= eps && Math.Abs(m.M32) <= eps && Math.Abs(m.M34) <= eps &&
        Math.Abs(m.M41) <= eps && Math.Abs(m.M42) <= eps && Math.Abs(m.M43) <= eps;

    private static bool IsFinite(SdxMatrix m) =>
        float.IsFinite(m.M11) && float.IsFinite(m.M12) && float.IsFinite(m.M13) && float.IsFinite(m.M14) &&
        float.IsFinite(m.M21) && float.IsFinite(m.M22) && float.IsFinite(m.M23) && float.IsFinite(m.M24) &&
        float.IsFinite(m.M31) && float.IsFinite(m.M32) && float.IsFinite(m.M33) && float.IsFinite(m.M34) &&
        float.IsFinite(m.M41) && float.IsFinite(m.M42) && float.IsFinite(m.M43) && float.IsFinite(m.M44);
}

internal sealed class MeshExtractor
{
    // glTF stores indices as ushort here and 65535 is the primitive-restart value, so a geometry may hold at most 65535 vertices.
    private const int MaxGeometryVertices = 65535;
    // Semantic indices (VertexSemantics) are also the bit positions in VertexDeclaration.Flags.
    private const int SemPosition = (int)VertexSemantics.Position;
    private const int SemNormal = (int)VertexSemantics.Normal;
    private const int SemTexCoord0 = (int)VertexSemantics.TexCoord0;

    private readonly Drawable drawable;
    private readonly BonePlacement placement;

    public MeshExtractor(Drawable drawable)
    {
        this.drawable = drawable;
        placement = new BonePlacement(drawable.Skeleton);
    }

    private sealed class Candidate
    {
        public int ModelIndex;
        public int GeometryIndex;
        public float[] Positions = Array.Empty<float>();
        public float[]? Normals;
        public float[]? Uvs;
        public ushort[] Indices = Array.Empty<ushort>();
        public string? ShaderName;
        public bool Decided;          // winding could be judged from this geometry's own normals
        public bool Flip;
        public double Score;
        public int Agree;
        public int Disagree;
        public bool PlacedByBone;
        public bool Mirrored;         // its bone placement has a negative determinant, which reverses the stored winding
    }

    public LodMesh Extract(LodLevel level)
    {
        var mesh = new LodMesh { Level = level };
        var models = Lods.Models(drawable, level);
        if (models == null) return mesh;

        // Cheap size check first so a hostile file cannot make us decode millions of vertices.
        long declared = 0;
        foreach (var m in models)
            if (m?.Geometries != null)
                foreach (var g in m.Geometries)
                    declared += Math.Max(0, g?.VertexData?.VertexCount ?? 0);
        mesh.DeclaredVertices = declared;
        if (declared > YdrConverter.MaxVertices)
        {
            mesh.TooLarge = true;
            mesh.Renderable = true;
            return mesh;
        }

        var candidates = new List<Candidate>();
        var skinned = new List<string>();
        for (int mi = 0; mi < models.Length; mi++)
        {
            var model = models[mi];
            if (model?.Geometries == null) continue;
            var label = $"model_{mi}";
            if (model.HasSkin > 0) skinned.Add(label);
            var matrix = placement.Place(model, label, mesh.Warnings);

            for (int gi = 0; gi < model.Geometries.Length; gi++)
            {
                var geom = model.Geometries[gi];
                if (geom == null) continue;
                var c = BuildCandidate(geom, $"{label} geometry {gi}", matrix, mesh.Warnings);
                if (c == null) continue;
                c.ModelIndex = mi;
                c.GeometryIndex = gi;
                c.PlacedByBone = matrix.HasValue && !BonePlacement.IsIdentity(matrix.Value);
                c.Mirrored = matrix.HasValue && BonePlacement.Determinant3(matrix.Value) < 0;
                candidates.Add(c);
            }
        }
        if (skinned.Count > 0)
            mesh.Warnings.Add($"{skinned.Count} skinned model(s) ({string.Join(", ", skinned.Take(5))}{(skinned.Count > 5 ? ", ..." : "")}) exported in bind pose; skin weights and bone indices are not exported.");
        if (candidates.Count == 0) return mesh;

        DecideWinding(candidates, mesh.Warnings);

        MeshModel? current = null;
        var shaderSeen = new HashSet<string>(StringComparer.Ordinal);
        var min = new[] { float.PositiveInfinity, float.PositiveInfinity, float.PositiveInfinity };
        var max = new[] { float.NegativeInfinity, float.NegativeInfinity, float.NegativeInfinity };
        foreach (var c in candidates)
        {
            if (current == null || current.Index != c.ModelIndex)
            {
                current = new MeshModel { Index = c.ModelIndex };
                mesh.Models.Add(current);
            }
            var indices = c.Flip ? Flipped(c.Indices) : c.Indices;
            current.Geometries.Add(new MeshGeometry
            {
                GeometryIndex = c.GeometryIndex,
                Positions = c.Positions,
                Normals = c.Normals,
                Uvs = c.Uvs,
                Indices = indices,
                WindingFlipped = c.Flip,
            });
            mesh.Geometries++;
            mesh.Vertices += c.Positions.Length / 3;
            mesh.Triangles += indices.Length / 3;
            if (c.Flip) mesh.WindingFlipped++;
            if (c.PlacedByBone) mesh.BoneTransformsApplied = true;
            if (!string.IsNullOrEmpty(c.ShaderName) && shaderSeen.Add(c.ShaderName)) mesh.Shaders.Add(c.ShaderName);
            for (int i = 0; i < c.Positions.Length; i += 3)
                for (int k = 0; k < 3; k++)
                {
                    float v = c.Positions[i + k];
                    if (v < min[k]) min[k] = v;
                    if (v > max[k]) max[k] = v;
                }
        }
        mesh.BoundsMin = min;
        mesh.BoundsMax = max;
        mesh.Renderable = true;
        return mesh;
    }

    // ------------------------------------------------------------------ one geometry

    private Candidate? BuildCandidate(DrawableGeometry geom, string label, SdxMatrix? matrix, List<string> warnings)
    {
        var data = geom.VertexData ?? geom.VertexBuffer?.Data1 ?? geom.VertexBuffer?.Data2;
        var decl = data?.Info ?? geom.VertexBuffer?.Info;
        var bytes = data?.VertexBytes;
        var indices = geom.IndexBuffer?.Indices;
        if (data == null || decl == null || bytes == null)
        {
            warnings.Add($"{label} skipped: it has no vertex data.");
            return null;
        }
        if (indices == null || indices.Length == 0)
        {
            warnings.Add($"{label} skipped: it has no indices.");
            return null;
        }
        int count = data.VertexCount;
        int stride = data.VertexStride;
        if (count <= 0 || count > MaxGeometryVertices)
        {
            warnings.Add($"{label} skipped: vertex count {count} is outside 1..{MaxGeometryVertices}.");
            return null;
        }
        if (indices.Length % 3 != 0)
        {
            warnings.Add($"{label} skipped: index count {indices.Length} is not a multiple of 3.");
            return null;
        }
        // The vertex layout is described by the declaration: one 4-bit component type per semantic, packed in semantic order.
        // Offsets are the sum of the sizes of the flagged components before the attribute (VertexDeclaration.GetComponentOffset).
        int layoutSize = 0;
        for (int k = 0; k < 16; k++)
        {
            if (((decl.Flags >> k) & 1) == 0) continue;
            int size = VertexComponentTypes.GetSizeInBytes(decl.GetComponentType(k));
            if (size == 0)
            {
                warnings.Add($"{label} skipped: its vertex layout uses a component type ({decl.GetComponentType(k)}) with unknown size.");
                return null;
            }
            layoutSize += size;
        }
        if (stride < layoutSize || (long)count * stride > bytes.Length)
        {
            warnings.Add($"{label} skipped: vertex stride {stride} / count {count} do not fit the layout ({layoutSize} bytes) or the data ({bytes.Length} bytes).");
            return null;
        }
        for (int i = 0; i < indices.Length; i++)
        {
            if (indices[i] >= count)
            {
                warnings.Add($"{label} skipped: index {indices[i]} (at {i}) is out of range for {count} vertices.");
                return null;
            }
        }

        // --- position (required)
        if (((decl.Flags >> SemPosition) & 1) == 0)
        {
            warnings.Add($"{label} skipped: its vertex layout has no position.");
            return null;
        }
        var posType = decl.GetComponentType(SemPosition);
        if (posType != VertexComponentType.Float3 && posType != VertexComponentType.Float4)
        {
            warnings.Add($"{label} skipped: position format {posType} is not supported (Float3/Float4 only).");
            return null;
        }
        int posOffset = decl.GetComponentOffset(SemPosition);
        var positions = new float[count * 3];
        for (int v = 0; v < count; v++)
        {
            int o = v * stride + posOffset;
            float x = ReadF32(bytes, o), y = ReadF32(bytes, o + 4), z = ReadF32(bytes, o + 8);
            if (!float.IsFinite(x) || !float.IsFinite(y) || !float.IsFinite(z))
            {
                warnings.Add($"{label} skipped: vertex {v} has a non-finite position.");
                return null;
            }
            positions[v * 3] = x; positions[v * 3 + 1] = y; positions[v * 3 + 2] = z;
        }

        // --- normal (optional)
        float[]? normals = null;
        if (((decl.Flags >> SemNormal) & 1) != 0)
        {
            var nType = decl.GetComponentType(SemNormal);
            int nOffset = decl.GetComponentOffset(SemNormal);
            if (nType == VertexComponentType.Float3 || nType == VertexComponentType.RGBA8SNorm)
            {
                normals = new float[count * 3];
                int bad = 0;
                for (int v = 0; v < count; v++)
                {
                    int o = v * stride + nOffset;
                    double x, y, z;
                    if (nType == VertexComponentType.Float3)
                    {
                        x = ReadF32(bytes, o); y = ReadF32(bytes, o + 4); z = ReadF32(bytes, o + 8);
                    }
                    else
                    {
                        // R8G8B8A8_SNORM: signed bytes scaled by 1/127 (the 4th byte is unused for normals)
                        x = (sbyte)bytes[o] / 127.0; y = (sbyte)bytes[o + 1] / 127.0; z = (sbyte)bytes[o + 2] / 127.0;
                    }
                    double len = Math.Sqrt(x * x + y * y + z * z);
                    if (!double.IsFinite(len) || len < 1e-6) { bad++; continue; }
                    normals[v * 3] = (float)(x / len); normals[v * 3 + 1] = (float)(y / len); normals[v * 3 + 2] = (float)(z / len);
                }
                if (bad > 0)
                {
                    warnings.Add($"{label}: {bad} of {count} normals are zero or non-finite; normals were omitted for this geometry.");
                    normals = null;
                }
            }
            else
            {
                warnings.Add($"{label}: normal format {nType} is not supported; normals were omitted for this geometry.");
            }
        }

        // --- texture coordinates (optional)
        float[]? uvs = null;
        if (((decl.Flags >> SemTexCoord0) & 1) != 0)
        {
            var uType = decl.GetComponentType(SemTexCoord0);
            int uOffset = decl.GetComponentOffset(SemTexCoord0);
            if (uType == VertexComponentType.Float2 || uType == VertexComponentType.Half2)
            {
                uvs = new float[count * 2];
                bool ok = true;
                for (int v = 0; v < count && ok; v++)
                {
                    int o = v * stride + uOffset;
                    float u, w;
                    if (uType == VertexComponentType.Float2) { u = ReadF32(bytes, o); w = ReadF32(bytes, o + 4); }
                    else
                    {
                        u = (float)BinaryPrimitives.ReadHalfLittleEndian(bytes.AsSpan(o, 2));
                        w = (float)BinaryPrimitives.ReadHalfLittleEndian(bytes.AsSpan(o + 2, 2));
                    }
                    if (!float.IsFinite(u) || !float.IsFinite(w)) { ok = false; break; }
                    // GTA and glTF both put the UV origin at the top-left of the image: no flip needed.
                    uvs[v * 2] = u; uvs[v * 2 + 1] = w;
                }
                if (!ok)
                {
                    warnings.Add($"{label}: texture coordinates contain non-finite values; TEXCOORD_0 was omitted for this geometry.");
                    uvs = null;
                }
            }
            else
            {
                warnings.Add($"{label}: texture-coordinate format {uType} is not supported; TEXCOORD_0 was omitted for this geometry.");
            }
        }

        // --- place the rigid model by its bone, then convert GTA axes to glTF axes: (x, y, z) -> (x, z, -y)
        if (matrix.HasValue)
        {
            var m = matrix.Value;
            for (int i = 0; i < positions.Length; i += 3)
            {
                float x = positions[i], y = positions[i + 1], z = positions[i + 2];
                positions[i] = x * m.M11 + y * m.M21 + z * m.M31 + m.M41;
                positions[i + 1] = x * m.M12 + y * m.M22 + z * m.M32 + m.M42;
                positions[i + 2] = x * m.M13 + y * m.M23 + z * m.M33 + m.M43;
            }
            if (normals != null)
            {
                // like the shader: rotate by the upper 3x3 and renormalise (bone matrices carry no shear in practice)
                for (int i = 0; i < normals.Length; i += 3)
                {
                    double x = normals[i], y = normals[i + 1], z = normals[i + 2];
                    double nx = x * m.M11 + y * m.M21 + z * m.M31;
                    double ny = x * m.M12 + y * m.M22 + z * m.M32;
                    double nz = x * m.M13 + y * m.M23 + z * m.M33;
                    double len = Math.Sqrt(nx * nx + ny * ny + nz * nz);
                    if (!double.IsFinite(len) || len < 1e-9)
                    {
                        warnings.Add($"{label}: the bone matrix collapses a normal; normals were omitted for this geometry.");
                        normals = null;
                        break;
                    }
                    normals[i] = (float)(nx / len); normals[i + 1] = (float)(ny / len); normals[i + 2] = (float)(nz / len);
                }
            }
            for (int i = 0; i < positions.Length; i += 3)
                if (!float.IsFinite(positions[i]) || !float.IsFinite(positions[i + 1]) || !float.IsFinite(positions[i + 2]))
                {
                    warnings.Add($"{label} skipped: the bone placement produced a non-finite position.");
                    return null;
                }
        }
        for (int i = 0; i < positions.Length; i += 3)
        {
            float y = positions[i + 1], z = positions[i + 2];
            positions[i + 1] = z;
            positions[i + 2] = 0f - y;   // not -y: that would turn +0 into -0 and write "-0" into the file
        }
        if (normals != null)
            for (int i = 0; i < normals.Length; i += 3)
            {
                float y = normals[i + 1], z = normals[i + 2];
                normals[i + 1] = z;
                normals[i + 2] = 0f - y;
            }
        PositiveZero(positions);
        if (normals != null) PositiveZero(normals);

        var c = new Candidate
        {
            Positions = positions,
            Normals = normals,
            Uvs = uvs,
            Indices = indices,
            ShaderName = geom.Shader != null ? YdrXml.HashString(geom.Shader.Name) : null,
        };
        if (normals != null)
        {
            (c.Score, c.Agree, c.Disagree) = WindingScore(positions, normals, indices);
            c.Decided = c.Score != 0 && c.Agree + c.Disagree > 0;
            c.Flip = c.Score < 0;
        }
        return c;
    }

    // ------------------------------------------------------------------ winding

    /// glTF front faces are counter-clockwise seen from outside. GTA's index order is NOT assumed: CodeWalker's renderer
    /// (CullMode.Back with IsFrontCounterClockwise = true and a right-handed projection) suggests counter-clockwise too, but
    /// that is a reading of the renderer, not something verified against game files, and exporters/mods differ. So each
    /// geometry is judged on its own data: its triangles' geometric normals ((p1-p0)x(p2-p0), area-weighted) are compared with
    /// the sum of the triangle's vertex normals. If they mostly disagree, the geometry is stored clockwise relative to its
    /// normals and the index order of every triangle is reversed. The decision is per geometry (not per drawable) because
    /// a single drawable can mix geometries that were authored with different conventions (for example a mirrored part).
    /// A geometry without usable normals cannot be judged; it follows the triangle-weighted majority of the geometries that can.
    private static (double Score, int Agree, int Disagree) WindingScore(float[] p, float[] n, ushort[] idx)
    {
        double score = 0;
        int agree = 0, disagree = 0;
        for (int t = 0; t + 2 < idx.Length; t += 3)
        {
            int a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
            double e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
            double e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
            double gx = e1y * e2z - e1z * e2y;
            double gy = e1z * e2x - e1x * e2z;
            double gz = e1x * e2y - e1y * e2x;
            double sx = (double)n[a] + n[b] + n[c];
            double sy = (double)n[a + 1] + n[b + 1] + n[c + 1];
            double sz = (double)n[a + 2] + n[b + 2] + n[c + 2];
            double d = gx * sx + gy * sy + gz * sz;
            if (d > 1e-9) agree++;
            else if (d < -1e-9) disagree++;
            score += d;
        }
        return (score, agree, disagree);
    }

    /// The vote is taken in STORED-order terms ("was this geometry stored clockwise relative to its normals?"), because a
    /// geometry's final decision also contains its own mirroring: a placement with a negative determinant reverses the
    /// orientation of its triangles. An undecided geometry adopts the drawable's stored convention and then applies its
    /// own mirroring, so a normal-less part on a mirrored bone is reversed even when the rest of the drawable is not.
    private static void DecideWinding(List<Candidate> candidates, List<string> warnings)
    {
        long keepTriangles = 0, flipTriangles = 0;
        foreach (var c in candidates)
        {
            if (!c.Decided) continue;
            bool storedClockwise = c.Flip ^ c.Mirrored;
            if (storedClockwise) flipTriangles += c.Indices.Length / 3; else keepTriangles += c.Indices.Length / 3;
        }
        bool majorityStoredClockwise = flipTriangles > keepTriangles;
        foreach (var c in candidates)
        {
            string label = $"model_{c.ModelIndex} geometry {c.GeometryIndex}";
            if (c.Decided)
            {
                int total = c.Agree + c.Disagree;
                int minority = Math.Min(c.Agree, c.Disagree);
                if (total > 0 && minority > 0.25 * total)
                    warnings.Add($"{label}: winding is ambiguous ({c.Agree} triangles agree with the vertex normals, {c.Disagree} disagree); decided by the area-weighted score.");
                continue;
            }
            c.Flip = majorityStoredClockwise ^ c.Mirrored;
            string why = c.Normals == null ? "has no normals to judge its winding by" : "has normals that give no winding signal";
            string mirror = c.Mirrored ? " and its bone placement mirrors it" : "";
            string result = c.Flip ? "so its index order was reversed" : "so the stored order was kept";
            string how = flipTriangles + keepTriangles == 0
                ? c.Mirrored
                    ? "no other geometry could be judged, so it was taken as stored counter-clockwise (like CodeWalker's renderer)" + mirror + ", " + result
                    : "no other geometry could be judged, so the stored order was kept (counter-clockwise assumed, like CodeWalker's renderer)"
                : majorityStoredClockwise
                    ? $"it follows the other geometries ({flipTriangles} triangles stored clockwise, {keepTriangles} counter-clockwise relative to their normals){mirror}, {result}"
                    : $"it follows the other geometries ({keepTriangles} triangles stored counter-clockwise, {flipTriangles} clockwise relative to their normals){mirror}, {result}";
            warnings.Add($"{label} {why}; {how}.");
        }
    }

    /// Swaps the 2nd and 3rd index of every triangle (keeps the first vertex, so the result is deterministic).
    private static ushort[] Flipped(ushort[] indices)
    {
        var r = new ushort[indices.Length];
        for (int t = 0; t + 2 < indices.Length; t += 3)
        {
            r[t] = indices[t];
            r[t + 1] = indices[t + 2];
            r[t + 2] = indices[t + 1];
        }
        return r;
    }

    /// Replaces -0 by +0 so the output (and the reported bounds) never contain "-0".
    private static void PositiveZero(float[] a)
    {
        for (int i = 0; i < a.Length; i++)
            if (a[i] == 0f) a[i] = 0f;
    }

    private static float ReadF32(byte[] b, int pos) => BinaryPrimitives.ReadSingleLittleEndian(b.AsSpan(pos, 4));
}
