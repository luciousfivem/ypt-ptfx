/**
 * YptModel -> `.ypt.xml` in CodeWalker's exact element order.
 * Every function below mirrors the corresponding `WriteXml` in CodeWalker's Particle.cs.
 */
import type {
  BehaviourModel,
  DomainModel,
  EffectRuleModel,
  EmitterRuleModel,
  EventEmitterModel,
  Kfp,
  ParticleRuleModel,
  ShaderVarModel,
  SpawnerModel,
  TextureModel,
  YptModel,
} from './model';
import { XmlWriter, fmt } from './xml';

/** Writes a keyframe-prop body (the part inside an <Item> or a *KFP element). */
function writeKfpBody(w: XmlWriter, k: Kfp): void {
  w.string('Name', k.name);
  w.value('InvertBiasLink', k.invertBiasLink);
  w.value('RandomIndex', k.randomIndex);
  writeItemList(w, 'Keyframes', k.keys, (e) => {
    w.vec('KeyframeTime', [e.time, e.time, e.time, e.time]);
    w.vec('KeyframeValue', e.value);
  });
}

function writeItemList<T>(w: XmlWriter, name: string, items: readonly T[], body: (t: T) => void): void {
  if (items.length === 0) {
    w.selfClosing(name);
    return;
  }
  w.open(name);
  for (const it of items) {
    w.open('Item');
    body(it);
    w.close('Item');
  }
  w.close(name);
}

function writeKfpElement(w: XmlWriter, tag: string, k: Kfp): void {
  w.open(tag);
  writeKfpBody(w, k);
  w.close(tag);
}

function writeBehaviour(w: XmlWriter, b: BehaviourModel): void {
  w.value('Type', b.type);
  switch (b.type) {
    case 'Age':
    case 'Velocity':
      return;
    case 'Acceleration':
      w.value('ReferenceSpace', b.referenceSpace);
      w.value('IsAffectedByZoom', b.isAffectedByZoom);
      w.value('EnableGravity', b.enableGravity);
      writeKfpElement(w, 'XYZMinKFP', b.xyzMin);
      writeKfpElement(w, 'XYZMaxKFP', b.xyzMax);
      return;
    case 'Rotation':
      w.value('InitRotationMode', b.initRotationMode);
      w.value('UpdateRotationMode', b.updateRotationMode);
      w.value('AccumulateAngle', b.accumulateAngle);
      w.value('RotateAngleAxes', b.rotateAngleAxes);
      w.value('RotateInitAngleAxes', b.rotateInitAngleAxes);
      w.value('SpeedFadeThreshold', fmt(b.speedFadeThreshold));
      writeKfpElement(w, 'InitialAngleMinKFP', b.initialAngleMin);
      writeKfpElement(w, 'InitialAngleMaxKFP', b.initialAngleMax);
      writeKfpElement(w, 'AngleMinKFP', b.angleMin);
      writeKfpElement(w, 'AngleMaxKFP', b.angleMax);
      return;
    case 'Size':
      w.value('KeyframeMode', b.keyframeMode);
      w.value('IsProportional', b.isProportional);
      writeKfpElement(w, 'WhdMinKFP', b.whdMin);
      writeKfpElement(w, 'WhdMaxKFP', b.whdMax);
      writeKfpElement(w, 'TblrScalarKFP', b.tblrScalar);
      writeKfpElement(w, 'TblrVelScalarKFP', b.tblrVelScalar);
      return;
    case 'Dampening':
      w.value('ReferenceSpace', b.referenceSpace);
      w.value('EnableAirResistance', b.enableAirResistance);
      writeKfpElement(w, 'XYZMinKFP', b.xyzMin);
      writeKfpElement(w, 'XYZMaxKFP', b.xyzMax);
      return;
    case 'Colour':
      w.value('KeyframeMode', b.keyframeMode);
      w.value('RGBAMaxEnable', b.rgbaMaxEnable);
      w.value('RGBAProportional', b.rgbaProportional);
      w.value('RGBCanTint', b.rgbCanTint);
      writeKfpElement(w, 'RGBAMinKFP', b.rgbaMin);
      writeKfpElement(w, 'RGBAMaxKFP', b.rgbaMax);
      writeKfpElement(w, 'EmissiveIntensityKFP', b.emissiveIntensity);
      return;
    case 'Noise':
      w.value('ReferenceSpace', b.referenceSpace);
      w.value('KeepConstantSpeed', b.keepConstantSpeed);
      writeKfpElement(w, 'PosNoiseMinKFP', b.posNoiseMin);
      writeKfpElement(w, 'PosNoiseMaxKFP', b.posNoiseMax);
      writeKfpElement(w, 'VelNoiseMinKFP', b.velNoiseMin);
      writeKfpElement(w, 'VelNoiseMaxKFP', b.velNoiseMax);
      return;
    case 'AnimateTexture':
      w.value('KeyframeMode', b.keyframeMode);
      w.value('LastFrameID', b.lastFrameId);
      w.value('LoopMode', b.loopMode);
      w.value('IsRandomised', b.isRandomised);
      w.value('IsScaledOverParticleLife', b.isScaledOverParticleLife);
      w.value('IsHeldOnLastFrame', b.isHeldOnLastFrame);
      w.value('DoFrameBlending', b.doFrameBlending);
      writeKfpElement(w, 'AnimRateKFP', b.animRate);
      return;
    case 'Sprite':
      w.vec('AlignAxis', b.alignAxis);
      w.value('AlignmentMode', b.alignmentMode);
      w.value('FlipChanceU', fmt(b.flipChanceU));
      w.value('FlipChanceV', fmt(b.flipChanceV));
      w.value('NearClipDist', fmt(b.nearClipDist));
      w.value('FarClipDist', fmt(b.farClipDist));
      w.value('ProjectionDepth', fmt(b.projectionDepth));
      w.value('ShadowCastIntensity', fmt(b.shadowCastIntensity));
      w.value('IsScreenSpace', b.isScreenSpace);
      w.value('IsHighRes', b.isHighRes);
      w.value('NearClip', b.nearClip);
      w.value('FarClip', b.farClip);
      w.value('UVClip', b.uvClip);
      w.value('DisableDraw', b.disableDraw);
      return;
  }
}

function writeSpawner(w: XmlWriter, s: SpawnerModel): void {
  w.string('EffectRule', s.effectRule);
  w.value('DurationScalarMin', fmt(s.durationScalarMin));
  w.value('PlaybackRateScalarMin', fmt(s.playbackRateScalarMin));
  w.value('ColourTintScalarMin', hex(s.colourTintScalarMin));
  w.value('ZoomScalarMin', fmt(s.zoomScalarMin));
  w.value('FlagsMin', s.flagsMin);
  w.value('DurationScalarMax', fmt(s.durationScalarMax));
  w.value('PlaybackRateScalarMax', fmt(s.playbackRateScalarMax));
  w.value('ColourTintScalarMax', hex(s.colourTintScalarMax));
  w.value('ZoomScalarMax', fmt(s.zoomScalarMax));
  w.value('FlagsMax', s.flagsMax);
  w.value('TriggerInfo', fmt(s.triggerInfo));
  w.value('InheritsPointLife', s.inheritsPointLife);
  w.value('TracksPointPos', s.tracksPointPos);
  w.value('TracksPointDir', s.tracksPointDir);
  w.value('TracksPointNegDir', s.tracksPointNegDir);
}

/** CodeWalker prints uint tint values as 0xHEX (YptXml.UintString). */
function hex(n: number): string {
  return '0x' + (n >>> 0).toString(16).toUpperCase();
}

function writeShaderVar(w: XmlWriter, v: ShaderVarModel): void {
  w.value('Type', 'Texture');
  w.string('Name', v.name);
  w.value('ShaderVarID', v.shaderVarId);
  w.value('IsKeyframeable', v.isKeyframeable);
  w.value('ExternalReference', v.externalReference);
  w.string('TextureName', v.textureName);
}

function writeParticleRule(w: XmlWriter, r: ParticleRuleModel): void {
  w.string('Name', r.name);
  w.value('RefCount', r.refCount);
  w.string('ShaderFile', r.shaderFile);
  w.string('ShaderTechnique', r.shaderTechnique);
  w.value('CullMode', r.cullMode);
  w.value('BlendSet', r.blendSet);
  w.value('LightingMode', r.lightingMode);
  w.value('DepthWrite', r.depthWrite);
  w.value('DepthTest', r.depthTest);
  w.value('AlphaBlend', r.alphaBlend);
  w.value('TexFrameIDMin', r.texFrameIdMin);
  w.value('TexFrameIDMax', r.texFrameIdMax);
  w.value('ShaderTemplateTechniqueID', r.shaderTemplateTechniqueId);
  w.value('DiffuseMode', r.diffuseMode);
  w.value('ProjectionMode', r.projectionMode);
  w.value('IsLit', r.isLit);
  w.value('IsSoft', r.isSoft);
  w.value('IsScreenSpace', r.isScreenSpace);
  w.value('IsRefract', r.isRefract);
  w.value('IsNormalSpec', r.isNormalSpec);
  w.value('SortType', r.sortType);
  w.value('DrawType', r.drawType);
  w.value('Flags', r.flags);
  w.value('RuntimeFlags', r.runtimeFlags);
  w.open('EffectSpawnerAtRatio');
  writeSpawner(w, r.effectSpawnerAtRatio);
  w.close('EffectSpawnerAtRatio');
  w.open('EffectSpawnerOnCollision');
  writeSpawner(w, r.effectSpawnerOnCollision);
  w.close('EffectSpawnerOnCollision');
  if (r.behaviours.length > 0) writeItemList(w, 'AllBehaviours', r.behaviours, (b) => writeBehaviour(w, b));
  if (r.shaderVars.length > 0) writeItemList(w, 'ShaderVars', r.shaderVars, (v) => writeShaderVar(w, v));
}

function writeDomain(w: XmlWriter, tag: string, d: DomainModel): void {
  w.open(tag);
  w.value('DomainType', d.type);
  w.value('IsWorldSpace', d.isWorldSpace);
  w.value('IsPointRelative', d.isPointRelative);
  w.value('IsCreationRelative', d.isCreationRelative);
  w.value('IsTargetRelatve', d.isTargetRelative); // sic: CodeWalker's spelling
  w.value('FileVersion', fmt(d.fileVersion));
  writeKfpElement(w, 'PositionKFP', d.position);
  writeKfpElement(w, 'RotationKFP', d.rotation);
  writeKfpElement(w, 'SizeOuterKFP', d.sizeOuter);
  writeKfpElement(w, 'SizeInnerKFP', d.sizeInner);
  w.close(tag);
}

function writeEmitterRule(w: XmlWriter, r: EmitterRuleModel): void {
  w.string('Name', r.name);
  w.value('RefCount', r.refCount);
  w.value('IsOneShot', r.isOneShot);
  writeDomain(w, 'CreationDomainObj', r.creation);
  writeDomain(w, 'TargetDomainObj', r.target);
  writeDomain(w, 'AttractorDomainObj', r.attractor);
  writeItemList(w, 'KeyframeProps', r.keyframeProps, (k) => writeKfpBody(w, k));
}

function writeEventEmitter(w: XmlWriter, e: EventEmitterModel): void {
  w.string('EmitterRule', e.emitterRule);
  w.string('ParticleRule', e.particleRule);
  w.value('EventType', e.eventType);
  w.value('StartRatio', fmt(e.startRatio));
  w.value('EndRatio', fmt(e.endRatio));
  w.value('PlaybackRateScalarMin', fmt(e.playbackRateScalarMin));
  w.value('PlaybackRateScalarMax', fmt(e.playbackRateScalarMax));
  w.value('ZoomScalarMin', fmt(e.zoomScalarMin));
  w.value('ZoomScalarMax', fmt(e.zoomScalarMax));
  w.value('ColourTintMin', hex(e.colourTintMin));
  w.value('ColourTintMax', hex(e.colourTintMax));
}

function writeEffectRule(w: XmlWriter, r: EffectRuleModel): void {
  w.string('Name', r.name);
  w.value('RefCount', r.refCount);
  w.value('FileVersion', fmt(r.fileVersion));
  w.value('NumLoops', hex(r.numLoops));
  w.value('SortEventsByDistance', fmt(r.sortEventsByDistance));
  w.value('DrawListID', fmt(r.drawListId));
  w.value('IsShortLived', fmt(r.isShortLived));
  w.value('HasNoShadows', fmt(r.hasNoShadows));
  w.vec('VRandomOffsetPos', r.vRandomOffsetPos);
  w.value('PreUpdateTime', fmt(r.preUpdateTime));
  w.value('PreUpdateTimeInterval', fmt(r.preUpdateTimeInterval));
  w.value('DurationMin', fmt(r.durationMin));
  w.value('DurationMax', fmt(r.durationMax));
  w.value('PlaybackRateScalarMin', fmt(r.playbackRateScalarMin));
  w.value('PlaybackRateScalarMax', fmt(r.playbackRateScalarMax));
  w.value('ViewportCullingMode', fmt(r.viewportCullingMode));
  w.value('RenderWhenViewportCulled', fmt(r.renderWhenViewportCulled));
  w.value('UpdateWhenViewportCulled', fmt(r.updateWhenViewportCulled));
  w.value('EmitWhenViewportCulled', fmt(r.emitWhenViewportCulled));
  w.value('DistanceCullingMode', fmt(r.distanceCullingMode));
  w.value('RenderWhenDistanceCulled', fmt(r.renderWhenDistanceCulled));
  w.value('UpdateWhenDistanceCulled', fmt(r.updateWhenDistanceCulled));
  w.value('EmitWhenDistanceCulled', fmt(r.emitWhenDistanceCulled));
  w.vec('ViewportCullingSphereOffset', r.viewportCullingSphereOffset);
  w.value('ViewportCullingSphereRadius', fmt(r.viewportCullingSphereRadius));
  w.value('DistanceCullingFadeDist', fmt(r.distanceCullingFadeDist));
  w.value('DistanceCullingCullDist', fmt(r.distanceCullingCullDist));
  w.value('LodEvoDistanceMin', fmt(r.lodEvoDistanceMin));
  w.value('LodEvoDistanceMax', fmt(r.lodEvoDistanceMax));
  w.value('CollisionRange', fmt(r.collisionRange));
  w.value('CollisionProbeDistance', fmt(r.collisionProbeDistance));
  w.value('CollisionType', fmt(r.collisionType));
  w.value('ShareEntityCollisions', fmt(r.shareEntityCollisions));
  w.value('OnlyUseBVHCollisions', fmt(r.onlyUseBvhCollisions));
  w.value('GameFlags', fmt(r.gameFlags));
  w.value('ColourTintMaxEnable', fmt(r.colourTintMaxEnable));
  w.value('UseDataVolume', fmt(r.useDataVolume));
  w.value('DataVolumeType', fmt(r.dataVolumeType));
  w.value('ZoomLevel', fmt(r.zoomLevel));
  writeItemList(w, 'EventEmitters', r.eventEmitters, (e) => writeEventEmitter(w, e));
  writeItemList(w, 'KeyframeProps', r.keyframeProps, (k) => writeKfpBody(w, k));
}

function writeTexture(w: XmlWriter, t: TextureModel): void {
  w.string('Name', t.name);
  w.value('Unk32', t.unk32);
  w.string('Usage', t.usage);
  w.string('UsageFlags', t.usageFlags);
  w.value('ExtraFlags', t.extraFlags);
  w.value('Width', t.width);
  w.value('Height', t.height);
  w.value('MipLevels', t.mipLevels);
  w.string('Format', t.format);
  w.string('FileName', t.fileName);
}

/** Sorted like CodeWalker's dictionaries (ordinal by name) so output is deterministic. */
const byName = <T extends { name: string }>(a: T, b: T) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export function writeYptXml(model: YptModel): string {
  const w = new XmlWriter();
  w.open('ParticleEffectsList');
  w.string('Name', model.name);

  w.open('EffectRuleDictionary');
  for (const r of [...model.effects].sort(byName)) {
    w.open('Item');
    writeEffectRule(w, r);
    w.close('Item');
  }
  w.close('EffectRuleDictionary');

  w.open('EmitterRuleDictionary');
  for (const r of [...model.emitters].sort(byName)) {
    w.open('Item');
    writeEmitterRule(w, r);
    w.close('Item');
  }
  w.close('EmitterRuleDictionary');

  w.open('ParticleRuleDictionary');
  for (const r of [...model.particles].sort(byName)) {
    w.open('Item');
    writeParticleRule(w, r);
    w.close('Item');
  }
  w.close('ParticleRuleDictionary');

  if (model.textures.length === 0) {
    w.selfClosing('TextureDictionary');
  } else {
    w.open('TextureDictionary');
    for (const t of [...model.textures].sort(byName)) {
      w.open('Item');
      writeTexture(w, t);
      w.close('Item');
    }
    w.close('TextureDictionary');
  }
  w.close('ParticleEffectsList');
  return w.toString();
}
