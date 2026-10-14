# The YPT converter bridge

VFXForge writes the particle file as CodeWalker-compatible **`.ypt.xml`** itself. Turning that XML into a
**binary `.ypt`** that GTA V can load is done by [CodeWalker](https://github.com/dexyfex/CodeWalker)'s
`CodeWalker.Core` library — the same code the community uses to edit these files.

CodeWalker is **GPL-licensed**. VFXForge therefore does **not** contain, link or redistribute any CodeWalker
code. Instead `tools/ypt-bridge` is a tiny separate program that *you* build against *your own* checkout of
CodeWalker. VFXForge starts it as a separate process and reads one line of JSON back.

Without the bridge VFXForge still works: it exports a clearly-labelled **source-only package**
(`.ypt.xml` + `.dds`) that you convert with CodeWalker yourself. It never pretends a binary was produced.

## What the bridge does (and the proof it gives)

| Command | Purpose |
|---|---|
| `version` | prints the bridge and `CodeWalker.Core` versions |
| `xml2ypt --in x.ypt.xml --out x.ypt --gen legacy\|gen9` | XML + DDS files beside it → binary `.ypt` |
| `ypt2xml --in x.ypt --out x.ypt.xml` | binary → XML (+ DDS), for inspecting donors |
| `xml-normalize --in … --out …` | canonical XML, used by the test-suite's oracle diff |

`xml2ypt` does not just write the file. It **loads the binary it just wrote with CodeWalker again** and compares
the structure (effects, emitters, particles, textures) with the XML. The reply contains
`roundTrip: { ok, mismatches[] }`. VFXForge refuses to export when `ok` is false: *"The file was NOT exported"*.

Protocol: one JSON object on the **last** line of stdout; diagnostics go to stderr; exit code 1 on failure
(`{"ok":false,"code":"missing_texture","error":"…"}`).

## Building it

Requirements: the **.NET 8 SDK** and a local clone of CodeWalker.

```bash
git clone https://github.com/dexyfex/CodeWalker.git            # or your fork
cd /path/to/ypt-ptfx
dotnet build tools/ypt-bridge -c Release \
  -p:CodeWalkerCoreDir=/path/to/CodeWalker/CodeWalker.Core \
  -o tools/ypt-bridge/out
```

The build fails with a readable message if `CodeWalkerCoreDir` is wrong. The result is
`tools/ypt-bridge/out/vfxforge-ypt-bridge.dll`.

> **Verified toolchain:** .NET 8 (`8.0.x`) on Linux against `CodeWalker.Core` `1.0.0.0` (reported by
> `dotnet vfxforge-ypt-bridge.dll version`). CodeWalker is a Windows-first project; if your checkout needs a
> different target framework, adjust `TargetFramework` in `VfxForge.YptBridge.csproj`.

## Telling VFXForge where it is

Desktop app → **Settings → Tools**:

* *ypt-bridge DLL*: the `vfxforge-ypt-bridge.dll` you built,
* *.NET (dotnet)*: only needed if `dotnet` is not on `PATH`.

The status bar then shows **“Binary .ypt ready · <CodeWalker version>”**. (From the command line:
`vfxforge-cli bridge-status --dll …/vfxforge-ypt-bridge.dll`.)

For the automated tests set `VFXFORGE_BRIDGE_DLL=/path/to/vfxforge-ypt-bridge.dll`; they are skipped (with the
reason printed) when it is absent.

## What the round-trip proves — and what it does not

**Proves:** the XML is well-formed for CodeWalker, every texture is present and decodable, every reference
(effect → emitter → particle → texture) resolves, and CodeWalker can read back exactly what it wrote.

**Does not prove:** that GTA V *renders* the effect. Several engine-side values (shader names, blend-set
enums, the meaning of some key-frame properties, how a flipbook frame id becomes a UV rectangle) are inferred
from CodeWalker's field names and are labelled `inferred`/`unverified` in the fidelity report. Use the
**donor-template** workflow (export a known-good PTFX from your game files with CodeWalker, let VFXForge patch only
the texture, frame range and names) when you need the highest chance of in-game success, and run
[`FIVEM_TEST_CHECKLIST.md`](FIVEM_TEST_CHECKLIST.md).

## Troubleshooting

| Message | Cause / fix |
|---|---|
| `The CodeWalker converter bridge is not configured` | Build it (above) and set the DLL path in Settings → Tools. |
| `missing_texture` | A `.dds` named in the XML was not next to it. VFXForge always writes them together; this appears if you convert a hand-edited XML. |
| `could not read the binary YPT back identically` | A real converter problem; the export is blocked. Open an issue with the mismatch list. |
| `dotnet … was not found` | Install the .NET 8 runtime or set the `dotnet` path. |
