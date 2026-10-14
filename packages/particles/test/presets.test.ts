import { PRESET_CATEGORIES_EXPECTED } from './helpers';
import { parseProject, createProject, startsLooped, SPRITE_KINDS, type Generator } from '@vfxforge/core';
import { meanAbsDiff, type RgbaImage } from '@vfxforge/media';
import { describe, expect, it } from 'vitest';
import { PRESETS, PRESET_CATEGORIES, ParticleSim, createInstanceBuffers, findPreset, generateSpriteFrames, instantiatePreset, presetsByCategory } from '../src';

const gen = (id: string, over: Partial<Generator> = {}): Generator => {
  const inst = instantiatePreset(findPreset(id)!, { seed: 99, frameSize: 64 });
  return { ...inst.clip.generator!, ...over };
};

function stats(img: RgbaImage) {
  let visible = 0;
  let strong = 0;
  let r = 0, g = 0, b = 0, w = 0;
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    const a = img.data[i * 4 + 3]! / 255;
    if (a > 0.04) visible++;
    if (a > 0.5) strong++;
    r += img.data[i * 4]! * a;
    g += img.data[i * 4 + 1]! * a;
    b += img.data[i * 4 + 2]! * a;
    w += a;
  }
  return { visible: visible / n, strong: strong / n, mean: w > 0 ? [r / w / 255, g / w / 255, b / w / 255] : [0, 0, 0] };
}

describe('preset library', () => {
  it('has the six requested categories with five editable presets each', () => {
    expect(PRESET_CATEGORIES).toEqual(PRESET_CATEGORIES_EXPECTED);
    expect(PRESETS).toHaveLength(30);
    const by = presetsByCategory();
    for (const c of PRESET_CATEGORIES) expect(by[c], c).toHaveLength(5);
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(30);
    expect(new Set(PRESETS.map((p) => p.name)).size).toBe(30);
  });

  it('contains every preset named in the brief', () => {
    const names = PRESETS.map((p) => p.name);
    for (const n of ['Purple Flames', 'Blue Hellfire', 'Red Inferno', 'Ghost Fire', 'Dark Flames', 'Lightning Arcs', 'Blue Electricity', 'Purple Plasma', 'Electric Sparks', 'Pulsing Energy', 'Dark Smoke', 'Toxic Green Smoke', 'Purple Mist', 'Ghost Smoke', 'Magical Smoke', 'Floating Runes', 'Glowing Symbols', 'Energy Aura', 'Magical Particles', 'Mystic Embers', 'Blood Mist', 'Haunted Aura', 'Red Spectral Glow', 'Ghost Particles', 'Dark Energy', 'Plasma Bursts', 'Neon Particles', 'Holographic Effects', 'Reactor Glow', 'Cyberpunk Energy']) {
      expect(names, n).toContain(n);
    }
  });

  it('every preset instantiates into a valid, self-consistent project fragment', () => {
    for (const p of PRESETS) {
      const inst = instantiatePreset(p, { seed: 5 });
      const proj = createProject('t');
      proj.clips[inst.clip.id] = inst.clip;
      proj.sheets[inst.sheet.id] = inst.sheet;
      proj.effects[inst.effect.id] = inst.effect;
      const r = parseProject(JSON.parse(JSON.stringify(proj)));
      expect(r.ok, `${p.id}: ${r.ok ? '' : r.errors.join('; ')}`).toBe(true);
      // grid really holds the frames and the texture is a clean multiple
      expect(inst.sheet.grid.cols * inst.sheet.grid.rows).toBe(inst.clip.generator!.frames);
      expect(inst.sheet.texture.width % inst.sheet.grid.cols).toBe(0);
      expect(inst.effect.emitters[0]!.sheetId).toBe(inst.sheet.id);
      expect(inst.effect.emitters[0]!.triggers).toEqual(p.triggers);
    }
  });

  it('can be instantiated twice without id/name clashes', () => {
    const a = instantiatePreset(PRESETS[0]!, { uniqueSuffix: 'a' });
    const b = instantiatePreset(PRESETS[0]!, { uniqueSuffix: 'b' });
    expect(a.sheet.textureName).not.toBe(b.sheet.textureName);
    expect(a.effect.ptfxName).not.toBe(b.effect.ptfxName);
    expect(a.clip.id).not.toBe(b.clip.id);
  });

  it('idle/aura presets are looped continuous emitters; trigger presets are one-shot starts', () => {
    for (const p of PRESETS) {
      const e = instantiatePreset(p).effect.emitters[0]!;
      if (p.triggers.includes('idle')) expect(startsLooped(e), `${p.id} should loop`).toBe(true);
      if (p.triggers.includes('fired') && e.emission.mode === 'burst') expect(startsLooped(e), `${p.id} burst`).toBe(false);
    }
  });

  it('every preset emitter actually simulates and renders particles', () => {
    for (const p of PRESETS) {
      const inst = instantiatePreset(p, { seed: 3 });
      const sim = new ParticleSim(inst.effect.emitters[0]!, { frameCount: 16, seed: 3 });
      for (let i = 0; i < 90; i++) sim.step(1 / 60);
      expect(sim.totalSpawned, p.id).toBeGreaterThan(0);
      const out = createInstanceBuffers(sim.capacity);
      const n = sim.fill(out);
      for (let i = 0; i < n * 4; i++) expect(Number.isFinite(out.color[i]!), `${p.id} colour`).toBe(true);
    }
  });
});

describe('procedural sprite art', () => {
  it('every preset produces visible, non-degenerate, non-saturated frames', () => {
    for (const p of PRESETS) {
      const frames = generateSpriteFrames(gen(p.id));
      expect(frames).toHaveLength(16);
      for (const f of [0, 7, 15]) {
        const s = stats(frames[f]!);
        expect(s.visible, `${p.id} frame ${f} has art`).toBeGreaterThan(0.01);
        expect(s.visible, `${p.id} frame ${f} is not a solid block`).toBeLessThan(0.9);
        expect(frames[f]!.width).toBe(64);
      }
    }
  });

  it('corners are transparent (sprites fade out before the cell edge, so they tile cleanly in an atlas)', () => {
    for (const p of PRESETS) {
      const f = generateSpriteFrames(gen(p.id, { frames: 4 }))[1]!;
      for (const [x, y] of [[0, 0], [63, 0], [0, 63], [63, 63]] as const) expect(f.data[(y * 64 + x) * 4 + 3], `${p.id} corner`).toBeLessThan(30);
    }
  });

  it('colours stay inside the preset palette (no stray hues)', () => {
    for (const p of PRESETS) {
      const g = gen(p.id);
      const frames = generateSpriteFrames(g);
      const m = stats(frames[5]!).mean;
      for (let c = 0; c < 3; c++) {
        const lo = Math.min(...g.palette.map((x) => x[c]!)) - 0.12;
        const hi = Math.max(...g.palette.map((x) => x[c]!)) + 0.12;
        expect(m[c]!, `${p.id} channel ${c}: ${m[c]!.toFixed(2)} not in [${lo.toFixed(2)}, ${hi.toFixed(2)}]`).toBeGreaterThanOrEqual(lo);
        expect(m[c]!).toBeLessThanOrEqual(hi);
      }
    }
  });

  it('is deterministic for a seed and different for another', () => {
    const a = generateSpriteFrames(gen('red_inferno', { frames: 4 }));
    const b = generateSpriteFrames(gen('red_inferno', { frames: 4 }));
    const c = generateSpriteFrames(gen('red_inferno', { frames: 4, seed: 12345 }));
    expect(meanAbsDiff(a[2]!, b[2]!)).toBe(0);
    expect(meanAbsDiff(a[2]!, c[2]!)).toBeGreaterThan(0.5);
  });

  it('frames animate (consecutive frames differ) and loops are seamless (last -> first is no outlier)', () => {
    // lightning re-rolls its bolts every frame by design, so it is excluded from the seam test
    const looping = PRESETS.filter((p) => p.generator.kind !== 'lightning');
    for (const p of looping) {
      const frames = generateSpriteFrames(gen(p.id));
      const diffs = frames.slice(1).map((f, i) => meanAbsDiff(frames[i]!, f));
      const typical = diffs.reduce((s, d) => s + d, 0) / diffs.length;
      const seam = meanAbsDiff(frames[15]!, frames[0]!);
      if (p.generator.kind !== 'glow') expect(typical, `${p.id} animates`).toBeGreaterThan(0.05);
      expect(seam, `${p.id}: loop seam ${seam.toFixed(2)} vs typical step ${typical.toFixed(2)}`).toBeLessThanOrEqual(typical * 2.6 + 0.3);
    }
  });

  it('lightning re-rolls its bolts every frame', () => {
    const f = generateSpriteFrames(gen('lightning_arcs', { frames: 4 }));
    expect(meanAbsDiff(f[0]!, f[1]!)).toBeGreaterThan(1);
  });

  it('generation is fast enough to preview interactively', () => {
    const t0 = performance.now();
    generateSpriteFrames({ ...gen('purple_flames'), size: 128, frames: 16 });
    expect(performance.now() - t0).toBeLessThan(4000);
  });
});


describe('sprite borders', () => {
  it.each(SPRITE_KINDS)('%s: every frame has a fully transparent border and keeps its interior', (kind) => {
    const frames = generateSpriteFrames({ kind, palette: [[0.1, 0, 0.2], [1, 0.6, 0.2], [1, 1, 1]], frames: 4, size: 64, seed: 11, intensity: 1.3 });
    for (const f of frames) {
      let borderMax = 0;
      let interiorMax = 0;
      for (let y = 0; y < f.height; y++) {
        for (let x = 0; x < f.width; x++) {
          const a = f.data[(y * f.width + x) * 4 + 3]!;
          if (x === 0 || y === 0 || x === f.width - 1 || y === f.height - 1) borderMax = Math.max(borderMax, a);
          else interiorMax = Math.max(interiorMax, a);
        }
      }
      expect(borderMax).toBe(0);
      expect(interiorMax).toBeGreaterThan(40); // the art itself survives the fade
    }
  });
});
