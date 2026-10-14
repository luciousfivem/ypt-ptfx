/**
 * Effect preset library: 30 editable presets in six categories.
 *
 * Each preset is a recipe, not a baked asset: a procedural sprite generator (original art, free to
 * distribute) plus emitter tuning. Instantiating a preset yields ordinary project entities
 * (clip + sheet + effect) that the user can edit like anything else.
 */
import {
  createClip,
  createEffect,
  createEmitter,
  createSheet,
  linearCurve,
  newId,
  sanitizeIdentifier,
  type Clip,
  type Effect,
  type Emitter,
  type Generator,
  type Sheet,
  type SpriteKind,
  type TriggerEvent,
} from '@vfxforge/core';

export type PresetCategory = 'Fire' | 'Electricity' | 'Smoke' | 'Fantasy' | 'Horror' | 'Sci-fi';
export const PRESET_CATEGORIES: PresetCategory[] = ['Fire', 'Electricity', 'Smoke', 'Fantasy', 'Horror', 'Sci-fi'];

type Rgb = [number, number, number];

export interface Preset {
  id: string;
  name: string;
  category: PresetCategory;
  description: string;
  tags: string[];
  generator: Omit<Generator, 'seed' | 'frames' | 'size'> & Partial<Pick<Generator, 'frames' | 'size'>>;
  /** Tunes a fresh emitter. */
  tune: (e: Emitter) => void;
  triggers: TriggerEvent[];
}

interface Style {
  rate?: number;
  burst?: number;
  mode?: Emitter['emission']['mode'];
  life?: [number, number];
  size?: [number, number];
  speed?: [number, number];
  /** emission direction in emitter space: 'up' (+Y) or 'forward' (-Z, down the barrel) */
  dir?: 'up' | 'forward';
  spread?: number;
  gravity?: number;
  drag?: number;
  turbulence?: number;
  blend?: Emitter['blend'];
  glow?: number;
  rotation?: [number, number];
  spin?: [number, number];
  duration?: number;
  fps?: number;
  loop?: boolean;
  /** alpha envelope: [fade-in end, fade-out start] */
  fade?: [number, number];
  grow?: number;
  tint?: [number, number, number, number];
}

function style(s: Style): (e: Emitter) => void {
  return (e) => {
    const mode = s.mode ?? 'continuous';
    e.emission.mode = mode;
    e.emission.rate = s.rate ?? 24;
    e.emission.burstCount = s.burst ?? 8;
    e.emission.lifetime = { min: s.life?.[0] ?? 0.5, max: s.life?.[1] ?? 0.8 };
    e.emission.duration = s.duration ?? 2;
    e.emission.loop = s.loop ?? mode === 'continuous';
    e.emission.interval = 0.5;
    e.emission.maxParticles = 300;
    e.shape = { type: 'cone', size: [0.02, 0.02, 0.02], radius: 0.01, angle: 6, fromShell: false };
    e.particle.size = { min: s.size?.[0] ?? 0.14, max: s.size?.[1] ?? 0.22 };
    e.particle.sizeOverLife = linearCurve(
      [
        [0, 0.35],
        [0.25, 1],
        [1, 1 + (s.grow ?? 0.15)],
      ],
      'smooth',
    );
    const [fi, fo] = s.fade ?? [0.12, 0.65];
    e.particle.alphaOverLife = linearCurve(
      [
        [0, 0],
        [fi, 1],
        [fo, 0.85],
        [1, 0],
      ],
      'smooth',
    );
    e.particle.rotation = { min: s.rotation?.[0] ?? 0, max: s.rotation?.[1] ?? 360 };
    e.particle.angularVelocity = { min: s.spin?.[0] ?? -25, max: s.spin?.[1] ?? 25 };
    e.particle.glow = s.glow ?? 1;
    e.particle.color = s.tint ?? [1, 1, 1, 1];
    e.physics.direction = s.dir === 'forward' ? [0, 0, -1] : [0, 1, 0];
    e.physics.speed = { min: s.speed?.[0] ?? 0.3, max: s.speed?.[1] ?? 0.8 };
    e.physics.spread = s.spread ?? 12;
    e.physics.gravity = s.gravity ?? 0;
    e.physics.drag = s.drag ?? 0.5;
    e.physics.turbulence = { strength: s.turbulence ?? 0, frequency: 1.2 };
    e.blend = s.blend ?? 'additive';
    e.animation = { mode: s.fps ? 'fps' : 'overLife', fps: s.fps ?? 16, startFrame: 0, endFrame: null, loop: true, randomStart: false, blendFrames: true };
  };
}

const P = (
  id: string,
  name: string,
  category: PresetCategory,
  description: string,
  kind: SpriteKind,
  palette: Rgb[],
  st: Style,
  triggers: TriggerEvent[],
  intensity = 1,
  tags: string[] = [],
): Preset => ({ id, name, category, description, tags: [kind, category.toLowerCase(), ...tags], generator: { kind, palette, intensity }, tune: style(st), triggers });

const aura = (over: Style = {}): Style => ({ rate: 10, life: [0.9, 1.4], size: [0.25, 0.4], speed: [0.02, 0.1], spread: 180, drag: 1, glow: 1.4, fade: [0.25, 0.6], ...over });
const risingFlame = (over: Style = {}): Style => ({ rotation: [-8, 8], spin: [-6, 6], rate: 28, life: [0.45, 0.8], size: [0.14, 0.24], speed: [0.35, 0.9], spread: 10, gravity: -0.12, turbulence: 0.6, glow: 1.3, ...over });
const muzzleBurst = (over: Style = {}): Style => ({ mode: 'burst', burst: 3, life: [0.18, 0.32], size: [0.16, 0.26], speed: [0.4, 1.4], dir: 'forward', spread: 10, drag: 2, glow: 1.6, fade: [0.08, 0.5], duration: 0.4, loop: false, ...over });
const driftSmoke = (over: Style = {}): Style => ({ rate: 14, life: [1.0, 1.7], size: [0.22, 0.4], speed: [0.15, 0.4], spread: 20, gravity: -0.05, drag: 0.9, blend: 'alpha', grow: 1.2, fade: [0.2, 0.55], ...over });

export const PRESETS: Preset[] = [
  /* ------------------------------------------------------------------ Fire */
  P('purple_flames', 'Purple Flames', 'Fire', 'Classic arcane flames with a white-violet core.', 'fire', [[0.08, 0, 0.2], [0.45, 0.05, 0.8], [0.85, 0.35, 1], [1, 0.85, 1]], risingFlame(), ['idle'], 1.1),
  P('blue_hellfire', 'Blue Hellfire', 'Fire', 'Hot blue-white fire.', 'fire', [[0, 0.02, 0.15], [0.05, 0.25, 0.9], [0.3, 0.7, 1], [0.9, 1, 1]], risingFlame({ rate: 34, speed: [0.5, 1.1], glow: 1.6 }), ['idle'], 1.15),
  P('red_inferno', 'Red Inferno', 'Fire', 'Roaring orange-red flames.', 'fire', [[0.15, 0, 0], [0.8, 0.05, 0], [1, 0.5, 0.05], [1, 0.95, 0.6]], risingFlame({ rate: 36, size: [0.18, 0.3], turbulence: 1 }), ['idle'], 1.15),
  P('ghost_fire', 'Ghost Fire', 'Fire', 'Pale spectral flames that drift upward.', 'fire', [[0, 0.1, 0.12], [0.2, 0.7, 0.65], [0.7, 1, 0.9], [1, 1, 1]], risingFlame({ speed: [0.2, 0.6], gravity: -0.25, turbulence: 1.2, glow: 1.1 }), ['idle'], 0.95),
  P('dark_flames', 'Dark Flames', 'Fire', 'Black flames with a smouldering red edge.', 'fire', [[0.01, 0, 0.02], [0.2, 0, 0.25], [0.7, 0.05, 0.2], [1, 0.3, 0.25]], risingFlame({ blend: 'alpha', glow: 1 }), ['idle'], 1.2),

  /* ----------------------------------------------------------- Electricity */
  P('lightning_arcs', 'Lightning Arcs', 'Electricity', 'Jagged white-blue bolts.', 'lightning', [[0.1, 0.2, 0.6], [0.5, 0.7, 1], [1, 1, 1]], muzzleBurst({ burst: 2, size: [0.3, 0.5], speed: [0, 0.1], spread: 30, glow: 2.2, fade: [0.05, 0.4], fps: 12 }), ['fired'], 1.2),
  P('blue_electricity', 'Blue Electricity', 'Electricity', 'Crackling cyan electricity around the weapon.', 'lightning', [[0, 0.2, 0.7], [0.2, 0.7, 1], [0.85, 1, 1]], aura({ rate: 6, size: [0.3, 0.5], life: [0.1, 0.22], speed: [0, 0.05], glow: 2, fade: [0.08, 0.3] }), ['idle'], 1.2),
  P('purple_plasma', 'Purple Plasma', 'Electricity', 'Swirling violet plasma ball.', 'plasma', [[0.1, 0, 0.3], [0.6, 0.1, 0.9], [1, 0.6, 1]], aura({ rate: 6, size: [0.2, 0.32], life: [0.7, 1.1], glow: 1.5 }), ['idle']),
  P('electric_sparks', 'Electric Sparks', 'Electricity', 'A burst of hot sparks.', 'sparks', [[1, 0.4, 0.05], [1, 0.85, 0.3], [1, 1, 0.9]], muzzleBurst({ burst: 4, size: [0.2, 0.32], speed: [0.2, 0.7], spread: 40, glow: 2, life: [0.2, 0.4] }), ['fired']),
  P('pulsing_energy', 'Pulsing Energy', 'Electricity', 'A breathing blue energy core.', 'glow', [[0, 0.1, 0.5], [0.2, 0.5, 1], [0.9, 1, 1]], aura({ rate: 3, size: [0.3, 0.42], life: [1.0, 1.4], speed: [0, 0.02], glow: 1.8 }), ['idle']),

  /* ----------------------------------------------------------------- Smoke */
  P('dark_smoke', 'Dark Smoke', 'Smoke', 'Heavy black-grey smoke.', 'smoke', [[0.02, 0.02, 0.02], [0.2, 0.2, 0.22], [0.45, 0.45, 0.48]], driftSmoke(), ['fired'], 1.3),
  P('toxic_green_smoke', 'Toxic Green Smoke', 'Smoke', 'Sickly radioactive-green smoke.', 'smoke', [[0.05, 0.15, 0], [0.3, 0.7, 0.1], [0.7, 1, 0.3]], driftSmoke({ glow: 1.1 }), ['fired'], 1.3),
  P('purple_mist', 'Purple Mist', 'Smoke', 'A low, wide violet haze.', 'mist', [[0.15, 0.02, 0.3], [0.5, 0.2, 0.8], [0.85, 0.6, 1]], driftSmoke({ rate: 10, size: [0.3, 0.5], speed: [0.05, 0.2], blend: 'additive', glow: 1.2 }), ['idle'], 1.1),
  P('ghost_smoke', 'Ghost Smoke', 'Smoke', 'Translucent pale-blue wisps.', 'smoke', [[0.5, 0.6, 0.7], [0.8, 0.9, 1], [1, 1, 1]], driftSmoke({ gravity: -0.15, blend: 'additive', glow: 1 }), ['idle'], 0.9),
  P('magical_smoke', 'Magical Smoke', 'Smoke', 'Shifting violet, pink and cyan smoke.', 'smoke', [[0.3, 0.1, 0.6], [0.9, 0.3, 0.8], [0.4, 0.9, 1]], driftSmoke({ blend: 'additive', glow: 1.3 }), ['fired'], 1.1),

  /* --------------------------------------------------------------- Fantasy */
  P('floating_runes', 'Floating Runes', 'Fantasy', 'A golden rune circle that slowly turns.', 'runes', [[0.6, 0.35, 0.05], [1, 0.75, 0.2], [1, 0.95, 0.7]], aura({ rate: 2, size: [0.35, 0.45], life: [1.4, 2], speed: [0, 0.03], glow: 1.5, fade: [0.2, 0.7] }), ['idle'], 1.1),
  P('glowing_symbols', 'Glowing Symbols', 'Fantasy', 'Cyan sigils that pulse and fade.', 'runes', [[0, 0.3, 0.5], [0.2, 0.8, 1], [0.9, 1, 1]], aura({ rate: 3, size: [0.28, 0.4], life: [0.8, 1.3], glow: 1.7 }), ['equipped']),
  P('energy_aura', 'Energy Aura', 'Fantasy', 'A warm golden halo.', 'glow', [[0.5, 0.25, 0], [1, 0.7, 0.15], [1, 0.95, 0.7]], aura({ rate: 4, size: [0.4, 0.55], life: [1.0, 1.5], glow: 1.6 }), ['idle']),
  P('magical_particles', 'Magical Particles', 'Fantasy', 'Twinkling pastel motes.', 'sparks', [[0.8, 0.4, 1], [1, 0.7, 0.9], [1, 1, 1]], risingFlame({ rate: 16, size: [0.1, 0.18], life: [0.8, 1.3], speed: [0.15, 0.45], spread: 70, gravity: -0.05, glow: 1.8 }), ['idle']),
  P('mystic_embers', 'Mystic Embers', 'Fantasy', 'Drifting orange-violet embers.', 'embers', [[0.5, 0.1, 0.6], [1, 0.45, 0.15], [1, 0.9, 0.5]], risingFlame({ rate: 14, size: [0.12, 0.2], life: [0.9, 1.5], speed: [0.2, 0.55], spread: 45, glow: 1.6 }), ['idle']),

  /* ---------------------------------------------------------------- Horror */
  P('blood_mist', 'Blood Mist', 'Horror', 'A dark red spray that hangs in the air.', 'mist', [[0.15, 0, 0], [0.5, 0.02, 0.02], [0.8, 0.1, 0.1]], driftSmoke({ mode: 'burst', burst: 6, duration: 0.5, loop: false, dir: 'forward', speed: [0.3, 1.0], life: [0.7, 1.2], size: [0.2, 0.34] }), ['fired'], 1.2),
  P('haunted_aura', 'Haunted Aura', 'Horror', 'A faint sickly-green presence.', 'glow', [[0.05, 0.2, 0.1], [0.4, 0.9, 0.5], [0.9, 1, 0.9]], aura({ rate: 5, size: [0.35, 0.5], life: [1.2, 1.8], glow: 1.1 }), ['idle'], 0.9),
  P('red_spectral_glow', 'Red Spectral Glow', 'Horror', 'An ominous crimson glow.', 'glow', [[0.2, 0, 0], [0.9, 0.05, 0.05], [1, 0.5, 0.4]], aura({ rate: 4, size: [0.35, 0.5], life: [1.0, 1.5], glow: 1.4 }), ['idle']),
  P('ghost_particles', 'Ghost Particles', 'Horror', 'Pale specks rising like breath.', 'embers', [[0.6, 0.7, 0.8], [0.85, 0.95, 1], [1, 1, 1]], risingFlame({ rate: 12, size: [0.1, 0.18], life: [1.0, 1.6], speed: [0.1, 0.35], spread: 60, gravity: -0.1, glow: 1.2 }), ['idle'], 0.9),
  P('dark_energy', 'Dark Energy', 'Horror', 'Black-violet plasma edged in red.', 'plasma', [[0.02, 0, 0.05], [0.35, 0, 0.5], [0.9, 0.05, 0.2]], aura({ rate: 5, size: [0.25, 0.38], life: [0.8, 1.2], blend: 'alpha', glow: 1 }), ['idle'], 1.1),

  /* ---------------------------------------------------------------- Sci-fi */
  P('plasma_bursts', 'Plasma Bursts', 'Sci-fi', 'Green-white plasma flashes.', 'plasma', [[0, 0.3, 0.1], [0.2, 1, 0.4], [0.9, 1, 0.9]], muzzleBurst({ burst: 2, size: [0.2, 0.34], speed: [0.2, 0.9], glow: 2 }), ['fired']),
  P('neon_particles', 'Neon Particles', 'Sci-fi', 'Pink and cyan neon sparks.', 'sparks', [[1, 0.1, 0.6], [0.2, 0.9, 1], [1, 1, 1]], muzzleBurst({ burst: 5, size: [0.14, 0.24], speed: [0.3, 1.0], spread: 45, glow: 2.2 }), ['fired']),
  P('holographic_effects', 'Holographic Effects', 'Sci-fi', 'A flickering cyan hologram disc.', 'holo', [[0, 0.2, 0.4], [0.1, 0.8, 1], [0.8, 1, 1]], aura({ rate: 3, size: [0.32, 0.45], life: [0.9, 1.3], glow: 1.5 }), ['idle']),
  P('reactor_glow', 'Reactor Glow', 'Sci-fi', 'A hot, pulsing reactor core.', 'glow', [[0.6, 0.2, 0], [1, 0.55, 0.1], [1, 0.95, 0.7]], aura({ rate: 4, size: [0.3, 0.42], life: [0.8, 1.2], glow: 2 }), ['idle'], 1.2),
  P('cyberpunk_energy', 'Cyberpunk Energy', 'Sci-fi', 'Magenta-to-cyan swirling energy.', 'plasma', [[0.8, 0.05, 0.6], [0.2, 0.5, 1], [0.9, 1, 1]], aura({ rate: 6, size: [0.22, 0.34], life: [0.6, 1.0], glow: 1.8 }), ['idle']),
];

export function presetsByCategory(): Record<PresetCategory, Preset[]> {
  const out = {} as Record<PresetCategory, Preset[]>;
  for (const c of PRESET_CATEGORIES) out[c] = PRESETS.filter((p) => p.category === c);
  return out;
}

export function findPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

export interface InstantiatedPreset {
  clip: Clip;
  sheet: Sheet;
  effect: Effect;
}

export interface InstantiateOptions {
  /** Frames per flipbook (a perfect square: 4, 9, 16, 25 ...). Default 16 -> 4x4. */
  frames?: number;
  /** Pixel size of one frame. Default 128. */
  frameSize?: number;
  seed?: number;
  /** Use unique ids/names so the same preset can be added twice. */
  uniqueSuffix?: string;
}

/** Creates the clip, sheet and effect for a preset. Pure: the caller adds them to the project. */
export function instantiatePreset(preset: Preset, opts: InstantiateOptions = {}): InstantiatedPreset {
  const frames = opts.frames ?? 16;
  const side = Math.round(Math.sqrt(frames));
  const frameSize = opts.frameSize ?? 128;
  const suffix = opts.uniqueSuffix ? `_${opts.uniqueSuffix}` : '';
  const clip = createClip(preset.name, null);
  clip.generator = {
    kind: preset.generator.kind,
    palette: preset.generator.palette,
    frames,
    size: frameSize,
    seed: opts.seed ?? Math.floor(Math.random() * 0xffffffff),
    intensity: preset.generator.intensity,
  };
  clip.extract.fps = 16;
  const sheet = createSheet(preset.name, clip.id);
  sheet.textureName = sanitizeIdentifier(preset.id + suffix);
  const tex = Math.max(16, frameSize * side);
  sheet.texture = { width: tex, height: tex };
  sheet.grid = { cols: side, rows: side };
  sheet.dds = { format: 'BC3', mipmaps: true };
  const effect = createEffect(preset.name);
  effect.ptfxName = sanitizeIdentifier(preset.id + suffix);
  const em = createEmitter(preset.name, sheet.id);
  preset.tune(em);
  em.triggers = [...preset.triggers];
  em.id = newId('em');
  effect.emitters.push(em);
  return { clip, sheet, effect };
}
