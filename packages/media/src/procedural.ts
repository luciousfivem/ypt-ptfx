/**
 * Procedural animation for a SINGLE image.
 *
 * A still image contains no motion information. These generators synthesise motion by
 * applying parametric transforms (scale, rotation, brightness, hue, displacement...)
 * over time. The result is a real frame sequence, but it is an *authored* animation,
 * not recovered motion — the UI labels it as such.
 *
 * Time for frame i is t = i / frames, so frame `frames` would equal frame 0 and the
 * loop is seamless.
 */
import { Rng } from '@vfxforge/core';
import { colorAdjust, glow } from './adjust';
import { cloneImage, createImage, fromPremultiplied, toPremultiplied, type RgbaImage } from './image';

export type ProceduralType =
  | 'pulse'
  | 'fade'
  | 'scale'
  | 'rotate'
  | 'scroll'
  | 'flicker'
  | 'colorCycle'
  | 'glow'
  | 'shimmer'
  | 'distort'
  | 'duplicate';

export interface ProceduralParams {
  type: ProceduralType;
  frames: number;
  intensity: number;
  cycles: number;
  seed: number;
}

const TAU = Math.PI * 2;

interface Affine {
  scale: number;
  rotationDeg: number;
  tx: number;
  ty: number;
}

/** Inverse-mapped affine warp about the image centre, premultiplied bilinear sampling. */
export function warpAffine(img: RgbaImage, m: Affine): RgbaImage {
  const { width: w, height: h } = img;
  const src = toPremultiplied(img);
  const dst = new Float32Array(w * h * 4);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const rad = (-m.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const inv = 1 / Math.max(1e-6, m.scale);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx - m.tx;
      const dy = y - cy - m.ty;
      const sx = (dx * cos - dy * sin) * inv + cx;
      const sy = (dx * sin + dy * cos) * inv + cy;
      sampleBilinear(src, w, h, sx, sy, dst, (y * w + x) * 4);
    }
  }
  return fromPremultiplied(dst, w, h);
}

function sampleBilinear(src: Float32Array, w: number, h: number, x: number, y: number, out: Float32Array, o: number): void {
  if (x < -1 || y < -1 || x > w || y > h) return; // fully outside: stays transparent
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      const px = x0 + i;
      const py = y0 + j;
      if (px < 0 || py < 0 || px >= w || py >= h) continue; // transparent outside
      const wgt = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
      const q = (py * w + px) * 4;
      out[o] = out[o]! + src[q]! * wgt;
      out[o + 1] = out[o + 1]! + src[q + 1]! * wgt;
      out[o + 2] = out[o + 2]! + src[q + 2]! * wgt;
      out[o + 3] = out[o + 3]! + src[q + 3]! * wgt;
    }
  }
}

function scrollWrap(img: RgbaImage, dx: number, dy: number): RgbaImage {
  const { width: w, height: h } = img;
  const out = createImage(w, h);
  const ix = ((Math.round(dx) % w) + w) % w;
  const iy = ((Math.round(dy) % h) + h) % h;
  for (let y = 0; y < h; y++) {
    const sy = (y - iy + h) % h;
    for (let x = 0; x < w; x++) {
      const sx = (x - ix + w) % w;
      const s = (sy * w + sx) * 4;
      const d = (y * w + x) * 4;
      out.data[d] = img.data[s]!;
      out.data[d + 1] = img.data[s + 1]!;
      out.data[d + 2] = img.data[s + 2]!;
      out.data[d + 3] = img.data[s + 3]!;
    }
  }
  return out;
}

function displace(img: RgbaImage, amplitudePx: number, waves: number, phase: number): RgbaImage {
  const { width: w, height: h } = img;
  const src = toPremultiplied(img);
  const dst = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const off = amplitudePx * Math.sin(TAU * (waves * (y / h) + phase));
    for (let x = 0; x < w; x++) sampleBilinear(src, w, h, x + off, y, dst, (y * w + x) * 4);
  }
  return fromPremultiplied(dst, w, h);
}

function multiplyRgb(img: RgbaImage, k: number): RgbaImage {
  const out = cloneImage(img);
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = out.data[i]! * k;
    out.data[i + 1] = out.data[i + 1]! * k;
    out.data[i + 2] = out.data[i + 2]! * k;
  }
  return out;
}

function multiplyAlpha(img: RgbaImage, k: number): RgbaImage {
  const out = cloneImage(img);
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = out.data[i]! * k;
  return out;
}

/** Moving diagonal highlight band, masked by the image's own alpha. */
function shimmerBand(img: RgbaImage, centre: number, width: number, strength: number): RgbaImage {
  const out = cloneImage(img);
  const { width: w, height: h } = img;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = (x / w + y / h) / 2 - centre; // diagonal coordinate
      const band = Math.max(0, 1 - Math.abs(d) / width);
      if (band <= 0) continue;
      const i = (y * w + x) * 4;
      const k = band * band * strength * 255;
      out.data[i] = out.data[i]! + k;
      out.data[i + 1] = out.data[i + 1]! + k;
      out.data[i + 2] = out.data[i + 2]! + k;
    }
  }
  return out;
}

export function generateProcedural(base: RgbaImage, p: ProceduralParams): RgbaImage[] {
  const n = Math.max(2, Math.floor(p.frames));
  const rng = new Rng(p.seed);
  const out: RgbaImage[] = [];
  const k = p.intensity;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const ph = t * p.cycles; // phase in cycles
    const wave = Math.sin(TAU * ph);
    const saw = ph - Math.floor(ph);
    switch (p.type) {
      case 'pulse': {
        const s = 1 + 0.15 * k * wave;
        const bright = 1 + 0.35 * k * wave;
        out.push(multiplyRgb(warpAffine(base, { scale: s, rotationDeg: 0, tx: 0, ty: 0 }), bright));
        break;
      }
      case 'fade': {
        const a = 1 - Math.min(1, k * 0.5) * (1 - Math.cos(TAU * ph));
        out.push(multiplyAlpha(base, Math.max(0, a)));
        break;
      }
      case 'scale': {
        // expanding burst: grows over each cycle and fades out toward the end of it
        const s = 0.6 + (0.4 + 0.6 * k) * saw;
        const fade = Math.min(1, (1 - saw) * 3);
        out.push(multiplyAlpha(warpAffine(base, { scale: s, rotationDeg: 0, tx: 0, ty: 0 }), fade));
        break;
      }
      case 'rotate':
        out.push(warpAffine(base, { scale: 1, rotationDeg: 360 * ph, tx: 0, ty: 0 }));
        break;
      case 'scroll':
        out.push(scrollWrap(base, saw * base.width, 0));
        break;
      case 'flicker': {
        const bright = 1 - Math.min(0.9, 0.5 * k) * rng.next();
        const jitter = 1 + 0.03 * k * rng.signed();
        out.push(multiplyRgb(warpAffine(base, { scale: jitter, rotationDeg: 0, tx: 0, ty: 0 }), bright));
        break;
      }
      case 'colorCycle':
        out.push(colorAdjust(base, { brightness: 0, contrast: 0, saturation: 0, hue: ((360 * ph + 180) % 360) - 180 }));
        break;
      case 'glow':
        out.push(glow(base, k * (0.6 + 0.4 * wave), Math.max(2, Math.min(base.width, base.height) * 0.04)));
        break;
      case 'shimmer':
        out.push(shimmerBand(base, -0.3 + 1.6 * saw, 0.18, 0.45 * Math.min(2, k)));
        break;
      case 'distort':
        out.push(displace(base, 0.03 * k * base.width, 3, ph));
        break;
      case 'duplicate':
        out.push(cloneImage(base));
        break;
    }
  }
  return out;
}
