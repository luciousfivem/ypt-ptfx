# Status: what works, what is verified, what is not

This page is deliberately blunt. “Verified” means an automated test or a command run during development
exercised it with the **real tool** (FFmpeg, CodeWalker, `luac`, Chromium, WebKitGTK) — not a mock — unless
stated. Nothing here was run inside GTA V or FiveM, because that cannot be done from the build environment.

## Test inventory (all passing at the time of writing)

| Suite | Count | What it exercises |
|---|---|---|
| TypeScript unit/integration (vitest) | 358 (+1 opt-in generator) | core 34 · media 57 · ypt 55 · fivem 48 · export 49 · particles 73 · desktop 42 |
| Rust (`cargo test --workspace`) | 82 | native 55 unit · FFmpeg integration 13 · CodeWalker converter integration 4 · Tauri IPC 10 |
| UI end-to-end (Playwright, Chromium, WebGL via SwiftShader) | 17 | boot, presets, undo, import (real WebM), content-sniffing rejection, drag & drop, GLB import, persistence, crash recovery, export ZIP, shortcuts |
| Typecheck | all 7 TS projects + `cargo clippy` clean | |

Commands: see [`DEVELOPMENT.md`](DEVELOPMENT.md).

## Verified (with real tools)

| Area | Evidence |
|---|---|
| Media → spritesheet | Exact-pixel tests for black/white/chroma keying, premultiplied resampling, atlas placement; a real H.264 MP4 and VP9 WebM go through FFmpeg/`<video>` into a keyed atlas |
| DDS | BC1/BC3/BGRA8 encode → decode with PSNR bounds; validator rejects short/oversized/odd-header files; CodeWalker-style tight mip tail accepted with a warning |
| `.ypt.xml` | Structural validator; CodeWalker **oracle**: XML → binary → CodeWalker re-reads → normalised-XML diff; a deliberately wrong XML **must fail** (negative control) |
| Binary `.ypt` | Produced by `CodeWalker.Core` 1.0.0.0 on .NET 8 for **legacy (RSC7 v68)** and **gen9 (v71)**; read back and compared with the XML. All **30 presets** export through it |
| Lua | `luac 5.4 -p` syntax; behavioural harness with a mocked FiveM runtime (21 scenarios: no duplicate loops, cleanup on switch/death/restart, rate limit, asset-load failure retry, sync validation, injection attempts); **mutation testing**: 9 injected bugs, all caught |
| Particle simulation | Exact integration of constant acceleration + linear drag matches the analytic solution; deterministic by seed; flipbook frame selection; live edits re-simulate to the same state as a fresh run |
| FFmpeg handling | Frame count/order/content exact on a lossless fixture; time window, frame cap, skip, resize/aspect, blend interpolation, progress events; GIF and WebM through forced demuxers; corrupt/hostile inputs; concurrent extractions; cancel and timeout kill the whole process tree (regression test for a grandchild holding the pipes). A VP9 WebM with an alpha channel keeps its transparency (probe + extracted PNG alpha checked) |
| Desktop shell | The **real release binary** (embedded frontend, production CSP, WebKitGTK) was launched under Xvfb and driven with xdotool (`apps/desktop/scripts/desktop-smoke.sh`): preset → sheet built in the worker → Export → **“Export complete … CodeWalker 1.0.0.0 loaded the binary YPT (RSC7 v68) and its structure matched the XML”** ([screenshot](screenshots/desktop-export-complete.png)). A `.deb` bundle (5.3 MiB) builds. 10 IPC tests drive the actual command table (camelCase args, raw bodies, errors, FFmpeg extraction through a channel, CodeWalker conversion); the VFXW wire format is byte-identical in Rust and TypeScript |
| UI | 17 Chromium end-to-end tests; no test is allowed to log a console error |
| Safety | Hostile inputs: path traversal, `//` and UNC paths, Lua/XML injection, XXE/DTD, tampered bundles (hash/format), text files named `.png`, oversize/hostile wire lengths |

## Not verified — and why

| Item | Status |
|---|---|
| **Effects rendering in GTA V / FiveM** | **Unverified.** Several engine-level values are inferred from CodeWalker field names (shader/render-state names, blend-set enums, key-frame semantics, units) and are labelled `inferred`/`unverified` in the fidelity report. Use the donor-template strategy and [`FIVEM_TEST_CHECKLIST.md`](FIVEM_TEST_CHECKLIST.md) |
| **Flipbook frame → UV mapping in the engine** | **Unverifiable offline.** The brief names `ptxclipregions.dat`; CodeWalker has no reference to it, so its format cannot be read, written or checked here. VFXForge writes frame ids and animate-texture settings and reports *structural* validity only (`engineVerified` is always `false`) |
| Legacy vs Enhanced in-game | The Enhanced (gen9) binary is produced and read back by CodeWalker; how the Enhanced game consumes it is untested |
| Windows | The Windows installer targets (NSIS/MSI) are configured but **not built** here (Linux container); the Windows branch of process-tree kill (`taskkill /T`) is written but only the Unix path is tested; WebView2 not exercised (Chromium is the closest tested engine) |
| macOS | Not built or tested |
| Preview fidelity/performance | The WebGL preview is an approximation (additive/alpha blending, bloom, billboards) and not GTA V's renderer. Frame rates were only measured with **software** GL (≈10–35 fps at reduced resolution); real GPUs should be much faster but this was not measured |
| Linux WebKitGTK rendering | One software-GL screenshot showed a stray dark shape in the viewport that Chromium did not; believed to be a llvmpipe/bloom artefact, not investigated further |
| `resmon` cost of the Lua | Designed to be ~0 ms when unarmed (slow poll, fast loop only while a tracked weapon is held) and tested with a mock; **not measured in game** |
| Code signing, notarisation, auto-update | Not configured (need your certificates/server) |

## Known limitations (by design)

* The preview can show things a YPT cannot carry: **trails**, **attractor**, **drift**, **speed-over-life**, glow ≤ 1,
  max-particle caps, frame blending. They are tagged in the UI and listed as *not exported / preview-only* in the report.
* **Bursts** repeat only through script triggers (a YPT effect has one burst window); a repeating burst is exported as
  one burst per trigger and flagged.
* **Cone** emission is approximated (GTA has no cone domain); **drag** and **turbulence** are approximated;
  multi-axis rotations assume an Euler order (single-axis rotations are exact) — all flagged.
* **FBX** import is experimental, **OBJ** loads geometry only, glTF with external files is refused (use GLB).
* WebP animations are decoded by the web engine (FFmpeg has no WebP demuxer here); frame interpolation needs FFmpeg.
* Sprite sheets are limited to what the atlas builder can lay out (grid ≤ 64×64, texture ≤ 8192², power-of-two is
  *warned about*, not forced).
* In browser mode there is no converter: only **source-only** packages (clearly labelled) can be exported.

## Brief checklist

| Requirement | State |
|---|---|
| Import image/GIF/MP4/WebM/WebP, extraction controls, keying (black/white/chroma), colour, crop, reverse/ping-pong | ✔ |
| Spritesheet generator (grid, padding, extrude, trim, PNG + DDS), procedural single-image animation | ✔ |
| Layered editing (clip recipe + emitter layers, frame list with hold/duplicate/delete/reorder) | ✔ |
| Particle editor with curves + gradients, 30 presets in 6 categories | ✔ |
| 3D weapon preview, model import, attachment gizmos, event simulation, environments | ✔ (model import: GLB/glTF/OBJ; FBX experimental) |
| Flipbook Compatibility Validator | ✔ (structural; never claims engine compatibility) |
| Validated `.ypt.xml` + binary `.ypt` with round-trip + FiveM resource/ZIP/Lua | ✔ (binary needs the CodeWalker bridge) |
| Multi-effect, before/after, cost estimates, undo/redo, autosave/recovery, project bundles, drag & drop, preset sharing, shortcuts, light/dark | ✔ |
| Workers, cancellable jobs, security hardening, atomic saves | ✔ |
| Windows installer | configured, **not built here** |
| “The exported effect loads and displays inside the game” | **Not demonstrated** — requires your in-game test |
