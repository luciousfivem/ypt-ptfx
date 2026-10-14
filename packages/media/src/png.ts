/**
 * PNG / APNG I/O on top of fast-png (pure TypeScript, so it behaves identically in the
 * webview worker, Node tests and the browser build).
 */
import { convertIndexedToRgb, decode, decodeApng, encode, hasPngSignature } from 'fast-png';
import { createImage, type RgbaImage } from './image';

export { hasPngSignature };

export function encodePng(img: RgbaImage): Uint8Array {
  return encode({ width: img.width, height: img.height, data: img.data, depth: 8, channels: 4 });
}

/** Normalises any decoded PNG layout (gray, GA, RGB, RGBA, palette, 8/16-bit) to RGBA8. */
function toRgba(width: number, height: number, data: ArrayLike<number>, channels: number, depth: number, trns?: Uint16Array): RgbaImage {
  const img = createImage(width, height);
  const o = img.data;
  const shift = depth === 16 ? 8 : 0;
  const n = width * height;
  const maxv = (1 << depth) - 1;
  for (let i = 0; i < n; i++) {
    const g = (k: number) => (depth === 16 ? (data[i * channels + k]! >> shift) : depth === 8 ? data[i * channels + k]! : Math.round((data[i * channels + k]! * 255) / maxv));
    if (channels === 4) {
      o[i * 4] = g(0); o[i * 4 + 1] = g(1); o[i * 4 + 2] = g(2); o[i * 4 + 3] = g(3);
    } else if (channels === 3) {
      o[i * 4] = g(0); o[i * 4 + 1] = g(1); o[i * 4 + 2] = g(2); o[i * 4 + 3] = 255;
      if (trns && trns.length >= 3 && data[i * 3] === trns[0] && data[i * 3 + 1] === trns[1] && data[i * 3 + 2] === trns[2]) o[i * 4 + 3] = 0;
    } else if (channels === 2) {
      const v = g(0);
      o[i * 4] = v; o[i * 4 + 1] = v; o[i * 4 + 2] = v; o[i * 4 + 3] = g(1);
    } else if (channels === 1) {
      const v = g(0);
      o[i * 4] = v; o[i * 4 + 1] = v; o[i * 4 + 2] = v; o[i * 4 + 3] = 255;
      if (trns && trns.length >= 1 && data[i] === trns[0]) o[i * 4 + 3] = 0;
    } else {
      throw new Error(`Unsupported PNG channel count ${channels}`);
    }
  }
  return img;
}

export function decodePng(bytes: Uint8Array): RgbaImage {
  if (!hasPngSignature(bytes)) throw new Error('Not a PNG file (bad signature).');
  const png = decode(bytes);
  if (png.palette) {
    const rgb = convertIndexedToRgb(png);
    const hasAlpha = rgb.length === png.width * png.height * 4;
    return toRgba(png.width, png.height, rgb, hasAlpha ? 4 : 3, 8);
  }
  return toRgba(png.width, png.height, png.data, png.channels, png.depth, png.transparency);
}

export interface DecodedAnimation {
  frames: RgbaImage[];
  /** Per-frame display time in seconds. */
  delays: number[];
  loops: number;
}

/**
 * Decodes an APNG into full-canvas frames. fast-png already applies the APNG
 * dispose/blend operations, so each returned frame is a complete picture. A plain PNG
 * yields a single frame. (On desktop, FFmpeg is the primary path for animated images;
 * this is the dependency-free fallback.)
 */
export function decodeApngFrames(bytes: Uint8Array): DecodedAnimation {
  if (!hasPngSignature(bytes)) throw new Error('Not a PNG/APNG file (bad signature).');
  let apng;
  try {
    apng = decodeApng(bytes);
  } catch {
    return { frames: [decodePng(bytes)], delays: [0], loops: 0 };
  }
  if (apng.frames.length === 0) return { frames: [decodePng(bytes)], delays: [0], loops: 0 };
  const frames = apng.frames.map((f) => toRgba(apng.width, apng.height, f.data, apng.channels, apng.depth));
  const delays = apng.frames.map((f) => (f.delayDenominator ? f.delayNumber / f.delayDenominator : f.delayNumber / 100));
  return { frames, delays, loops: apng.numberOfPlays };
}
