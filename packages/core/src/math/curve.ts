/**
 * Editable 1-D animation curves and colour gradients.
 *
 * Time is normalised to [0, 1] (particle life, or effect duration). A key's `ease`
 * shapes the segment that STARTS at that key (key[i] -> key[i+1]).
 */

export const EASES = ['linear', 'step', 'easeIn', 'easeOut', 'easeInOut', 'smooth'] as const;
export type Ease = (typeof EASES)[number];

export interface CurveKey {
  t: number;
  v: number;
  ease: Ease;
}

export interface Curve {
  keys: CurveKey[];
}

export type Rgba = [number, number, number, number];

export interface GradientStop {
  t: number;
  color: Rgba;
}

export interface Gradient {
  stops: GradientStop[];
}

export function applyEase(ease: Ease, x: number): number {
  switch (ease) {
    case 'linear':
      return x;
    case 'step':
      return 0;
    case 'easeIn':
      return x * x;
    case 'easeOut':
      return 1 - (1 - x) * (1 - x);
    case 'easeInOut':
      return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    case 'smooth':
      return x * x * (3 - 2 * x);
  }
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Returns keys sorted by time with times clamped to [0,1]. Never mutates the input. */
export function normaliseCurve(curve: Curve): Curve {
  const keys = curve.keys
    .map((k) => ({ ...k, t: clamp(k.t, 0, 1) }))
    .sort((a, b) => a.t - b.t);
  return { keys };
}

/**
 * Evaluates the curve at normalised time `t`. An empty curve evaluates to 0, a
 * single-key curve is constant, and times outside the key range hold the end values.
 */
export function evalCurve(curve: Curve, t: number): number {
  const keys = curve.keys;
  const n = keys.length;
  if (n === 0) return 0;
  const first = keys[0]!;
  if (n === 1 || t <= first.t) return first.v;
  const last = keys[n - 1]!;
  if (t >= last.t) return last.v;
  for (let i = 0; i < n - 1; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      if (span <= 1e-9) return b.v;
      const x = applyEase(a.ease, (t - a.t) / span);
      return lerp(a.v, b.v, x);
    }
  }
  return last.v;
}

export function evalGradient(gradient: Gradient, t: number, out: Rgba = [0, 0, 0, 0]): Rgba {
  const stops = gradient.stops;
  const n = stops.length;
  if (n === 0) {
    out[0] = out[1] = out[2] = out[3] = 1;
    return out;
  }
  const first = stops[0]!;
  const last = stops[n - 1]!;
  if (n === 1 || t <= first.t) return copyRgba(first.color, out);
  if (t >= last.t) return copyRgba(last.color, out);
  for (let i = 0; i < n - 1; i++) {
    const a = stops[i]!;
    const b = stops[i + 1]!;
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      const x = span <= 1e-9 ? 1 : (t - a.t) / span;
      out[0] = lerp(a.color[0], b.color[0], x);
      out[1] = lerp(a.color[1], b.color[1], x);
      out[2] = lerp(a.color[2], b.color[2], x);
      out[3] = lerp(a.color[3], b.color[3], x);
      return out;
    }
  }
  return copyRgba(last.color, out);
}

function copyRgba(src: Rgba, out: Rgba): Rgba {
  out[0] = src[0];
  out[1] = src[1];
  out[2] = src[2];
  out[3] = src[3];
  return out;
}

/** Convenience constructors used by presets and defaults. */
export function constantCurve(v: number): Curve {
  return { keys: [{ t: 0, v, ease: 'linear' }] };
}

export function linearCurve(points: Array<[number, number]>, ease: Ease = 'linear'): Curve {
  return { keys: points.map(([t, v]) => ({ t, v, ease })) };
}

/**
 * Samples a curve into a lookup table. The particle renderer uploads these LUTs
 * so per-particle evaluation on the GPU is a single texture fetch.
 */
export function bakeCurve(curve: Curve, samples: number): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) out[i] = evalCurve(curve, samples === 1 ? 0 : i / (samples - 1));
  return out;
}

export function bakeGradient(gradient: Gradient, samples: number): Float32Array {
  const out = new Float32Array(samples * 4);
  const tmp: Rgba = [0, 0, 0, 0];
  for (let i = 0; i < samples; i++) {
    evalGradient(gradient, samples === 1 ? 0 : i / (samples - 1), tmp);
    out[i * 4] = tmp[0];
    out[i * 4 + 1] = tmp[1];
    out[i * 4 + 2] = tmp[2];
    out[i * 4 + 3] = tmp[3];
  }
  return out;
}
