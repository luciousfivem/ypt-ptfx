/**
 * Small, fast, seedable PRNG (mulberry32). Deterministic across platforms, which
 * matters because the particle simulation is shared between the live preview and
 * the automated tests: the same seed must produce the same particles everywhere.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** Signed uniform float in [-1, 1). */
  signed(): number {
    return this.next() * 2 - 1;
  }

  /** Snapshot/restore support so simulations can be rewound for timeline scrubbing. */
  getState(): number {
    return this.state;
  }

  setState(state: number): void {
    this.state = state >>> 0;
  }
}

/** Stable 32-bit string hash (FNV-1a) used to derive per-emitter seeds from ids. */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
