/**
 * VFXForge effects -> YptModel, with an explicit report of how faithfully each property
 * could be represented.
 *
 * Two orthogonal labels are attached to every mapped property:
 *
 *   status      mapped        a direct equivalent exists in the YPT
 *               approximated  represented, but not identically (e.g. bursts as a short high spawn rate)
 *               preview-only  exists only in the VFXForge preview, NOT exported
 *               unsupported   cannot be expressed; the user must be told
 *
 *   confidence  verified      the YPT structure is verified against CodeWalker's source
 *               inferred      field exists (verified) but its numeric meaning is inferred
 *               unverified    never confirmed in a running game
 *
 * Nothing here is allowed to claim "works in game": that can only be established by the
 * FiveM test checklist.
 */
import {
  constantCurve,
  evalCurve,
  evalGradient,
  rotateEulerXYZ,
  toGtaSpace,
  type AttachmentPoint,
  type Curve,
  type Emitter,
  type Project,
  type Sheet,
  type TriggerEvent,
} from '@vfxforge/core';
import {
  EFFECT_KFP_SLOTS,
  EMITTER_KFP_SLOTS,
  ENGINE_DEFAULTS,
  KFP,
  constKfp,
  kfp,
  type BehaviourModel,
  type DomainModel,
  type EffectRuleModel,
  type EmitterRuleModel,
  type Kfp,
  type ParticleRuleModel,
  type SpawnerModel,
  type TextureModel,
  type V3,
  type V4,
  type YptModel,
} from './model';

export type MappingStatus = 'mapped' | 'approximated' | 'preview-only' | 'unsupported';
export type MappingConfidence = 'verified' | 'inferred' | 'unverified';

export interface MappingNote {
  effect: string;
  emitter: string;
  property: string;
  status: MappingStatus;
  confidence: MappingConfidence;
  detail: string;
}

/** What the media pipeline produced for a sheet; the YPT builder never touches pixels. */
export interface SheetAsset {
  sheet: Sheet;
  frameCount: number;
  ddsFileName: string;
  width: number;
  height: number;
  mipLevels: number;
  ddsFormat: 'BC1' | 'BC3' | 'BGRA8';
}

export interface BuildOptions {
  /** Defaults to the project's export.assetName. */
  assetName?: string;
  render?: Partial<{ shaderFile: string; shaderTechnique: string; diffuseVarName: string }>;
}

/**
 * How the runtime script must start one exported effect rule. One native start call attaches ONE
 * effect at ONE offset, so emitters that differ in attachment point / triggers / loop-ness are
 * exported as separate effect rules, each with its own binding.
 */
export interface BindingPlan {
  /** Effect rule name inside the YPT (what StartParticleFx… is called with). */
  effectRule: string;
  /** The VFXForge effect this binding came from. */
  effectName: string;
  attachmentId: string | null;
  attachmentName: string | null;
  /** Attachment offset in GTA weapon-local space (metres). */
  offset: V3;
  /** Attachment rotation, degrees, in GTA axes. */
  rotation: V3;
  scale: number;
  bone: string | null;
  triggers: TriggerEvent[];
  loop: boolean;
  emitterNames: string[];
}

export interface BuildResult {
  model: YptModel;
  bindings: BindingPlan[];
  notes: MappingNote[];
  /** Hard problems that make the effect un-exportable (missing sheet, no emitters...). */
  errors: string[];
}

const GRAVITY = 9.81;
const MAX_SAMPLES = 12;
const BURST_WINDOW_SECONDS = 0.05;
const DEG2RAD = Math.PI / 180;

/** Time stamps at which to sample a 1-D curve so the exported keyframes follow it closely. */
function sampleTimes(...curves: Curve[]): number[] {
  const set = new Set<number>([0, 1]);
  for (const c of curves) for (const k of c.keys) set.add(Math.round(k.t * 1000) / 1000);
  let times = [...set].sort((a, b) => a - b);
  if (times.length > MAX_SAMPLES) {
    times = Array.from({ length: MAX_SAMPLES }, (_, i) => i / (MAX_SAMPLES - 1));
  }
  return times;
}

function domainKfps(prefix: 'creation' | 'target' | 'attractor', position: V3, rotation: V3, sizeOuter: V3, sizeInner: V3) {
  const n = {
    creation: [KFP.creationPosition, KFP.creationRotation, KFP.creationSizeOuter, KFP.creationSizeInner],
    target: [KFP.targetPosition, KFP.targetRotation, KFP.targetSizeOuter, KFP.targetSizeInner],
    attractor: [KFP.attractorPosition, KFP.attractorRotation, KFP.attractorSizeOuter, KFP.attractorSizeInner],
  }[prefix];
  const v4 = (v: V3): V4 => [v[0], v[1], v[2], 0];
  return {
    position: constKfp(n[0]!, v4(position)),
    rotation: constKfp(n[1]!, v4(rotation)),
    sizeOuter: constKfp(n[2]!, v4(sizeOuter)),
    sizeInner: constKfp(n[3]!, v4(sizeInner)),
  };
}

function makeDomain(prefix: 'creation' | 'target' | 'attractor', type: DomainModel['type'], position: V3, rotation: V3, sizeOuter: V3, sizeInner: V3): DomainModel {
  return {
    type,
    isWorldSpace: 0,
    isPointRelative: 1,
    isCreationRelative: 0,
    isTargetRelative: 0,
    fileVersion: ENGINE_DEFAULTS.domainFileVersion,
    ...domainKfps(prefix, position, rotation, sizeOuter, sizeInner),
  };
}

function emptySpawner(): SpawnerModel {
  return {
    effectRule: '',
    durationScalarMin: 0,
    playbackRateScalarMin: 0,
    colourTintScalarMin: 0,
    zoomScalarMin: 0,
    flagsMin: 0,
    durationScalarMax: 0,
    playbackRateScalarMax: 0,
    colourTintScalarMax: 0,
    zoomScalarMax: 0,
    flagsMax: 0,
    triggerInfo: 0,
    inheritsPointLife: 0,
    tracksPointPos: 0,
    tracksPointDir: 0,
    tracksPointNegDir: 0,
  };
}

/** Texture entries for the sheets actually referenced by emitters. */
function textureFor(a: SheetAsset): TextureModel {
  return {
    name: a.sheet.textureName,
    fileName: a.ddsFileName,
    width: a.width,
    height: a.height,
    mipLevels: a.mipLevels,
    format: a.ddsFormat === 'BC1' ? 'D3DFMT_DXT1' : a.ddsFormat === 'BC3' ? 'D3DFMT_DXT5' : 'D3DFMT_A8R8G8B8',
    usage: ENGINE_DEFAULTS.textureUsage,
    usageFlags: ENGINE_DEFAULTS.textureUsageFlags,
    extraFlags: 0,
    unk32: 0,
  };
}

/** Particle/emitter rule names for emitter `i` of the effect rule `effectRule`. */
export function ruleNames(effectRule: string, i: number): { particle: string; emitter: string } {
  return { particle: `${effectRule}_p${i + 1}`, emitter: `${effectRule}_e${i + 1}` };
}

/** Key that decides which emitters can share one effect rule (one start call). */
function groupKey(em: Emitter): string {
  return `${em.attachmentId ?? ''}|${[...em.triggers].sort().join(',')}|${em.emission.mode === 'oneShot' || !em.emission.loop ? 'once' : 'loop'}`;
}

/**
 * GTA native rotation arguments are Euler degrees about world axes. Converting an arbitrary
 * three-axis Euler between the two coordinate systems depends on the engine's rotation order,
 * which is unverified; a rotation about ONE axis is exact in every order, so only that case is
 * claimed exact.
 */
export function rotationToGta(eulerDeg: V3): { rotation: V3; exact: boolean } {
  const nonZero = eulerDeg.filter((a) => Math.abs(a) > 1e-6).length;
  // axes map: x->x, y(up)->z, z(back)->-y ; a rotation of +a about three's Y is +a about GTA's Z, etc.
  const rotation: V3 = [eulerDeg[0], -eulerDeg[2], eulerDeg[1]];
  return { rotation, exact: nonZero <= 1 };
}

export function buildYptModel(project: Project, sheets: Record<string, SheetAsset>, opts: BuildOptions = {}): BuildResult {
  const notes: MappingNote[] = [];
  const errors: string[] = [];
  const render = { ...ENGINE_DEFAULTS, ...opts.render };
  const model: YptModel = {
    name: opts.assetName ?? project.export.assetName,
    effects: [],
    emitters: [],
    particles: [],
    textures: [],
  };
  const usedSheets = new Map<string, SheetAsset>();

  const bindings: BindingPlan[] = [];
  const attachments = new Map<string, AttachmentPoint>(project.weapon.attachments.map((a) => [a.id, a]));

  for (const effect of Object.values(project.effects)) {
    const active = effect.emitters.filter((e) => e.enabled);
    if (active.length === 0) {
      errors.push(`Effect "${effect.name}" has no enabled emitters.`);
      continue;
    }
    const groups = new Map<string, Emitter[]>();
    for (const em of active) {
      const k = groupKey(em);
      groups.set(k, [...(groups.get(k) ?? []), em]);
    }
    let groupIndex = 0;
    for (const members of groups.values()) {
      const effectRule = groupIndex === 0 ? effect.ptfxName : `${effect.ptfxName}_${groupIndex + 1}`;
      groupIndex++;
      const eventEmitters: EffectRuleModel['eventEmitters'] = [];
      const used: Emitter[] = [];
      let effectDuration = 0;
      members.forEach((em, i) => {
        const names = ruleNames(effectRule, i);
        const note = (property: string, status: MappingStatus, confidence: MappingConfidence, detail: string) =>
          notes.push({ effect: effect.name, emitter: em.name, property, status, confidence, detail });

        if (em.sheetId === null) {
          errors.push(`Emitter "${em.name}" (effect "${effect.name}") has no spritesheet assigned.`);
          return;
        }
        const asset = sheets[em.sheetId];
        if (!asset) {
          errors.push(`Emitter "${em.name}" references a spritesheet that has not been generated.`);
          return;
        }
        usedSheets.set(asset.sheet.textureName, asset);
        const { particle, emitter, rangeEnd } = buildEmitterRules(em, asset, names, render, note);
        model.particles.push(particle);
        model.emitters.push(emitter);
        used.push(em);
        effectDuration = Math.max(effectDuration, em.emission.startDelay + em.emission.duration, rangeEnd);
        eventEmitters.push({
          emitterRule: names.emitter,
          particleRule: names.particle,
          eventType: 0,
          startRatio: 0,
          endRatio: 1,
          playbackRateScalarMin: 1,
          playbackRateScalarMax: 1,
          zoomScalarMin: 1,
          zoomScalarMax: 1,
          colourTintMin: 0xffffffff,
          colourTintMax: 0xffffffff,
        });
      });
      if (eventEmitters.length === 0) continue;
      model.effects.push(buildEffectRule(effectRule, used, eventEmitters, effectDuration));

      const first = used[0]!;
      const att = first.attachmentId ? attachments.get(first.attachmentId) : undefined;
      const rot = rotationToGta((att?.rotation ?? [0, 0, 0]) as V3);
      if (!rot.exact) {
        notes.push({
          effect: effect.name,
          emitter: used.map((u) => u.name).join(', '),
          property: 'attachment.rotation',
          status: 'approximated',
          confidence: 'unverified',
          detail: `Attachment "${att?.name}" rotates about more than one axis; the conversion to GTA Euler angles assumes XYZ order, which is unverified. Rotating about a single axis is exact.`,
        });
      }
      if (!att) {
        notes.push({ effect: effect.name, emitter: used.map((u) => u.name).join(', '), property: 'attachment', status: 'mapped', confidence: 'verified', detail: 'No attachment point: the effect attaches to the weapon entity origin with no offset.' });
      }
      bindings.push({
        effectRule,
        effectName: effect.name,
        attachmentId: att?.id ?? null,
        attachmentName: att?.name ?? null,
        offset: att ? toGtaSpace(att.position as V3) : [0, 0, 0],
        rotation: rot.rotation,
        scale: 1,
        bone: att?.gtaBone ?? null,
        triggers: [...new Set(used.flatMap((u) => u.triggers))].sort() as TriggerEvent[],
        loop: first.emission.mode !== 'oneShot' && first.emission.loop,
        emitterNames: used.map((u) => u.name),
      });
    }
  }
  model.textures = [...usedSheets.values()].map(textureFor);
  return { model, bindings, notes, errors };
}

function buildEffectRule(ruleName: string, emitters: Emitter[], eventEmitters: EffectRuleModel['eventEmitters'], duration: number): EffectRuleModel {
  const looping = emitters.some((e) => e.emission.loop && e.emission.mode !== 'oneShot');
  // Event start/end ratios are fractions of the effect duration; per-emitter start delays are expressed through them.
  eventEmitters.forEach((ev, i) => {
    const em = emitters[i]!;
    ev.startRatio = duration > 0 ? Math.min(1, em.emission.startDelay / duration) : 0;
    ev.endRatio = duration > 0 ? Math.min(1, (em.emission.startDelay + em.emission.duration) / duration) : 1;
  });
  const white: V4 = [1, 1, 1, 1];
  return {
    name: ruleName,
    refCount: 0,
    fileVersion: ENGINE_DEFAULTS.effectFileVersion,
    numLoops: looping ? 0 : 1,
    sortEventsByDistance: 0,
    drawListId: 0,
    isShortLived: 0,
    hasNoShadows: 1,
    vRandomOffsetPos: [0, 0, 0],
    preUpdateTime: 0,
    preUpdateTimeInterval: 0,
    durationMin: duration,
    durationMax: duration,
    playbackRateScalarMin: 1,
    playbackRateScalarMax: 1,
    viewportCullingMode: 0,
    renderWhenViewportCulled: 0,
    updateWhenViewportCulled: 0,
    emitWhenViewportCulled: 0,
    distanceCullingMode: 0,
    renderWhenDistanceCulled: 0,
    updateWhenDistanceCulled: 0,
    emitWhenDistanceCulled: 0,
    viewportCullingSphereOffset: [0, 0, 0],
    viewportCullingSphereRadius: 0,
    distanceCullingFadeDist: 0,
    distanceCullingCullDist: 0,
    lodEvoDistanceMin: 0,
    lodEvoDistanceMax: 0,
    collisionRange: 0,
    collisionProbeDistance: 0,
    collisionType: 0,
    shareEntityCollisions: 0,
    onlyUseBvhCollisions: 0,
    gameFlags: 0,
    colourTintMaxEnable: 0,
    useDataVolume: 0,
    dataVolumeType: 0,
    zoomLevel: 1,
    eventEmitters,
    keyframeProps: [
      constKfp(EFFECT_KFP_SLOTS[0], white),
      constKfp(EFFECT_KFP_SLOTS[1], white),
      constKfp(EFFECT_KFP_SLOTS[2], white),
      constKfp(EFFECT_KFP_SLOTS[3], [0, 0, 0, 0]),
      constKfp(EFFECT_KFP_SLOTS[4], [0, 0, 0, 0]),
    ],
  };
}

type Noter = (property: string, status: MappingStatus, confidence: MappingConfidence, detail: string) => void;

function buildEmitterRules(
  em: Emitter,
  asset: SheetAsset,
  names: { particle: string; emitter: string },
  render: { shaderFile: string; shaderTechnique: string; diffuseVarName: string },
  note: Noter,
): { particle: ParticleRuleModel; emitter: EmitterRuleModel; rangeEnd: number } {
  const lifeMid = (em.emission.lifetime.min + em.emission.lifetime.max) / 2;
  const behaviours: BehaviourModel[] = [{ type: 'Age' }];

  /* ----- acceleration (gravity + constant acceleration), converted to GTA space ----- */
  const accel = toGtaSpace(em.physics.acceleration);
  const accelZ = accel[2] - GRAVITY * em.physics.gravity;
  const aVec: V4 = [accel[0], accel[1], accelZ, 0];
  behaviours.push({
    type: 'Acceleration',
    referenceSpace: 0,
    isAffectedByZoom: 0,
    enableGravity: 0,
    xyzMin: constKfp(KFP.accelXyzMin, aVec),
    xyzMax: constKfp(KFP.accelXyzMax, aVec),
  });
  note('physics.gravity + acceleration', 'mapped', 'inferred', 'Folded into one constant acceleration (gravity is applied along GTA -Z as -9.81 m/s² × multiplier); EnableGravity is left off so the multiplier is honoured exactly.');
  behaviours.push({ type: 'Velocity' });

  /* ----- rotation ----- */
  const rot = (deg: number): V4 => [deg * DEG2RAD, 0, 0, 0];
  behaviours.push({
    type: 'Rotation',
    initRotationMode: 0,
    updateRotationMode: 0,
    accumulateAngle: 0,
    rotateAngleAxes: 0,
    rotateInitAngleAxes: 0,
    speedFadeThreshold: 0,
    initialAngleMin: constKfp(KFP.rotInitialMin, rot(em.particle.rotation.min)),
    initialAngleMax: constKfp(KFP.rotInitialMax, rot(em.particle.rotation.max)),
    angleMin: constKfp(KFP.rotAngleMin, rot(em.particle.angularVelocity.min)),
    angleMax: constKfp(KFP.rotAngleMax, rot(em.particle.angularVelocity.max)),
  });
  note('particle.rotation / angularVelocity', 'mapped', 'inferred', 'Degrees converted to radians; the game is assumed to use radians and radians/second.');

  /* ----- size over life ----- */
  const sizeTimes = sampleTimes(em.particle.sizeOverLife);
  const aspect = em.particle.aspect;
  const tf = em.transform;
  const uniformScale = (tf.scale[0] + tf.scale[1] + tf.scale[2]) / 3;
  if (Math.max(...tf.scale) - Math.min(...tf.scale) > 1e-6) {
    note('transform.scale', 'approximated', 'verified', 'Non-uniform emitter scale is averaged to a uniform scale (sprites cannot be stretched per-axis).');
  }
  behaviours.push({
    type: 'Size',
    keyframeMode: 0,
    isProportional: aspect === 1 ? 1 : 0,
    whdMin: kfp(KFP.sizeWhdMin, sizeTimes.map((t) => [t, sizeVec(em.particle.size.min * uniformScale, em.particle.sizeOverLife, t, aspect)] as [number, V4])),
    whdMax: kfp(KFP.sizeWhdMax, sizeTimes.map((t) => [t, sizeVec(em.particle.size.max * uniformScale, em.particle.sizeOverLife, t, aspect)] as [number, V4])),
    tblrScalar: constKfp(KFP.sizeTblrScalar, [1, 1, 1, 1]),
    tblrVelScalar: constKfp(KFP.sizeTblrVelScalar, [0, 0, 0, 0]),
  });
  note('particle.size + sizeOverLife', 'mapped', 'inferred', `Sampled at ${sizeTimes.length} points; width/height/depth stored in metres (assumed).`);

  /* ----- drag ----- */
  if (em.physics.drag > 0) {
    const d: V4 = [em.physics.drag, em.physics.drag, em.physics.drag, 0];
    behaviours.push({ type: 'Dampening', referenceSpace: 0, enableAirResistance: 0, xyzMin: constKfp(KFP.dampXyzMin, d), xyzMax: constKfp(KFP.dampXyzMax, d) });
    note('physics.drag', 'approximated', 'inferred', 'Mapped to ptxu_Dampening per-axis values; the engine\'s damping curve may differ from the preview\'s exponential drag.');
  }

  /* ----- colour / alpha over life ----- */
  const colTimes = sampleTimes(em.particle.alphaOverLife);
  for (const s of em.particle.colorOverLife.stops) if (!colTimes.includes(s.t)) colTimes.push(s.t);
  colTimes.sort((a, b) => a - b);
  const colour = colTimes.slice(0, 16).map((t) => {
    const g = evalGradient(em.particle.colorOverLife, t);
    const a = evalCurve(em.particle.alphaOverLife, t) * g[3] * em.particle.color[3];
    return [t, [g[0] * em.particle.color[0], g[1] * em.particle.color[1], g[2] * em.particle.color[2], a]] as [number, V4];
  });
  const emissive = Math.max(1, em.particle.glow);
  behaviours.push({
    type: 'Colour',
    keyframeMode: 0,
    rgbaMaxEnable: 0,
    rgbaProportional: 0,
    rgbCanTint: 1,
    rgbaMin: kfp(KFP.colourRgbaMin, colour),
    rgbaMax: kfp(KFP.colourRgbaMax, colour),
    emissiveIntensity: constKfp(KFP.colourEmissive, [emissive, emissive, emissive, emissive]),
  });
  note('particle.color / colorOverLife / alphaOverLife', 'mapped', 'inferred', 'Combined into one RGBA keyframe track over particle life (straight alpha, 0..1).');
  if (em.particle.glow > 1) {
    note('particle.glow', 'approximated', 'unverified', `Preview glow ${em.particle.glow} was mapped to ptxu_Colour emissive intensity; the in-game look will differ from the WebGL bloom.`);
  } else {
    note('particle.glow', 'preview-only', 'verified', 'Preview bloom is not exported (glow ≤ 1).');
  }

  /* ----- turbulence ----- */
  if (em.physics.turbulence.strength > 0) {
    const s = em.physics.turbulence.strength;
    behaviours.push({
      type: 'Noise',
      referenceSpace: 0,
      keepConstantSpeed: 0,
      posNoiseMin: constKfp(KFP.noisePosMin, [0, 0, 0, 0]),
      posNoiseMax: constKfp(KFP.noisePosMax, [0, 0, 0, 0]),
      velNoiseMin: constKfp(KFP.noiseVelMin, [-s, -s, -s, 0]),
      velNoiseMax: constKfp(KFP.noiseVelMax, [s, s, s, 0]),
    });
    note('physics.turbulence', 'approximated', 'unverified', 'Preview curl-style turbulence is approximated by random velocity noise (ptxu_Noise); frequency is not representable.');
  }
  if (em.physics.attractor.enabled) note('physics.attractor', 'unsupported', 'verified', 'Attractor behaviour is not exported (the preview-only attractor has no equivalent in the generated rule).');
  if (!isZero(em.physics.drift)) note('physics.drift', 'unsupported', 'verified', 'A constant drift velocity has no equivalent in the generated rule (it is not an acceleration); preview only.');
  if (em.particle.trail.enabled) note('particle.trail', 'unsupported', 'verified', 'Trails need a ptxd_Trail behaviour with its own texture layout; not generated. Preview only.');
  if (em.particle.orientation === 'velocity') note('particle.orientation', 'approximated', 'unverified', 'Velocity-aligned sprites use Sprite.AlignmentMode; the numeric enum value is unverified.');

  /* ----- flipbook ----- */
  const lastFrame = Math.max(0, Math.min(asset.frameCount - 1, em.animation.endFrame ?? asset.frameCount - 1));
  const firstFrame = Math.max(0, Math.min(lastFrame, em.animation.startFrame));
  const animated = lastFrame > firstFrame;
  if (animated) {
    // frames per second of particle life
    const fps = em.animation.mode === 'fps' ? em.animation.fps : (lastFrame - firstFrame + 1) / Math.max(lifeMid, 1e-3);
    behaviours.push({
      type: 'AnimateTexture',
      keyframeMode: 0,
      lastFrameId: lastFrame,
      loopMode: em.animation.loop ? 1 : 0,
      isRandomised: em.animation.randomStart ? 1 : 0,
      isScaledOverParticleLife: em.animation.mode === 'overLife' ? 1 : 0,
      isHeldOnLastFrame: em.animation.loop ? 0 : 1,
      doFrameBlending: em.animation.blendFrames ? 1 : 0,
      animRate: constKfp(KFP.animRate, [fps, fps, 0, 0]),
    });
    note('animation', 'mapped', 'inferred', `Flipbook frames ${firstFrame}..${lastFrame} via TexFrameIDMin/Max + ptxu_AnimateTexture. How a frame id maps to a UV rectangle is decided by the game's clip-region data (ptxclipregions.dat), which CANNOT be verified here.`);
  } else {
    note('animation', 'mapped', 'verified', 'Single frame: no ptxu_AnimateTexture behaviour is generated.');
  }

  /* ----- sprite (the draw behaviour) ----- */
  behaviours.push({
    type: 'Sprite',
    alignAxis: [0, 0, 0],
    alignmentMode: em.particle.orientation === 'billboard' ? 0 : 1,
    flipChanceU: 0,
    flipChanceV: 0,
    nearClipDist: 0,
    farClipDist: 0,
    projectionDepth: 0,
    shadowCastIntensity: 0,
    isScreenSpace: 0,
    isHighRes: 0,
    nearClip: 0,
    farClip: 0,
    uvClip: 0,
    disableDraw: 0,
  });

  const blendSet = em.blend === 'additive' ? ENGINE_DEFAULTS.blendSet.additive : ENGINE_DEFAULTS.blendSet.alpha;
  note('blend', 'mapped', 'unverified', `${em.blend} → ptxRenderState.BlendSet ${blendSet}. The numeric enum is inferred from RAGE's order and was not verified in-game.`);

  const particle: ParticleRuleModel = {
    name: names.particle,
    refCount: 0,
    shaderFile: render.shaderFile,
    shaderTechnique: render.shaderTechnique,
    cullMode: 0,
    blendSet,
    lightingMode: 0,
    depthWrite: 0,
    depthTest: 1,
    alphaBlend: 1,
    texFrameIdMin: firstFrame,
    texFrameIdMax: lastFrame,
    shaderTemplateTechniqueId: 0,
    diffuseMode: 0,
    projectionMode: 0,
    isLit: 0,
    isSoft: 0,
    isScreenSpace: 0,
    isRefract: 0,
    isNormalSpec: 0,
    sortType: 0,
    drawType: 0,
    flags: 0,
    runtimeFlags: 0,
    effectSpawnerAtRatio: emptySpawner(),
    effectSpawnerOnCollision: emptySpawner(),
    behaviours,
    shaderVars: [
      {
        name: render.diffuseVarName,
        shaderVarId: 0,
        isKeyframeable: 0,
        externalReference: 0,
        textureName: asset.sheet.textureName,
      },
    ],
  };
  note('shader', 'mapped', 'unverified', `Shader "${render.shaderFile}" / texture variable "${render.diffuseVarName}" are best-effort names; use the donor-template workflow for a rule that is known to render.`);

  /* ----- emitter rule ----- */
  const shape = em.shape;
  const k = uniformScale;
  const sizeV: V3 = toGtaSpace([(shape.size[0] / 2) * k, (shape.size[1] / 2) * k, (shape.size[2] / 2) * k]).map(Math.abs) as V3;
  let creationType: DomainModel['type'] = 'Box';
  let outer: V3 = sizeV;
  switch (shape.type) {
    case 'point':
    case 'directional':
      outer = [0, 0, 0];
      break;
    case 'box':
      break;
    case 'sphere':
      creationType = 'Sphere';
      outer = [shape.radius * k, shape.radius * k, shape.radius * k];
      break;
    case 'circle':
      creationType = 'Cylinder';
      outer = [shape.radius * k, shape.radius * k, 0];
      break;
    case 'cone':
      creationType = 'Cylinder';
      outer = [shape.radius * k, shape.radius * k, 0];
      note('shape.cone', 'approximated', 'inferred', 'GTA has no cone domain: the cone is emitted from a disc and its half-angle is approximated by the target domain spread.');
      break;
  }
  const inner: V3 = shape.fromShell ? outer : [0, 0, 0];
  const emitterRot = rotationToGta(tf.rotation as V3);
  const creation = makeDomain('creation', creationType, toGtaSpace(tf.position as V3), emitterRot.rotation.map((d) => d * DEG2RAD) as V3, outer, inner);
  note('transform', 'mapped', 'inferred', 'Emitter position/rotation/scale are baked into the creation domain (position, rotation in radians, size); the attachment offset is applied at runtime.');
  if (!emitterRot.exact) note('transform.rotation', 'approximated', 'unverified', 'Multi-axis emitter rotation assumes XYZ Euler order when converted to GTA axes.');

  // Target domain: a point in the emission direction (rotated by the emitter rotation); its size encodes the spread.
  const dir = toGtaSpace(rotateEulerXYZ(em.physics.direction as V3, tf.rotation as V3));
  const spreadRad = Math.tan(Math.min(89, em.physics.spread) * DEG2RAD);
  const target = makeDomain('target', 'Sphere', dir, [0, 0, 0], [spreadRad, spreadRad, spreadRad], [0, 0, 0]);
  const attractor = makeDomain('attractor', 'Sphere', [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]);
  note('physics.direction / spread', 'approximated', 'unverified', 'Direction and spread are encoded as the target-domain centre and radius; how the engine turns the target domain into initial velocity is not verified.');

  const burst = em.emission.mode === 'burst' || em.emission.mode === 'oneShot';
  let rate = em.emission.rate;
  let rangeEnd = 0;
  if (em.emission.mode === 'burst') {
    rate = em.emission.burstCount / BURST_WINDOW_SECONDS;
    note('emission.burst', 'approximated', 'inferred', `A burst of ${em.emission.burstCount} is exported as a ${BURST_WINDOW_SECONDS * 1000} ms window at ${Math.round(rate)}/s. Repeating bursts (interval) are not representable; trigger the effect from script instead.`);
    rangeEnd = em.emission.startDelay + BURST_WINDOW_SECONDS;
  } else if (em.emission.mode === 'oneShot') {
    rate = em.emission.burstCount / BURST_WINDOW_SECONDS;
    note('emission.oneShot', 'approximated', 'inferred', `One-shot of ${em.emission.burstCount} particles exported as a ${BURST_WINDOW_SECONDS * 1000} ms window; IsOneShot is set.`);
    rangeEnd = em.emission.startDelay + BURST_WINDOW_SECONDS;
  } else {
    note('emission.rate', 'mapped', 'inferred', 'Particles per second → m_spawnRateOverTimeKFP.');
  }
  note('emission.maxParticles', 'preview-only', 'verified', 'The engine has its own pool limits; the preview cap is not exported.');

  const slots: Kfp[] = [
    constKfp(EMITTER_KFP_SLOTS[0], [rate, rate, 0, 0]),
    constKfp(EMITTER_KFP_SLOTS[1], [0, 0, 0, 0]),
    constKfp(EMITTER_KFP_SLOTS[2], [em.emission.lifetime.min, em.emission.lifetime.max, 0, 0]),
    constKfp(EMITTER_KFP_SLOTS[3], [1, 1, 1, 1]),
    constKfp(EMITTER_KFP_SLOTS[4], [em.physics.speed.min, em.physics.speed.max, 0, 0]),
    constKfp(EMITTER_KFP_SLOTS[5], [1, 1, 1, 1]),
    constKfp(EMITTER_KFP_SLOTS[6], [1, 1, 1, 1]),
    constKfp(EMITTER_KFP_SLOTS[7], [1, 1, 1, 1]),
    constKfp(EMITTER_KFP_SLOTS[8], [1, 1, 1, 1]),
    constKfp(EMITTER_KFP_SLOTS[9], [0, 0, 0, 0]),
  ];
  note('physics.speed', 'mapped', 'unverified', 'Speed min/max → m_speedScalarKFP (x = min, y = max); the vector-component layout is inferred.');
  note('particle.lifetime', 'mapped', 'inferred', 'Lifetime min/max → m_particleLifeKFP (x = min, y = max).');
  if (em.physics.speedOverLife.keys.length > 1) note('physics.speedOverLife', 'unsupported', 'verified', 'Speed-over-life curves are not exported.');
  note('attachment', 'preview-only', 'verified', 'The attachment point offset/rotation is applied at runtime by the generated Lua (config.lua), not stored in the YPT.');

  const emitter: EmitterRuleModel = {
    name: names.emitter,
    refCount: 0,
    isOneShot: em.emission.mode === 'oneShot' || (burst && !em.emission.loop) ? 1 : 0,
    creation,
    target,
    attractor,
    keyframeProps: slots,
  };
  return { particle, emitter, rangeEnd };
}

function sizeVec(base: number, curve: Curve, t: number, aspect: number): V4 {
  const s = base * evalCurve(curve, t);
  return [s * aspect, s, s, 0];
}

function isZero(v: readonly number[]): boolean {
  return v.every((x) => x === 0);
}

/** Helper for tests/UI: a curve that is constant 1. */
export const UNIT_CURVE: Curve = constantCurve(1);
