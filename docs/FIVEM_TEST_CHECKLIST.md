# In-game test checklist

VFXForge can verify a great deal offline — XML schema, DDS validity, CodeWalker's ability to re-read the binary,
Lua syntax and behaviour against a mocked FiveM runtime — but it **cannot start GTA V**. The questions below can
only be answered in the game. Please work through them on a development server before shipping an effect, and
record the result: the answers decide which of VFXForge's *inferred* values are correct.

> Use a test server and a throwaway character. Keep the F8 console open.

## 0. Prepare

1. Export from VFXForge (**Export → Build export**), unzip into `resources/`, add `ensure <resource_name>`.
2. In `config.lua` set `Config.Debug = true` for the first run.
3. Note your build: FiveM client build number, **Legacy or Enhanced**, and whether OneSync is enabled.

## 1. Resource and asset loading

| # | Test | Expected | If it fails |
|---|---|---|---|
| 1.1 | `ensure` the resource | no red errors; “particle asset … loaded” in F8 (debug) | `could not load particle asset`: the `.ypt` is missing from `stream/`, has the wrong name (must equal `Config.Asset`), or is not valid for your game build |
| 1.2 | `refresh` then `restart <resource>` twice | still loads; no orphan effects | note the console output |
| 1.3 | Server console on start | no stream/“failed to load” lines | copy the line, it names the file |

## 2. Does it render?

| # | Test | Expected |
|---|---|---|
| 2.1 | `/vfxtest` (or your `Config.TestCommand`) while holding a configured weapon | each effect appears once |
| 2.2 | Same, unarmed | effects play on the ped (documented fallback) |
| 2.3 | Fire the weapon | the *fired* effects appear at the muzzle offset |
| 2.4 | Reload / switch / holster | *reloaded*, *switched*, *equipped* effects as configured; looped effects stop on holster |

If **nothing** appears in 2.1: screenshot F8 and report. The most likely causes are a shader/render-state value we
inferred wrongly — try the **donor-template** strategy next.

## 3. Flipbook (the part we can only guess)

The brief for this tool says frames are mapped through the game's clip-region data. VFXForge writes frame ids
(`TexFrameIDMin/Max`) and the animate-texture behaviour; **whether those ids select the cells of *your* atlas is
unverified**.

| # | Observation | What it tells us |
|---|---|---|
| 3.1 | The effect animates through distinct frames | ids map to the atlas cells as laid out (row-major) ✔ |
| 3.2 | Static, but a *single* cell | the animate behaviour ran with one frame: frame range or fps not honoured |
| 3.3 | The **whole sheet** is drawn on one sprite | the texture has no clip regions for this name: use a donor whose texture is registered, or add the regions |
| 3.4 | Wrong order / wrong cells | note the grid (e.g. 4×4) and which cells showed — column-major vs row-major, or the origin corner |

Please record: texture name, grid, what you saw, build number. A photo/GIF is perfect.

## 4. Lifecycle and cleanliness (what the Lua is designed to guarantee)

- [ ] Hold a looped (idle) effect, switch weapon: it stops **immediately**.
- [ ] Die and respawn while a looped effect runs: no stuck effect.
- [ ] Full-auto burst for 10 s: no console spam, no frame-time spike (`/vfxtest` at 60 fps vs yours).
- [ ] `restart <resource>` repeatedly: no duplicated/orphaned particles.
- [ ] `resmon` shows the resource at (or very near) 0.00 ms when no tracked weapon is held. The script is designed
      to poll slowly (`Config.IdlePollMs`) while unarmed and to run a fast loop only while a tracked weapon is
      selected; it was tested for that behaviour with a mocked runtime, **not measured in the game** — please
      report your resmon numbers.

## 5. Multiplayer (only if `Config.Sync.enabled`)

- [ ] A second player within the radius sees your effect; one beyond it does not.
- [ ] Spamming the event from a modified client is ignored (server logs a rate-limit message in debug).

## 6. Visual fidelity vs the preview

The 3D preview is a WebGL approximation. Compare: size, brightness/additive look, softness, speed. Differences are
expected; the fidelity report in the export lists what was *approximated* or *not exported*. Useful feedback:
“sprites are 2× larger than preview”, “glow looks flat”, etc.

## 7. Report

Open an issue (or note it for yourself) with:

```
Client build / Legacy|Enhanced / OneSync: …
Strategy: generate | donor        Target in VFXForge: legacy | enhanced
1.x  pass/fail + console text
2.x  pass/fail
3.x  observation (see table) + screenshot
4.x  checklist results
```

Until sections 1–3 pass on your server, treat the effect as **unverified in-game** — which is exactly how the
export dialog and the generated README label it.
