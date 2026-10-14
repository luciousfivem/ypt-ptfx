# VFXForge user guide

VFXForge turns images and video into animated spritesheets, lets you build particle effects around them, previews
those effects on a weapon, and exports a **FiveM resource** (`.ypt` + textures + Lua).

![Particle editor](screenshots/particle-editor.png)

## The 5-minute path

1. **Pick a preset** (left panel → *Presets*), or **import** your own clip with *Import* (Ctrl+I) / drag & drop.
2. Look at it in the **3D preview**. Use *Fire*, *Reload*, *Equipped/Holstered* to see how it behaves with the weapon.
3. Tune it in the **Inspector** (right). Drag the attachment points (*Weapon* tab) to where the effect belongs.
4. **Export** → *Build export*. Read the report. Save the ZIP. Test it with
   [`FIVEM_TEST_CHECKLIST.md`](FIVEM_TEST_CHECKLIST.md).

## Workspaces

| Button (key) | What you work on |
|---|---|
| **Sprite Editor** (1) | Frames: extraction, background removal, colour, the atlas, per-frame holds/order, PNG/DDS output |
| **Particle Editor** (2) | Emitters: emission, shape, look, physics, flipbook, placement; curves and gradients |
| **Weapon Preview** (3) | The weapon: built-in stand-ins or your own GLB/glTF/OBJ/FBX (or a GTA V `.ydr` on the desktop app), attachment points with a move/rotate gizmo, environments |

Panels resize; the layout is remembered. Everything is undoable (Ctrl+Z / Ctrl+Shift+Z); dragging a slider or
typing repeatedly in one field is a single undo step. Work is autosaved to a recoverable snapshot — after a crash
VFXForge offers to recover it. *Save* (Ctrl+S) stores the project; *Save as bundle* makes one portable
`.vfxforge` file (project + media) for sharing or backup.

## From a video to a spritesheet

1. **Import** an MP4 / MOV / WebM / GIF / WebP / PNG / JPG. VFXForge identifies files by their **contents**, not
   their extension, and never modifies the original (it is stored by hash inside the project).
2. A clip and a spritesheet are created for you. In the **Clip** inspector:
   * *Frame extraction*: start/end, frame rate, skip, max frames, size (the preview is capped at 512 px for
     speed; the export uses exactly your settings).
   * *Background removal*: **Black** (ideal for fire/smoke/energy shot on black — the colour is un-premultiplied
     from brightness, so soft edges stay soft), **White**, **Chroma** (pick the key colour, tolerance, feather,
     despill) or **None**. Footage that already has transparency is left alone.
   * *Colour & glow*, *motion blur*, *auto-crop to content* (all frames are cropped by the same rectangle so they
     stay registered), *reverse / ping-pong / loop / speed*.
   * *Animate a single image*: turn one picture into an animation (pulse, fade, scale, rotate, scroll, flicker,
     colour-cycle, glow, shimmer, distort, duplicate). These frames are **authored**, not recovered motion.
3. In the **Sheet** inspector choose the grid (2×2 … 16×16), texture size (256–4096+; power-of-two is flagged if
   not), padding/extrude, fit, and the DDS format (**BC3** for soft alpha, BC1 for hard-edged, BGRA8 uncompressed).
   *Fit grid to N frames* picks a sensible square layout.
4. The **Flipbook compatibility** box tells you whether the layout is *structurally valid*. It will never say
   “compatible with the game” — see the in-game checklist for that.
5. Use *PNG* / *DDS* in the Sprite Editor header to save the sheet by itself.

## Building an effect

* One **effect** = one or more **emitters** (layers). Layers that share an attachment point, triggers and loop
  behaviour are exported into one effect rule automatically.
* **Triggers** decide when the script starts an emitter: *Equipped, Fired, Reloaded, Switched to, Idle (held),
  Manual*. A continuous + looping emitter becomes **one** looped instance that stops when the weapon is put away;
  everything else is a one-shot started per trigger (rate-limited).
* Controls tagged **preview only / approximated / not exported** are things the preview can show but the YPT
  cannot carry (or only approximately). The Export dialog's *fidelity report* lists every property's status and
  confidence.
* Presets are procedural (no copyrighted footage). **Share as preset…** writes a small `.vfxpreset.json` that only
  contains procedural clips; importing validates everything and regenerates ids.

## The weapon

* Built-in pistol / SMG / rifle / shotgun / sniper are **stand-ins** for scale and placement — not GTA V models.
* Import your own model for the preview: **GLB** (best), glTF with embedded data, OBJ (geometry only), FBX
  (experimental). Set the scale (1 unit = 1 m; *Auto-fit* helps) and orient it so the barrel points to −Z with +Y up
  (the *Orientation* menu converts from common conventions). The model is **never** put in the exported resource.
* **GTA V `.ydr` drawables** (desktop app only; needs the converter bridge, [`YPT_BRIDGE.md`](YPT_BRIDGE.md)): pick
  *GTA V drawable (ydr)* in the import dialog's file-type list, or drop the file on the window. VFXForge converts it to a
  GLB when you import it: the highest level of detail that has usable geometry, parts bound to skeleton bones placed at
  their rest pose, GTA's Z-up axes turned into the preview's Y-up, metres kept (Scale 1, Rotation 0 are set for you).
  It is **geometry only**: GTA textures and shaders are not converted, the model is shown in a neutral material, and
  skinned parts are shown unposed. The converter's notes appear under the model. Only the converted GLB is stored, so
  keep your `.ydr`. If the barrel does not point to −Z, use a *Y-up* Orientation (not the Z-up one: the axes are already
  converted).
* **Attachment points** carry the offset/rotation the Lua script uses at runtime (and an optional GTA bone name you
  type yourself — it cannot be validated outside the game).

## Exporting

*Export* (Ctrl+E) shows a pre-flight list, the cost estimate (rules of thumb, not GTA limits), options (test
command, rate limit, optional multiplayer relay) and then runs the pipeline:

`frames → spritesheets → flipbook check → effect→rule mapping → .ypt.xml + validation → binary .ypt (CodeWalker) → resource ZIP`

Any error stops the export and nothing is written (**blocked**). Without the converter you can opt into a
**source-only** package (`.ypt.xml` + `.dds` to convert with CodeWalker) — labelled as such everywhere. With the
converter the binary is re-read by CodeWalker and compared with the XML before it is accepted.

The ZIP contains `fxmanifest.lua`, `config.lua` (offsets, weapons, triggers, sync — editable without rebuilding the
`.ypt`), `client.lua`, optional `server.lua`, `stream/<asset>.ypt`, `source/` and a `README.md` with the effect table,
weapon hashes, fidelity report and in-game checklist.

## Keyboard shortcuts

Press **?** in the app. Highlights: Ctrl+S/O/N/I/E, Ctrl+Z / Ctrl+Shift+Z, Space (play/pause), F (fire), R (reload),
1/2/3 (workspaces), W/E (gizmo), Delete, Ctrl+D (duplicate emitter).

## Troubleshooting

| Symptom | Fix |
|---|---|
| “Video import needs FFmpeg” | Install FFmpeg and add it to PATH, or set it in Settings → Tools (desktop). The browser build uses the browser's decoders (WebM/MP4 where supported). |
| “Binary .ypt: converter unavailable” | Build the bridge — [`YPT_BRIDGE.md`](YPT_BRIDGE.md). |
| No “GTA V drawable (ydr)” in the import dialog | That is the browser build; `.ydr` import needs the desktop app. |
| “….ydr: … converter bridge is not configured” | Build the bridge and select its DLL in Settings → Tools; or export the model from your 3D tool as `.glb`. |
| “…this converter bridge is too old to convert .ydr drawables” | A bridge built before `.ydr` support: rebuild `tools/ypt-bridge` from this version and select the new DLL. |
| “…not a GTA V resource file” / “…no renderable geometry” | The file is not a drawable (for example a `.ydd`, `.yft` or `.ytd` renamed), or none of its geometry could be read; the message says which. |
| A part of a converted `.ydr` is missing or looks inside-out | Its winding could not be judged from normals; the model notes say which geometry. Export that model as `.glb` instead. |
| Preview is slow | Settings → Preview quality (Auto lowers resolution/bloom when the frame rate drops); disable bloom; reduce *Max particles*. |
| Atlas looks wrong after changing the grid | The grid must divide the texture exactly; check the red message in the Sheet inspector. |
| Nothing shows in game | [`FIVEM_TEST_CHECKLIST.md`](FIVEM_TEST_CHECKLIST.md) §1–3; try the donor-template strategy. |
