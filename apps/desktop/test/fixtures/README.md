# GLB fixtures from the .ydr converter

Golden outputs of `ydr2glb` (the CodeWalker bridge's `.ydr` -> `.glb` command), copied byte for byte from
`tools/ypt-bridge/fixtures/`. They were produced from small synthetic drawables, not from game files. The unit tests load them
through `loadModel`, and the Playwright suite imports one through the weapon model picker.

`ydr-bridge.test.ts` (run with `VFXFORGE_BRIDGE_DLL` set) converts the committed `.ydr` files with the real bridge and requires the
output to equal these copies, so a change to the converter that is not copied here fails loudly.

| file | what it is |
|---|---|
| `cube_pnct.glb` | 1 model, 1 geometry, 12 triangles; 1.0 x 0.5 x 2.0 m |
| `cube_pnct_gen9.glb` | the same mesh from a gen9 (RSC7 version 159) drawable; only the metadata differs |
| `multi_lod.glb` | high LOD of a drawable with 2 models and 3 geometries, 22 triangles, 1 geometry reversed, 1 converter warning |
| `multi_lod_med.glb` | the med LOD of the same drawable: 12 triangles |
| `bone_bound.glb` | 4 models placed by their bone transforms; one skinned; 48 triangles, 1 geometry reversed, 1 converter warning |
