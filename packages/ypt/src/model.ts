/**
 * Typed model of the parts of a GTA V `ParticleEffectsList` that VFXForge generates.
 *
 * Field names, order and types mirror CodeWalker's `WriteXml` implementations (verified
 * against the source — see docs/research/ypt-format.md). Values that CodeWalker only
 * round-trips and gives no meaning to are grouped in {@link ENGINE_DEFAULTS} and marked
 * UNVERIFIED: they are schema-valid, but whether the game renderer is happy with them
 * has to be confirmed in-game (docs/FIVEM_TEST_CHECKLIST.md).
 */

export type V3 = [number, number, number];
export type V4 = [number, number, number, number];

export interface KeyframeEntry {
  /** Normalised time. Serialised into all four lanes of `KeyframeTime` (inferred SIMD splat). */
  time: number;
  value: V4;
}

export interface Kfp {
  /** Canonical CodeWalker name, e.g. `ptxu_Colour:m_rgbaMinKFP`. */
  name: string;
  keys: KeyframeEntry[];
  invertBiasLink: number;
  randomIndex: number;
}

/** Names of every keyframe property CodeWalker knows (ParticleKeyframeProp.GetName). */
export const KFP = {
  accelXyzMin: 'ptxu_Acceleration:m_xyzMinKFP',
  accelXyzMax: 'ptxu_Acceleration:m_xyzMaxKFP',
  sizeWhdMin: 'ptxu_Size:m_whdMinKFP',
  sizeWhdMax: 'ptxu_Size:m_whdMaxKFP',
  sizeTblrScalar: 'ptxu_Size:m_tblrScalarKFP',
  sizeTblrVelScalar: 'ptxu_Size:m_tblrVelScalarKFP',
  colourRgbaMin: 'ptxu_Colour:m_rgbaMinKFP',
  colourRgbaMax: 'ptxu_Colour:m_rgbaMaxKFP',
  colourEmissive: 'ptxu_Colour:m_emissiveIntensityKFP',
  rotInitialMin: 'ptxu_Rotation:m_initialAngleMinKFP',
  rotInitialMax: 'ptxu_Rotation:m_initialAngleMaxKFP',
  rotAngleMin: 'ptxu_Rotation:m_angleMinKFP',
  rotAngleMax: 'ptxu_Rotation:m_angleMaxKFP',
  animRate: 'ptxu_AnimateTexture:m_animRateKFP',
  dampXyzMin: 'ptxu_Dampening:m_xyzMinKFP',
  dampXyzMax: 'ptxu_Dampening:m_xyzMaxKFP',
  noisePosMin: 'ptxu_Noise:m_posNoiseMinKFP',
  noisePosMax: 'ptxu_Noise:m_posNoiseMaxKFP',
  noiseVelMin: 'ptxu_Noise:m_velNoiseMinKFP',
  noiseVelMax: 'ptxu_Noise:m_velNoiseMaxKFP',
  effTintMin: 'ptxEffectRule:m_colourTintMinKFP',
  effTintMax: 'ptxEffectRule:m_colourTintMaxKFP',
  effZoom: 'ptxEffectRule:m_zoomScalarKFP',
  effDataSphere: 'ptxEffectRule:m_dataSphereKFP',
  effDataCapsule: 'ptxEffectRule:m_dataCapsuleKFP',
  emSpawnRateTime: 'ptxEmitterRule:m_spawnRateOverTimeKFP',
  emSpawnRateDist: 'ptxEmitterRule:m_spawnRateOverDistKFP',
  emParticleLife: 'ptxEmitterRule:m_particleLifeKFP',
  emPlaybackRate: 'ptxEmitterRule:m_playbackRateScalarKFP',
  emSpeedScalar: 'ptxEmitterRule:m_speedScalarKFP',
  emSizeScalar: 'ptxEmitterRule:m_sizeScalarKFP',
  emAccnScalar: 'ptxEmitterRule:m_accnScalarKFP',
  emDampScalar: 'ptxEmitterRule:m_dampeningScalarKFP',
  emMatrixWeight: 'ptxEmitterRule:m_matrixWeightScalarKFP',
  emInheritVelocity: 'ptxEmitterRule:m_inheritVelocityKFP',
  creationPosition: 'ptxCreationDomain:m_positionKFP',
  creationRotation: 'ptxCreationDomain:m_rotationKFP',
  creationSizeOuter: 'ptxCreationDomain:m_sizeOuterKFP',
  creationSizeInner: 'ptxCreationDomain:m_sizeInnerKFP',
  targetPosition: 'ptxTargetDomain:m_positionKFP',
  targetRotation: 'ptxTargetDomain:m_rotationKFP',
  targetSizeOuter: 'ptxTargetDomain:m_sizeOuterKFP',
  targetSizeInner: 'ptxTargetDomain:m_sizeInnerKFP',
  attractorPosition: 'ptxAttractorDomain:m_positionKFP',
  attractorRotation: 'ptxAttractorDomain:m_rotationKFP',
  attractorSizeOuter: 'ptxAttractorDomain:m_sizeOuterKFP',
  attractorSizeInner: 'ptxAttractorDomain:m_sizeInnerKFP',
} as const;

/** The 10 fixed slots of a ParticleEmitterRule, in file order. */
export const EMITTER_KFP_SLOTS = [
  KFP.emSpawnRateTime,
  KFP.emSpawnRateDist,
  KFP.emParticleLife,
  KFP.emPlaybackRate,
  KFP.emSpeedScalar,
  KFP.emSizeScalar,
  KFP.emAccnScalar,
  KFP.emDampScalar,
  KFP.emMatrixWeight,
  KFP.emInheritVelocity,
] as const;

/** The 5 meaningful slots of a ParticleEffectRule, in file order. */
export const EFFECT_KFP_SLOTS = [KFP.effTintMin, KFP.effTintMax, KFP.effZoom, KFP.effDataSphere, KFP.effDataCapsule] as const;

export function kfp(name: string, keys: Array<[number, V4]> | KeyframeEntry[], opts: Partial<Pick<Kfp, 'invertBiasLink' | 'randomIndex'>> = {}): Kfp {
  const entries: KeyframeEntry[] = keys.map((k) => (Array.isArray(k) ? { time: k[0], value: k[1] } : k));
  return { name, keys: entries, invertBiasLink: opts.invertBiasLink ?? 0, randomIndex: opts.randomIndex ?? 0 };
}

/** A constant KFP (single key at t=0). */
export function constKfp(name: string, value: V4): Kfp {
  return kfp(name, [[0, value]]);
}

/* --------------------------------------------------------------- behaviours */

export type DomainType = 'Box' | 'Sphere' | 'Cylinder' | 'Attractor';

export interface DomainModel {
  type: DomainType;
  isWorldSpace: number;
  isPointRelative: number;
  isCreationRelative: number;
  isTargetRelative: number;
  fileVersion: number;
  position: Kfp;
  rotation: Kfp;
  sizeOuter: Kfp;
  sizeInner: Kfp;
}

export type BehaviourModel =
  | { type: 'Age' }
  | { type: 'Velocity' }
  | { type: 'Acceleration'; referenceSpace: number; isAffectedByZoom: number; enableGravity: number; xyzMin: Kfp; xyzMax: Kfp }
  | {
      type: 'Rotation';
      initRotationMode: number;
      updateRotationMode: number;
      accumulateAngle: number;
      rotateAngleAxes: number;
      rotateInitAngleAxes: number;
      speedFadeThreshold: number;
      initialAngleMin: Kfp;
      initialAngleMax: Kfp;
      angleMin: Kfp;
      angleMax: Kfp;
    }
  | { type: 'Size'; keyframeMode: number; isProportional: number; whdMin: Kfp; whdMax: Kfp; tblrScalar: Kfp; tblrVelScalar: Kfp }
  | { type: 'Dampening'; referenceSpace: number; enableAirResistance: number; xyzMin: Kfp; xyzMax: Kfp }
  | { type: 'Colour'; keyframeMode: number; rgbaMaxEnable: number; rgbaProportional: number; rgbCanTint: number; rgbaMin: Kfp; rgbaMax: Kfp; emissiveIntensity: Kfp }
  | { type: 'Noise'; referenceSpace: number; keepConstantSpeed: number; posNoiseMin: Kfp; posNoiseMax: Kfp; velNoiseMin: Kfp; velNoiseMax: Kfp }
  | {
      type: 'AnimateTexture';
      keyframeMode: number;
      lastFrameId: number;
      loopMode: number;
      isRandomised: number;
      isScaledOverParticleLife: number;
      isHeldOnLastFrame: number;
      doFrameBlending: number;
      animRate: Kfp;
    }
  | {
      type: 'Sprite';
      alignAxis: V3;
      alignmentMode: number;
      flipChanceU: number;
      flipChanceV: number;
      nearClipDist: number;
      farClipDist: number;
      projectionDepth: number;
      shadowCastIntensity: number;
      isScreenSpace: number;
      isHighRes: number;
      nearClip: number;
      farClip: number;
      uvClip: number;
      disableDraw: number;
    };

export interface ShaderVarModel {
  /** Hash-resolved name or `hash_XXXXXXXX`. */
  name: string;
  shaderVarId: number;
  isKeyframeable: number;
  externalReference: number;
  textureName: string;
}

export interface SpawnerModel {
  effectRule: string;
  durationScalarMin: number;
  playbackRateScalarMin: number;
  colourTintScalarMin: number;
  zoomScalarMin: number;
  flagsMin: number;
  durationScalarMax: number;
  playbackRateScalarMax: number;
  colourTintScalarMax: number;
  zoomScalarMax: number;
  flagsMax: number;
  triggerInfo: number;
  inheritsPointLife: number;
  tracksPointPos: number;
  tracksPointDir: number;
  tracksPointNegDir: number;
}

export interface ParticleRuleModel {
  name: string;
  refCount: number;
  shaderFile: string;
  shaderTechnique: string;
  cullMode: number;
  blendSet: number;
  lightingMode: number;
  depthWrite: number;
  depthTest: number;
  alphaBlend: number;
  texFrameIdMin: number;
  texFrameIdMax: number;
  shaderTemplateTechniqueId: number;
  diffuseMode: number;
  projectionMode: number;
  isLit: number;
  isSoft: number;
  isScreenSpace: number;
  isRefract: number;
  isNormalSpec: number;
  sortType: number;
  drawType: number;
  flags: number;
  runtimeFlags: number;
  effectSpawnerAtRatio: SpawnerModel;
  effectSpawnerOnCollision: SpawnerModel;
  behaviours: BehaviourModel[];
  shaderVars: ShaderVarModel[];
}

export interface EmitterRuleModel {
  name: string;
  refCount: number;
  isOneShot: number;
  creation: DomainModel;
  target: DomainModel;
  attractor: DomainModel;
  /** Exactly 10 entries in {@link EMITTER_KFP_SLOTS} order. */
  keyframeProps: Kfp[];
}

export interface EventEmitterModel {
  emitterRule: string;
  particleRule: string;
  eventType: number;
  startRatio: number;
  endRatio: number;
  playbackRateScalarMin: number;
  playbackRateScalarMax: number;
  zoomScalarMin: number;
  zoomScalarMax: number;
  colourTintMin: number;
  colourTintMax: number;
}

export interface EffectRuleModel {
  name: string;
  refCount: number;
  fileVersion: number;
  numLoops: number;
  sortEventsByDistance: number;
  drawListId: number;
  isShortLived: number;
  hasNoShadows: number;
  vRandomOffsetPos: V3;
  preUpdateTime: number;
  preUpdateTimeInterval: number;
  durationMin: number;
  durationMax: number;
  playbackRateScalarMin: number;
  playbackRateScalarMax: number;
  viewportCullingMode: number;
  renderWhenViewportCulled: number;
  updateWhenViewportCulled: number;
  emitWhenViewportCulled: number;
  distanceCullingMode: number;
  renderWhenDistanceCulled: number;
  updateWhenDistanceCulled: number;
  emitWhenDistanceCulled: number;
  viewportCullingSphereOffset: V3;
  viewportCullingSphereRadius: number;
  distanceCullingFadeDist: number;
  distanceCullingCullDist: number;
  lodEvoDistanceMin: number;
  lodEvoDistanceMax: number;
  collisionRange: number;
  collisionProbeDistance: number;
  collisionType: number;
  shareEntityCollisions: number;
  onlyUseBvhCollisions: number;
  gameFlags: number;
  colourTintMaxEnable: number;
  useDataVolume: number;
  dataVolumeType: number;
  zoomLevel: number;
  eventEmitters: EventEmitterModel[];
  /** Exactly 5 entries in {@link EFFECT_KFP_SLOTS} order. */
  keyframeProps: Kfp[];
}

export interface TextureModel {
  name: string;
  /** DDS file name next to the XML, e.g. `purple_flames.dds`. */
  fileName: string;
  width: number;
  height: number;
  mipLevels: number;
  /** CodeWalker TextureFormat enum name, e.g. `D3DFMT_DXT5`. */
  format: 'D3DFMT_DXT1' | 'D3DFMT_DXT5' | 'D3DFMT_A8R8G8B8';
  usage: string;
  usageFlags: string;
  extraFlags: number;
  unk32: number;
}

export interface YptModel {
  /** Asset name; must equal the .ypt file name (without extension). */
  name: string;
  effects: EffectRuleModel[];
  emitters: EmitterRuleModel[];
  particles: ParticleRuleModel[];
  textures: TextureModel[];
}

/* ------------------------------------------------------------ engine defaults */

/**
 * UNVERIFIED engine-side defaults. CodeWalker round-trips these numbers but attaches no meaning
 * to them; the values below are best-effort and were NOT confirmed in a running game.
 * Anything here can be overridden per project, and the donor-template workflow bypasses
 * them entirely by reusing a rule that is known to work.
 */
export const ENGINE_DEFAULTS = {
  shaderFile: 'rmptfx_default',
  shaderTechnique: 'rmptfx_default',
  /** Name of the texture shader variable that receives the sprite atlas. */
  diffuseVarName: 'diffusetexture',
  /** ptxRenderState blend sets (inferred from the RAGE ptx enum order; unverified). */
  blendSet: { alpha: 1, additive: 2, premultiplied: 1 } as const,
  effectFileVersion: 1,
  domainFileVersion: 1,
  textureUsage: 'DEFAULT',
  textureUsageFlags: 'UNK24',
} as const;

export const ENGINE_DEFAULTS_NOTE =
  'Shader file/technique, shader-variable names, blend-set numbers and file-version fields are not interpreted by CodeWalker and were not verified in-game.';
