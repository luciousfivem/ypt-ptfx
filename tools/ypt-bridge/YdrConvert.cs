// ydr2glb: GTA V drawable (.ydr, RSC7 resource) -> glTF 2.0 binary (.glb), plus the dev/test helper xml2ydr.
//
// The binary is parsed by CodeWalker.Core (not distributed here). The RSC7 header is inspected first so that the errors
// are precise (not a resource / not a drawable version / corrupt) and so that a hostile file cannot make us allocate or
// inflate without bound: CodeWalker's own YdrFile.Load swallows every parse exception and inflates without a limit.

using System.IO.Compression;
using System.Text;
using System.Text.Json;
using CodeWalker.GameFiles;

namespace VfxForge.YptBridge;

internal sealed record LoadedYdr(Drawable Drawable, int ResourceVersion, bool Gen9, List<string> Warnings);

internal static class YdrConverter
{
    internal const long MaxInputBytes = 256L * 1024 * 1024;
    internal const long MaxResourceBytes = 512L * 1024 * 1024;   // declared (inflated) system + graphics pages
    internal const long MaxGlbBytes = 256L * 1024 * 1024;
    internal const int MaxVertices = 4_000_000;
    private const int MaxWarnings = 60;
    private const uint Rsc7Magic = 0x37435352;                    // "RSC7" read as a little-endian uint32

    // Resource versions, from YdrFile.GetVersion and the other CodeWalker file types: legacy drawable 165 (also used by .ydd),
    // gen9 drawable 159 (YdrFile.Load also accepts 154 as gen9). Other types: ypt 68/71, ytd 13/5, yft 162/171.
    private const int VersionLegacy = 165;
    private const int VersionGen9 = 159;
    private const int VersionGen9Alt = 154;

    // ------------------------------------------------------------------ ydr2glb

    public static object YdrToGlb(string input, string output, string lodOption)
    {
        LodLevel? requested = lodOption switch
        {
            "auto" => null,
            "high" => LodLevel.High,
            "med" => LodLevel.Med,
            "low" => LodLevel.Low,
            "vlow" => LodLevel.VLow,
            _ => throw new BridgeException("bad_argument", "--lod must be one of auto, high, med, low, vlow."),
        };
        var inPath = Program.ExistingFile(input);
        if (!inPath.EndsWith(".ydr", StringComparison.OrdinalIgnoreCase))
            throw new BridgeException("bad_argument", "Input file name must end with .ydr.");
        var outPath = Program.OutputFile(output, ".glb");

        using var watchdog = Watchdog.Start(ConversionTimeout());
        var info = new FileInfo(inPath);
        if (info.Length > MaxInputBytes)
            throw new BridgeException("too_large", $"The file is {info.Length / (1024 * 1024)} MiB; the limit is {MaxInputBytes / (1024 * 1024)} MiB.");
        var loaded = LoadYdr(File.ReadAllBytes(inPath));
        var drawable = loaded.Drawable;
        LoadKnownNames();

        var extractor = new MeshExtractor(drawable);
        var available = new List<LodLevel>();
        var skipReasons = new List<string>();
        var passedOver = new List<string>();   // auto: higher LODs that have geometry, none of it exportable
        LodMesh? chosen = null;
        foreach (var level in Lods.All)
        {
            var mesh = extractor.Extract(level);
            if (mesh.Renderable) available.Add(level);
            else
            {
                var reasons = mesh.Warnings.Where(w => w.Contains("skipped")).ToList();
                skipReasons.AddRange(reasons);
                if (!requested.HasValue && chosen == null && reasons.Count > 0)
                    passedOver.Add($"LOD '{Lods.Name(level)}' was not exported because none of its geometry could be read ({reasons[0]}{(reasons.Count > 1 ? $" +{reasons.Count - 1} more" : "")}); a lower LOD was used.");
            }
            bool pick = requested.HasValue ? requested.Value == level : chosen == null;
            if (pick && mesh.Renderable) chosen = mesh;
        }
        if (chosen == null)
        {
            string wanted = requested.HasValue ? $"LOD '{Lods.Name(requested.Value)}'" : "any LOD";
            string have = available.Count > 0 ? $" Available: {string.Join(", ", available.Select(Lods.Name))}." : "";
            // say why geometries were rejected (only the ones of the LODs that were examined, first few)
            string why = skipReasons.Count > 0 ? " " + string.Join(" ", skipReasons.Take(3)) + (skipReasons.Count > 3 ? $" (+{skipReasons.Count - 3} more)" : "") : "";
            throw new BridgeException("no_geometry", $"The drawable has no renderable geometry in {wanted}.{have}{why}");
        }
        if (chosen.TooLarge)
            throw new BridgeException("too_large", $"LOD '{Lods.Name(chosen.Level)}' declares {chosen.DeclaredVertices} vertices; the limit is {MaxVertices}.");

        var warnings = new List<string>(loaded.Warnings);
        warnings.AddRange(passedOver);
        warnings.AddRange(chosen.Warnings);
        if (warnings.Count > MaxWarnings)
        {
            int extra = warnings.Count - MaxWarnings;
            warnings.RemoveRange(MaxWarnings, extra);
            warnings.Add($"... and {extra} more warnings.");
        }

        string name = CleanName(drawable.Name);
        string generator = "vfxforge-ypt-bridge ydr2glb " + BridgeVersion();
        string lodName = Lods.Name(chosen.Level);
        var nodes = chosen.Models.Select(m => new GlbMeshNode
        {
            Name = $"model_{m.Index}",
            Primitives = m.Geometries.Select(g => new GlbPrimitive
            {
                Positions = g.Positions,
                Normals = g.Normals,
                Uvs = g.Uvs,
                Indices = g.Indices,
            }).ToList(),
        }).ToList();

        var glb = GlbWriter.Build(generator, nodes, w =>
        {
            w.WriteString("source", "ydr");
            w.WriteString("name", name);
            w.WriteString("lod", lodName);
            w.WriteStartArray("lodsAvailable");
            foreach (var l in available) w.WriteStringValue(Lods.Name(l));
            w.WriteEndArray();
            w.WriteString("gen", loaded.Gen9 ? "gen9" : "legacy");
            w.WriteNumber("resourceVersion", loaded.ResourceVersion);
            w.WriteNumber("models", chosen.Models.Count);
            w.WriteNumber("geometries", chosen.Geometries);
            w.WriteNumber("vertices", chosen.Vertices);
            w.WriteNumber("triangles", chosen.Triangles);
            w.WriteNumber("windingFlippedGeometries", chosen.WindingFlipped);
            w.WriteBoolean("boneTransformsApplied", chosen.BoneTransformsApplied);
            w.WriteString("axes", "GTA Z-up -> glTF Y-up: (x,y,z) -> (x,z,-y)");
            w.WriteStartArray("warnings");
            foreach (var s in warnings) w.WriteStringValue(s);
            w.WriteEndArray();
        });
        if (glb.Length > MaxGlbBytes)
            throw new BridgeException("too_large", $"The converted GLB would be {glb.Length / (1024 * 1024)} MiB; the limit is {MaxGlbBytes / (1024 * 1024)} MiB.");

        Program.AtomicWrite(outPath, glb);
        return new
        {
            ok = true,
            output = outPath,
            bytes = glb.Length,
            name,
            gen = loaded.Gen9 ? "gen9" : "legacy",
            resourceVersion = loaded.ResourceVersion,
            lod = lodName,
            lodsAvailable = available.Select(Lods.Name).ToArray(),
            models = chosen.Models.Count,
            geometries = chosen.Geometries,
            vertices = chosen.Vertices,
            triangles = chosen.Triangles,
            windingFlippedGeometries = chosen.WindingFlipped,
            bounds = new { min = chosen.BoundsMin, max = chosen.BoundsMax },
            shaders = chosen.Shaders.ToArray(),
            hasSkeleton = drawable.Skeleton != null,
            boneTransformsApplied = chosen.BoneTransformsApplied,
            warnings,
        };
    }

    // ------------------------------------------------------------------ xml2ydr (dev / test helper)

    /// CodeWalker drawable XML -> binary .ydr. Used to author the fixtures under tools/ypt-bridge/fixtures; not user-facing.
    public static object XmlToYdr(string input, string output, string gen)
    {
        var xmlPath = Program.ExistingFile(input);
        var outPath = Program.OutputFile(output, ".ydr");
        bool gen9 = gen switch
        {
            "gen9" => true,
            "legacy" => false,
            _ => throw new BridgeException("bad_argument", "--gen must be 'legacy' or 'gen9'."),
        };
        var xml = Program.ReadXmlSafely(xmlPath);
        RpfManager.IsGen9 = gen9;
        var folder = Path.GetDirectoryName(xmlPath)! + Path.DirectorySeparatorChar;

        var ydr = XmlYdr.GetYdr(xml, folder);
        if (ydr?.Drawable == null)
            throw new BridgeException("not_ydr_xml", "The XML root is not a <Drawable>; this does not look like a CodeWalker drawable XML export.");
        var bytes = ydr.Save();
        if (bytes == null || bytes.Length < 16)
            throw new BridgeException("empty_output", "CodeWalker produced no data for this drawable.");

        // Round-trip: the binary we just wrote must load again through the same path ydr2glb uses.
        try
        {
            LoadYdr(bytes);
        }
        catch (BridgeException ex)
        {
            throw new BridgeException("roundtrip_failed", "The binary YDR could not be parsed back: " + ex.Message);
        }

        Program.AtomicWrite(outPath, bytes);
        return new
        {
            ok = true,
            output = outPath,
            bytes = bytes.Length,
            resourceVersion = BitConverter.ToInt32(bytes, 4),
            gen = gen9 ? "gen9" : "legacy",
        };
    }

    // ------------------------------------------------------------------ RSC7 loading

    public static LoadedYdr LoadYdr(byte[] file)
    {
        if (file.Length < 4 || BitConverter.ToUInt32(file, 0) != Rsc7Magic)
            throw new BridgeException("not_ydr", file.Length == 0
                ? "The file is empty; it is not a GTA V resource file (.ydr)."
                : "The file does not start with an RSC7 resource header; it is not a GTA V resource file (.ydr).");
        if (file.Length < 16)
            throw new BridgeException("parse_failed", "The file has an RSC7 magic but is shorter than the 16-byte resource header (truncated).");

        var warnings = new List<string>();
        uint headerVersion = BitConverter.ToUInt32(file, 4);
        uint sysFlags = BitConverter.ToUInt32(file, 8);
        uint gfxFlags = BitConverter.ToUInt32(file, 12);
        // CodeWalker takes the version from the page flags (RpfResourceFileEntry.Version), so this is the one that counts.
        int version = (int)(((sysFlags >> 28) & 0xF) * 16 + ((gfxFlags >> 28) & 0xF));
        bool gen9 = version == VersionGen9 || version == VersionGen9Alt;
        if (!gen9 && version != VersionLegacy)
            throw new BridgeException("unsupported_version",
                $"RSC7 resource version {version} is not a drawable version this converter can read " +
                $"(drawables are {VersionLegacy} legacy or {VersionGen9}/{VersionGen9Alt} gen9; for comparison particle effects use 68/71, textures 13/5, fragments 162/171).");
        if (headerVersion != (uint)version)
            warnings.Add($"The RSC7 header says version {headerVersion} but the page flags say {version}; the page flags were used, like CodeWalker does.");

        var entry = new RpfResourceFileEntry { Name = "", NameLower = "", SystemFlags = sysFlags, GraphicsFlags = gfxFlags };
        long sysSize = entry.SystemSize, gfxSize = entry.GraphicsSize;
        if (sysSize < 0 || gfxSize < 0 || sysSize + gfxSize > MaxResourceBytes)
            throw new BridgeException("too_large", $"The resource header declares {(sysSize < 0 || gfxSize < 0 ? "an invalid" : $"{(sysSize + gfxSize) / (1024 * 1024)} MiB of")} data; the limit is {MaxResourceBytes / (1024 * 1024)} MiB.");
        long total = sysSize + gfxSize;
        if (total <= 0)
            throw new BridgeException("parse_failed", "The resource header declares no data.");

        // Inflate exactly the declared amount (the payload after the 16-byte header is a raw deflate stream).
        var payload = new byte[total];
        int read = 0;
        try
        {
            using var ms = new MemoryStream(file, 16, file.Length - 16, writable: false);
            using var ds = new DeflateStream(ms, CompressionMode.Decompress);
            while (read < total)
            {
                int n = ds.Read(payload, read, (int)(total - read));
                if (n <= 0) break;
                read += n;
            }
        }
        catch (InvalidDataException ex)
        {
            Console.Error.WriteLine(ex.ToString());
            throw new BridgeException("parse_failed", "The resource data is not a valid deflate stream (the file is corrupt, truncated or not a GTA V resource).");
        }
        if (read < total)
            throw new BridgeException("parse_failed", $"The resource data is truncated: the header declares {total} bytes but only {read} could be inflated.");

        RpfManager.IsGen9 = gen9;
        Drawable? drawable;
        try
        {
            // This is what YdrFile.Load does, minus the exception swallowing that would hide why a file is unreadable.
            var reader = new ResourceDataReader(entry, payload);
            drawable = reader.ReadBlock<Drawable>();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.ToString());
            throw new BridgeException("parse_failed", "CodeWalker could not read this file as a drawable: " + FirstLine(ex));
        }
        if (drawable == null)
            throw new BridgeException("parse_failed", "CodeWalker could not read this file as a drawable (no drawable at the resource root).");
        if (!string.IsNullOrEmpty(drawable.ErrorMessage))
            warnings.Add("CodeWalker could not read the drawable's name/bounds block (ignored): " + FirstLine(drawable.ErrorMessage));
        if (drawable.DrawableModels == null)
            throw new BridgeException("no_geometry", "The drawable contains no models (it may be a different resource type with a drawable version, such as .ydd or .yft).");
        return new LoadedYdr(drawable, version, gen9, warnings);
    }

    // ------------------------------------------------------------------ helpers

    /// A hostile file can make CodeWalker's reader do a great deal of work (nested pointer lists), so a conversion that has
    /// not finished after this long is abandoned with a JSON error instead of hanging. VFXFORGE_YDR_TIMEOUT_SECONDS
    /// overrides the default (used by the tests).
    private static TimeSpan ConversionTimeout()
    {
        var env = Environment.GetEnvironmentVariable("VFXFORGE_YDR_TIMEOUT_SECONDS");
        if (!string.IsNullOrEmpty(env) && double.TryParse(env, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var secs) && secs >= 0.01 && secs <= 3600)
            return TimeSpan.FromSeconds(secs);
        return TimeSpan.FromSeconds(90);
    }

    /// Shader names are stored as hashes; CodeWalker ships a list of known names (strings.txt next to CodeWalker.Core.dll)
    /// that its own tools load into JenkIndex. Without it names come out as hash_XXXXXXXX.
    private static void LoadKnownNames()
    {
        try
        {
            var dir = Path.GetDirectoryName(typeof(Drawable).Assembly.Location);
            if (string.IsNullOrEmpty(dir)) return;
            var path = Path.Combine(dir, "strings.txt");
            if (!File.Exists(path)) return;
            foreach (var line in File.ReadLines(path))
            {
                var s = line.Trim();
                if (s.Length == 0 || s.StartsWith("//", StringComparison.Ordinal)) continue;
                JenkIndex.Ensure(s);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // names are cosmetic; hashes are reported instead
        }
    }

    private static string CleanName(string? name)
    {
        if (string.IsNullOrEmpty(name)) return "";
        var sb = new StringBuilder();
        foreach (var ch in name)
        {
            if (sb.Length >= 200) break;
            sb.Append(char.IsControl(ch) ? '?' : ch);
        }
        return sb.ToString();
    }

    private static string BridgeVersion() => typeof(Program).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";

    private static string FirstLine(Exception ex) => ex.GetType().Name + ": " + FirstLine(ex.Message);

    private static string FirstLine(string s)
    {
        var line = s.Split('\n')[0].Trim();
        return line.Length > 300 ? line[..300] + "..." : line;
    }
}

/// Prints the failure reply and exits when a conversion runs for too long. Disposing it (on every normal path) disarms it.
internal sealed class Watchdog : IDisposable
{
    private readonly Timer timer;
    private int finished;

    private Watchdog(TimeSpan limit)
    {
        timer = new Timer(_ => Fire(limit), null, limit, Timeout.InfiniteTimeSpan);
    }

    public static Watchdog Start(TimeSpan limit) => new(limit);

    private void Fire(TimeSpan limit)
    {
        if (Interlocked.Exchange(ref finished, 1) != 0) return;
        var message = $"The conversion did not finish within {limit.TotalSeconds:0.##} s and was stopped; the file is probably corrupt or far more complex than a weapon model.";
        Console.Out.WriteLine(JsonSerializer.Serialize(new { ok = false, code = "convert_error", error = message }));
        Console.Out.Flush();
        Environment.Exit(1);
    }

    public void Dispose()
    {
        Interlocked.Exchange(ref finished, 1);
        timer.Dispose();
    }
}
