# The YPT converter bridge

VFXForge writes the particle file as CodeWalker-compatible **`.ypt.xml`** itself. Turning that XML into a
**binary `.ypt`** that GTA V can load is done by [CodeWalker](https://github.com/dexyfex/CodeWalker)'s
`CodeWalker.Core` library — the same code the community uses to edit these files.

CodeWalker is **GPL-licensed**. VFXForge therefore does **not** contain, link or redistribute any CodeWalker
code. Instead `tools/ypt-bridge` is a tiny separate program that *you* build against *your own* checkout of
CodeWalker. VFXForge starts it as a separate process and reads one line of JSON back.

The same bridge also converts **GTA V `.ydr` drawables** to GLB so they can be imported as the preview weapon
(see *`.ydr` model import* below).

Without the bridge VFXForge still works: it exports a clearly-labelled **source-only package**
(`.ypt.xml` + `.dds`) that you convert with CodeWalker yourself. It never pretends a binary was produced. `.ydr`
models cannot be imported without it (GLB, glTF, OBJ and FBX still can).

## What the bridge does (and the proof it gives)

| Command | Purpose |
|---|---|
| `version` | prints the bridge and `CodeWalker.Core` versions |
| `xml2ypt --in x.ypt.xml --out x.ypt --gen legacy\|gen9` | XML + DDS files beside it → binary `.ypt` |
| `ypt2xml --in x.ypt --out x.ypt.xml` | binary → XML (+ DDS), for inspecting donors |
| `xml-normalize --in … --out …` | canonical XML, used by the test-suite's oracle diff |
| `ydr2glb --in x.ydr --out x.glb [--lod auto\|high\|med\|low\|vlow]` | GTA V drawable → GLB, for the weapon preview (see below) |
| `xml2ydr --in x.ydr.xml --out x.ydr [--gen legacy\|gen9]` | developer/test helper: CodeWalker drawable XML → binary `.ydr` (used to make the fixtures) |

`xml2ypt` does not just write the file. It **loads the binary it just wrote with CodeWalker again** and compares
the structure (effects, emitters, particles, textures) with the XML. The reply contains
`roundTrip: { ok, mismatches[] }`. VFXForge refuses to export when `ok` is false: *"The file was NOT exported"*.

> **Built the bridge before `.ydr` support?** Rebuild it (same command as below). An older DLL answers `ydr2glb` with
> `unknown_command` and VFXForge tells you to rebuild. `version` reports `0.2.0` or later for a bridge that converts `.ydr`.

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

## `.ydr` model import (`ydr2glb`)

The desktop app converts a `.ydr` when you import it as a weapon model and stores only the resulting GLB. The bridge:

* reads the RSC7 header itself (precise errors for a non-resource, a non-drawable version, a truncated/corrupt file;
  the inflated size is capped) and then CodeWalker's drawable reader;
* takes the highest level of detail with usable geometry (`--lod auto`; a skipped higher LOD is reported);
* decodes positions, normals and the first UV set from each geometry's own vertex declaration (unsupported formats
  are skipped with a warning, never guessed), validates indices, and skips any geometry that fails;
* places rigid parts bound to a skeleton bone at the bone's rest pose (the bone's local matrix composed with its
  ancestors'); skinned parts stay in bind pose;
* converts GTA axes to glTF: `(x, y, z) → (x, z, −y)` (a rotation; metres unchanged);
* decides triangle winding per geometry from its own vertex normals (a geometry without normals follows the rest of
  the drawable, corrected for its own mirroring), so faces point outward under glTF's counter-clockwise rule;
* writes a deterministic GLB with one neutral material and records what it did in `asset.extras.vfxforge`
  (LOD, counts, warnings), which the app shows under the model.

Reply: `{ok, output, bytes, name, gen, resourceVersion, lod, lodsAvailable, models, geometries, vertices, triangles,
windingFlippedGeometries, bounds, shaders, hasSkeleton, boneTransformsApplied, warnings}`. Error codes: `bad_argument`,
`not_found`, `not_ydr`, `unsupported_version`, `parse_failed`, `no_geometry`, `too_large`, `convert_error`.
Limits: input and GLB 256 MiB, 4,000,000 vertices, 90 s.

**Not converted:** textures and shaders (GTA's `.ytd`/embedded textures, shader parameters), skin weights and
animation, lights, collision, other LODs. **Verified** only on synthetic drawables written by CodeWalker from XML authored
for this repo (`tools/ypt-bridge/fixtures`: a cube, multiple LODs and layouts, a skeleton with rotated/mirrored bones, a
gen9 cube) plus hostile inputs; **no real game `.ydr` (legacy or Enhanced) has been converted yet**. Check them with
`node tools/ypt-bridge/fixtures/check.mjs` after building.

## Troubleshooting

| Message | Cause / fix |
|---|---|
| `The CodeWalker converter bridge is not configured` | Build it (above) and set the DLL path in Settings → Tools. |
| `missing_texture` | A `.dds` named in the XML was not next to it. VFXForge always writes them together; this appears if you convert a hand-edited XML. |
| `could not read the binary YPT back identically` | A real converter problem; the export is blocked. Open an issue with the mismatch list. |
| `.ydr`: `this converter bridge is too old` | Rebuild `tools/ypt-bridge` and select the new DLL. |
| `.ydr`: `unsupported_version` / `no_geometry` | Not a drawable (`.ydd`, `.yft`, `.ytd`… renamed), or none of its geometry is readable; the message lists why. |
| `.ydr`: `the converter stopped without answering` | The converter crashed on the file (corrupt or deliberately malformed). Nothing was imported. |
| `dotnet … was not found` | Install the .NET 8 runtime or set the `dotnet` path. |
