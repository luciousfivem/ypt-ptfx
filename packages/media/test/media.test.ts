import { createClip, createSheet } from '@vfxforge/core';
import { encode } from 'fast-png';
import { describe, expect, it } from 'vitest';
import {
  AtlasError,
  PipelineCancelled,
  alphaBounds,
  applyAdjust,
  applyKey,
  bleedTransparentColor,
  buildAtlas,
  buildMipChain,
  colorAdjust,
  cloneImage,
  createImage,
  decodeDds,
  decodePng,
  encodeDds,
  encodePng,
  expandHolds,
  expectedDdsSize,
  fillImage,
  generateProcedural,
  glow,
  imagesEqual,
  meanAbsDiff,
  mipLevelCount,
  processClip,
  psnr,
  resizeImage,
  validateDds,
  type RgbaImage,
} from '../src';

/* ---------------------------------------------------------------- helpers */

function solid(w: number, h: number, r: number, g: number, b: number, a = 255): RgbaImage {
  const img = createImage(w, h);
  fillImage(img, r, g, b, a);
  return img;
}

/** Soft radial "flame" blob on black: orange core fading to black. Straight RGB, opaque. */
function flameOnBlack(size: number, phase = 0): RgbaImage {
  const img = createImage(size, size);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c + Math.sin(phase) * 2) / (size * 0.45);
      const v = Math.max(0, 1 - d);
      const i = (y * size + x) * 4;
      img.data[i] = 255 * v;
      img.data[i + 1] = 120 * v * v;
      img.data[i + 2] = 200 * v * v * v;
      img.data[i + 3] = 255;
    }
  }
  return img;
}

/** Smooth RGB gradient with a soft alpha vignette — representative of a real sprite. */
function gradientSprite(size: number): RgbaImage {
  const img = createImage(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      img.data[i] = (x / size) * 255;
      img.data[i + 1] = (y / size) * 255;
      img.data[i + 2] = 128 + 100 * Math.sin((x + y) / 9);
      const d = Math.hypot(x - size / 2, y - size / 2) / (size / 2);
      img.data[i + 3] = Math.max(0, Math.min(255, (1.15 - d) * 400));
    }
  }
  return img;
}

function compositeOverBlack(img: RgbaImage): RgbaImage {
  const out = createImage(img.width, img.height);
  for (let i = 0; i < img.width * img.height; i++) {
    const a = img.data[i * 4 + 3]! / 255;
    out.data[i * 4] = img.data[i * 4]! * a;
    out.data[i * 4 + 1] = img.data[i * 4 + 1]! * a;
    out.data[i * 4 + 2] = img.data[i * 4 + 2]! * a;
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

function pixel(img: RgbaImage, x: number, y: number): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!];
}

/* ------------------------------------------------------------------ image */

describe('resize', () => {
  it('does not bleed transparent-pixel colour into edges (no dark halo)', () => {
    const img = createImage(8, 8);
    // opaque pure-red 4x4 square in the middle, transparent BLACK elsewhere
    for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) img.data.set([255, 0, 0, 255], (y * 8 + x) * 4);
    const small = resizeImage(img, 3, 3);
    for (let i = 0; i < 9; i++) {
      if (small.data[i * 4 + 3]! > 0) {
        // straight colour must stay pure red wherever there is any coverage
        expect(small.data[i * 4]).toBeGreaterThanOrEqual(254);
        expect(small.data[i * 4 + 1]).toBeLessThanOrEqual(1);
      }
    }
  });

  it('preserves flat colour exactly on up- and down-scale', () => {
    const img = solid(10, 6, 12, 200, 99, 180);
    for (const [w, h] of [[5, 3], [20, 12], [7, 7], [1, 1]] as const) {
      const r = resizeImage(img, w, h);
      expect(pixel(r, 0, 0)).toEqual([12, 200, 99, 180]);
      expect(pixel(r, w - 1, h - 1)).toEqual([12, 200, 99, 180]);
    }
  });

  it('rejects invalid sizes', () => {
    expect(() => resizeImage(solid(2, 2, 0, 0, 0), 0, 4)).toThrow();
    expect(() => createImage(1.5, 2)).toThrow();
  });
});

/* ----------------------------------------------------------------- keying */

describe('black / white / chroma keying', () => {
  const base = { color: [0, 1, 0] as [number, number, number], tolerance: 0, feather: 0, despill: false, keepSourceAlpha: true };

  it('black key: background becomes transparent and compositing over black reproduces the source', () => {
    const src = flameOnBlack(64);
    const keyed = applyKey(src, { ...base, mode: 'black' });
    expect(pixel(keyed, 0, 0)[3]).toBe(0); // corner is pure black
    expect(pixel(keyed, 32, 32)[3]).toBeGreaterThan(240); // hot core is opaque
    // the defining property of the black key:
    expect(meanAbsDiff(compositeOverBlack(keyed), src)).toBeLessThan(1.0);
  });

  it('black key colour recovery: dim pixels keep their hue instead of going muddy', () => {
    const img = solid(2, 1, 50, 25, 0); // dim orange
    const keyed = applyKey(img, { ...base, mode: 'black' });
    const [r, g, , a] = pixel(keyed, 0, 0);
    expect(a).toBeCloseTo(50, -1); // alpha ~ max channel
    expect(r).toBeGreaterThan(250); // colour re-normalised to full brightness
    expect(g / r).toBeCloseTo(0.5, 1); // hue preserved
  });

  it('tolerance removes near-black noise; feather widens the ramp', () => {
    const noise = solid(1, 1, 8, 8, 8);
    expect(pixel(applyKey(noise, { ...base, mode: 'black', tolerance: 0.1 }), 0, 0)[3]).toBe(0);
    expect(pixel(applyKey(noise, { ...base, mode: 'black', tolerance: 0 }), 0, 0)[3]).toBeGreaterThan(0);
    const mid = solid(1, 1, 60, 60, 60);
    const hard = pixel(applyKey(mid, { ...base, mode: 'black', tolerance: 0.2, feather: 0 }), 0, 0)[3];
    const soft = pixel(applyKey(mid, { ...base, mode: 'black', tolerance: 0.2, feather: 0.3 }), 0, 0)[3];
    expect(hard).toBe(60); // above the gate: alpha is the true coverage (60/255), unchanged
    expect(soft).toBeGreaterThan(0); // inside the feather ramp: partially suppressed
    expect(soft).toBeLessThan(hard);
  });

  it('white key: white becomes transparent, saturated colours stay', () => {
    const img = createImage(2, 1);
    img.data.set([255, 255, 255, 255, 255, 0, 0, 255]);
    const keyed = applyKey(img, { ...base, mode: 'white' });
    expect(pixel(keyed, 0, 0)[3]).toBe(0);
    expect(pixel(keyed, 1, 0)).toEqual([255, 0, 0, 255]);
  });

  it('chroma key: green screen removed, other colours kept', () => {
    const img = createImage(3, 1);
    img.data.set([0, 255, 0, 255, 255, 0, 0, 255, 20, 200, 30, 255]);
    const keyed = applyKey(img, { ...base, mode: 'chroma', tolerance: 0.3, feather: 0.1 });
    expect(pixel(keyed, 0, 0)[3]).toBe(0);
    expect(pixel(keyed, 1, 0)[3]).toBe(255);
    expect(pixel(keyed, 2, 0)[3]).toBe(0); // darker green is still "green" in CbCr space
  });

  it('chroma despill suppresses green fringing on kept pixels', () => {
    const img = solid(1, 1, 200, 230, 60); // yellow-green fringe pixel
    const off = pixel(applyKey(img, { ...base, mode: 'chroma', tolerance: 0, feather: 0, despill: false }), 0, 0);
    const on = pixel(applyKey(img, { ...base, mode: 'chroma', tolerance: 0, feather: 0, despill: true }), 0, 0);
    expect(off[1]).toBe(230);
    expect(on[1]).toBeLessThanOrEqual(130); // limited to avg(r, b)
  });

  it('keepSourceAlpha multiplies, and the input is never mutated', () => {
    const img = solid(1, 1, 255, 255, 255, 100);
    const copy = cloneImage(img);
    const k = applyKey(img, { ...base, mode: 'black', keepSourceAlpha: true });
    expect(pixel(k, 0, 0)[3]).toBe(100);
    expect(pixel(applyKey(img, { ...base, mode: 'black', keepSourceAlpha: false }), 0, 0)[3]).toBe(255);
    expect(imagesEqual(img, copy)).toBe(true);
  });

  it('mode none returns an equal but distinct copy', () => {
    const img = flameOnBlack(8);
    const k = applyKey(img, { ...base, mode: 'none' });
    expect(imagesEqual(k, img)).toBe(true);
    expect(k.data).not.toBe(img.data);
  });
});

/* ----------------------------------------------------------------- adjust */

describe('adjust', () => {
  it('identity parameters are a no-op', () => {
    const img = flameOnBlack(16);
    expect(imagesEqual(applyAdjust(img, { brightness: 0, contrast: 0, saturation: 0, hue: 0, sharpen: 0, glowAmount: 0, glowRadius: 6 }), img, 1)).toBe(true);
  });

  it('brightness shifts, full desaturation yields gray, alpha is untouched', () => {
    const img = solid(1, 1, 200, 100, 50, 77);
    expect(pixel(colorAdjust(img, { brightness: 0.1, contrast: 0, saturation: 0, hue: 0 }), 0, 0)).toEqual([226, 126, 76, 77]);
    const g = pixel(colorAdjust(img, { brightness: 0, contrast: 0, saturation: -1, hue: 0 }), 0, 0);
    expect(g[0]).toBe(g[1]);
    expect(g[1]).toBe(g[2]);
    expect(g[3]).toBe(77);
  });

  it('hue rotation moves red toward green by 120 degrees and preserves luma roughly', () => {
    const r = pixel(colorAdjust(solid(1, 1, 255, 0, 0), { brightness: 0, contrast: 0, saturation: 0, hue: 120 }), 0, 0);
    expect(r[1]).toBeGreaterThan(r[0]);
    expect(r[1]).toBeGreaterThan(r[2]);
    const b = pixel(colorAdjust(solid(1, 1, 255, 0, 0), { brightness: 0, contrast: 0, saturation: 0, hue: 240 }), 0, 0);
    expect(b[2]).toBeGreaterThan(b[0]); // 240 degrees -> blue
    expect(pixel(colorAdjust(solid(1, 1, 90, 160, 30), { brightness: 0, contrast: 0, saturation: 0, hue: 360 }), 0, 0)).toEqual([90, 160, 30, 255]);
  });

  it('glow adds light around a bright dot without moving the dot', () => {
    const img = createImage(33, 33);
    img.data.set([255, 200, 100, 255], (16 * 33 + 16) * 4);
    const g = glow(img, 1, 6);
    expect(pixel(g, 16, 16)[3]).toBe(255);
    expect(pixel(g, 20, 16)[3]).toBeGreaterThan(0); // halo
    expect(pixel(img, 20, 16)[3]).toBe(0);
  });
});

/* ------------------------------------------------------------- procedural */

describe('procedural animation', () => {
  const base = flameOnBlack(32);
  const params = { frames: 8, intensity: 1, cycles: 1, seed: 7 };

  it('produces the requested number of frames of the same size for every type', () => {
    for (const type of ['pulse', 'fade', 'scale', 'rotate', 'scroll', 'flicker', 'colorCycle', 'glow', 'shimmer', 'distort', 'duplicate'] as const) {
      const frames = generateProcedural(base, { ...params, type });
      expect(frames).toHaveLength(8);
      for (const f of frames) expect([f.width, f.height]).toEqual([32, 32]);
    }
  });

  it('actually animates (frames differ) for every type except duplicate', () => {
    for (const type of ['pulse', 'fade', 'scale', 'rotate', 'scroll', 'flicker', 'colorCycle', 'glow', 'shimmer', 'distort'] as const) {
      const frames = generateProcedural(base, { ...params, type });
      const distinct = frames.some((f, i) => i > 0 && meanAbsDiff(f, frames[0]!) > 0.05);
      expect(distinct, type).toBe(true);
    }
    const dup = generateProcedural(base, { ...params, type: 'duplicate' });
    expect(dup.every((f) => imagesEqual(f, base))).toBe(true);
  });

  it('is deterministic for a seed and loops seamlessly (frame 0 == identity pose)', () => {
    const a = generateProcedural(base, { ...params, type: 'flicker' });
    const b = generateProcedural(base, { ...params, type: 'flicker' });
    expect(a.every((f, i) => imagesEqual(f, b[i]!))).toBe(true);
    const rot = generateProcedural(base, { ...params, type: 'rotate' });
    expect(meanAbsDiff(rot[0]!, base)).toBeLessThan(1.5); // t=0 -> 0 degrees
    const fade = generateProcedural(base, { ...params, type: 'fade' });
    expect(imagesEqual(fade[0]!, base, 1)).toBe(true);
  });

  it('fade really changes alpha, colorCycle really changes hue', () => {
    const solidPx = solid(8, 8, 255, 0, 0, 255);
    const fade = generateProcedural(solidPx, { ...params, type: 'fade', intensity: 2 });
    const alphas = fade.map((f) => pixel(f, 4, 4)[3]);
    expect(Math.min(...alphas)).toBeLessThan(10);
    const cc = generateProcedural(solidPx, { ...params, type: 'colorCycle' });
    expect(pixel(cc[3]!, 4, 4)).not.toEqual([255, 0, 0, 255]);
  });
});

/* --------------------------------------------------------------- pipeline */

describe('processClip', () => {
  const frames = Array.from({ length: 5 }, (_, i) => solid(8, 8, i * 50, 0, 0));
  const clip = () => createClip('c', null);

  it('keeps natural order and does not mutate inputs', () => {
    const before = frames.map(cloneImage);
    const out = processClip(frames, clip());
    expect(out.frames).toHaveLength(5);
    out.frames.forEach((f, i) => expect(pixel(f, 0, 0)[0]).toBe(i * 50));
    frames.forEach((f, i) => expect(imagesEqual(f, before[i]!)).toBe(true));
  });

  it('reverse and ping-pong (no duplicated end frames)', () => {
    const c = clip();
    c.playback.reverse = true;
    expect(processClip(frames, c).frames.map((f) => pixel(f, 0, 0)[0])).toEqual([200, 150, 100, 50, 0]);
    const p = clip();
    p.playback.pingPong = true;
    expect(processClip(frames, p).frames.map((f) => pixel(f, 0, 0)[0])).toEqual([0, 50, 100, 150, 200, 150, 100, 50]);
  });

  it('explicit frame list deletes, duplicates, reorders and holds; reverse applies afterwards', () => {
    const c = clip();
    c.frames = [{ src: 3, hold: 1 }, { src: 0, hold: 2 }, { src: 3, hold: 1 }];
    const out = processClip(frames, c);
    expect(out.frames.map((f) => pixel(f, 0, 0)[0])).toEqual([150, 0, 150]);
    expect(out.durations).toEqual([1, 2, 1]);
    expect(expandHolds(out.frames, out.durations).map((f) => pixel(f, 0, 0)[0])).toEqual([150, 0, 0, 150]);
    c.playback.reverse = true;
    expect(processClip(frames, c).frames.map((f) => pixel(f, 0, 0)[0])).toEqual([150, 0, 150]);
    const bad = clip();
    bad.frames = [{ src: 99, hold: 1 }];
    expect(() => processClip(frames, bad)).toThrow(/no valid frames/);
  });

  it('applies keying then auto-crops to the union bounds so registration is preserved', () => {
    const f1 = createImage(32, 32);
    const f2 = createImage(32, 32);
    f1.data.set([255, 0, 0, 255], (10 * 32 + 10) * 4);
    f2.data.set([255, 0, 0, 255], (20 * 32 + 22) * 4);
    const c = clip();
    c.crop = { auto: true, margin: 1 };
    const out = processClip([f1, f2], c);
    expect(out.cropRect).toEqual({ x: 9, y: 9, w: 15, h: 13 });
    expect(out.frames.every((f) => f.width === 15 && f.height === 13)).toBe(true);
    // the dot's position relative to the crop differs between frames (motion retained)
    expect(alphaBounds(out.frames[0]!, 0)).toMatchObject({ x: 1, y: 1 });
    expect(alphaBounds(out.frames[1]!, 0)).toMatchObject({ x: 13, y: 11 });
  });

  it('single-image clips run through the procedural generator and say so', () => {
    const c = clip();
    c.procedural = { type: 'pulse', frames: 6, intensity: 1, cycles: 1, seed: 1 };
    const out = processClip([flameOnBlack(16)], c);
    expect(out.frames).toHaveLength(6);
    expect(out.notes.join(' ')).toMatch(/procedurally/);
  });

  it('fps is extraction fps times playback speed', () => {
    const c = clip();
    c.extract.fps = 12;
    c.playback.speed = 2;
    expect(processClip(frames, c).fps).toBe(24);
  });

  it('can be cancelled mid-way', () => {
    expect(() => processClip(frames, clip(), { onProgress: (done) => done < 2 })).toThrow(PipelineCancelled);
  });

  it('motion blur smooths consecutive frames', () => {
    const a = solid(4, 4, 255, 255, 255);
    const b = solid(4, 4, 0, 0, 0);
    const c = clip();
    c.adjust.motionBlurSamples = 2;
    c.adjust.motionBlurStrength = 1;
    const out = processClip([b, a, b], c);
    const mid = pixel(out.frames[1]!, 0, 0)[0];
    expect(mid).toBeGreaterThan(100);
    expect(mid).toBeLessThan(200);
  });
});

/* ------------------------------------------------------------------ atlas */

describe('buildAtlas', () => {
  const sheet = () => {
    const s = createSheet('s', 'c');
    return { grid: s.grid, texture: s.texture, order: s.order, padding: s.padding, extrude: s.extrude, fit: s.fit, trim: s.trim, center: s.center, range: s.range };
  };
  const colourFrames = (n: number, size = 64) => Array.from({ length: n }, (_, i) => solid(size, size, (i * 15) % 256, 255 - ((i * 15) % 256), i, 255));

  it('places 16 frames of a 4x4 1024 sheet in exact cells, pixel for pixel', () => {
    const frames = colourFrames(16);
    const atlas = buildAtlas(frames, sheet());
    expect([atlas.image.width, atlas.image.height]).toEqual([1024, 1024]);
    expect(atlas.layout.cellWidth).toBe(256);
    expect(atlas.placements).toHaveLength(16);
    for (let i = 0; i < 16; i++) {
      const col = i % 4;
      const row = Math.floor(i / 4);
      const expected = pixel(frames[i]!, 0, 0);
      // sample corners + centre of the cell
      for (const [dx, dy] of [[1, 1], [254, 1], [1, 254], [254, 254], [128, 128]] as const) {
        expect(pixel(atlas.image, col * 256 + dx, row * 256 + dy), `frame ${i} @${dx},${dy}`).toEqual(expected);
      }
    }
    expect(atlas.warnings).toEqual([]);
  });

  it('leaves unused cells fully transparent and reports them', () => {
    const atlas = buildAtlas(colourFrames(10), sheet());
    expect(pixel(atlas.image, 3 * 256 + 100, 3 * 256 + 100)).toEqual([0, 0, 0, 0]);
    expect(atlas.warnings.join(' ')).toMatch(/6 of 16 grid cells are empty/);
  });

  it('honours column-major order', () => {
    const p = { ...sheet(), order: 'column-major' as const };
    const frames = colourFrames(16);
    const atlas = buildAtlas(frames, p);
    // frame 1 goes below frame 0 in column-major order
    expect(pixel(atlas.image, 100, 256 + 100)).toEqual(pixel(frames[1]!, 0, 0));
    expect(atlas.placements[1]).toMatchObject({ col: 0, row: 1 });
  });

  it('padding insets the content and extrusion fills the gap with edge colour', () => {
    const p = { ...sheet(), padding: 4, extrude: 4, fit: 'stretch' as const };
    const frames = colourFrames(4);
    const atlas = buildAtlas(frames, p);
    const c = pixel(frames[0]!, 0, 0);
    expect(pixel(atlas.image, 2, 100)).toEqual(c); // inside the padding band (extruded)
    expect(pixel(atlas.image, 4, 100)).toEqual(c); // first content pixel
    const noExtrude = buildAtlas(frames, { ...p, extrude: 0 });
    expect(pixel(noExtrude.image, 2, 100)).toEqual([0, 0, 0, 0]);
  });

  it('refuses impossible configurations with every reason listed', () => {
    expect(() => buildAtlas(colourFrames(17), sheet())).toThrow(AtlasError);
    try {
      buildAtlas(colourFrames(17), sheet());
    } catch (e) {
      expect((e as AtlasError).issues.join(' ')).toMatch(/17 frames do not fit/);
    }
    expect(() => buildAtlas(colourFrames(4), { ...sheet(), padding: 1, extrude: 3 })).toThrow(/extrusion/i);
    expect(() => buildAtlas(colourFrames(4), { ...sheet(), texture: { width: 1001, height: 1024 } })).toThrow(AtlasError);
    expect(() => buildAtlas([], sheet())).toThrow(/no frames/);
  });

  it('applies a frame range', () => {
    const frames = colourFrames(16);
    const atlas = buildAtlas(frames, { ...sheet(), range: { start: 4, end: 7 } });
    expect(atlas.frameCount).toBe(4);
    expect(pixel(atlas.image, 100, 100)).toEqual(pixel(frames[4]!, 0, 0));
  });

  it('trims by the UNION bounds of all frames and keeps relative motion', () => {
    const mk = (x: number) => {
      const f = createImage(64, 64);
      f.data.set([255, 255, 255, 255], (32 * 64 + x) * 4);
      return f;
    };
    const atlas = buildAtlas([mk(10), mk(50)], { ...sheet(), grid: { cols: 2, rows: 1 }, texture: { width: 128, height: 64 }, trim: true, fit: 'stretch' });
    expect(atlas.trimRect).toEqual({ x: 10, y: 32, w: 41, h: 1 });
  });

  it('letterboxes non-square frames with contain and fills with cover', () => {
    const wide = solid(128, 32, 255, 0, 0, 255);
    const contain = buildAtlas([wide], { ...sheet(), grid: { cols: 1, rows: 1 }, texture: { width: 64, height: 64 }, fit: 'contain' });
    expect(pixel(contain.image, 32, 2)[3]).toBe(0); // letterbox
    expect(pixel(contain.image, 32, 32)[3]).toBe(255);
    const cover = buildAtlas([wide], { ...sheet(), grid: { cols: 1, rows: 1 }, texture: { width: 64, height: 64 }, fit: 'cover' });
    expect(pixel(cover.image, 32, 2)[3]).toBe(255);
  });

  it('bleedTransparentColor fills invisible pixels with neighbouring colour and never touches alpha', () => {
    const img = createImage(5, 1);
    img.data.set([255, 100, 0, 255], 0);
    const out = bleedTransparentColor(img, 4);
    expect(pixel(out, 3, 0)).toEqual([255, 100, 0, 0]);
    expect(pixel(out, 0, 0)).toEqual([255, 100, 0, 255]);
  });
});

/* -------------------------------------------------------------------- PNG */

describe('png', () => {
  it('round-trips RGBA exactly', () => {
    const img = gradientSprite(33);
    const back = decodePng(encodePng(img));
    expect(imagesEqual(back, img)).toBe(true);
  });

  it('decodes gray, gray+alpha, RGB and 16-bit PNGs to RGBA', () => {
    const gray = decodePng(encode({ width: 2, height: 1, data: new Uint8Array([0, 200]), depth: 8, channels: 1 }));
    expect(pixel(gray, 1, 0)).toEqual([200, 200, 200, 255]);
    const ga = decodePng(encode({ width: 1, height: 1, data: new Uint8Array([90, 40]), depth: 8, channels: 2 }));
    expect(pixel(ga, 0, 0)).toEqual([90, 90, 90, 40]);
    const rgb = decodePng(encode({ width: 1, height: 1, data: new Uint8Array([1, 2, 3]), depth: 8, channels: 3 }));
    expect(pixel(rgb, 0, 0)).toEqual([1, 2, 3, 255]);
    const deep = decodePng(encode({ width: 1, height: 1, data: new Uint16Array([65535, 32768, 0, 65535]), depth: 16, channels: 4 }));
    expect(pixel(deep, 0, 0)).toEqual([255, 128, 0, 255]);
  });

  it('rejects non-PNG input with a clear error', () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/Not a PNG/);
  });
});

/* -------------------------------------------------------------------- DDS */

describe('DDS', () => {
  const sprite = gradientSprite(64);

  it('BGRA8 is lossless and header fields are right', () => {
    const bytes = encodeDds(sprite, { format: 'BGRA8', mipmaps: false });
    expect(bytes.length).toBe(expectedDdsSize('BGRA8', 64, 64, 1));
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('DDS ');
    const dec = decodeDds(bytes);
    expect(imagesEqual(dec.levels[0]!, sprite)).toBe(true);
    expect(dec.info.format).toBe('BGRA8');
  });

  it('BC3 writes DXT5 and decodes with high fidelity including soft alpha', () => {
    const bytes = encodeDds(sprite, { format: 'BC3', mipmaps: false });
    expect(String.fromCharCode(...bytes.slice(84, 88))).toBe('DXT5');
    expect(bytes.length).toBe(4 + 124 + (64 / 4) * (64 / 4) * 16);
    const dec = decodeDds(bytes);
    expect(psnr(dec.levels[0]!, sprite)).toBeGreaterThan(30);
  });

  it('BC1 writes DXT1 and keeps opaque content close to the source', () => {
    const opaque = gradientSprite(64);
    for (let i = 3; i < opaque.data.length; i += 4) opaque.data[i] = 255;
    const bytes = encodeDds(opaque, { format: 'BC1', mipmaps: false });
    expect(String.fromCharCode(...bytes.slice(84, 88))).toBe('DXT1');
    expect(bytes.length).toBe(4 + 124 + (64 / 4) * (64 / 4) * 8);
    expect(psnr(decodeDds(bytes).levels[0]!, opaque)).toBeGreaterThan(28);
  });

  it('BC1 punch-through alpha: transparent texels stay transparent', () => {
    const img = createImage(8, 8);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) img.data.set([200, 50, 20, 255], (y * 8 + x) * 4);
    const dec = decodeDds(encodeDds(img, { format: 'BC1', mipmaps: false })).levels[0]!;
    expect(pixel(dec, 6, 3)[3]).toBe(0);
    expect(pixel(dec, 1, 3)[3]).toBe(255);
    expect(Math.abs(pixel(dec, 1, 3)[0] - 200)).toBeLessThan(12);
  });

  it('BC3 reproduces hard 0/255 alpha exactly and solid colours accurately', () => {
    const img = createImage(16, 16);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) img.data.set([255, 128, 0, 255], (y * 16 + x) * 4);
    const dec = decodeDds(encodeDds(img, { format: 'BC3', mipmaps: false })).levels[0]!;
    expect(pixel(dec, 3, 3)[3]).toBe(255);
    expect(pixel(dec, 12, 3)[3]).toBe(0);
    const [r, g, b] = pixel(dec, 3, 3);
    expect(Math.abs(r - 255) + Math.abs(g - 128) + Math.abs(b - 0)).toBeLessThan(16);
  });

  it('builds full mip chains with correct sizes and decodes every level', () => {
    expect(mipLevelCount(1024, 1024)).toBe(11);
    expect(mipLevelCount(256, 64)).toBe(9);
    const chain = buildMipChain(sprite);
    expect(chain.map((l) => l.width)).toEqual([64, 32, 16, 8, 4, 2, 1]);
    for (const format of ['BC1', 'BC3', 'BGRA8'] as const) {
      const bytes = encodeDds(sprite, { format, mipmaps: true });
      expect(bytes.length).toBe(expectedDdsSize(format, 64, 64, 7));
      const dec = decodeDds(bytes);
      expect(dec.levels).toHaveLength(7);
      expect(dec.levels.map((l) => l.width)).toEqual([64, 32, 16, 8, 4, 2, 1]);
      expect(dec.info.mipLevels).toBe(7);
    }
  });

  it('handles non-square and sub-block textures', () => {
    const tiny = gradientSprite(8);
    const wide = createImage(32, 8);
    wide.data.set(solid(32, 8, 10, 20, 30, 255).data);
    for (const [img, w, h] of [[tiny, 8, 8], [wide, 32, 8]] as const) {
      const dec = decodeDds(encodeDds(img, { format: 'BC3', mipmaps: true }));
      expect([dec.levels[0]!.width, dec.levels[0]!.height]).toEqual([w, h]);
      expect(dec.levels.at(-1)).toMatchObject({ width: 1, height: 1 });
    }
  });

  it('validator accepts our output and rejects corruption with specific reasons', () => {
    const good = encodeDds(sprite, { format: 'BC3', mipmaps: true });
    const v = validateDds(good);
    expect(v.valid).toBe(true);
    expect(v.info).toMatchObject({ width: 64, height: 64, mipLevels: 7, format: 'BC3', hasAlpha: true });

    const truncated = good.slice(0, good.length - 7);
    expect(validateDds(truncated).errors.join(' ')).toMatch(/does not match/);

    const badMagic = good.slice();
    badMagic[0] = 0x58;
    expect(validateDds(badMagic).errors.join(' ')).toMatch(/magic/);

    expect(validateDds(new Uint8Array(10)).errors.join(' ')).toMatch(/too small/);

    const cube = good.slice();
    cube[112] = 0x00;
    cube[113] = 0xfe; // caps2 = cubemap flags
    expect(validateDds(cube).errors.join(' ')).toMatch(/Cubemap/);

    const fourcc = good.slice();
    fourcc.set([0x41, 0x54, 0x49, 0x31], 84); // ATI1
    expect(validateDds(fourcc).errors.join(' ')).toMatch(/Unsupported FourCC "ATI1"/);

    const dx10 = good.slice();
    dx10.set([0x44, 0x58, 0x31, 0x30], 84);
    expect(validateDds(dx10).errors.join(' ')).toMatch(/DX10/);

    const tooManyMips = good.slice();
    tooManyMips[28] = 20;
    expect(validateDds(tooManyMips).errors.join(' ')).toMatch(/exceeds the maximum/);
    expect(() => decodeDds(truncated)).toThrow(/Invalid DDS/);
  });

  it('accepts the tightly-packed mip tail written by CodeWalker\'s exporter, with a warning', () => {
    const padded = encodeDds(sprite, { format: 'BC3', mipmaps: true }); // 64x64: tail levels 4x4, 2x2, 1x1 (3 x 16 bytes)
    // rebuild the tail as CodeWalker writes it: 4x4 -> 16 bytes, 2x2 -> 4 bytes, 1x1 -> 1 byte
    const tailStart = padded.length - 48;
    const tight = new Uint8Array(tailStart + 16 + 4 + 1);
    tight.set(padded.subarray(0, tailStart + 16));
    const v = validateDds(tight);
    expect(v.valid).toBe(true);
    expect(v.info!.tightTail).toBe(true);
    expect(v.warnings.join(' ')).toMatch(/tightly packed/);
    const dec = decodeDds(tight);
    expect(dec.levels.map((l) => l.width)).toEqual([64, 32, 16, 8, 4]); // sub-4x4 tail not decoded
    // anything else with the wrong size is still rejected
    expect(validateDds(tight.subarray(0, tight.length - 3)).valid).toBe(false);
    expect(validateDds(padded).info!.tightTail).toBe(false);
  });

  it('warns (does not fail) on non power-of-two sizes', () => {
    const odd = encodeDds(solid(12, 12, 1, 2, 3), { format: 'BGRA8', mipmaps: false });
    const v = validateDds(odd);
    expect(v.valid).toBe(true);
    expect(v.warnings.join(' ')).toMatch(/powers of two/);
  });

  it('encoding is deterministic', () => {
    const a = encodeDds(sprite, { format: 'BC3', mipmaps: true });
    const b = encodeDds(sprite, { format: 'BC3', mipmaps: true });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('a real flipbook atlas survives BC3 encode/decode', () => {
    const frames = Array.from({ length: 16 }, (_, i) => flameOnBlack(64, i));
    const keyed = frames.map((f) => applyKey(f, { mode: 'black', color: [0, 1, 0], tolerance: 0.02, feather: 0.1, despill: false, keepSourceAlpha: true }));
    const s = createSheet('flame', 'c');
    const atlas = buildAtlas(keyed, { grid: s.grid, texture: s.texture, order: s.order, padding: 0, extrude: 0, fit: 'contain', trim: false, center: true, range: null });
    const bled = bleedTransparentColor(atlas.image);
    const dec = decodeDds(encodeDds(bled, { format: 'BC3', mipmaps: true }));
    expect(dec.levels).toHaveLength(11);
    expect(psnr(dec.levels[0]!, bled)).toBeGreaterThan(30);
    expect(validateDds(encodeDds(bled, { format: 'BC3', mipmaps: true })).valid).toBe(true);
  });
});
