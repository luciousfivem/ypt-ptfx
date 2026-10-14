# YPT / PTFX format research (verified against CodeWalker source)

Source examined: `dexyfex/CodeWalker` @ `485d56b` (`CodeWalker.Core/GameFiles/Resources/Particle.cs`,
`Texture.cs`, `FileTypes/YptFile.cs`, `Utils/DDSIO.cs`). Everything in the "Verified" sections below was read
directly from that source. Anything marked **UNVERIFIED** could not be confirmed from source and must not be
presented to users as fact.

## Licensing constraint

CodeWalker is published under the GPL (`Notice.txt`), with MIT-licensed sub-components (Neodymium). VFXForge therefore:

* does **not** vendor, copy or statically link CodeWalker code;
* implements the `.ypt.xml` writer/reader independently, as an implementation of a *file format*;
* ships `tools/ypt-bridge` as source only. It is compiled **locally by the user** against their own CodeWalker
  checkout (`-p:CodeWalkerCoreDir=...`) and is invoked as a separate process.

## Verified: container structure

`.ypt.xml` root is `<ParticleEffectsList>` with, in this order:

```
Name
EffectRuleDictionary    -> <Item> ParticleEffectRule ...
EmitterRuleDictionary   -> <Item> ParticleEmitterRule ...
ParticleRuleDictionary  -> <Item> ParticleRule ...
DrawableDictionary      (optional)
TextureDictionary       -> <Item> Texture ...   (DDS files live next to the XML)
```

Cross references are **by name** and resolved through Jenkins hashes (`JenkHash.GenHash`):

* `ParticleEventEmitter.ParticleRuleName`  -> `ParticleRule.Name`
* `ParticleEventEmitter.EmitterRuleName`   -> `ParticleEmitterRule.Name`
* `ParticleEffectSpawner.EffectRuleName`   -> `ParticleEffectRule.Name`

A dangling reference does not throw inside CodeWalker (the `else if (hash != 0) { }` branches are empty), so a
dangling reference would be written silently: VFXForge's validator must catch these itself.

Binary save: `YptFile.Save()` -> `ResourceBuilder.Build(PtfxList, version, true, gen9)` where version is **68**
(legacy) or **71** (gen9 / Enhanced). The two versions are selected by the static `RpfManager.IsGen9`.

## Verified: flipbook animation

Frame addressing is carried by:

* `ParticleRule.TexFrameIDMin` / `TexFrameIDMax` (uint)
* `ptxu_AnimateTexture` behaviour: `AnimRateKFP` (keyframe prop `ptxu_AnimateTexture:m_animRateKFP`),
  `KeyframeMode`, `LastFrameID`, `LoopMode`, `IsRandomised`, `IsScaledOverParticleLife`, `IsHeldOnLastFrame`,
  `DoFrameBlending`
* `ptxd_Sprite` behaviour: `AlignmentMode`, `UVClip`, flip chances, clip distances

How a *frame id* maps to a UV rectangle inside the atlas is **not** defined in CodeWalker. The user's brief names
`ptxclipregions.dat`; CodeWalker contains **zero** references to it (`grep -ri clipregion` -> no hits). Therefore:

* **UNVERIFIED:** the format of `ptxclipregions.dat`, whether custom texture names can be registered in it from a
  FiveM resource, and whether arbitrary atlas grids animate in-game without it.
* VFXForge's Flipbook Compatibility Validator reports this as a *warning with "cannot verify"*, never as a pass.
* The only in-engine verification available is the FiveM test checklist in `docs/FIVEM_TEST_CHECKLIST.md`.

## Verified: textures

Texture `<Item>`: `Name`, `Unk32`, `Usage`, `UsageFlags`, `ExtraFlags`, `Width`, `Height`, `MipLevels`, `Format`,
`FileName` (`<name>.dds`). On `XmlYpt.GetYpt(xml, folder)` the DDS is read from `folder` and a missing file throws
`Texture file not found`.

`DDSIO.GetTexture` accepts these DXGI formats: BC1, BC2, BC3, BC4, BC5, BC7, B5G5R5A1, A8, R8G8B8A8, R8,
B8G8R8A8, B8G8R8X8. VFXForge's DDS encoder emits **BC3 (DXT5)**, **BC1 (DXT1)** and **B8G8R8A8** and its validator
rejects anything else. Cubemaps without all 6 faces and 1D/3D textures are rejected by CodeWalker.

`TextureFormat` enum: A8R8G8B8=21, X8R8G8B8=22, A1R5G5B5=25, A8=28, A8B8G8R8=32, L8=50,
DXT1=0x31545844, DXT3=0x33545844, DXT5=0x35545844, ATI1/ATI2, BC7=0x20374342.

## Verified: keyframe properties

`<Item>` (KeyframeProp): `Name` (string; a known name or a hash), `InvertBiasLink`, `RandomIndex`,
`Keyframes` -> items with `<KeyframeTime x y z w/>` and `<KeyframeValue x y z w/>`.
Known names are listed in `ParticleKeyframeProp.GetName` (e.g. `ptxu_Colour:m_rgbaMinKFP`).

Fixed-size slots in the binary layout (enforced by the XML reader):

* `ParticleEffectRule.KeyframeProps`: 5 meaningful slots (colourTintMin/Max, zoomScalar, dataSphere, dataCapsule), capacity 16
* `ParticleEffectRule.EventEmitters`: capacity 32
* `ParticleEmitterRule.KeyframeProps`: exactly 10 slots
* `ParticleDomain`: 4 KFPs (position, rotation, sizeOuter, sizeInner)

## Open items (tracked in docs/STATUS.md)

* Which shader/technique/blend values a *from-scratch* `ParticleRule` needs to render in the game renderer.
  CodeWalker round-trips them but does not document semantics. VFXForge therefore offers a **donor-template**
  workflow (clone a rule from the user's own exported YPT XML) in addition to from-scratch generation.
* Gen9 (Enhanced) specifics beyond `EnsureGen9()`.
