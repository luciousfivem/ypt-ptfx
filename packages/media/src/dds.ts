/**
 * DDS (DirectDraw Surface) encoder, decoder and validator.
 *
 * Supported pixel formats — the subset that CodeWalker's DDSIO verifiably imports
 * (see docs/research/ypt-format.md) AND that is useful for particle sprites:
 *
 *   BC1   (DXT1)   4 bpp, opaque or 1-bit alpha
 *   BC3   (DXT5)   8 bpp, smooth 8-bit alpha  <- recommended for flipbooks
 *   BGRA8 (A8R8G8B8) 32 bpp uncompressed
 *
 * Only legacy-header DDS (no DX10 extension) is written: it is the most widely
 * accepted layout. Cubemaps/volumes are never produced.
 */
import { createImage, resizeImage, type RgbaImage } from './image';

export type DdsPixelFormat = 'BC1' | 'BC3' | 'BGRA8';

export interface DdsEncodeOptions {
  format: DdsPixelFormat;
  /** Generate the full mip chain down to 1x1. */
  mipmaps: boolean;
}

const DDS_MAGIC = 0x20534444; // "DDS "
const HEADER_SIZE = 124;
const DDSD_CAPS = 0x1;
const DDSD_HEIGHT = 0x2;
const DDSD_WIDTH = 0x4;
const DDSD_PITCH = 0x8;
const DDSD_PIXELFORMAT = 0x1000;
const DDSD_MIPMAPCOUNT = 0x20000;
const DDSD_LINEARSIZE = 0x80000;
const DDPF_ALPHAPIXELS = 0x1;
const DDPF_FOURCC = 0x4;
const DDPF_RGB = 0x40;
const DDSCAPS_COMPLEX = 0x8;
const DDSCAPS_TEXTURE = 0x1000;
const DDSCAPS_MIPMAP = 0x400000;
const FOURCC_DXT1 = 0x31545844;
const FOURCC_DXT5 = 0x35545844;
const FOURCC_DX10 = 0x30315844;

export function mipDimensions(width: number, height: number, level: number): { w: number; h: number } {
  return { w: Math.max(1, width >> level), h: Math.max(1, height >> level) };
}

export function mipLevelCount(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

export function levelByteSize(format: DdsPixelFormat, w: number, h: number): number {
  if (format === 'BGRA8') return w * h * 4;
  const blocks = Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4));
  return blocks * (format === 'BC1' ? 8 : 16);
}

export function expectedDdsSize(format: DdsPixelFormat, width: number, height: number, mips: number): number {
  let total = 4 + HEADER_SIZE;
  for (let l = 0; l < mips; l++) {
    const { w, h } = mipDimensions(width, height, l);
    total += levelByteSize(format, w, h);
  }
  return total;
}

/* ------------------------------------------------------------ colour quant */

const expand5 = (v: number) => (v << 3) | (v >> 2);
const expand6 = (v: number) => (v << 2) | (v >> 4);

function quant565(r: number, g: number, b: number): number {
  const r5 = Math.max(0, Math.min(31, Math.round((r * 31) / 255)));
  const g6 = Math.max(0, Math.min(63, Math.round((g * 63) / 255)));
  const b5 = Math.max(0, Math.min(31, Math.round((b * 31) / 255)));
  return (r5 << 11) | (g6 << 5) | b5;
}

function unpack565(c: number, out: number[]): void {
  out[0] = expand5((c >> 11) & 31);
  out[1] = expand6((c >> 5) & 63);
  out[2] = expand5(c & 31);
}

interface ColorBlockResult {
  c0: number;
  c1: number;
  indices: number; // 16 x 2-bit, pixel 0 in the low bits
  error: number;
}

/** Index weights (weight of c0, weight of c1) per palette slot. */
const W4: ReadonlyArray<readonly [number, number]> = [[1, 0], [0, 1], [2 / 3, 1 / 3], [1 / 3, 2 / 3]];
const W3: ReadonlyArray<readonly [number, number]> = [[1, 0], [0, 1], [0.5, 0.5]];

function buildPalette(c0: number, c1: number, fourColor: boolean): number[][] {
  const a: number[] = [0, 0, 0];
  const b: number[] = [0, 0, 0];
  unpack565(c0, a);
  unpack565(c1, b);
  if (fourColor) {
    return [
      a,
      b,
      [(2 * a[0]! + b[0]!) / 3, (2 * a[1]! + b[1]!) / 3, (2 * a[2]! + b[2]!) / 3],
      [(a[0]! + 2 * b[0]!) / 3, (a[1]! + 2 * b[1]!) / 3, (a[2]! + 2 * b[2]!) / 3],
    ];
  }
  return [a, b, [(a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2, (a[2]! + b[2]!) / 2]];
}

/**
 * Chooses the best BC1 colour block for the given pixels.
 * `px` = 16 * [r,g,b]; `use` marks pixels that take part in the fit (opaque ones);
 * `transparent` marks pixels that must map to the transparent slot (BC1 3-colour mode only).
 */
function encodeColorBlock(px: Float32Array, use: boolean[], transparent: boolean[], allowThreeColor: boolean): ColorBlockResult {
  const hasTransparent = allowThreeColor && transparent.some(Boolean);
  const idx: number[] = [];
  for (let i = 0; i < 16; i++) if (use[i]) idx.push(i);
  if (idx.length === 0) {
    // nothing visible: any valid block works; use 3-colour mode with everything transparent
    return { c0: 0, c1: 0, indices: hasTransparent ? 0xffffffff : 0, error: 0 };
  }

  // mean + covariance of fitted pixels
  let mr = 0, mg = 0, mb = 0;
  for (const i of idx) { mr += px[i * 3]!; mg += px[i * 3 + 1]!; mb += px[i * 3 + 2]!; }
  const inv = 1 / idx.length;
  mr *= inv; mg *= inv; mb *= inv;
  let cxx = 0, cxy = 0, cxz = 0, cyy = 0, cyz = 0, czz = 0;
  let minR = 255, minG = 255, minB = 255, maxR = 0, maxG = 0, maxB = 0;
  for (const i of idx) {
    const r = px[i * 3]!, g = px[i * 3 + 1]!, b = px[i * 3 + 2]!;
    const dr = r - mr, dg = g - mg, db = b - mb;
    cxx += dr * dr; cxy += dr * dg; cxz += dr * db; cyy += dg * dg; cyz += dg * db; czz += db * db;
    minR = Math.min(minR, r); minG = Math.min(minG, g); minB = Math.min(minB, b);
    maxR = Math.max(maxR, r); maxG = Math.max(maxG, g); maxB = Math.max(maxB, b);
  }
  // principal axis by power iteration, seeded with the bbox diagonal
  let ax = maxR - minR, ay = maxG - minG, az = maxB - minB;
  if (ax + ay + az < 1e-6) { ax = 1; ay = 1; az = 1; }
  for (let it = 0; it < 6; it++) {
    const nx = cxx * ax + cxy * ay + cxz * az;
    const ny = cxy * ax + cyy * ay + cyz * az;
    const nz = cxz * ax + cyz * ay + czz * az;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) break;
    ax = nx / len; ay = ny / len; az = nz / len;
  }
  const alen = Math.hypot(ax, ay, az) || 1;
  ax /= alen; ay /= alen; az /= alen;
  let tmin = Infinity, tmax = -Infinity;
  for (const i of idx) {
    const t = (px[i * 3]! - mr) * ax + (px[i * 3 + 1]! - mg) * ay + (px[i * 3 + 2]! - mb) * az;
    if (t < tmin) tmin = t;
    if (t > tmax) tmax = t;
  }
  const clamp255 = (v: number) => Math.max(0, Math.min(255, v));
  let e0: [number, number, number] = [clamp255(mr + ax * tmax), clamp255(mg + ay * tmax), clamp255(mb + az * tmax)];
  let e1: [number, number, number] = [clamp255(mr + ax * tmin), clamp255(mg + ay * tmin), clamp255(mb + az * tmin)];

  let best: ColorBlockResult | null = null;
  for (let iter = 0; iter < 3; iter++) {
    let c0 = quant565(e0[0], e0[1], e0[2]);
    let c1 = quant565(e1[0], e1[1], e1[2]);
    // ordering rule: 4-colour mode needs c0 > c1, 3-colour mode needs c0 <= c1
    if (hasTransparent) {
      if (c0 > c1) [c0, c1] = [c1, c0];
    } else if (c0 < c1) {
      [c0, c1] = [c1, c0];
    }
    const fourColor = !hasTransparent && c0 > c1;
    const palette = buildPalette(c0, c1, fourColor || !allowThreeColor);
    // when not allowThreeColor (BC3) the block is ALWAYS decoded in 4-colour mode
    const slots = fourColor || !allowThreeColor ? 4 : 3;
    let indices = 0;
    let error = 0;
    const assigned: number[] = new Array(16).fill(0);
    for (let i = 0; i < 16; i++) {
      if (hasTransparent && transparent[i]) {
        indices |= 3 << (i * 2);
        assigned[i] = 3;
        continue;
      }
      let bi = 0, bd = Infinity;
      for (let s = 0; s < slots; s++) {
        const p = palette[s]!;
        const d = (px[i * 3]! - p[0]!) ** 2 + (px[i * 3 + 1]! - p[1]!) ** 2 + (px[i * 3 + 2]! - p[2]!) ** 2;
        if (d < bd) { bd = d; bi = s; }
      }
      indices |= bi << (i * 2);
      assigned[i] = bi;
      if (use[i]) error += bd;
    }
    if (!best || error < best.error) best = { c0, c1, indices: indices >>> 0, error };
    if (error === 0) break;
    // least-squares refinement of the endpoints for the current index assignment
    const weights = slots === 4 ? W4 : W3;
    let aa = 0, ab = 0, bb = 0;
    const ar = [0, 0, 0], br = [0, 0, 0];
    let counted = 0;
    for (let i = 0; i < 16; i++) {
      if (!use[i] || (hasTransparent && transparent[i])) continue;
      const [wa, wb] = weights[assigned[i]!]!;
      aa += wa * wa; ab += wa * wb; bb += wb * wb;
      for (let c = 0; c < 3; c++) { ar[c]! += wa * px[i * 3 + c]!; br[c]! += wb * px[i * 3 + c]!; }
      counted++;
    }
    const det = aa * bb - ab * ab;
    if (counted === 0 || Math.abs(det) < 1e-9) break;
    const n0: number[] = [], n1: number[] = [];
    for (let c = 0; c < 3; c++) {
      n0[c] = clamp255((bb * ar[c]! - ab * br[c]!) / det);
      n1[c] = clamp255((aa * br[c]! - ab * ar[c]!) / det);
    }
    e0 = [n0[0]!, n0[1]!, n0[2]!];
    e1 = [n1[0]!, n1[1]!, n1[2]!];
  }
  return best!;
}

function write16(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >> 8) & 0xff;
}

function write32(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >>> 8) & 0xff;
  buf[off + 2] = (v >>> 16) & 0xff;
  buf[off + 3] = (v >>> 24) & 0xff;
}

function read32(buf: Uint8Array, off: number): number {
  return (buf[off]! | (buf[off + 1]! << 8) | (buf[off + 2]! << 16) | (buf[off + 3]! << 24)) >>> 0;
}

function writeColorBlock(out: Uint8Array, off: number, r: ColorBlockResult): void {
  write16(out, off, r.c0);
  write16(out, off + 2, r.c1);
  write32(out, off + 4, r.indices);
}

/** Alpha block: tries the 8-value and the 6-value+{0,255} modes, keeps the smaller error. */
function encodeAlphaBlock(a: number[], out: Uint8Array, off: number): void {
  let amin = 255, amax = 0;
  for (const v of a) { if (v < amin) amin = v; if (v > amax) amax = v; }
  if (amin === amax) {
    out[off] = amax;
    out[off + 1] = amin;
    for (let i = 2; i < 8; i++) out[off + i] = 0;
    return;
  }
  type Mode = { a0: number; a1: number; pal: number[] };
  const mode8 = (): Mode => {
    const a0 = amax, a1 = amin;
    const pal = [a0, a1];
    for (let i = 1; i <= 6; i++) pal.push(((7 - i) * a0 + i * a1) / 7);
    return { a0, a1, pal };
  };
  const mode6 = (): Mode | null => {
    // endpoints are the extremes of the "interior" values; 0 and 255 are implicit palette slots
    let lo = 255, hi = 0, any = false;
    for (const v of a) if (v !== 0 && v !== 255) { any = true; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!any) { lo = 0; hi = 255; }
    const a0 = lo, a1 = hi;
    const pal = [a0, a1];
    for (let i = 1; i <= 4; i++) pal.push(((5 - i) * a0 + i * a1) / 5);
    pal.push(0, 255);
    return { a0, a1, pal };
  };
  let bestErr = Infinity;
  let bestMode: Mode | null = null;
  let bestIdx: number[] = [];
  for (const m of [mode8(), mode6()]) {
    if (!m) continue;
    let err = 0;
    const idx: number[] = [];
    for (const v of a) {
      let bi = 0, bd = Infinity;
      for (let s = 0; s < 8; s++) {
        const d = (v - m.pal[s]!) ** 2;
        if (d < bd) { bd = d; bi = s; }
      }
      err += bd;
      idx.push(bi);
    }
    if (err < bestErr) { bestErr = err; bestMode = m; bestIdx = idx; }
  }
  const m = bestMode!;
  out[off] = m.a0;
  out[off + 1] = m.a1;
  // pack 16 x 3-bit indices little-endian into 6 bytes
  let bits = 0n;
  for (let i = 0; i < 16; i++) bits |= BigInt(bestIdx[i]!) << BigInt(i * 3);
  for (let i = 0; i < 6; i++) out[off + 2 + i] = Number((bits >> BigInt(i * 8)) & 0xffn);
}

function encodeLevel(img: RgbaImage, format: DdsPixelFormat, out: Uint8Array, offset: number): number {
  const { width: w, height: h } = img;
  if (format === 'BGRA8') {
    for (let i = 0; i < w * h; i++) {
      out[offset + i * 4] = img.data[i * 4 + 2]!;
      out[offset + i * 4 + 1] = img.data[i * 4 + 1]!;
      out[offset + i * 4 + 2] = img.data[i * 4]!;
      out[offset + i * 4 + 3] = img.data[i * 4 + 3]!;
    }
    return w * h * 4;
  }
  const bw = Math.max(1, Math.ceil(w / 4));
  const bh = Math.max(1, Math.ceil(h / 4));
  const px = new Float32Array(48);
  const use: boolean[] = new Array(16).fill(false);
  const transparent: boolean[] = new Array(16).fill(false);
  const alphas: number[] = new Array(16).fill(0);
  const blockBytes = format === 'BC1' ? 8 : 16;
  let o = offset;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      for (let j = 0; j < 4; j++) {
        for (let i = 0; i < 4; i++) {
          const sx = Math.min(w - 1, bx * 4 + i);
          const sy = Math.min(h - 1, by * 4 + j);
          const s = (sy * w + sx) * 4;
          const k = j * 4 + i;
          const a = img.data[s + 3]!;
          px[k * 3] = img.data[s]!;
          px[k * 3 + 1] = img.data[s + 1]!;
          px[k * 3 + 2] = img.data[s + 2]!;
          alphas[k] = a;
          if (format === 'BC1') {
            transparent[k] = a < 128;
            use[k] = a >= 128;
          } else {
            // BC3: colour of fully transparent texels is irrelevant, so keep it out of the fit
            use[k] = a > 0;
            transparent[k] = false;
          }
        }
      }
      if (format === 'BC1') {
        writeColorBlock(out, o, encodeColorBlock(px, use, transparent, true));
      } else {
        // if the whole block is invisible, fit on all texels so colour is still sane
        if (!use.some(Boolean)) use.fill(true);
        encodeAlphaBlock(alphas, out, o);
        writeColorBlock(out, o + 8, encodeColorBlock(px, use, transparent, false));
      }
      o += blockBytes;
    }
  }
  return o - offset;
}

/** Full mip chain via premultiplied area-averaging (no dark halos on sprite edges). */
export function buildMipChain(img: RgbaImage): RgbaImage[] {
  const levels = [img];
  let cur = img;
  while (cur.width > 1 || cur.height > 1) {
    const { w, h } = mipDimensions(cur.width, cur.height, 1);
    cur = resizeImage(cur, w, h);
    levels.push(cur);
  }
  return levels;
}

export function encodeDds(img: RgbaImage, opts: DdsEncodeOptions): Uint8Array {
  const chain = opts.mipmaps ? buildMipChain(img) : [img];
  const mips = chain.length;
  const total = expectedDdsSize(opts.format, img.width, img.height, mips);
  const out = new Uint8Array(total);
  write32(out, 0, DDS_MAGIC);
  write32(out, 4, HEADER_SIZE);
  const compressed = opts.format !== 'BGRA8';
  let flags = DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT;
  flags |= compressed ? DDSD_LINEARSIZE : DDSD_PITCH;
  if (mips > 1) flags |= DDSD_MIPMAPCOUNT;
  write32(out, 8, flags);
  write32(out, 12, img.height);
  write32(out, 16, img.width);
  write32(out, 20, compressed ? levelByteSize(opts.format, img.width, img.height) : img.width * 4);
  write32(out, 24, 0); // depth
  write32(out, 28, mips > 1 ? mips : 0);
  // dwReserved1[11] left zero (offset 32..76)
  // pixel format @ 76
  write32(out, 76, 32);
  if (opts.format === 'BGRA8') {
    write32(out, 80, DDPF_RGB | DDPF_ALPHAPIXELS);
    write32(out, 84, 0);
    write32(out, 88, 32);
    write32(out, 92, 0x00ff0000);
    write32(out, 96, 0x0000ff00);
    write32(out, 100, 0x000000ff);
    write32(out, 104, 0xff000000);
  } else {
    write32(out, 80, DDPF_FOURCC);
    write32(out, 84, opts.format === 'BC1' ? FOURCC_DXT1 : FOURCC_DXT5);
  }
  let caps = DDSCAPS_TEXTURE;
  if (mips > 1) caps |= DDSCAPS_COMPLEX | DDSCAPS_MIPMAP;
  write32(out, 108, caps);
  let off = 4 + HEADER_SIZE;
  for (const level of chain) off += encodeLevel(level, opts.format, out, off);
  if (off !== total) throw new Error(`DDS encoder size mismatch: wrote ${off}, expected ${total}`);
  return out;
}

/* ------------------------------------------------------------------ decode */

export interface DdsInfo {
  width: number;
  height: number;
  mipLevels: number;
  format: DdsPixelFormat;
  hasAlpha: boolean;
  dataBytes: number;
}

export interface DdsValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  info: DdsInfo | null;
}

export function validateDds(bytes: Uint8Array): DdsValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fail = (): DdsValidation => ({ valid: false, errors, warnings, info: null });
  if (bytes.length < 4 + HEADER_SIZE) {
    errors.push(`File too small to be a DDS (${bytes.length} bytes).`);
    return fail();
  }
  if (read32(bytes, 0) !== DDS_MAGIC) {
    errors.push('Missing "DDS " magic number.');
    return fail();
  }
  if (read32(bytes, 4) !== HEADER_SIZE) errors.push(`Header size is ${read32(bytes, 4)}, expected ${HEADER_SIZE}.`);
  if (read32(bytes, 76) !== 32) errors.push('Pixel-format block size is not 32.');
  const flags = read32(bytes, 8);
  for (const [bit, name] of [[DDSD_CAPS, 'CAPS'], [DDSD_HEIGHT, 'HEIGHT'], [DDSD_WIDTH, 'WIDTH'], [DDSD_PIXELFORMAT, 'PIXELFORMAT']] as const) {
    if (!(flags & bit)) errors.push(`Required header flag DDSD_${name} is not set.`);
  }
  const height = read32(bytes, 12);
  const width = read32(bytes, 16);
  const mipField = read32(bytes, 28);
  const mips = flags & DDSD_MIPMAPCOUNT ? Math.max(1, mipField) : 1;
  if (width < 1 || height < 1 || width > 16384 || height > 16384) errors.push(`Invalid dimensions ${width}x${height}.`);
  const depth = read32(bytes, 24);
  const caps2 = read32(bytes, 112);
  if (caps2 !== 0) errors.push('Cubemap/volume DDS files are not supported (caps2 != 0).');
  if (depth > 1) errors.push('Volume textures are not supported.');
  const pfFlags = read32(bytes, 80);
  const fourCC = read32(bytes, 84);
  let format: DdsPixelFormat | null = null;
  let hasAlpha = false;
  if (pfFlags & DDPF_FOURCC) {
    if (fourCC === FOURCC_DXT1) {
      format = 'BC1';
      hasAlpha = true; // 1-bit
    } else if (fourCC === FOURCC_DXT5) {
      format = 'BC3';
      hasAlpha = true;
    } else if (fourCC === FOURCC_DX10) {
      errors.push('DX10-extended DDS headers are not supported by this exporter; use legacy DXT1/DXT5/A8R8G8B8.');
    } else {
      const cc = String.fromCharCode(fourCC & 255, (fourCC >> 8) & 255, (fourCC >> 16) & 255, (fourCC >>> 24) & 255);
      errors.push(`Unsupported FourCC "${cc}" (supported: DXT1, DXT5).`);
    }
  } else if (pfFlags & DDPF_RGB) {
    const bits = read32(bytes, 88);
    const r = read32(bytes, 92), g = read32(bytes, 96), b = read32(bytes, 100), a = read32(bytes, 104);
    if (bits === 32 && r === 0x00ff0000 && g === 0x0000ff00 && b === 0x000000ff && a === 0xff000000) {
      format = 'BGRA8';
      hasAlpha = (pfFlags & DDPF_ALPHAPIXELS) !== 0;
      if (!hasAlpha) warnings.push('BGRA8 texture has no alpha flag.');
    } else {
      errors.push(`Unsupported uncompressed layout (${bits} bpp, masks ${r.toString(16)}/${g.toString(16)}/${b.toString(16)}/${a.toString(16)}); expected A8R8G8B8.`);
    }
  } else {
    errors.push('Pixel format is neither FourCC nor RGB.');
  }
  if (!(read32(bytes, 108) & DDSCAPS_TEXTURE)) errors.push('DDSCAPS_TEXTURE is not set.');
  if (mips > 1 && !(read32(bytes, 108) & DDSCAPS_MIPMAP)) warnings.push('Mip count > 1 but DDSCAPS_MIPMAP is not set.');
  if (errors.length || !format) return fail();
  const maxMips = mipLevelCount(width, height);
  if (mips > maxMips) {
    errors.push(`Mip count ${mips} exceeds the maximum ${maxMips} for ${width}x${height}.`);
    return fail();
  }
  const expected = expectedDdsSize(format, width, height, mips);
  if (bytes.length !== expected) {
    errors.push(`File size ${bytes.length} does not match the ${expected} bytes expected for ${format} ${width}x${height} with ${mips} mip level(s).`);
    return fail();
  }
  const pow2 = (n: number) => (n & (n - 1)) === 0;
  if (!pow2(width) || !pow2(height)) warnings.push(`Dimensions ${width}x${height} are not powers of two.`);
  if ((format === 'BC1' || format === 'BC3') && (width % 4 !== 0 || height % 4 !== 0)) {
    warnings.push('Block-compressed dimensions are not multiples of 4.');
  }
  return {
    valid: true,
    errors,
    warnings,
    info: { width, height, mipLevels: mips, format, hasAlpha, dataBytes: bytes.length - 4 - HEADER_SIZE },
  };
}

function decodeColorBlock(bytes: Uint8Array, off: number, fourColorOnly: boolean, rgba: Uint8ClampedArray, blockIndexPx: (i: number) => number): void {
  const c0 = bytes[off]! | (bytes[off + 1]! << 8);
  const c1 = bytes[off + 2]! | (bytes[off + 3]! << 8);
  const bits = read32(bytes, off + 4);
  const four = fourColorOnly || c0 > c1;
  const pal = buildPalette(c0, c1, four);
  for (let i = 0; i < 16; i++) {
    const idx = (bits >>> (i * 2)) & 3;
    const dst = blockIndexPx(i);
    if (dst < 0) continue;
    if (!four && idx === 3) {
      rgba[dst] = 0; rgba[dst + 1] = 0; rgba[dst + 2] = 0; rgba[dst + 3] = 0;
    } else {
      const p = pal[idx]!;
      rgba[dst] = p[0]!; rgba[dst + 1] = p[1]!; rgba[dst + 2] = p[2]!; rgba[dst + 3] = 255;
    }
  }
}

function decodeAlphaBlock(bytes: Uint8Array, off: number): number[] {
  const a0 = bytes[off]!;
  const a1 = bytes[off + 1]!;
  const pal = [a0, a1];
  if (a0 > a1) for (let i = 1; i <= 6; i++) pal.push(((7 - i) * a0 + i * a1) / 7);
  else {
    for (let i = 1; i <= 4; i++) pal.push(((5 - i) * a0 + i * a1) / 5);
    pal.push(0, 255);
  }
  let bits = 0n;
  for (let i = 0; i < 6; i++) bits |= BigInt(bytes[off + 2 + i]!) << BigInt(i * 8);
  const out: number[] = [];
  for (let i = 0; i < 16; i++) out.push(pal[Number((bits >> BigInt(i * 3)) & 7n)]!);
  return out;
}

/** Decodes every mip level to RGBA8. Throws if the file does not validate. */
export function decodeDds(bytes: Uint8Array): { info: DdsInfo; levels: RgbaImage[] } {
  const v = validateDds(bytes);
  if (!v.valid || !v.info) throw new Error(`Invalid DDS: ${v.errors.join('; ')}`);
  const info = v.info;
  const levels: RgbaImage[] = [];
  let off = 4 + HEADER_SIZE;
  for (let l = 0; l < info.mipLevels; l++) {
    const { w, h } = mipDimensions(info.width, info.height, l);
    const img = createImage(w, h);
    if (info.format === 'BGRA8') {
      for (let i = 0; i < w * h; i++) {
        img.data[i * 4] = bytes[off + i * 4 + 2]!;
        img.data[i * 4 + 1] = bytes[off + i * 4 + 1]!;
        img.data[i * 4 + 2] = bytes[off + i * 4]!;
        img.data[i * 4 + 3] = bytes[off + i * 4 + 3]!;
      }
    } else {
      const bw = Math.max(1, Math.ceil(w / 4));
      const bh = Math.max(1, Math.ceil(h / 4));
      let o = off;
      for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
          const dstOf = (i: number) => {
            const x = bx * 4 + (i % 4);
            const y = by * 4 + Math.floor(i / 4);
            return x < w && y < h ? (y * w + x) * 4 : -1;
          };
          if (info.format === 'BC1') {
            decodeColorBlock(bytes, o, false, img.data, dstOf);
            o += 8;
          } else {
            const alpha = decodeAlphaBlock(bytes, o);
            decodeColorBlock(bytes, o + 8, true, img.data, dstOf);
            for (let i = 0; i < 16; i++) {
              const d = dstOf(i);
              if (d >= 0) img.data[d + 3] = alpha[i]!;
            }
            o += 16;
          }
        }
      }
    }
    off += levelByteSize(info.format, w, h);
    levels.push(img);
  }
  return { info, levels };
}

/** Peak signal-to-noise ratio (dB) over premultiplied RGB + alpha, used to test codec quality. */
export function psnr(a: RgbaImage, b: RgbaImage): number {
  if (a.width !== b.width || a.height !== b.height) return -Infinity;
  let se = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    const aa = a.data[i * 4 + 3]! / 255;
    const ba = b.data[i * 4 + 3]! / 255;
    for (let c = 0; c < 3; c++) {
      const d = a.data[i * 4 + c]! * aa - b.data[i * 4 + c]! * ba;
      se += d * d;
    }
    const da = a.data[i * 4 + 3]! - b.data[i * 4 + 3]!;
    se += da * da;
  }
  const mse = se / (n * 4);
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}
