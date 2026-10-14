# Architecture

## The pipeline

```
 image / GIF / MP4 / WebM          3D model (GLB/glTF/OBJ/FBX; .ydr -> GLB via the bridge)
        │ import (content-sniffed,          │ preview only — never exported
        │ hashed, stored untouched)         ▼
        ▼                              ┌──────────────┐
 ┌──────────────┐  frames             │  Weapon view  │◄───────── attachment points
 │ FrameService │──────────┐          │  (three.js)   │          (offset / rotation)
 │ FFmpeg | web │          ▼          └──────▲───────┘
 └──────────────┘   ┌─────────────┐          │ live particles
                    │ media       │    ┌─────┴──────┐   ┌──────────────────┐
  Clip recipe  ───► │ key • adjust│    │ particles  │◄──│ Project (zod)    │
  (non-destructive) │ crop • order│    │ simulator  │   │ clips • sheets   │
                    └─────┬───────┘    └────────────┘   │ effects • weapon │
                          ▼                              │ export settings  │
                    ┌─────────────┐                      └───────┬──────────┘
                    │ atlas       │   PNG / DDS                  │
                    │ (grid, pad) │──────────────┐               │
                    └─────────────┘              ▼               ▼
                                         ┌────────────────────────────┐
                                         │ export orchestrator         │
                                         │ 1 frames  2 sheets  3 flipbook check
                                         │ 4 map effects→rules (fidelity notes)
                                         │ 5 .ypt.xml + validation
                                         │ 6 binary .ypt via CodeWalker + read-back
                                         │ 7 FiveM resource + ZIP
                                         └─────────────┬──────────────┘
                                          any error ⇒ "blocked", nothing written
```

## Packages (TypeScript, consumed from source)

| Package | Responsibility | Notable guarantees |
|---|---|---|
| `core` | Project document (zod schema, referential integrity), curves/gradients, deterministic RNG, undo `History`, grid maths, filename/identifier/path/Lua/XML escaping, preset packages | Untrusted JSON is parsed, never trusted; ids regenerated on import |
| `media` | RGBA image ops, black/white/chroma keying, colour adjust, motion blur, procedural single-image animation, clip pipeline, atlas builder, PNG (+APNG), **DDS** (BC1/BC3/BGRA8, mips) encoder/decoder/validator, content sniffing | Premultiplied resampling (no halos); DDS validated against hostile input; CodeWalker's tightly-packed mip tail accepted with a warning |
| `particles` | Deterministic SoA simulator with exact integration, 30 presets + procedural sprite generators, `RuntimeSimulator` (mirrors the Lua semantics) | Seeded; analytic-physics tests; live edits re-simulate deterministically |
| `ypt` | CodeWalker-compatible XML model/writer/validator, joaat hashing, flipbook validator, donor-template patching, effect→rule mapping with `status × confidence` notes | Field order and spelling follow CodeWalker (including its `IsTargetRelatve` typo); never claims "compatible with the game" |
| `fivem` | Lua 5.4 templates (client/server), `config.lua`/manifest/README generators, reproducible ZIP | Escapes every embedded string; no per-frame polling while unarmed; cleanup on switch/death/restart |
| `export` | The orchestrator and cost estimates | Hard gates (see below) |

### Export gates

`runExport` returns `complete`, `source-only` (only when the caller opts in and says so) or `blocked`. It blocks on:
no used spritesheet · texture-name clash · atlas/grid errors · flipbook layout errors · model-mapping errors ·
XML structural errors · DDS/XML mismatch · **no converter** (unless source-only) · **converter threw** ·
**CodeWalker could not read the binary back identically** · invalid resource options · cancellation.
A file is never reported as exported merely because it was written.

## The desktop app (`apps/desktop`)

```
React UI ── zustand stores ─────────────────┐
  │          project (immer + History)       │
  │          ui • runtime • derived • export │
  │                                          ▼
  │      EngineClient ◄─ typed RPC ─► engine.worker (engine-core)
  │            ▲   host callbacks:        keying • atlas • DDS/PNG • export run
  │            │   getFrames, convert     (cancellable jobs, bounded raw-frame cache)
  ▼            │
Platform ──────┴──► browser: IndexedDB, <video>/ImageDecoder, source-only export
  │                 tauri:   invoke() ─► Rust commands (below)
  ▼
ViewportEngine (three.js): weapon • attachments + TransformControls • instanced
flipbook particle renderer • bloom • auto quality • RuntimeSimulator events
```

* **Non-destructive**: the project stores recipes (extract/keying/adjust/grid/emitters); frames, atlases and particles
  are derived. `state/derived.ts` rebuilds only sheets whose inputs changed (immutable data ⇒ reference comparison),
  keeps the last good preview while rebuilding, and shows errors without losing the preview.
* **Workers**: all CPU-heavy work runs in a Web Worker behind a small typed RPC (`lib/rpc.ts`) that supports host
  callbacks, error propagation and cancellation; the same engine code runs in Node for tests.
* **Platform abstraction**: the UI asks the `Platform` what it can do; unavailable features are disabled *and
  explained* (e.g. “Video import needs FFmpeg”, “Binary .ypt: converter unavailable”).
* **Undo**: structural-sharing snapshots with coalescing keys, so a slider drag is one step.

## The native side

```
apps/desktop/src-tauri      thin Tauri 2 command layer (validates, runs on blocking threads)
        │ uses
native/vfxforge-native      FFmpeg probe/extract • content sniffing • atomic file I/O • project store +
                            autosave/recovery • process runner (timeouts, process-tree kill) • converter launcher •
                            service layer (project ids, asset paths, bundle verification, convert) • VFXW wire format
        │ spawns (separate processes)
ffmpeg / ffprobe            discovered: Settings → app folder → PATH
dotnet vfxforge-ypt-bridge.dll → CodeWalker.Core (GPL, built by the user against their own checkout)
```

Binary IPC uses the **VFXW** container (`wire.rs` / `platform/wire.ts`, byte-identical, asserted by tests in both
languages), so DDS textures, PNG frames and `.ypt` files never become JSON number arrays.

## Security model

| Input | Treatment |
|---|---|
| Media / models | Identified by magic numbers, not extension; size-limited; stored by SHA-256; originals never modified. glTF external references are blocked |
| `.ydr` drawables | The only import chosen by name: it must end in `.ydr` **and** start with an RSC7 header (an RSC7 file with another name is refused). A private copy is converted by the bridge (`ydr2glb`) in a scratch folder that is always removed; the bridge's reply is validated, its output must be a well-formed GLB and is stored like any model (the `.ydr` itself is not kept). GLB metadata from the converter is read as untrusted (types checked, strings capped) |
| Project files / bundles / preset packages | zod-validated; referential integrity checked; bundle assets re-hashed; paths confined to the project folder (`..`, absolute, UNC, `//` rejected) |
| FFmpeg | argv built from validated numbers only; forced demuxer; `-protocol_whitelist file`; absolute canonical input path; hard timeout; process tree killed on cancel |
| Converter | fixed command set; absolute paths; runs CodeWalker's reader on a thread with a 256 MiB stack so a hostile file cannot abort it before it answers (a reply-less exit is reported as a failed conversion); texture names must match `[a-z][a-z0-9_]*.dds`; temp folder removed afterwards |
| XML (donor files) | DTD/entity expansion rejected; size-capped |
| Generated Lua | every embedded string escaped; injection attempts are in the test-suite |
| Webview | CSP; no filesystem scope; only the app's own commands + native dialogs |
| Writes | temp-file + rename (atomic); previous good project kept as `.bak`; autosave never overwrites the saved project |

## Where honesty is enforced in code

* `ypt/src/flipbook.ts`: verdict type is `'invalid' | 'structurally-valid'` and `engineVerified: false` is a literal type.
* `ypt/src/build.ts`: every mapped property carries `status` (mapped / approximated / preview-only / unsupported) and
  `confidence` (verified / inferred / unverified); engine defaults are marked UNVERIFIED in `model.ts`.
* `export/src/run.ts`: the gates above; `source-only` is a distinct status shown in the UI, the README and the ZIP.
* The UI tags controls whose in-game behaviour differs (`FidelityTag`) and labels the 3D view “Preview ≠ GTA V”.
