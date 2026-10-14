/**
 * The non-destructive clip pipeline: raw frames + Clip parameters -> processed frames.
 *
 * Order of operations (this order is part of the product contract and is documented in
 * the UI, because it changes the result):
 *
 *   1. procedural generation (single-image clips only)
 *   2. keying (background removal)
 *   3. colour adjust, sharpen, glow
 *   4. temporal motion blur
 *   5. auto-crop to the UNION alpha bounds of all frames (keeps registration)
 *   6. explicit frame list (delete / duplicate / reorder / hold)
 *   7. reverse, then ping-pong
 *
 * The raw input frames are never modified.
 */
import type { Clip } from '@vfxforge/core';
import { applyAdjust, motionBlurSequence } from './adjust';
import { alphaBounds, cropImage, unionRect, type Rect, type RgbaImage } from './image';
import { applyKey } from './keying';
import { generateProcedural } from './procedural';

export interface ProcessedClip {
  frames: RgbaImage[];
  /** Relative display time per frame (1 = one frame period). Same length as `frames`. */
  durations: number[];
  /** Effective playback fps (extraction fps * playback speed). */
  fps: number;
  loop: boolean;
  cropRect: Rect | null;
  /** Human-readable notes about what the pipeline did / could not do. */
  notes: string[];
}

export interface PipelineHooks {
  /** Called after each frame finishes the per-frame stages. Return false to cancel. */
  onProgress?: (done: number, total: number) => boolean | void;
}

export class PipelineCancelled extends Error {
  constructor() {
    super('Processing cancelled');
    this.name = 'PipelineCancelled';
  }
}

export function processClip(raw: RgbaImage[], clip: Clip, hooks: PipelineHooks = {}): ProcessedClip {
  const notes: string[] = [];
  if (raw.length === 0) throw new Error('Clip has no source frames.');

  let frames: RgbaImage[];
  if (clip.procedural) {
    if (raw.length > 1) notes.push('Procedural animation uses only the first source frame.');
    frames = generateProcedural(raw[0]!, clip.procedural);
    notes.push('Frames were synthesised procedurally from a single image; this is an authored animation, not recovered motion.');
  } else {
    frames = raw;
  }

  const total = frames.length;
  const processed: RgbaImage[] = [];
  for (let i = 0; i < total; i++) {
    let f = frames[i]!;
    if (clip.keying.mode !== 'none') f = applyKey(f, clip.keying);
    f = applyAdjust(f, {
      brightness: clip.adjust.brightness,
      contrast: clip.adjust.contrast,
      saturation: clip.adjust.saturation,
      hue: clip.adjust.hue,
      sharpen: clip.adjust.sharpen,
      glowAmount: clip.adjust.glowAmount,
      glowRadius: clip.adjust.glowRadius,
    });
    processed.push(f);
    if (hooks.onProgress?.(i + 1, total) === false) throw new PipelineCancelled();
  }

  frames = motionBlurSequence(processed, clip.adjust.motionBlurSamples, clip.adjust.motionBlurStrength, clip.playback.loop);

  let cropRect: Rect | null = null;
  if (clip.crop.auto) {
    let u: Rect | null = null;
    for (const f of frames) u = unionRect(u, alphaBounds(f, 4));
    if (u) {
      const m = clip.crop.margin;
      const x = Math.max(0, u.x - m);
      const y = Math.max(0, u.y - m);
      const r = Math.min(frames[0]!.width, u.x + u.w + m);
      const b = Math.min(frames[0]!.height, u.y + u.h + m);
      cropRect = { x, y, w: r - x, h: b - y };
      if (cropRect.w < frames[0]!.width || cropRect.h < frames[0]!.height) {
        const c = cropRect;
        frames = frames.map((f) => cropImage(f, c.x, c.y, c.w, c.h));
      } else {
        cropRect = null;
      }
    } else {
      notes.push('Auto-crop skipped: every frame is fully transparent after keying.');
    }
  }

  let durations: number[];
  if (clip.frames) {
    const picked: RgbaImage[] = [];
    durations = [];
    for (const entry of clip.frames) {
      const src = frames[entry.src];
      if (!src) {
        notes.push(`Frame list references missing frame ${entry.src}; skipped.`);
        continue;
      }
      picked.push(src);
      durations.push(entry.hold);
    }
    if (picked.length === 0) throw new Error('The explicit frame list selects no valid frames.');
    frames = picked;
  } else {
    durations = frames.map(() => 1);
  }

  if (clip.playback.reverse) {
    frames = [...frames].reverse();
    durations = [...durations].reverse();
  }
  if (clip.playback.pingPong && frames.length > 2) {
    // forward then backward without repeating the two end frames, so the loop has no stutter
    const back = frames.slice(1, -1).reverse();
    const backD = durations.slice(1, -1).reverse();
    frames = [...frames, ...back];
    durations = [...durations, ...backD];
  }

  return { frames, durations, fps: clip.extract.fps * clip.playback.speed, loop: clip.playback.loop, cropRect, notes };
}

/**
 * Expands per-frame holds into repeated frames (round to whole cells, minimum 1).
 * Flipbook atlases cannot express variable frame time, so a hold of 2 costs 2 cells.
 */
export function expandHolds(frames: RgbaImage[], durations: number[]): RgbaImage[] {
  const out: RgbaImage[] = [];
  frames.forEach((f, i) => {
    const reps = Math.max(1, Math.round(durations[i] ?? 1));
    for (let r = 0; r < reps; r++) out.push(f);
  });
  return out;
}
