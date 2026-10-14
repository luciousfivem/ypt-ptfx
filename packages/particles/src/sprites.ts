/**
 * Procedural flipbook sprite generators.
 *
 * Every preset ships with real, original art produced here from noise and simple geometry —
 * nothing is copied from games or stock libraries, so the output is free to distribute.
 * All generators are deterministic for a seed and loop seamlessly (frame N would equal frame 0),
 * because looping flipbooks are what particle effects need.
 */
import { Rng, type Generator, type SpriteKind } from '@vfxforge/core';
import { createImage, type RgbaImage } from '@vfxforge/media';

type Rgb = readonly [number, number, number];

/* ---------------------------------------------------------------- noise */

function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function vnoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, y: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * vnoise(x * f, y * f, seed + i * 101);
    f *= 2;
    amp *= 0.5;
  }
  return sum;
}

/**
 * Time-looping noise: crossfades noise(t) with noise(t − T) so the animation is seamless over
 * the loop (a slightly lower-contrast but artefact-free approach compared to 4-D noise).
 */
function loopFbm(x: number, y: number, t: number, drift: [number, number], seed: number, octaves = 4): number {
  const a = fbm(x + drift[0] * t, y + drift[1] * t, seed, octaves);
  const b = fbm(x + drift[0] * (t - 1), y + drift[1] * (t - 1), seed, octaves);
  return a * (1 - t) + b * t;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Maps 0..1 intensity through a multi-stop colour ramp. */
function ramp(palette: readonly Rgb[], t: number): [number, number, number] {
  const n = palette.length - 1;
  const x = clamp01(t) * n;
  const i = Math.min(n - 1, Math.floor(x));
  const f = x - i;
  const a = palette[i]!;
  const b = palette[i + 1]!;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/* ------------------------------------------------------------- framebuffer */

/** Float RGBA accumulation buffer (straight colour, premultiplied by coverage on write). */
class Canvas {
  readonly data: Float32Array;
  constructor(readonly size: number) {
    this.data = new Float32Array(size * size * 4);
  }

  /** Adds light (additive) with coverage `a`. */
  add(x: number, y: number, r: number, g: number, b: number, a: number): void {
    const i = (y * this.size + x) * 4;
    this.data[i] = this.data[i]! + r * a;
    this.data[i + 1] = this.data[i + 1]! + g * a;
    this.data[i + 2] = this.data[i + 2]! + b * a;
    this.data[i + 3] = Math.max(this.data[i + 3]!, a);
  }

  toImage(): RgbaImage {
    const img = createImage(this.size, this.size);
    for (let p = 0; p < this.size * this.size; p++) {
      const a = clamp01(this.data[p * 4 + 3]!);
      if (a <= 0.002) continue;
      // buffer holds colour × coverage; recover straight colour
      const inv = 1 / Math.max(a, 1e-4);
      img.data[p * 4] = clamp01(this.data[p * 4]! * inv) * 255;
      img.data[p * 4 + 1] = clamp01(this.data[p * 4 + 1]! * inv) * 255;
      img.data[p * 4 + 2] = clamp01(this.data[p * 4 + 2]! * inv) * 255;
      img.data[p * 4 + 3] = a * 255;
    }
    return img;
  }
}

/** Soft line segment (distance field) drawn additively. */
function glowLine(c: Canvas, x0: number, y0: number, x1: number, y1: number, width: number, color: Rgb, strength: number): void {
  const s = c.size;
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - width * 4));
  const maxX = Math.min(s - 1, Math.ceil(Math.max(x0, x1) + width * 4));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - width * 4));
  const maxY = Math.min(s - 1, Math.ceil(Math.max(y0, y1) + width * 4));
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy || 1e-6;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const t = clamp01(((x - x0) * dx + (y - y0) * dy) / len2);
      const d = Math.hypot(x - (x0 + dx * t), y - (y0 + dy * t));
      const core = Math.exp(-(d * d) / (width * width * 0.35));
      const halo = Math.exp(-(d * d) / (width * width * 6)) * 0.35;
      const v = (core + halo) * strength;
      if (v > 0.003) c.add(x, y, color[0], color[1], color[2], Math.min(1, v));
    }
  }
}

/* -------------------------------------------------------------- generators */

type Painter = (g: Generator, frame: number, rng: Rng) => RgbaImage;

const fire: Painter = (g, frame) => {
  const s = g.size;
  const t = frame / g.frames;
  const img = createImage(s, s);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const u = (x / s - 0.5) * 2; // -1..1
      const v = 1 - y / s; // 0 bottom .. 1 top
      // body: wide at the base, tapering with height; noise erodes it more with height
      const warp = (loopFbm(u * 2.2 + 3, v * 2.8, t, [0, -2.2], g.seed, 4) - 0.5) * (0.55 + v * 0.9);
      const width = 0.62 * (1 - v * 0.82) + 0.02;
      const body = 1 - Math.abs(u + warp) / width;
      const flicker = loopFbm(u * 4 + 9, v * 5, t, [0, -3.5], g.seed + 7, 3);
      let i = clamp01(body) * (1 - v * 0.78) + (flicker - 0.45) * 0.55 * clamp01(body * 2);
      i = clamp01(i * g.intensity * 1.35);
      i *= smooth(0, 0.07, v) * smooth(1.0, 0.82, v); // fade at the very bottom/top
      if (i <= 0.01) continue;
      const [r, gg, b] = ramp(g.palette, i);
      const o = (y * s + x) * 4;
      img.data[o] = r * 255;
      img.data[o + 1] = gg * 255;
      img.data[o + 2] = b * 255;
      img.data[o + 3] = clamp01(i * 1.25) * 255;
    }
  }
  return img;
};

const smokeLike = (billow: number, softness: number): Painter => (g, frame) => {
  const s = g.size;
  const t = frame / g.frames;
  const img = createImage(s, s);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const u = (x / s - 0.5) * 2;
      const v = (y / s - 0.5) * 2;
      const r = Math.hypot(u, v);
      const n = loopFbm(u * billow + 5, v * billow + 5, t, [0.6, -0.9], g.seed, 5);
      const puff = clamp01(1 - r / (0.92 + (n - 0.5) * 0.35)); // radial mask eroded by noise
      let a = Math.pow(puff, softness) * (0.35 + n * 0.95) * g.intensity;
      a = clamp01(a);
      if (a <= 0.004) continue;
      const [rr, gg, bb] = ramp(g.palette, clamp01(n * 1.15 + (1 - r) * 0.2));
      const o = (y * s + x) * 4;
      img.data[o] = rr * 255;
      img.data[o + 1] = gg * 255;
      img.data[o + 2] = bb * 255;
      img.data[o + 3] = a * 255;
    }
  }
  return img;
};

const glow: Painter = (g, frame) => {
  const s = g.size;
  const t = frame / g.frames;
  const img = createImage(s, s);
  const pulse = 0.82 + 0.18 * Math.sin(t * Math.PI * 2);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const r = Math.hypot((x / s - 0.5) * 2, (y / s - 0.5) * 2);
      const n = loopFbm((x / s) * 3 + 2, (y / s) * 3 + 2, t, [0.3, 0.2], g.seed, 3);
      const core = Math.exp(-r * r * 5.5) * pulse;
      const halo = Math.exp(-r * r * 1.6) * 0.45 * (0.85 + n * 0.3);
      const i = clamp01((core + halo) * g.intensity) * smooth(1, 0.78, r);
      if (i <= 0.004) continue;
      const [rr, gg, bb] = ramp(g.palette, clamp01(core * 0.9 + halo * 0.3));
      const o = (y * s + x) * 4;
      img.data[o] = rr * 255;
      img.data[o + 1] = gg * 255;
      img.data[o + 2] = bb * 255;
      img.data[o + 3] = i * 255;
    }
  }
  return img;
};

const plasma: Painter = (g, frame) => {
  const s = g.size;
  const t = (frame / g.frames) * Math.PI * 2;
  const img = createImage(s, s);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const u = (x / s - 0.5) * 2;
      const v = (y / s - 0.5) * 2;
      const r = Math.hypot(u, v);
      const ang = Math.atan2(v, u);
      // interference of rings and spiral arms; every term is periodic in t => seamless loop
      const f =
        0.5 +
        0.25 * Math.sin(r * 9 - t + g.seed * 0.01) +
        0.15 * Math.sin(ang * 3 + r * 5 + t) +
        0.1 * Math.sin((u + v) * 7 + 2 * t);
      const mask = smooth(1, 0.55, r);
      const i = clamp01(f * g.intensity * 1.2) * mask;
      if (i <= 0.01) continue;
      const [rr, gg, bb] = ramp(g.palette, i);
      const o = (y * s + x) * 4;
      img.data[o] = rr * 255;
      img.data[o + 1] = gg * 255;
      img.data[o + 2] = bb * 255;
      img.data[o + 3] = clamp01(i * 1.15) * 255;
    }
  }
  return img;
};

const lightning: Painter = (g, frame, rng) => {
  const s = g.size;
  const c = new Canvas(s);
  const core = g.palette[g.palette.length - 1]!;
  const edge = g.palette[Math.max(0, g.palette.length - 2)]!;
  const bolt = (x0: number, y0: number, x1: number, y1: number, depth: number, width: number) => {
    // recursive midpoint displacement
    const pts: Array<[number, number]> = [[x0, y0], [x1, y1]];
    let jitter = Math.hypot(x1 - x0, y1 - y0) * 0.28;
    for (let pass = 0; pass < 5; pass++) {
      const next: Array<[number, number]> = [pts[0]!];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        const mx = (a[0] + b[0]) / 2;
        const my = (a[1] + b[1]) / 2;
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const l = Math.hypot(dx, dy) || 1;
        const off = rng.signed() * jitter;
        next.push([mx - (dy / l) * off, my + (dx / l) * off], b);
      }
      pts.length = 0;
      pts.push(...next);
      jitter *= 0.55;
    }
    for (let i = 0; i < pts.length - 1; i++) {
      glowLine(c, pts[i]![0], pts[i]![1], pts[i + 1]![0], pts[i + 1]![1], width * 2.1, edge, 0.85 * g.intensity);
      glowLine(c, pts[i]![0], pts[i]![1], pts[i + 1]![0], pts[i + 1]![1], width * 0.4, core, 0.95 * g.intensity);
      if (depth > 0 && rng.next() < 0.1) {
        const ang = Math.atan2(y1 - y0, x1 - x0) + rng.signed() * 0.9;
        const len = Math.hypot(x1 - x0, y1 - y0) * (0.25 + rng.next() * 0.3);
        bolt(pts[i]![0], pts[i]![1], pts[i]![0] + Math.cos(ang) * len, pts[i]![1] + Math.sin(ang) * len, depth - 1, width * 0.6);
      }
    }
  };
  const main = 1 + (frame % 2);
  for (let k = 0; k < main; k++) {
    bolt(s * (0.5 + rng.signed() * 0.18), s * 0.04, s * (0.5 + rng.signed() * 0.22), s * 0.96, 2, s / 70);
  }
  return c.toImage();
};

const sparks: Painter = (g, frame, rng) => {
  const s = g.size;
  const c = new Canvas(s);
  const t = frame / g.frames;
  const n = 22;
  const a0 = new Rng(g.seed ^ 0x51ed); // fixed per-spark parameters (same every frame)
  for (let i = 0; i < n; i++) {
    const ang = a0.next() * Math.PI * 2;
    const speed = 0.5 + a0.next() * 0.9;
    const phase = a0.next();
    const p = (t + phase) % 1; // each spark loops with its own phase
    const r0 = p * speed * s * 0.5;
    const r1 = Math.max(0, r0 - s * 0.16 * (1 - p * 0.6));
    const cx = s / 2;
    const cy = s / 2;
    const fade = (1 - p) * smooth(0, 0.06, p);
    const col = ramp(g.palette, 0.5 + fade * 0.5);
    glowLine(c, cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1, cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0, s / 50 + 0.6, col, Math.min(1, fade * 1.4) * g.intensity);
  }
  void rng;
  return c.toImage();
};

const embers: Painter = (g, frame) => {
  const s = g.size;
  const c = new Canvas(s);
  const t = frame / g.frames;
  const a0 = new Rng(g.seed ^ 0xe3be);
  for (let i = 0; i < 22; i++) {
    const x0 = a0.next();
    const speed = 0.35 + a0.next() * 0.5;
    const phase = a0.next();
    const sway = a0.next() * Math.PI * 2;
    const p = (t + phase) % 1;
    const x = (x0 + Math.sin(p * Math.PI * 2 + sway) * 0.05) * s;
    const y = (1 - p * speed - 0.05) * s;
    const fade = Math.sin(p * Math.PI);
    const rad = (0.9 + a0.next() * 1.7) * (s / 128);
    const col = ramp(g.palette, 0.4 + fade * 0.6);
    const x0i = Math.max(0, Math.floor(x - rad * 4));
    const x1i = Math.min(s - 1, Math.ceil(x + rad * 4));
    const y0i = Math.max(0, Math.floor(y - rad * 4));
    const y1i = Math.min(s - 1, Math.ceil(y + rad * 4));
    for (let yy = y0i; yy <= y1i; yy++) {
      for (let xx = x0i; xx <= x1i; xx++) {
        const d2 = (xx - x) ** 2 + (yy - y) ** 2;
        const v = Math.exp(-d2 / (rad * rad * 1.2)) * fade * g.intensity;
        if (v > 0.01) c.add(xx, yy, col[0], col[1], col[2], Math.min(1, v));
      }
    }
  }
  return c.toImage();
};

const runes: Painter = (g, frame) => {
  const s = g.size;
  const c = new Canvas(s);
  const t = frame / g.frames;
  const cx = s / 2;
  const cy = s / 2;
  const edge = g.palette[Math.max(0, g.palette.length - 2)]!;
  const core = g.palette[g.palette.length - 1]!;
  const spin = t * Math.PI * 2;
  const lw = s / 64 + 0.5;
  const ring = (radius: number, rot: number, dashes: number, strength: number) => {
    const seg = 48;
    for (let i = 0; i < seg; i++) {
      if (dashes > 0 && Math.floor((i / seg) * dashes * 2) % 2 === 1) continue;
      const a0 = (i / seg) * Math.PI * 2 + rot;
      const a1 = ((i + 1.05) / seg) * Math.PI * 2 + rot;
      glowLine(c, cx + Math.cos(a0) * radius, cy + Math.sin(a0) * radius, cx + Math.cos(a1) * radius, cy + Math.sin(a1) * radius, lw, edge, strength * g.intensity);
    }
  };
  ring(s * 0.44, spin, 0, 0.9);
  ring(s * 0.37, -spin * 2, 12, 0.75);
  ring(s * 0.22, spin * 3, 6, 0.6);
  // inscribed triangle + counter-rotating square and spokes: the "rune" glyph
  const poly = (sides: number, radius: number, rot: number, strength: number) => {
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2 + rot;
      const a1 = ((i + 1) / sides) * Math.PI * 2 + rot;
      glowLine(c, cx + Math.cos(a0) * radius, cy + Math.sin(a0) * radius, cx + Math.cos(a1) * radius, cy + Math.sin(a1) * radius, lw, core, strength * g.intensity);
    }
  };
  poly(3, s * 0.36, -spin, 0.95);
  poly(4, s * 0.2, spin * 2, 0.8);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + spin;
    glowLine(c, cx + Math.cos(a) * s * 0.08, cy + Math.sin(a) * s * 0.08, cx + Math.cos(a) * s * 0.18, cy + Math.sin(a) * s * 0.18, lw * 0.8, core, 0.8 * g.intensity);
  }
  return c.toImage();
};

const holo: Painter = (g, frame) => {
  const s = g.size;
  const t = frame / g.frames;
  const img = createImage(s, s);
  for (let y = 0; y < s; y++) {
    const scan = 0.5 + 0.5 * Math.sin(((y / s) * 46 - t * 2) * Math.PI * 2 * 0.5 + t * Math.PI * 2); // scrolls one period over the loop
    for (let x = 0; x < s; x++) {
      const u = (x / s - 0.5) * 2;
      const v = (y / s - 0.5) * 2;
      const r = Math.hypot(u, v);
      const grid = (Math.abs(((x / s) * 10) % 1 - 0.5) < 0.04 || Math.abs(((y / s) * 10) % 1 - 0.5) < 0.04 ? 0.5 : 0) * smooth(0.95, 0.4, r);
      const body = smooth(0.9, 0.2, r) * (0.28 + 0.4 * scan);
      const ring = Math.exp(-Math.pow((r - 0.78) * 14, 2)) * 0.9;
      const flick = 0.92 + 0.08 * Math.sin(t * Math.PI * 4 + u * 3);
      const i = clamp01((body + grid + ring) * flick * g.intensity);
      if (i <= 0.01) continue;
      const [rr, gg, bb] = ramp(g.palette, i);
      const o = (y * s + x) * 4;
      img.data[o] = rr * 255;
      img.data[o + 1] = gg * 255;
      img.data[o + 2] = bb * 255;
      img.data[o + 3] = clamp01(i) * 255;
    }
  }
  return img;
};

const PAINTERS: Record<SpriteKind, Painter> = {
  fire,
  smoke: smokeLike(2.6, 0.9),
  mist: smokeLike(1.6, 1.6),
  glow,
  plasma,
  lightning,
  sparks,
  embers,
  runes,
  holo,
};

/** Generates `g.frames` square RGBA frames. Deterministic for a given generator. */
export function generateSpriteFrames(g: Generator, onFrame?: (done: number, total: number) => void): RgbaImage[] {
  const paint = PAINTERS[g.kind];
  const frames: RgbaImage[] = [];
  for (let f = 0; f < g.frames; f++) {
    // lightning re-rolls its bolts every frame; others use the shared seed for coherence
    frames.push(paint(g, f, new Rng((g.seed ^ Math.imul(f + 1, 0x9e3779b1)) >>> 0)));
    onFrame?.(f + 1, g.frames);
  }
  return frames;
}
