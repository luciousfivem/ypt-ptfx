// Minimal glTF 2.0 binary (GLB) writer for the ydr2glb command.
//
// Written from the glTF 2.0 specification only (no CodeWalker code, no extra NuGet packages). The output is
// deterministic: every key is written in a fixed order, buffer views are laid out in a fixed order and nothing
// time- or machine-dependent is embedded, so the same mesh always yields byte-identical bytes.

using System.Buffers.Binary;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace VfxForge.YptBridge;

/// One glTF primitive, already in glTF axes and winding. Positions/Normals are xyz triples, Uvs are uv pairs.
internal sealed class GlbPrimitive
{
    public required float[] Positions { get; init; }
    public float[]? Normals { get; init; }
    public float[]? Uvs { get; init; }
    public required ushort[] Indices { get; init; }
}

/// One scene node with one mesh (one primitive per geometry).
internal sealed class GlbMeshNode
{
    public required string Name { get; init; }
    public required IReadOnlyList<GlbPrimitive> Primitives { get; init; }
}

internal static class GlbWriter
{
    private const uint MagicGltf = 0x46546C67;   // "glTF"
    private const uint ChunkJson = 0x4E4F534A;   // "JSON"
    private const uint ChunkBin = 0x004E4942;    // "BIN\0"

    // glTF 2.0 enumerations (accessor.componentType, bufferView.target, primitive.mode)
    private const int ComponentFloat = 5126;
    private const int ComponentUnsignedShort = 5123;
    private const int TargetArrayBuffer = 34962;
    private const int TargetElementArrayBuffer = 34963;
    private const int ModeTriangles = 4;

    private const string MaterialName = "vfxforge_neutral";

    /// Builds the GLB. <paramref name="writeExtras"/> writes the members of asset.extras (an object is opened for it).
    public static byte[] Build(string generator, IReadOnlyList<GlbMeshNode> nodes, Action<Utf8JsonWriter> writeExtras)
    {
        var bin = new MemoryStream();
        var views = new List<(long Offset, long Length, int Target)>();
        var accessors = new List<Accessor>();

        // --- binary payload: one bufferView per attribute / index array, each starting on a 4-byte boundary
        var primitiveAccessors = new List<(int Position, int Normal, int Uv, int Index)[]>();
        foreach (var node in nodes)
        {
            var list = new (int Position, int Normal, int Uv, int Index)[node.Primitives.Count];
            for (int p = 0; p < node.Primitives.Count; p++)
            {
                var prim = node.Primitives[p];
                int vertexCount = prim.Positions.Length / 3;

                int pos = AddFloatAccessor(bin, views, accessors, prim.Positions, vertexCount, "VEC3", withBounds: true);
                int nrm = prim.Normals != null ? AddFloatAccessor(bin, views, accessors, prim.Normals, vertexCount, "VEC3", withBounds: false) : -1;
                int uv = prim.Uvs != null ? AddFloatAccessor(bin, views, accessors, prim.Uvs, vertexCount, "VEC2", withBounds: false) : -1;

                Align4(bin);
                long offset = bin.Position;
                var idxBytes = new byte[prim.Indices.Length * 2];
                for (int i = 0; i < prim.Indices.Length; i++)
                    BinaryPrimitives.WriteUInt16LittleEndian(idxBytes.AsSpan(i * 2, 2), prim.Indices[i]);
                bin.Write(idxBytes);
                views.Add((offset, idxBytes.Length, TargetElementArrayBuffer));
                accessors.Add(new Accessor(views.Count - 1, ComponentUnsignedShort, prim.Indices.Length, "SCALAR", null, null));
                list[p] = (pos, nrm, uv, accessors.Count - 1);
            }
            primitiveAccessors.Add(list);
        }

        long binLength = bin.Length;                    // buffer.byteLength excludes the chunk's trailing padding
        var binBytes = PadTo4(bin.ToArray(), 0x00);

        // --- JSON chunk
        var jsonStream = new MemoryStream();
        using (var w = new Utf8JsonWriter(jsonStream, new JsonWriterOptions { Indented = false, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping }))
        {
            w.WriteStartObject();

            w.WriteStartObject("asset");
            w.WriteString("version", "2.0");
            w.WriteString("generator", generator);
            w.WriteStartObject("extras");
            w.WriteStartObject("vfxforge");
            writeExtras(w);
            w.WriteEndObject();
            w.WriteEndObject();
            w.WriteEndObject();

            w.WriteNumber("scene", 0);

            w.WriteStartArray("scenes");
            w.WriteStartObject();
            w.WriteString("name", "drawable");
            w.WriteStartArray("nodes");
            for (int n = 0; n < nodes.Count; n++) w.WriteNumberValue(n);
            w.WriteEndArray();
            w.WriteEndObject();
            w.WriteEndArray();

            w.WriteStartArray("nodes");
            for (int n = 0; n < nodes.Count; n++)
            {
                w.WriteStartObject();
                w.WriteString("name", nodes[n].Name);
                w.WriteNumber("mesh", n);
                w.WriteEndObject();
            }
            w.WriteEndArray();

            w.WriteStartArray("meshes");
            for (int n = 0; n < nodes.Count; n++)
            {
                w.WriteStartObject();
                w.WriteString("name", nodes[n].Name);
                w.WriteStartArray("primitives");
                foreach (var a in primitiveAccessors[n])
                {
                    w.WriteStartObject();
                    w.WriteStartObject("attributes");
                    w.WriteNumber("POSITION", a.Position);
                    if (a.Normal >= 0) w.WriteNumber("NORMAL", a.Normal);
                    if (a.Uv >= 0) w.WriteNumber("TEXCOORD_0", a.Uv);
                    w.WriteEndObject();
                    w.WriteNumber("indices", a.Index);
                    w.WriteNumber("material", 0);
                    w.WriteNumber("mode", ModeTriangles);
                    w.WriteEndObject();
                }
                w.WriteEndArray();
                w.WriteEndObject();
            }
            w.WriteEndArray();

            // GTA shaders and textures are not converted: one neutral material for everything.
            w.WriteStartArray("materials");
            w.WriteStartObject();
            w.WriteString("name", MaterialName);
            w.WriteStartObject("pbrMetallicRoughness");
            w.WriteStartArray("baseColorFactor");
            w.WriteNumberValue(0.8f); w.WriteNumberValue(0.8f); w.WriteNumberValue(0.8f); w.WriteNumberValue(1.0f);
            w.WriteEndArray();
            w.WriteNumber("metallicFactor", 0.1f);
            w.WriteNumber("roughnessFactor", 0.7f);
            w.WriteEndObject();
            w.WriteBoolean("doubleSided", false);
            w.WriteEndObject();
            w.WriteEndArray();

            w.WriteStartArray("accessors");
            foreach (var a in accessors)
            {
                w.WriteStartObject();
                w.WriteNumber("bufferView", a.View);
                w.WriteNumber("componentType", a.ComponentType);
                w.WriteNumber("count", a.Count);
                w.WriteString("type", a.Type);
                if (a.Min != null && a.Max != null)
                {
                    // written as the exact double value of each float32, so a reader that parses the JSON number and
                    // compares it with the accessor data (as a float32) finds them identical
                    w.WriteStartArray("max");
                    foreach (var v in a.Max) w.WriteNumberValue((double)v);
                    w.WriteEndArray();
                    w.WriteStartArray("min");
                    foreach (var v in a.Min) w.WriteNumberValue((double)v);
                    w.WriteEndArray();
                }
                w.WriteEndObject();
            }
            w.WriteEndArray();

            w.WriteStartArray("bufferViews");
            foreach (var v in views)
            {
                w.WriteStartObject();
                w.WriteNumber("buffer", 0);
                w.WriteNumber("byteOffset", v.Offset);
                w.WriteNumber("byteLength", v.Length);
                w.WriteNumber("target", v.Target);
                w.WriteEndObject();
            }
            w.WriteEndArray();

            w.WriteStartArray("buffers");
            w.WriteStartObject();
            w.WriteNumber("byteLength", binLength);
            w.WriteEndObject();
            w.WriteEndArray();

            w.WriteEndObject();
        }
        var jsonBytes = PadTo4(jsonStream.ToArray(), 0x20);   // the JSON chunk is padded with spaces

        // --- container
        long total = 12 + 8 + jsonBytes.Length + 8 + binBytes.Length;
        var glb = new byte[total];
        var span = glb.AsSpan();
        BinaryPrimitives.WriteUInt32LittleEndian(span[0..], MagicGltf);
        BinaryPrimitives.WriteUInt32LittleEndian(span[4..], 2);
        BinaryPrimitives.WriteUInt32LittleEndian(span[8..], checked((uint)total));
        BinaryPrimitives.WriteUInt32LittleEndian(span[12..], (uint)jsonBytes.Length);
        BinaryPrimitives.WriteUInt32LittleEndian(span[16..], ChunkJson);
        jsonBytes.CopyTo(span[20..]);
        int binHeader = 20 + jsonBytes.Length;
        BinaryPrimitives.WriteUInt32LittleEndian(span[binHeader..], (uint)binBytes.Length);
        BinaryPrimitives.WriteUInt32LittleEndian(span[(binHeader + 4)..], ChunkBin);
        binBytes.CopyTo(span[(binHeader + 8)..]);
        return glb;
    }

    private sealed record Accessor(int View, int ComponentType, int Count, string Type, float[]? Min, float[]? Max);

    private static int AddFloatAccessor(MemoryStream bin, List<(long Offset, long Length, int Target)> views, List<Accessor> accessors,
        float[] data, int count, string type, bool withBounds)
    {
        Align4(bin);
        long offset = bin.Position;
        var bytes = new byte[data.Length * 4];
        for (int i = 0; i < data.Length; i++)
            BinaryPrimitives.WriteSingleLittleEndian(bytes.AsSpan(i * 4, 4), data[i]);
        bin.Write(bytes);
        views.Add((offset, bytes.Length, TargetArrayBuffer));

        float[]? min = null, max = null;
        if (withBounds)
        {
            int comps = type == "VEC3" ? 3 : 2;
            min = new float[comps];
            max = new float[comps];
            for (int c = 0; c < comps; c++) { min[c] = float.PositiveInfinity; max[c] = float.NegativeInfinity; }
            for (int i = 0; i < data.Length; i += comps)
                for (int c = 0; c < comps; c++)
                {
                    if (data[i + c] < min[c]) min[c] = data[i + c];
                    if (data[i + c] > max[c]) max[c] = data[i + c];
                }
        }
        accessors.Add(new Accessor(views.Count - 1, ComponentFloat, count, type, min, max));
        return accessors.Count - 1;
    }

    private static void Align4(MemoryStream s)
    {
        while ((s.Length & 3) != 0) s.WriteByte(0);
    }

    private static byte[] PadTo4(byte[] data, byte pad)
    {
        int padded = (data.Length + 3) & ~3;
        if (padded == data.Length) return data;
        var r = new byte[padded];
        data.CopyTo(r, 0);
        Array.Fill(r, pad, data.Length, padded - data.Length);
        return r;
    }
}
