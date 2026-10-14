import { constantCurve, linearCurve } from '../math/curve';
import { sanitizeIdentifier } from '../safety';
import {
  SCHEMA_VERSION,
  type Asset,
  type AttachmentPoint,
  type Clip,
  type Effect,
  type Emitter,
  type Project,
  type Sheet,
} from './schema';

let idCounter = 0;

/** Collision-resistant id. Uses crypto.randomUUID when available, otherwise a counter fallback. */
export function newId(prefix = 'id'): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const core = c?.randomUUID ? c.randomUUID().replace(/-/g, '').slice(0, 16) : `${Date.now().toString(36)}${(idCounter++).toString(36)}`;
  return `${prefix}_${core}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function createProject(name = 'Untitled Effect'): Project {
  const safe = sanitizeIdentifier(name, 'vfxforge_weapon_effect');
  const ts = nowIso();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newId('proj'),
    name,
    createdAt: ts,
    modifiedAt: ts,
    assets: {},
    clips: {},
    sheets: {},
    effects: {},
    weapon: {
      preset: 'pistol',
      modelAssetId: null,
      modelScale: 1,
      modelRotation: [0, 0, 0],
      attachments: [],
      environment: 'darkStudio',
    },
    export: {
      resourceName: safe,
      assetName: safe.slice(0, 40) + '_fx',
      target: 'fivem-legacy',
      weapons: [],
      yptStrategy: 'generate',
      author: '',
    },
  };
}

export function createClip(name: string, assetId: string | null): Clip {
  return {
    id: newId('clip'),
    name,
    assetId,
    extract: {
      startSec: 0,
      endSec: null,
      fps: 16,
      frameSkip: 0,
      maxFrames: 16,
      width: null,
      height: null,
      keepAspect: true,
      interpolation: 'none',
    },
    playback: { reverse: false, pingPong: false, loop: true, speed: 1 },
    keying: { mode: 'none', color: [0, 1, 0], tolerance: 0.25, feather: 0.1, despill: true, keepSourceAlpha: true },
    adjust: {
      brightness: 0,
      contrast: 0,
      saturation: 0,
      hue: 0,
      sharpen: 0,
      glowAmount: 0,
      glowRadius: 6,
      motionBlurSamples: 1,
      motionBlurStrength: 0,
    },
    crop: { auto: false, margin: 2 },
    procedural: null,
    generator: null,
    frames: null,
  };
}

export function createSheet(name: string, clipId: string): Sheet {
  return {
    id: newId('sheet'),
    name,
    clipId,
    grid: { cols: 4, rows: 4 },
    texture: { width: 1024, height: 1024 },
    order: 'row-major',
    padding: 0,
    extrude: 0,
    fit: 'contain',
    trim: false,
    center: true,
    range: null,
    dds: { format: 'BC3', mipmaps: false },
    textureName: sanitizeIdentifier(name, 'vfxforge_sheet'),
    fps: 16,
  };
}

export function createEmitter(name = 'Emitter', sheetId: string | null = null): Emitter {
  return {
    id: newId('em'),
    name,
    enabled: true,
    sheetId,
    blend: 'additive',
    seed: Math.floor(Math.random() * 0xffffffff),
    emission: {
      mode: 'continuous',
      rate: 40,
      burstCount: 12,
      interval: 0.5,
      lifetime: { min: 0.35, max: 0.6 },
      startDelay: 0,
      duration: 2,
      loop: true,
      maxParticles: 400,
    },
    shape: { type: 'cone', size: [0.02, 0.02, 0.02], radius: 0.01, angle: 12, fromShell: false },
    particle: {
      size: { min: 0.08, max: 0.14 },
      aspect: 1,
      sizeOverLife: linearCurve([[0, 0.4], [0.2, 1], [1, 0.6]], 'smooth'),
      color: [1, 1, 1, 1],
      colorOverLife: {
        stops: [
          { t: 0, color: [1, 1, 1, 1] },
          { t: 1, color: [1, 1, 1, 1] },
        ],
      },
      alphaOverLife: linearCurve([[0, 0], [0.1, 1], [0.7, 0.8], [1, 0]], 'smooth'),
      rotation: { min: 0, max: 360 },
      angularVelocity: { min: -30, max: 30 },
      orientation: 'billboard',
      glow: 1,
      trail: { enabled: false, length: 8, fade: 0.8 },
    },
    physics: {
      speed: { min: 0.4, max: 1.2 },
      direction: [0, 1, 0],
      spread: 10,
      randomness: 0.2,
      acceleration: [0, 0, 0],
      gravity: 0,
      drag: 0.4,
      turbulence: { strength: 0, frequency: 1 },
      attractor: { enabled: false, position: [0, 0, 0], strength: 0 },
      drift: [0, 0, 0],
      speedOverLife: constantCurve(1),
    },
    animation: {
      mode: 'overLife',
      fps: 16,
      startFrame: 0,
      endFrame: null,
      loop: true,
      randomStart: false,
      blendFrames: true,
    },
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], space: 'local' },
    attachmentId: null,
    triggers: ['fired'],
  };
}

export function createEffect(name = 'Effect'): Effect {
  return {
    id: newId('fx'),
    name,
    ptfxName: sanitizeIdentifier(name, 'custom_fx'),
    emitters: [],
  };
}

export function createAttachment(kind: AttachmentPoint['kind'], name?: string): AttachmentPoint {
  return {
    id: newId('att'),
    name: name ?? kind[0]!.toUpperCase() + kind.slice(1),
    kind,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    gtaBone: null,
  };
}

export function createAsset(partial: Omit<Asset, 'id' | 'importedAt'> & { id?: string }): Asset {
  return { ...partial, id: partial.id ?? newId('asset'), importedAt: nowIso() };
}
