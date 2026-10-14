/**
 * Background removal. All functions return a NEW image (inputs are never mutated,
 * which is what makes the whole pipeline non-destructive).
 *
 * Black / white keys do real colour recovery rather than just thresholding alpha:
 *
 *  - Footage of light/fire/energy on a black background satisfies  P = a * F  (P =
 *    observed pixel, F = true foreground colour, a = coverage). The largest a that
 *    keeps F in range is a = max(P), so F = P / max(P). Compositing F with alpha a
 *    over black reproduces the original exactly, and additive blending also matches.
 *
 *  - On white:  P = 1 - a*(1 - F)  =>  a = 1 - min(P),  F = (P - min(P)) / (1 - min(P)).
 *
 * `tolerance` / `feather` only GATE the recovered coverage:  a = cover * gate(cover),
 * where gate is 0 below `tolerance` and ramps (smoothstep) to 1 over `feather`. With
 * tolerance = feather = 0 the alpha is exactly the physical coverage, so the identity
 * above holds; raising tolerance removes near-background noise (compression
 * artefacts) without changing the colour of anything that remains.
 */
import { createImage, type RgbaImage } from './image';

export interface KeyingParams {
  mode: 'none' | 'black' | 'white' | 'chroma';
  /** sRGB 0..1, only used by `chroma`. */
  color: [number, number, number];
  /** 0..1: how far from the background a pixel must be to start becoming visible. */
  tolerance: number;
  /** 0..1: width of the soft transition above the tolerance. */
  feather: number;
  despill: boolean;
  /** Multiply by the source alpha (keeps pre-existing transparency, e.g. PNG sequences). */
  keepSourceAlpha: boolean;
}

function smoothstep(e0: number, e1: number, x: number): number {
  if (e1 <= e0) return x >= e1 ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function applyKey(img: RgbaImage, p: KeyingParams): RgbaImage {
  if (p.mode === 'none') return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  const out = createImage(img.width, img.height);
  const s = img.data;
  const o = out.data;
  const n = img.width * img.height;
  const lo = p.tolerance;
  const hi = Math.min(1, p.tolerance + p.feather + 1e-6);

  if (p.mode === 'black' || p.mode === 'white') {
    const white = p.mode === 'white';
    for (let i = 0; i < n; i++) {
      const r = s[i * 4]! / 255;
      const g = s[i * 4 + 1]! / 255;
      const b = s[i * 4 + 2]! / 255;
      const srcA = s[i * 4 + 3]! / 255;
      let cover: number;
      let fr: number, fg: number, fb: number;
      if (!white) {
        cover = Math.max(r, g, b);
        const inv = cover > 1e-5 ? 1 / cover : 0;
        fr = r * inv;
        fg = g * inv;
        fb = b * inv;
      } else {
        const mn = Math.min(r, g, b);
        cover = 1 - mn;
        const inv = cover > 1e-5 ? 1 / cover : 0;
        fr = (r - mn) * inv;
        fg = (g - mn) * inv;
        fb = (b - mn) * inv;
      }
      // gate(cover): hard cut at `tolerance` when feather is 0, smooth ramp otherwise
      const gate = p.feather <= 0 ? (cover > lo ? 1 : 0) : smoothstep(lo, hi, cover);
      let a = cover * gate;
      if (p.keepSourceAlpha) a *= srcA;
      o[i * 4] = fr * 255;
      o[i * 4 + 1] = fg * 255;
      o[i * 4 + 2] = fb * 255;
      o[i * 4 + 3] = a * 255;
    }
    return out;
  }

  // Chroma key in CbCr space (BT.601) on BRIGHTNESS-NORMALISED colour: chroma magnitude
  // shrinks with luminance, so without normalising, shadowed parts of a real green screen
  // would survive. A dark guard keeps near-black pixels (no usable hue) as foreground.
  const [kr0, kg0, kb0] = p.color;
  const kmax = Math.max(kr0, kg0, kb0, 1e-6);
  const [kr, kg, kb] = [kr0 / kmax, kg0 / kmax, kb0 / kmax];
  const kcb = -0.168736 * kr - 0.331264 * kg + 0.5 * kb;
  const kcr = 0.5 * kr - 0.418688 * kg - 0.081312 * kb;
  const t0 = lo * 0.5;
  const t1 = Math.min(0.75, t0 + p.feather * 0.5 + 1e-6);
  // despill configuration
  const ks = [kr, kg, kb];
  const order = [0, 1, 2].sort((a, b) => ks[b]! - ks[a]!);
  const dom = order[0]!;
  const mid = order[1]!;
  const low = order[2]!;
  const singleDominant = ks[dom]! - ks[mid]! >= ks[mid]! - ks[low]!;

  for (let i = 0; i < n; i++) {
    let r = s[i * 4]! / 255;
    let g = s[i * 4 + 1]! / 255;
    let b = s[i * 4 + 2]! / 255;
    const pmax = Math.max(r, g, b);
    const inv = pmax > 1e-6 ? 1 / pmax : 0;
    const nr = r * inv, ng = g * inv, nb = b * inv;
    const cb = -0.168736 * nr - 0.331264 * ng + 0.5 * nb;
    const cr = 0.5 * nr - 0.418688 * ng - 0.081312 * nb;
    const dist = Math.hypot(cb - kcb, cr - kcr);
    const darkGuard = smoothstep(0.03, 0.15, pmax); // 0 => pure black, treated as foreground
    let a = 1 - (1 - smoothstep(t0, t1, dist)) * darkGuard;
    if (p.keepSourceAlpha) a *= s[i * 4 + 3]! / 255;
    if (p.despill && a > 0) {
      const c = [r, g, b];
      if (singleDominant) {
        const limit = (c[mid]! + c[low]!) / 2;
        if (c[dom]! > limit) c[dom] = limit;
      } else {
        const limit = c[low]!;
        if (c[dom]! > limit) c[dom] = limit;
        if (c[mid]! > limit) c[mid] = limit;
      }
      [r, g, b] = c as [number, number, number];
    }
    o[i * 4] = r * 255;
    o[i * 4 + 1] = g * 255;
    o[i * 4 + 2] = b * 255;
    o[i * 4 + 3] = a * 255;
  }
  return out;
}
