/**
 * The VFXForge project document.
 *
 * Design rules:
 *  - Pure JSON, validated with zod on load (project files are untrusted input).
 *  - Non-destructive: imported media is referenced, never modified. Everything the
 *    user tweaks (extraction, keying, grid, emitters...) is a parameter here, and the
 *    frames / atlas / particles are DERIVED from these parameters on demand.
 *  - Binary data (media, models) lives next to the document in `assets/`, addressed
 *    by relative path + sha256, so saving the document never rewrites large files.
 */
import { z } from 'zod';
import { EASES } from '../math/curve';
import { isSafeRelativePath } from '../safety';

export const SCHEMA_VERSION = 1 as const;

const num = z.number().finite();
const int = z.number().int();
const unit = z.number().finite().min(0).max(1);

export const Vec3Schema = z.tuple([num, num, num]);
export const RgbaSchema = z.tuple([unit, unit, unit, unit]);
export const RangeSchema = z.object({ min: num, max: num });

export const CurveSchema = z.object({
  keys: z
    .array(z.object({ t: unit, v: num, ease: z.enum(EASES) }))
    .min(1)
    .max(64),
});

export const GradientSchema = z.object({
  stops: z
    .array(z.object({ t: unit, color: RgbaSchema }))
    .min(1)
    .max(32),
});

/* ------------------------------------------------------------------ assets */

export const AssetKindSchema = z.enum(['image', 'video', 'model']);

export const MediaInfoSchema = z.object({
  width: int.min(1).max(16384),
  height: int.min(1).max(16384),
  durationSec: num.min(0).nullable(),
  fps: num.min(0).max(1000).nullable(),
  frameCount: int.min(0).nullable(),
  hasAlpha: z.boolean(),
  codec: z.string().max(64).nullable(),
});

export const AssetSchema = z.object({
  id: z.string().min(1).max(64),
  kind: AssetKindSchema,
  name: z.string().min(1).max(200),
  /** Path relative to the project folder, e.g. `assets/3f2a....mp4`. */
  file: z.string().refine(isSafeRelativePath, 'unsafe asset path'),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: int.min(0),
  mime: z.string().max(100),
  info: MediaInfoSchema.nullable(),
  importedAt: z.string(),
});

/* -------------------------------------------------------------------- clips */

export const PROCEDURAL_TYPES = [
  'pulse',
  'fade',
  'scale',
  'rotate',
  'scroll',
  'flicker',
  'colorCycle',
  'glow',
  'shimmer',
  'distort',
  'duplicate',
] as const;
export type ProceduralType = (typeof PROCEDURAL_TYPES)[number];

export const ProceduralSchema = z.object({
  type: z.enum(PROCEDURAL_TYPES),
  frames: int.min(2).max(256),
  /** 0..2, meaning depends on type (amplitude of the effect). */
  intensity: num.min(0).max(2),
  /** Cycles per clip (how many times the motion repeats across all frames). */
  cycles: num.min(0.25).max(16),
  seed: int.min(0).max(0xffffffff),
});

export const KeyingModeSchema = z.enum(['none', 'black', 'white', 'chroma']);

export const ClipSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  assetId: z.string().min(1).max(64).nullable(),
  extract: z.object({
    startSec: num.min(0),
    endSec: num.min(0).nullable(),
    fps: num.min(0.1).max(120),
    frameSkip: int.min(0).max(64),
    maxFrames: int.min(1).max(1024),
    width: int.min(1).max(8192).nullable(),
    height: int.min(1).max(8192).nullable(),
    keepAspect: z.boolean(),
    interpolation: z.enum(['none', 'blend']),
  }),
  playback: z.object({
    reverse: z.boolean(),
    pingPong: z.boolean(),
    loop: z.boolean(),
    speed: num.min(0.05).max(16),
  }),
  keying: z.object({
    mode: KeyingModeSchema,
    /** Key colour in 0..1 sRGB — only used by `chroma`. */
    color: z.tuple([unit, unit, unit]),
    tolerance: unit,
    feather: unit,
    despill: z.boolean(),
    keepSourceAlpha: z.boolean(),
  }),
  adjust: z.object({
    brightness: num.min(-1).max(1),
    contrast: num.min(-1).max(1),
    saturation: num.min(-1).max(1),
    hue: num.min(-180).max(180),
    sharpen: num.min(0).max(3),
    glowAmount: num.min(0).max(2),
    glowRadius: num.min(0).max(64),
    motionBlurSamples: int.min(1).max(8),
    motionBlurStrength: unit,
  }),
  crop: z.object({
    auto: z.boolean(),
    margin: int.min(0).max(256),
  }),
  procedural: ProceduralSchema.nullable(),
  /** Explicit ordering after extraction/processing. `null` = natural order. */
  frames: z
    .array(z.object({ src: int.min(0), hold: num.min(0.05).max(64) }))
    .max(4096)
    .nullable(),
});

/* ------------------------------------------------------------------- sheets */

export const DdsFormatSchema = z.enum(['BC3', 'BC1', 'BGRA8']);
export type DdsFormat = z.infer<typeof DdsFormatSchema>;

export const SheetSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  clipId: z.string().min(1).max(64),
  grid: z.object({ cols: int.min(1).max(64), rows: int.min(1).max(64) }),
  texture: z.object({ width: int.min(16).max(8192), height: int.min(16).max(8192) }),
  order: z.enum(['row-major', 'column-major']),
  padding: int.min(0).max(64),
  extrude: int.min(0).max(16),
  fit: z.enum(['contain', 'cover', 'stretch']),
  trim: z.boolean(),
  center: z.boolean(),
  /** Inclusive frame range of the clip to use, or null for all. */
  range: z.object({ start: int.min(0), end: int.min(0) }).nullable(),
  dds: z.object({ format: DdsFormatSchema, mipmaps: z.boolean() }),
  /** In-game texture name: lowercase identifier (becomes the DDS/texture dictionary entry). */
  textureName: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
  /** Playback fps this sheet was authored for (informational + default for emitters). */
  fps: num.min(0.1).max(120),
});

/* ----------------------------------------------------------------- emitters */

export const BLEND_MODES = ['additive', 'alpha', 'premultiplied'] as const;
export const SHAPES = ['point', 'box', 'sphere', 'circle', 'cone', 'directional'] as const;
export const ORIENTATIONS = ['billboard', 'velocity', 'aligned'] as const;
export const TRIGGER_EVENTS = ['equipped', 'fired', 'reloaded', 'switched', 'idle', 'manual'] as const;
export type TriggerEvent = (typeof TRIGGER_EVENTS)[number];

export const EmitterSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  enabled: z.boolean(),
  sheetId: z.string().min(1).max(64).nullable(),
  blend: z.enum(BLEND_MODES),
  seed: int.min(0).max(0xffffffff),
  emission: z.object({
    mode: z.enum(['continuous', 'burst', 'oneShot']),
    rate: num.min(0).max(5000),
    burstCount: int.min(0).max(5000),
    /** Seconds between bursts (burst mode). */
    interval: num.min(0.01).max(60),
    lifetime: RangeSchema,
    startDelay: num.min(0).max(60),
    duration: num.min(0.05).max(600),
    loop: z.boolean(),
    maxParticles: int.min(1).max(20000),
  }),
  shape: z.object({
    type: z.enum(SHAPES),
    size: Vec3Schema,
    radius: num.min(0),
    /** Cone half-angle in degrees. */
    angle: num.min(0).max(89),
    fromShell: z.boolean(),
  }),
  particle: z.object({
    size: RangeSchema,
    aspect: num.min(0.05).max(20),
    sizeOverLife: CurveSchema,
    color: RgbaSchema,
    colorOverLife: GradientSchema,
    alphaOverLife: CurveSchema,
    rotation: RangeSchema,
    angularVelocity: RangeSchema,
    orientation: z.enum(ORIENTATIONS),
    /** Preview-only HDR multiplier. NOT representable in a YPT without a light/emissive behaviour. */
    glow: num.min(0).max(8),
    trail: z.object({ enabled: z.boolean(), length: int.min(2).max(32), fade: unit }),
  }),
  physics: z.object({
    speed: RangeSchema,
    direction: Vec3Schema,
    spread: num.min(0).max(180),
    randomness: unit,
    acceleration: Vec3Schema,
    gravity: num.min(-5).max(5),
    drag: num.min(0).max(20),
    turbulence: z.object({ strength: num.min(0).max(20), frequency: num.min(0).max(20) }),
    attractor: z.object({ enabled: z.boolean(), position: Vec3Schema, strength: num.min(-100).max(100) }),
    drift: Vec3Schema,
    speedOverLife: CurveSchema,
  }),
  animation: z.object({
    mode: z.enum(['overLife', 'fps', 'fixed']),
    fps: num.min(0.1).max(120),
    startFrame: int.min(0),
    endFrame: int.min(0).nullable(),
    loop: z.boolean(),
    randomStart: z.boolean(),
    blendFrames: z.boolean(),
  }),
  transform: z.object({
    position: Vec3Schema,
    rotation: Vec3Schema,
    scale: Vec3Schema,
    space: z.enum(['local', 'world']),
  }),
  attachmentId: z.string().max(64).nullable(),
  triggers: z.array(z.enum(TRIGGER_EVENTS)).max(TRIGGER_EVENTS.length),
});

export const EffectSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  /** Effect rule name inside the YPT, lowercase identifier. */
  ptfxName: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
  emitters: z.array(EmitterSchema).max(32),
});

/* ------------------------------------------------------------------- weapon */

export const WEAPON_PRESETS = ['pistol', 'smg', 'rifle', 'shotgun', 'sniper', 'custom'] as const;
export const ATTACHMENT_KINDS = ['barrel', 'muzzle', 'slide', 'magazine', 'receiver', 'trigger', 'grip', 'custom'] as const;
export const ENVIRONMENTS = ['darkStudio', 'neutralStudio', 'daylight', 'night', 'firstPerson', 'thirdPerson'] as const;

export const AttachmentPointSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  kind: z.enum(ATTACHMENT_KINDS),
  /** Weapon-local metres. */
  position: Vec3Schema,
  /** Weapon-local XYZ Euler degrees. */
  rotation: Vec3Schema,
  /** Optional GTA weapon bone / component name the runtime script attaches to. */
  gtaBone: z.string().max(64).nullable(),
});

export const WeaponSchema = z.object({
  preset: z.enum(WEAPON_PRESETS),
  modelAssetId: z.string().max(64).nullable(),
  /** Uniform scale applied to an imported model so 1 unit = 1 metre. */
  modelScale: num.min(0.0001).max(1000),
  attachments: z.array(AttachmentPointSchema).max(64),
  environment: z.enum(ENVIRONMENTS),
});

/* ------------------------------------------------------------------- export */

export const ExportTargetSchema = z.enum(['fivem-legacy', 'fivem-enhanced']);

export const ExportSettingsSchema = z.object({
  resourceName: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
  /** Name of the PTFX asset (`<assetName>.ypt`) requested by the Lua script. */
  assetName: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
  target: ExportTargetSchema,
  /** Weapon names (e.g. WEAPON_PISTOL) the runtime script reacts to; empty = any weapon. */
  weapons: z.array(z.string().regex(/^WEAPON_[A-Z0-9_]{1,48}$/)).max(64),
  /** Build strategy for the YPT payload. */
  yptStrategy: z.enum(['generate', 'donor']),
  author: z.string().max(80),
});

/* ---------------------------------------------------------------- document */

export const ProjectSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  createdAt: z.string(),
  modifiedAt: z.string(),
  assets: z.record(z.string(), AssetSchema),
  clips: z.record(z.string(), ClipSchema),
  sheets: z.record(z.string(), SheetSchema),
  effects: z.record(z.string(), EffectSchema),
  weapon: WeaponSchema,
  export: ExportSettingsSchema,
});

export type Vec3T = z.infer<typeof Vec3Schema>;
export type Asset = z.infer<typeof AssetSchema>;
export type MediaInfo = z.infer<typeof MediaInfoSchema>;
export type Clip = z.infer<typeof ClipSchema>;
export type Procedural = z.infer<typeof ProceduralSchema>;
export type Sheet = z.infer<typeof SheetSchema>;
export type Emitter = z.infer<typeof EmitterSchema>;
export type Effect = z.infer<typeof EffectSchema>;
export type AttachmentPoint = z.infer<typeof AttachmentPointSchema>;
export type Weapon = z.infer<typeof WeaponSchema>;
export type ExportSettings = z.infer<typeof ExportSettingsSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type BlendMode = (typeof BLEND_MODES)[number];

export type ParseResult = { ok: true; project: Project } | { ok: false; errors: string[] };

/**
 * Parses and validates untrusted project JSON. Besides the structural schema it
 * checks referential integrity (clip -> asset, sheet -> clip, emitter -> sheet).
 */
export function parseProject(json: unknown): ParseResult {
  const parsed = ProjectSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  const project = parsed.data;
  const errors = checkIntegrity(project);
  return errors.length ? { ok: false, errors } : { ok: true, project };
}

export function checkIntegrity(p: Project): string[] {
  const errors: string[] = [];
  for (const [key, a] of Object.entries(p.assets)) if (a.id !== key) errors.push(`assets.${key}: id mismatch`);
  for (const [key, c] of Object.entries(p.clips)) {
    if (c.id !== key) errors.push(`clips.${key}: id mismatch`);
    if (c.assetId !== null && !p.assets[c.assetId]) errors.push(`clips.${key}: missing asset ${c.assetId}`);
  }
  for (const [key, s] of Object.entries(p.sheets)) {
    if (s.id !== key) errors.push(`sheets.${key}: id mismatch`);
    if (!p.clips[s.clipId]) errors.push(`sheets.${key}: missing clip ${s.clipId}`);
  }
  const attachmentIds = new Set(p.weapon.attachments.map((a) => a.id));
  for (const [key, e] of Object.entries(p.effects)) {
    if (e.id !== key) errors.push(`effects.${key}: id mismatch`);
    for (const em of e.emitters) {
      if (em.sheetId !== null && !p.sheets[em.sheetId]) errors.push(`effects.${key}.${em.name}: missing sheet ${em.sheetId}`);
      if (em.attachmentId !== null && !attachmentIds.has(em.attachmentId)) errors.push(`effects.${key}.${em.name}: missing attachment ${em.attachmentId}`);
    }
  }
  if (p.weapon.modelAssetId !== null && !p.assets[p.weapon.modelAssetId]) errors.push(`weapon: missing model asset ${p.weapon.modelAssetId}`);
  return errors;
}
