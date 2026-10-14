/**
 * RGBA8 image primitives. Pixels are STRAIGHT (non-premultiplied) alpha, row-major,
 * top-left origin. Resampling is done in premultiplied space so colour never bleeds
 * out of transparent pixels (the classic dark/white halo around sprites).
 */

export interface RgbaImage {
  width: number;
  height: number;
  /** length === width * height * 4 */
  data: Uint8ClampedArray;
}

export function createImage(width: number, height: number): RgbaImage {
  assertDims(width, height);
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function assertDims(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`Invalid image size ${width}x${height}`);
  }
  if (width * height > 16384 * 16384) throw new RangeError(`Image ${width}x${height} is too large`);
}

export function cloneImage(img: RgbaImage): RgbaImage {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

export function fillImage(img: RgbaImage, r: number, g: number, b: number, a: number): void {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = a;
  }
}

/** Copies a rectangle of `src` into `dst` (no blending). Out-of-range parts are clipped. */
export function blit(
  src: RgbaImage,
  dst: RgbaImage,
  dx: number,
  dy: number,
  sx = 0,
  sy = 0,
  sw = src.width - sx,
  sh = src.height - sy,
): void {
  for (let y = 0; y < sh; y++) {
    const ty = dy + y;
    const srcY = sy + y;
    if (ty < 0 || ty >= dst.height || srcY < 0 || srcY >= src.height) continue;
    for (let x = 0; x < sw; x++) {
      const tx = dx + x;
      const srcX = sx + x;
      if (tx < 0 || tx >= dst.width || srcX < 0 || srcX >= src.width) continue;
      const si = (srcY * src.width + srcX) * 4;
      const di = (ty * dst.width + tx) * 4;
      dst.data[di] = src.data[si]!;
      dst.data[di + 1] = src.data[si + 1]!;
      dst.data[di + 2] = src.data[si + 2]!;
      dst.data[di + 3] = src.data[si + 3]!;
    }
  }
}

export function cropImage(img: RgbaImage, x: number, y: number, w: number, h: number): RgbaImage {
  const out = createImage(w, h);
  blit(img, out, 0, 0, x, y, w, h);
  return out;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Bounding box of pixels with alpha > threshold, or null when fully transparent. */
export function alphaBounds(img: RgbaImage, threshold = 0): Rect | null {
  let minX = img.width;
  let minY = img.height;
  let maxX = -1;
  let maxY = -1;
  const d = img.data;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (d[(y * img.width + x) * 4 + 3]! > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Convert to premultiplied float RGBA (values 0..255 scaled by alpha/255). */
export function toPremultiplied(img: RgbaImage): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n * 4);
  const d = img.data;
  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3]! / 255;
    out[i * 4] = d[i * 4]! * a;
    out[i * 4 + 1] = d[i * 4 + 1]! * a;
    out[i * 4 + 2] = d[i * 4 + 2]! * a;
    out[i * 4 + 3] = a * 255;
  }
  return out;
}

export function fromPremultiplied(buf: Float32Array, width: number, height: number): RgbaImage {
  const img = createImage(width, height);
  const o = img.data;
  const n = width * height;
  for (let i = 0; i < n; i++) {
    const a = buf[i * 4 + 3]!;
    if (a <= 0.0001) {
      o[i * 4] = o[i * 4 + 1] = o[i * 4 + 2] = o[i * 4 + 3] = 0;
      continue;
    }
    const inv = 255 / a;
    o[i * 4] = buf[i * 4]! * inv;
    o[i * 4 + 1] = buf[i * 4 + 1]! * inv;
    o[i * 4 + 2] = buf[i * 4 + 2]! * inv;
    o[i * 4 + 3] = a;
  }
  return img;
}

/**
 * Resamples to `width` x `height`. Downscaling uses exact area averaging (box filter
 * with fractional coverage) which is alias-free; upscaling uses bilinear.
 * Both operate in premultiplied space.
 */
export function resizeImage(img: RgbaImage, width: number, height: number): RgbaImage {
  assertDims(width, height);
  if (width === img.width && height === img.height) return cloneImage(img);
  const src = toPremultiplied(img);
  const tmp = new Float32Array(width * img.height * 4);
  resampleAxis(src, img.width, img.height, tmp, width, true);
  const dst = new Float32Array(width * height * 4);
  resampleAxis(tmp, width, img.height, dst, height, false);
  return fromPremultiplied(dst, width, height);
}

/** Resample one axis. `horizontal` selects x (true) or y (false). */
function resampleAxis(src: Float32Array, sw: number, sh: number, dst: Float32Array, newSize: number, horizontal: boolean): void {
  const oldSize = horizontal ? sw : sh;
  const lines = horizontal ? sh : sw;
  const scale = oldSize / newSize;
  for (let d = 0; d < newSize; d++) {
    if (scale > 1) {
      // area average
      const start = d * scale;
      const end = start + scale;
      const i0 = Math.floor(start);
      const i1 = Math.min(oldSize - 1, Math.ceil(end) - 1);
      for (let line = 0; line < lines; line++) {
        let r = 0, g = 0, b = 0, a = 0, wsum = 0;
        for (let i = i0; i <= i1; i++) {
          const w = Math.min(end, i + 1) - Math.max(start, i);
          if (w <= 0) continue;
          const idx = horizontal ? (line * sw + i) * 4 : (i * sw + line) * 4;
          r += src[idx]! * w;
          g += src[idx + 1]! * w;
          b += src[idx + 2]! * w;
          a += src[idx + 3]! * w;
          wsum += w;
        }
        const out = horizontal ? (line * newSize + d) * 4 : (d * sw + line) * 4;
        const inv = wsum > 0 ? 1 / wsum : 0;
        dst[out] = r * inv;
        dst[out + 1] = g * inv;
        dst[out + 2] = b * inv;
        dst[out + 3] = a * inv;
      }
    } else {
      // bilinear (pixel-centre aligned)
      const pos = (d + 0.5) * scale - 0.5;
      const i0 = Math.max(0, Math.min(oldSize - 1, Math.floor(pos)));
      const i1 = Math.min(oldSize - 1, i0 + 1);
      const t = Math.max(0, Math.min(1, pos - i0));
      for (let line = 0; line < lines; line++) {
        const a0 = horizontal ? (line * sw + i0) * 4 : (i0 * sw + line) * 4;
        const a1 = horizontal ? (line * sw + i1) * 4 : (i1 * sw + line) * 4;
        const out = horizontal ? (line * newSize + d) * 4 : (d * sw + line) * 4;
        for (let c = 0; c < 4; c++) dst[out + c] = src[a0 + c]! * (1 - t) + src[a1 + c]! * t;
      }
    }
  }
}

export type FitMode = 'contain' | 'cover' | 'stretch';

/**
 * Fits `img` into a `w` x `h` transparent canvas. `contain` preserves aspect and
 * letterboxes, `cover` preserves aspect and crops, `stretch` ignores aspect.
 */
export function fitImage(img: RgbaImage, w: number, h: number, mode: FitMode, center = true): RgbaImage {
  assertDims(w, h);
  if (mode === 'stretch') return resizeImage(img, w, h);
  const sx = w / img.width;
  const sy = h / img.height;
  const s = mode === 'contain' ? Math.min(sx, sy) : Math.max(sx, sy);
  const tw = Math.max(1, Math.round(img.width * s));
  const th = Math.max(1, Math.round(img.height * s));
  const scaled = resizeImage(img, tw, th);
  const out = createImage(w, h);
  const ox = center ? Math.floor((w - tw) / 2) : 0;
  const oy = center ? Math.floor((h - th) / 2) : 0;
  blit(scaled, out, ox, oy);
  return out;
}

/** Edge extrusion: repeats the border pixels of the rect outward by `amount` px (clipped to the image). */
export function extrudeEdges(img: RgbaImage, rect: Rect, amount: number): void {
  if (amount <= 0) return;
  const { x, y, w, h } = rect;
  const px = (cx: number, cy: number) => (cy * img.width + cx) * 4;
  const copy = (from: number, to: number) => {
    img.data[to] = img.data[from]!;
    img.data[to + 1] = img.data[from + 1]!;
    img.data[to + 2] = img.data[from + 2]!;
    img.data[to + 3] = img.data[from + 3]!;
  };
  for (let e = 1; e <= amount; e++) {
    for (let i = 0; i < w; i++) {
      const cx = x + i;
      if (y - e >= 0) copy(px(cx, y), px(cx, y - e));
      if (y + h - 1 + e < img.height) copy(px(cx, y + h - 1), px(cx, y + h - 1 + e));
    }
    for (let j = -e + 1; j < h + e; j++) {
      const cy = Math.min(y + h - 1, Math.max(y, y + j));
      const ry = y + j;
      if (ry < 0 || ry >= img.height) continue;
      if (x - e >= 0) copy(px(x, cy), px(x - e, ry));
      if (x + w - 1 + e < img.width) copy(px(x + w - 1, cy), px(x + w - 1 + e, ry));
    }
  }
}

export function flipVertical(img: RgbaImage): RgbaImage {
  const out = createImage(img.width, img.height);
  const row = img.width * 4;
  for (let y = 0; y < img.height; y++) {
    out.data.set(img.data.subarray(y * row, (y + 1) * row), (img.height - 1 - y) * row);
  }
  return out;
}

export function imagesEqual(a: RgbaImage, b: RgbaImage, tolerance = 0): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  for (let i = 0; i < a.data.length; i++) if (Math.abs(a.data[i]! - b.data[i]!) > tolerance) return false;
  return true;
}

/** Mean absolute difference per channel (0..255). */
export function meanAbsDiff(a: RgbaImage, b: RgbaImage): number {
  if (a.width !== b.width || a.height !== b.height) return Infinity;
  let s = 0;
  for (let i = 0; i < a.data.length; i++) s += Math.abs(a.data[i]! - b.data[i]!);
  return s / a.data.length;
}
