# ydr2glb fixtures

Small, synthetic GTA V drawables used to test the bridge's `ydr2glb` command (`.ydr` -> `.glb`). They contain **no
Rockstar data and no CodeWalker code**: the XML sources were written for this repository, and the binaries were produced
by `CodeWalker.Core`'s own writer through the bridge's developer helper `xml2ydr`.

| File | What it is |
|---|---|
| `*.ydr.xml` | Source of truth: CodeWalker drawable XML (the format `Drawable.WriteXml`/`ReadXml` use), authored by a throw-away script. Numbers are exact binary fractions (halves, quarters, eighths). |
| `*.ydr` | `xml2ydr` output (RSC7, deflate). `cube_pnct_gen9.ydr` was written with `--gen gen9`. |
| `*.glb` | Golden `ydr2glb` output. Byte-exact: the converter is deterministic. |
| `expected.json` | What the reply of `ydr2glb` must say for each case. The values come from an independent computation (below), not from the converter. |
| `check.mjs` | Runs every case against a built bridge and compares replies and bytes. |

```bash
dotnet build tools/ypt-bridge -c Release -p:CodeWalkerCoreDir=/path/to/CodeWalker.Core -o tools/ypt-bridge/out
node tools/ypt-bridge/fixtures/check.mjs                 # VFXFORGE_BRIDGE_DLL=... to use another build; skipped when absent
node tools/ypt-bridge/fixtures/check.mjs --regenerate    # rewrite the .ydr and .glb files from the XML
```

`check.mjs` converts the committed `.ydr`, and also a fresh `.ydr` made from the XML, and requires both to equal the
golden `.glb`. Regenerating the `.ydr` from the XML is only expected to be byte-identical on the same runtime (deflate output
may differ), which is why the `.ydr` bytes themselves are not compared.

CodeWalker's XML writer casts negative floats to `byte` when it packs `RGBA8SNorm` normals (`multi_lod`, `model_0` geometry 1); that
cast is CPU-dependent. The committed files were generated on x64 (Linux, .NET 8), the same behaviour as x64 Windows. On an
ARM64 host the "fresh from XML" half of the check can differ because of CodeWalker's writer, not because of the converter.

## Conventions the converter applies (what the fixtures prove)

* **Axes.** GTA is Z-up, +Y forward, right-handed, metres. glTF is Y-up, right-handed, metres. `(x, y, z) -> (x, z, -y)` for
  positions and normals. This is a rotation (determinant +1), so it does not change triangle winding. No scaling.
* **Winding.** Decided per geometry from its own vertex normals: the geometric normal of each triangle `(p1-p0) x (p2-p0)`
  is compared (area weighted) with the sum of the triangle's vertex normals; if they mostly disagree the geometry is stored
  clockwise relative to its normals and its indices are reversed, so glTF's counter-clockwise-front rule holds. The decision
  is made after bone placement, in the output axes. A geometry without usable normals follows the triangle-weighted
  majority of the geometries that have them, counted in *stored* order (and gets a warning); if none can be judged the
  stored order is assumed counter-clockwise. Either way its own bone placement is applied on top: a placement with a negative
  determinant (a mirror) reverses the triangles' orientation, so such a geometry is reversed (`mirror_no_normals`).
* **Bone placement** (rigid, non-skinned models): the bone's rest pose in model space, i.e. its local matrix composed with
  each ancestor's, child first: `M = Local(bone) * Local(parent) * ... * Local(root)`, where `Local` is the skeleton's stored
  matrix with its 4th column reset to (0,0,0,1); a vertex becomes `(x, y, z, 1) * M` (SharpDX row-vector convention,
  translation in `M41..M43`). This is where CodeWalker's model viewer draws such parts. Normals use the upper 3x3 and are renormalised, as the vertex shader
  does. Skinned models (`HasSkin != 0`) keep their bind pose (identity).
* **Output.** One scene, one node + mesh per `DrawableModel` (`model_<index of the model in its LOD>`), one primitive per
  geometry: `POSITION` (with min/max), `NORMAL` and `TEXCOORD_0` when present and decodable, `ushort` indices, one neutral
  PBR material, no textures. Khronos' validator reports `UNUSED_OBJECT` (info) for `TEXCOORD_0` because the material has no
  texture; the UVs are kept so a texture can be assigned later.

## The fixtures

### `cube_pnct` (A) - one model, one geometry, one outward box

`GTAV1` layout Position + Normal + Colour0 + TexCoord0, 24 vertices (4 per face, per-face normals and UVs), 12 triangles,
stored counter-clockwise seen from outside. GTA extents x [-0.5, 0.5], y [-0.25, 1.75], z [0.125, 0.625] become glTF
min `[-0.5, 0.125, -1.75]`, max `[0.5, 0.625, 0.25]` (asymmetric on purpose: a wrong axis or sign changes the bounds).
Expected: 1 model, 1 geometry, 24 vertices, 12 triangles, 0 flipped, no skeleton, `boneTransformsApplied: false`.
`cube_pnct_gen9.ydr` is the same XML written with `xml2ydr --gen gen9` (resource version 159) and converts to the same mesh.

### `multi_lod` (B) - LOD choice, mixed vertex layouts, winding

* High LOD, 2 models, 3 geometries, shaders `default` and `spec`:
  * `model_0` geometry 0: the cube (12 triangles, `GTAV1` PNCT), outward.
  * `model_0` geometry 1: an open box (faces +X, -X, +Z; 6 triangles; layout `GTAV2`: Normal as `RGBA8SNorm`, TexCoord0 as
    `Half2`) with **every triangle stored clockwise**. Expected: its indices are reversed (the one flip).
  * `model_1` geometry 0: two plates (+Z and -Z, 4 triangles) with **no normals** (layout Position + TexCoord0). Expected: it
    follows the other geometries (12 triangles stored counter-clockwise, 6 clockwise -> kept) and the reply carries a warning
    saying so.
* Med LOD: 1 model, 1 geometry (a cube, layout Position + Normal + TexCoord0).

`ydr2glb` default (`--lod auto`) picks `high`: 2 models, 3 geometries, 44 vertices, 22 triangles, 1 flipped, bounds
min `[-1.5, 0, -1.25]`, max `[1.5, 0.5, 0]`, `lodsAvailable: ["high", "med"]` (`multi_lod.glb`).
`--lod med` gives 1 model, 24 vertices, 12 triangles, 0 flipped (`multi_lod_med.glb`); `--lod low`/`vlow` fail with `no_geometry`.

### `bone_bound` (C) - skeleton placement

A 4-bone skeleton (the `TransformUnk` column 4 is deliberately non-zero on two bones, to prove it is reset):

| bone | parent | translation | rotation | scale |
|---|---|---|---|---|
| 0 `root` | - | 0 | identity | 1 |
| 1 `mount` | 0 | (0.25, 0.5, 0.125) | +90 deg about Z | 1 |
| 2 `muzzle` | 1 | (0, 1, 0.25) | +90 deg about X | 1 |
| 3 `mirror` | 0 | (0.5, 0, 0) | identity | (-1, 1, 1) |

Four models (24-vertex boxes): `model_0` bound to bone 0; `model_1` (box 0..0.5 x 0..0.25 x 0..0.125) bound to bone 2, so it
goes through two different rotations and translations; `model_2` is skinned (`HasSkin = 1`, layout with blend weights and
indices, bound to bone 1) and must **not** move; `model_3` bound to bone 3, whose negative scale mirrors it, so its triangles
change handedness and are reversed again (the one flip). Hand-worked example: the `model_1` corner (0.5, 0.25, 0.125) ->
bone 2 `(0.5, -0.125, 0.25) + (0, 1, 0.25) = (0.5, 0.875, 0.5)` -> bone 1 `(-0.875, 0.5, 0.5) + (0.25, 0.5, 0.125) = (-0.625, 1, 0.625)`
-> glTF `(-0.625, 0.625, -1)`, which is a vertex of `model_1`. Expected: 4 models, 96 vertices, 48 triangles, 1 flipped, bounds
min `[-0.75, 0, -1.25]`, max `[1.25, 1.25, 0.5]`, `hasSkeleton: true`, `boneTransformsApplied: true`, plus a warning that
`model_2` is exported in bind pose without skin weights.

### `mirror_no_normals` (E) - winding of a normal-less part on a mirrored bone

A 2-bone skeleton: `root` and `mirror` (parent root, translation (2, 0, 0), scale (-1, 1, 1)). `model_0` is the 24-vertex box
of `bone_bound` on the root (with normals, stored counter-clockwise outward). `model_1` is the same box **without normals**
(Position + TexCoord0) on the mirror bone, stored in the same order. The mirror turns its stored counter-clockwise triangles
clockwise, so although the drawable's convention is "keep", `model_1` must be reversed. Expected: 2 models, 48 vertices,
24 triangles, 1 flipped (`model_1`), bounds min `[-0.25, 0, -0.5]`, max `[2.25, 0.25, 0.5]`, and a warning naming the mirror.
Checked independently: every triangle of both boxes has its geometric normal pointing away from the box centre; with the
mirror's scale set to +1 the same drawable gives 0 flips and is still outward.

## How these were verified (all run in this repository's session, not assumed)

* An independent Node script (own GLB parser, own XML reader, own quaternion/axis/winding maths, and three.js
  `GLTFLoader.parse` on the same bytes) recomputed every position, normal, UV, index set, winding and bound from the numbers in
  the XML and compared them with the GLBs; it fails when a triangle is swapped or an axis sign is wrong (mutation-tested).
  The bone bounds were additionally recomputed with explicit 4x4 row-vector matrices.
* The Khronos glTF Validator (npm `gltf-validator` 2.0.0-dev.3.10) reports 0 errors and 0 warnings for every GLB here.
* Each GLB is byte-identical across repeated runs.

## Limits of these fixtures

They are synthetic and were written by CodeWalker's own writer; they prove the converter reads what CodeWalker writes, not
that it reads every real game file. No real `.ydr` from the game was available. Real files also carry skin weights, tangents,
second UV sets, vertex colours, embedded textures, shader parameters, bounds and lights; none of that is converted.
