// VFXForge YPT bridge — talks to a locally built CodeWalker.Core (GPL; not distributed here).
//
// Commands: version, xml2ypt, ypt2xml, xml-normalize (particle effects) and ydr2glb, xml2ydr (drawable models, YdrConvert.cs).
//
// Protocol: one JSON object on the LAST line of stdout.
//   success: {"ok":true, ...}
//   failure: {"ok":false,"code":"...","error":"..."}      (exit code 1)
// Everything diagnostic goes to stderr.

using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Xml;
using CodeWalker.GameFiles;

namespace VfxForge.YptBridge;

public static class Program
{
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = false };

    // CodeWalker's resource reader follows linked structures recursively (skeleton bone tags, for example). A hostile file
    // with a long chain can exhaust the default main-thread stack (1 MiB on Windows, 8 MiB on Linux), and a stack
    // overflow kills the process before any JSON reply is written. All work therefore runs on a thread with a large
    // stack (address space is reserved, memory is only committed as it is used). This raises the limit by orders of
    // magnitude; it cannot remove it, so the launcher still treats "exited without a reply" as a failed conversion.
    private const int WorkerStackBytes = 256 * 1024 * 1024;

    public static int Main(string[] args)
    {
        int exitCode = 1;
        var worker = new Thread(() => exitCode = Run(args), WorkerStackBytes) { Name = "vfxforge-bridge" };
        worker.Start();
        worker.Join();
        return exitCode;
    }

    private static int Run(string[] args)
    {
        try
        {
            var cmd = args.Length > 0 ? args[0] : "help";
            var opts = ParseOptions(args.Skip(1).ToArray());
            object reply = cmd switch
            {
                "version" => Version(),
                "xml2ypt" => XmlToYpt(Req(opts, "in"), Req(opts, "out"), opts.GetValueOrDefault("gen", "legacy")),
                "ypt2xml" => YptToXml(Req(opts, "in"), Req(opts, "out")),
                "xml-normalize" => XmlNormalize(Req(opts, "in"), Req(opts, "out")),
                "ydr2glb" => YdrToGlb(opts),
                "xml2ydr" => XmlToYdr(opts),
                _ => throw new BridgeException("unknown_command", $"Unknown command '{cmd}'. Commands: version, xml2ypt, ypt2xml, xml-normalize, ydr2glb, xml2ydr."),
            };
            Console.Out.WriteLine(JsonSerializer.Serialize(reply, Json));
            return 0;
        }
        catch (BridgeException ex)
        {
            Fail(ex.Code, ex.Message);
        }
        catch (OutOfMemoryException ex)
        {
            Console.Error.WriteLine(ex.ToString());
            Fail("too_large", "The converter ran out of memory; the file is larger or more complex than it can handle.");
        }
        catch (Exception ex)
        {
            var code = ex.Message.StartsWith("Texture file not found", StringComparison.Ordinal) ? "missing_texture"
                : ex.Message.StartsWith("Texture file format not supported", StringComparison.Ordinal) ? "bad_texture"
                : "convert_error";
            Console.Error.WriteLine(ex.ToString());
            Fail(code, ex.Message.Replace('\n', ' ').Trim());
        }
        return 1;
    }

    private static void Fail(string code, string message) =>
        Console.Out.WriteLine(JsonSerializer.Serialize(new { ok = false, code, error = message }, Json));

    private static object Version()
    {
        var core = typeof(YptFile).Assembly.GetName();
        return new
        {
            ok = true,
            bridge = "vfxforge-ypt-bridge",
            version = typeof(Program).Assembly.GetName().Version?.ToString(3) ?? "0.0.0",
            codewalkerCore = core.Version?.ToString() ?? "unknown",
            runtime = System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription,
        };
    }

    // ------------------------------------------------------------------ conversions

    private static object XmlToYpt(string input, string output, string gen)
    {
        var xmlPath = ExistingFile(input);
        var outPath = OutputFile(output, ".ypt");
        bool gen9 = gen switch
        {
            "gen9" => true,
            "legacy" => false,
            _ => throw new BridgeException("bad_argument", "--gen must be 'legacy' or 'gen9'."),
        };
        var xml = ReadXmlSafely(xmlPath);
        RpfManager.IsGen9 = gen9;
        var folder = Path.GetDirectoryName(xmlPath)! + Path.DirectorySeparatorChar;

        var ypt = XmlYpt.GetYpt(xml, folder);
        if (ypt?.PtfxList == null)
            throw new BridgeException("not_ypt_xml", "The XML root is not a <ParticleEffectsList>; this does not look like a YPT XML export.");
        var bytes = ypt.Save();
        if (bytes == null || bytes.Length < 16)
            throw new BridgeException("empty_output", "CodeWalker produced no data for this YPT.");

        // Round-trip verification: load what we just serialised and compare structure.
        var summaryIn = Summarise(ypt);
        var back = new YptFile();
        back.Load(bytes);
        if (back.PtfxList == null)
            throw new BridgeException("roundtrip_failed", "The binary YPT could not be parsed back: " + (back.ErrorMessage ?? "unknown error"));
        var summaryOut = Summarise(back);
        var mismatches = Compare(summaryIn, summaryOut);

        AtomicWrite(outPath, bytes);
        return new
        {
            ok = true,
            output = outPath,
            bytes = bytes.Length,
            gen = gen9 ? "gen9" : "legacy",
            resourceVersion = BitConverter.ToInt32(bytes, 4),
            summary = summaryOut,
            roundTrip = new { ok = mismatches.Count == 0, mismatches },
        };
    }

    private static object YptToXml(string input, string output)
    {
        var yptPath = ExistingFile(input);
        var outPath = OutputFile(output, ".xml");
        var data = File.ReadAllBytes(yptPath);
        if (data.Length < 16 || BitConverter.ToUInt32(data, 0) != 0x37435352)
            throw new BridgeException("not_ypt", "The file does not start with an RSC7 resource header; it is not a binary YPT.");
        var version = BitConverter.ToInt32(data, 4);
        RpfManager.IsGen9 = version == 71;
        var ypt = new YptFile();
        ypt.Load(data);
        if (ypt.PtfxList == null)
            throw new BridgeException("parse_failed", "The YPT could not be parsed: " + (ypt.ErrorMessage ?? "unknown error"));
        var ddsFolder = Path.GetDirectoryName(outPath)!;
        var xml = YptXml.GetXml(ypt, ddsFolder);
        AtomicWrite(outPath, new UTF8Encoding(false).GetBytes(xml));
        return new { ok = true, output = outPath, resourceVersion = version, summary = Summarise(ypt) };
    }

    /// Parses an XML file with CodeWalker and re-emits it. Diffing the input against the output
    /// shows exactly which of our fields CodeWalker understood and what defaults it filled in.
    private static object XmlNormalize(string input, string output)
    {
        var xmlPath = ExistingFile(input);
        var outPath = OutputFile(output, ".xml");
        RpfManager.IsGen9 = false;
        var ypt = XmlYpt.GetYpt(ReadXmlSafely(xmlPath), Path.GetDirectoryName(xmlPath)! + Path.DirectorySeparatorChar);
        var xml = YptXml.GetXml(ypt);
        AtomicWrite(outPath, new UTF8Encoding(false).GetBytes(xml));
        return new { ok = true, output = outPath, summary = Summarise(ypt) };
    }

    /// GTA V drawable (.ydr) -> GLB. See YdrConvert.cs; the output contract is documented in fixtures/README.md.
    private static object YdrToGlb(Dictionary<string, string> opts)
    {
        OnlyOptions(opts, "in", "out", "lod");
        return YdrConverter.YdrToGlb(Req(opts, "in"), Req(opts, "out"), opts.GetValueOrDefault("lod", "auto"));
    }

    /// CodeWalker drawable XML -> .ydr; a developer/test helper used to author the fixtures, not a user-facing command.
    private static object XmlToYdr(Dictionary<string, string> opts)
    {
        OnlyOptions(opts, "in", "out", "gen");
        return YdrConverter.XmlToYdr(Req(opts, "in"), Req(opts, "out"), opts.GetValueOrDefault("gen", "legacy"));
    }

    private static void OnlyOptions(Dictionary<string, string> opts, params string[] allowed)
    {
        foreach (var key in opts.Keys)
            if (!allowed.Contains(key)) throw new BridgeException("bad_argument", $"Unknown option --{key}. Options: {string.Join(", ", allowed.Select(a => "--" + a))}.");
    }

    // ------------------------------------------------------------------- helpers

    private static Dictionary<string, object> Summarise(YptFile ypt)
    {
        var p = ypt.PtfxList;
        return new Dictionary<string, object>
        {
            ["name"] = p?.Name?.Value ?? "",
            ["effectRules"] = p?.EffectRuleDictionary?.EffectRules?.data_items?.Length ?? 0,
            ["emitterRules"] = p?.EmitterRuleDictionary?.EmitterRules?.data_items?.Length ?? 0,
            ["particleRules"] = p?.ParticleRuleDictionary?.ParticleRules?.data_items?.Length ?? 0,
            ["textures"] = p?.TextureDictionary?.Textures?.data_items?.Length ?? 0,
            ["drawables"] = p?.DrawableDictionary?.Drawables?.data_items?.Length ?? 0,
            ["effectNames"] = (p?.EffectRuleDictionary?.EffectRules?.data_items ?? Array.Empty<ParticleEffectRule>()).Select(e => e.Name?.Value ?? "").OrderBy(s => s, StringComparer.Ordinal).ToArray(),
            ["emitterNames"] = (p?.EmitterRuleDictionary?.EmitterRules?.data_items ?? Array.Empty<ParticleEmitterRule>()).Select(e => e.Name?.Value ?? "").OrderBy(s => s, StringComparer.Ordinal).ToArray(),
            ["particleNames"] = (p?.ParticleRuleDictionary?.ParticleRules?.data_items ?? Array.Empty<ParticleRule>()).Select(e => e.Name?.Value ?? "").OrderBy(s => s, StringComparer.Ordinal).ToArray(),
            ["textureNames"] = (p?.TextureDictionary?.Textures?.data_items ?? Array.Empty<Texture>()).Select(t => $"{t.Name}:{t.Width}x{t.Height}:{t.Levels}:{t.Format}").OrderBy(s => s, StringComparer.Ordinal).ToArray(),
        };
    }

    private static List<string> Compare(Dictionary<string, object> a, Dictionary<string, object> b)
    {
        var problems = new List<string>();
        foreach (var key in a.Keys)
        {
            var av = a[key];
            var bv = b[key];
            var same = av is string[] sa && bv is string[] sb ? sa.SequenceEqual(sb) : Equals(av, bv);
            if (!same) problems.Add($"{key}: XML had {Describe(av)} but the re-loaded binary has {Describe(bv)}");
        }
        return problems;
    }

    private static string Describe(object o) => o is string[] arr ? "[" + string.Join(", ", arr) + "]" : o.ToString() ?? "";

    /// DTDs are prohibited and no resolver is used, so external entities / billion-laughs style XML cannot be expanded.
    internal static string ReadXmlSafely(string path)
    {
        var text = File.ReadAllText(path, Encoding.UTF8);
        var settings = new XmlReaderSettings
        {
            DtdProcessing = DtdProcessing.Prohibit,
            XmlResolver = null,
            MaxCharactersInDocument = 256L * 1024 * 1024,
        };
        try
        {
            using var reader = XmlReader.Create(new StringReader(text), settings);
            while (reader.Read()) { }
        }
        catch (XmlException ex)
        {
            throw new BridgeException("bad_xml", $"The XML is not acceptable: {ex.Message}");
        }
        return text;
    }

    internal static string ExistingFile(string path)
    {
        var full = Path.GetFullPath(path);
        if (!File.Exists(full)) throw new BridgeException("not_found", $"File not found: {full}");
        return full;
    }

    internal static string OutputFile(string path, string requiredSuffix)
    {
        var full = Path.GetFullPath(path);
        if (!full.EndsWith(requiredSuffix, StringComparison.OrdinalIgnoreCase))
            throw new BridgeException("bad_argument", $"Output file name must end with {requiredSuffix}.");
        var dir = Path.GetDirectoryName(full);
        if (dir == null || !Directory.Exists(dir)) throw new BridgeException("not_found", $"Output folder does not exist: {dir}");
        return full;
    }

    internal static void AtomicWrite(string path, byte[] data)
    {
        var tmp = path + "." + Environment.ProcessId + ".tmp";
        File.WriteAllBytes(tmp, data);
        File.Move(tmp, path, overwrite: true);
    }

    private static Dictionary<string, string> ParseOptions(string[] args)
    {
        var d = new Dictionary<string, string>(StringComparer.Ordinal);
        for (int i = 0; i < args.Length; i++)
        {
            if (!args[i].StartsWith("--", StringComparison.Ordinal)) throw new BridgeException("bad_argument", $"Unexpected argument '{args[i]}'.");
            if (i + 1 >= args.Length) throw new BridgeException("bad_argument", $"Missing value for {args[i]}.");
            d[args[i][2..]] = args[++i];
        }
        return d;
    }

    private static string Req(Dictionary<string, string> o, string key) =>
        o.TryGetValue(key, out var v) ? v : throw new BridgeException("bad_argument", $"Missing required option --{key}.");
}

public sealed class BridgeException : Exception
{
    public string Code { get; }
    public BridgeException(string code, string message) : base(message) => Code = code;
}
