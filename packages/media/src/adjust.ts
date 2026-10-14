/**
 * Colour correction and VFX filters. Everything returns a new image.
 */
import { createImage, fromPremultiplied, toPremultiplied, type RgbaImage } from './image';

export interface AdjustParams {
  brightness: number; // -1..1
  contrast: number; // -1..1
  saturation: number; // -1..1
  hue: number; // degrees
  sharpen: number; // 0..3
  glowAmount: number; // 0..2
  glowRadius: number; // px
}

export const IDENTITY_ADJUST: AdjustParams = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  hue: 0,
  sharpen: 0,
  glowAmount: 0,
  glowRadius: 6,
};

export function isIdentityAdjust(p: AdjustParams): boolean {
  return p.brightness === 0 && p.contrast === 0 && p.saturation === 0 && p.hue === 0 && p.sharpen === 0 && p.glowAmount === 0;
}

/** Brightness, contrast, saturation and hue rotation. Alpha is untouched. */
export function colorAdjust(img: RgbaImage, p: Pick<AdjustParams, 'brightness' | 'contrast' | 'saturation' | 'hue'>): RgbaImage {
  const out = createImage(img.width, img.height);
  const s = img.data;
  const o = out.data;
  const n = img.width * img.height;
  const contrast = Math.max(-0.99, Math.min(0.99, p.contrast));
  const cf = Math.tan(((contrast + 1) * Math.PI) / 4);
  const sat = 1 + p.saturation;
  const hueRad = (p.hue * Math.PI) / 180;
  const cosH = Math.cos(hueRad);
  const sinH = Math.sin(hueRad);
  // W3C filter-effects `hue-rotate` matrix: positive angles walk red -> green -> blue.
  const m = [
    0.213 + cosH * 0.787 - sinH * 0.213,
    0.715 - cosH * 0.715 - sinH * 0.715,
    0.072 - cosH * 0.072 + sinH * 0.928,
    0.213 - cosH * 0.213 + sinH * 0.143,
    0.715 + cosH * 0.285 + sinH * 0.14,
    0.072 - cosH * 0.072 - sinH * 0.283,
    0.213 - cosH * 0.213 - sinH * 0.787,
    0.715 - cosH * 0.715 + sinH * 0.715,
    0.072 + cosH * 0.928 + sinH * 0.072,
  ];
  const bright = p.brightness * 255;
  for (let i = 0; i < n; i++) {
    let r = s[i * 4]!;
    let g = s[i * 4 + 1]!;
    let b = s[i * 4 + 2]!;
    if (p.hue !== 0) {
      const r2 = m[0]! * r + m[1]! * g + m[2]! * b;
      const g2 = m[3]! * r + m[4]! * g + m[5]! * b;
      const b2 = m[6]! * r + m[7]! * g + m[8]! * b;
      r = r2;
      g = g2;
      b = b2;
    }
    if (p.saturation !== 0) {
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      r = y + (r - y) * sat;
      g = y + (g - y) * sat;
      b = y + (b - y) * sat;
    }
    if (p.contrast !== 0) {
      r = (r - 128) * cf + 128;
      g = (g - 128) * cf + 128;
      b = (b - 128) * cf + 128;
    }
    o[i * 4] = r + bright;
    o[i * 4 + 1] = g + bright;
    o[i * 4 + 2] = b + bright;
    o[i * 4 + 3] = s[i * 4 + 3]!;
  }
  return out;
}

/** Separable box blur on a float RGBA buffer, `radius` px, edge-clamped. */
function boxBlurPass(src: Float32Array, dst: Float32Array, w: number, h: number, radius: number, horizontal: boolean): void {
  const len = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const r = Math.max(0, Math.floor(radius));
  const norm = 1 / (2 * r + 1);
  for (let line = 0; line < lines; line++) {
    const idx = (k: number) => (horizontal ? (line * w + k) * 4 : (k * w + line) * 4);
    let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
    for (let k = -r; k <= r; k++) {
      const q = idx(Math.min(len - 1, Math.max(0, k)));
      a0 += src[q]!; a1 += src[q + 1]!; a2 += src[q + 2]!; a3 += src[q + 3]!;
    }
    for (let k = 0; k < len; k++) {
      const o = idx(k);
      dst[o] = a0 * norm; dst[o + 1] = a1 * norm; dst[o + 2] = a2 * norm; dst[o + 3] = a3 * norm;
      const add = idx(Math.min(len - 1, k + r + 1));
      const sub = idx(Math.max(0, k - r));
      a0 += src[add]! - src[sub]!;
      a1 += src[add + 1]! - src[sub + 1]!;
      a2 += src[add + 2]! - src[sub + 2]!;
      a3 += src[add + 3]! - src[sub + 3]!;
    }
  }
}

/** Approximate gaussian blur of a premultiplied float buffer: three box passes per axis. */
export function blurPremultiplied(buf: Float32Array, w: number, h: number, radius: number): Float32Array {
  if (radius < 0.5) return buf;
  let a: Float32Array = new Float32Array(buf);
  let b: Float32Array = new Float32Array(buf.length);
  const r = Math.max(1, Math.round(radius / 1.7));
  for (let pass = 0; pass < 3; pass++) {
    boxBlurPass(a, b, w, h, r, true);
    boxBlurPass(b, a, w, h, r, false);
  }
  return a;
}

/** Unsharp mask on colour only (premultiplied blur so transparent regions don't darken edges). */
export function sharpen(img: RgbaImage, amount: number): RgbaImage {
  if (amount <= 0) return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  const pm = toPremultiplied(img);
  const blur = blurPremultiplied(pm, img.width, img.height, 1.5);
  const out = new Float32Array(pm.length);
  for (let i = 0; i < pm.length; i += 4) {
    for (let c = 0; c < 3; c++) out[i + c] = Math.max(0, pm[i + c]! + amount * (pm[i + c]! - blur[i + c]!));
    out[i + 3] = pm[i + 3]!; // alpha untouched
    // keep premultiplied invariant: colour cannot exceed alpha
    const a = out[i + 3]!;
    for (let c = 0; c < 3; c++) if (out[i + c]! > a) out[i + c] = a;
  }
  return fromPremultiplied(out, img.width, img.height);
}

/** Additive bloom: P' = P + amount * blur(P) in premultiplied space (alpha grows with the halo). */
export function glow(img: RgbaImage, amount: number, radius: number): RgbaImage {
  if (amount <= 0 || radius <= 0) return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  const pm = toPremultiplied(img);
  const blur = blurPremultiplied(pm, img.width, img.height, radius);
  const out = new Float32Array(pm.length);
  for (let i = 0; i < pm.length; i += 4) {
    const a = Math.min(255, pm[i + 3]! + amount * blur[i + 3]!);
    out[i + 3] = a;
    for (let c = 0; c < 3; c++) out[i + c] = Math.min(a, pm[i + c]! + amount * blur[i + c]!);
  }
  return fromPremultiplied(out, img.width, img.height);
}

/**
 * Temporal motion blur: each output frame is a weighted blend of itself and the
 * previous `samples - 1` frames (wrapping for looping clips). `strength` 0 = off.
 */
export function motionBlurSequence(frames: RgbaImage[], samples: number, strength: number, wrap: boolean): RgbaImage[] {
  if (samples <= 1 || strength <= 0 || frames.length < 2) return frames;
  const n = frames.length;
  const pm = frames.map(toPremultiplied);
  const out: RgbaImage[] = [];
  for (let i = 0; i < n; i++) {
    const acc = new Float32Array(pm[0]!.length);
    let wsum = 0;
    for (let k = 0; k < samples; k++) {
      let j = i - k;
      if (j < 0) {
        if (!wrap) continue;
        j = (j + n) % n;
      }
      const w = k === 0 ? 1 : strength * Math.pow(0.7, k - 1);
      wsum += w;
      const f = pm[j]!;
      for (let q = 0; q < acc.length; q++) acc[q] = acc[q]! + f[q]! * w;
    }
    for (let q = 0; q < acc.length; q++) acc[q] = acc[q]! / wsum;
    out.push(fromPremultiplied(acc, frames[i]!.width, frames[i]!.height));
  }
  return out;
}

export function applyAdjust(img: RgbaImage, p: AdjustParams): RgbaImage {
  let cur = img;
  if (p.brightness !== 0 || p.contrast !== 0 || p.saturation !== 0 || p.hue !== 0) cur = colorAdjust(cur, p);
  if (p.sharpen > 0) cur = sharpen(cur, p.sharpen);
  if (p.glowAmount > 0) cur = glow(cur, p.glowAmount, p.glowRadius);
  return cur === img ? { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) } : cur;
}
