# Development

## Layout

```
apps/desktop/            React + Vite UI, Tauri 2 shell (src-tauri), Playwright e2e
packages/core/           project model (zod), math, history, safety helpers, preset sharing
packages/media/          image pipeline: keying, adjust, atlas, PNG, DDS (BC1/BC3/BGRA8), content sniffing
packages/particles/      deterministic simulator, 30 presets with procedural art, weapon-event runtime
packages/ypt/            CodeWalker-compatible XML writer/validator, flipbook validator, donor patching
packages/fivem/          Lua templates + resource/ZIP generator (+ Lua behaviour harness)
packages/export/         the export orchestrator with hard gates; cost estimates
native/vfxforge-native/  Rust: FFmpeg probing/extraction, safe file I/O, project store, converter launcher
tools/ypt-bridge/        .NET bridge to your local CodeWalker.Core (GPL — never vendored)
docs/                    guides, research notes, screenshots
```

TypeScript packages are consumed from source (no build step). `native/` is a plain Rust library crate with **no
GUI dependency**; the Tauri crate is a thin command layer over it.

## Prerequisites

* Node 22+, **pnpm** 10, Rust stable (1.80+), FFmpeg/ffprobe on PATH (tests that need them are skipped with a
  reason when missing), optionally .NET 8 + a CodeWalker checkout for the converter tests.
* Linux desktop builds need the Tauri system libraries (`webkit2gtk-4.1`, `libsoup-3.0`, GTK 3 …); on Windows the
  WebView2 runtime ships with Windows 11.

## Everyday commands

```bash
pnpm install
pnpm typecheck                 # all packages
pnpm test                      # vitest: core, media, ypt, fivem, export, particles, desktop
cargo test --workspace         # Rust unit + integration (ffmpeg, bridge, .ydr import) + Tauri IPC tests
pnpm --filter @vfxforge/desktop dev      # the UI in a browser at http://127.0.0.1:1420 (browser platform)
pnpm --filter @vfxforge/desktop tauri dev  # the real desktop app
pnpm --filter @vfxforge/desktop exec playwright test   # UI end-to-end (Chromium)
node tools/ypt-bridge/fixtures/check.mjs              # ydr2glb fixtures against a built bridge (skips without it)
```

Optional environment: `VFXFORGE_BRIDGE_DLL` (converter oracle tests and the real-bridge `.ydr` tests in Rust and TypeScript),
`VFXFORGE_OLD_BRIDGE_DLL` (a pre-0.2.0 bridge, for the "too old" message test), `VFXFORGE_CLI` (Rust CLI path),
`VFXFORGE_KEEP_ARTIFACTS=1` (keep export artifacts for inspection), `VFXFORGE_CHROMIUM` (browser binary).

## Test strategy

| Layer | How it is verified |
|---|---|
| Media | exact pixel expectations (keying math, premultiplied resampling, atlas placement), DDS encode → decode PSNR, validator on hostile/short files |
| YPT | structural validation; **CodeWalker as an oracle** (binary round-trip, normalised-XML diff, negative control that must fail) |
| Lua | `luac -p` syntax + a behavioural harness with a mocked FiveM runtime (21 scenarios) and **mutation testing** (each injected bug must be caught) |
| Simulator | analytic physics (exact integration of constant acceleration + linear drag), determinism, flipbook frame selection |
| Export | acceptance test with real FFmpeg + real CodeWalker; all 30 presets; every gate (no converter, failed round-trip, throwing converter, invalid project, cancellation) |
| Rust | unit tests, hostile-input tests, real FFmpeg integration, real bridge integration (YPT and `.ydr`), process-tree cancellation; a `/bin/sh` stand-in for the bridge covers argument shape, reply handling, crashes and scratch cleanup without .NET |
| `.ydr` converter | synthetic drawables written by CodeWalker from XML authored here (`tools/ypt-bridge/fixtures`), golden GLBs, values from an independent computation, Khronos validator, hostile inputs (`check.mjs`) |
| Desktop | RPC/worker over `MessageChannel`, derived-state service, Tauri client against a fake core, cross-language wire-format bytes, Playwright e2e in Chromium (WebGL via SwiftShader) |

## Desktop smoke test (Linux)

`apps/desktop/scripts/desktop-smoke.sh` launches the release build under Xvfb and clicks through preset → export
(see the header of the script for the exact command). It is a manual check, not part of `pnpm test`.

## Packaging

```bash
pnpm --filter @vfxforge/desktop tauri build         # NSIS/MSI on Windows, deb/AppImage on Linux, dmg on macOS
```

Bundle targets are in `apps/desktop/src-tauri/tauri.conf.json`. FFmpeg is **not** bundled (licensing differs by
build); the app looks for `ffmpeg`/`ffprobe` in Settings → Tools, next to the executable (`bin/`), then `PATH`.
To ship them, place them in `apps/desktop/src-tauri/bin/` and add `bundle.resources`.

Windows signing, notarisation and auto-update are intentionally not configured here (they need your certificates
and update server).

## Windows CI (`.github/workflows/windows-build.yml`)

Runs on GitHub's `windows-latest` on every push to the development branch and on demand (Actions → *Windows build* →
*Run workflow*). Two jobs:

* **Installer** — `tauri build --bundles nsis,msi`; uploads the `VFXForge-windows-installer` artifact (NSIS setup,
  MSI, and `VFXForge-portable.exe`, the bare executable).
* **Tests** (non-blocking, reported separately) — FFmpeg via Chocolatey, `pnpm typecheck`, `cargo test` for the
  native crate (real FFmpeg) and the Tauri IPC tests, then `pnpm test`.

Windows-specific things this exposed and that are now handled:

* A bare `bin/` in `.gitignore` also hid `native/vfxforge-native/src/bin/` (the CLI source), so fresh clones did not
  build. The rule is now limited to build-output folders.
* Test fixtures must not use Unix-style absolute paths (`/tmp/x` has no drive letter, so it is *relative* on
  Windows). Use `std::env::temp_dir()` / `tempfile`.
* The Tauri mock-runtime tests must send requests from the webview's own origin (`http://tauri.localhost` on
  Windows, `tauri://localhost` elsewhere), otherwise the ACL treats them as a remote page and rejects every command.
* The Tauri unit-test executable needs a Common Controls v6 manifest to start; CI passes one through `RUSTFLAGS`
  (`apps/desktop/src-tauri/windows-test.manifest`). It must **not** go in `build.rs`: `rustc-link-arg-tests` is
  rejected for a package without an integration-test target and breaks the app build.

## Security notes

* Imported media/models/projects/bundles/preset packages are **untrusted**: validated by content, size-limited,
  paths confined to the project folder, bundle assets re-hashed, glTF external references blocked, XML parsed with
  DTD/entity expansion rejected.
* FFmpeg is started with arguments built only from validated numbers and absolute canonical paths, a forced
  demuxer and `-protocol_whitelist file`; processes are killed as a tree on cancel/timeout.
* The webview has no filesystem scope; it can only call the app's own commands (see `src-tauri/src/lib.rs`) and the
  native open/save dialogs. Project ids, asset paths, texture names and job ids are validated in Rust.
* Generated Lua escapes every string it embeds; injection attempts are part of the test-suite.
