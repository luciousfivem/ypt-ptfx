/**
 * Spritesheet / texture-atlas builder.
 *
 * Given an ordered frame list and a sheet configuration, produces the atlas image plus
 * exact placement data. Placement data is the contract used by the preview, the
 * flipbook validator and the exporter, so everything agrees on where frame N lives.
 */
import { computeGridLayout, frameToCell, type FrameOrder, type GridLayout } from '@vfxforge/core';
import {
  alphaBounds,
  blit,
  cropImage,
  createImage,
  extrudeEdges,
  fitImage,
  unionRect,
  type FitMode,
  type Rect,
  type RgbaImage,
} from './image';

export interface AtlasParams {
  grid: { cols: number; rows: number };
  texture: { width: number; height: number };
  order: FrameOrder;
  padding: number;
  extrude: number;
  fit: FitMode;
  /** Union alpha-bounds trim: crops ALL frames by the same rect so registration is preserved. */
  trim: boolean;
  center: boolean;
  range: { start: number; end: number } | null;
}

export interface Placement {
  /** Index in the (range-filtered) frame list. */
  frame: number;
  col: number;
  row: number;
  /** Full cell rectangle in atlas pixels (padding included). */
  cell: Rect;
  /** Drawable area inside the cell. */
  inner: Rect;
}

export interface AtlasResult {
  image: RgbaImage;
  layout: GridLayout;
  placements: Placement[];
  frameCount: number;
  /** Rect (in source-frame pixels) that every frame was trimmed to, or null when not trimmed. */
  trimRect: Rect | null;
  warnings: string[];
}

export class AtlasError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Cannot build atlas: ${issues.join(' ')}`);
    this.name = 'AtlasError';
  }
}

export function buildAtlas(allFrames: RgbaImage[], p: AtlasParams): AtlasResult {
  const warnings: string[] = [];
  let frames = allFrames;
  if (p.range) {
    const start = Math.max(0, p.range.start);
    const end = Math.min(allFrames.length - 1, p.range.end);
    if (end < start) throw new AtlasError([`Frame range ${p.range.start}-${p.range.end} selects no frames.`]);
    frames = allFrames.slice(start, end + 1);
  }
  if (frames.length === 0) throw new AtlasError(['There are no frames to pack.']);

  const { layout, issues } = computeGridLayout(p.grid, p.texture, p.padding, frames.length);
  const fatal = issues.filter((i) => i.code !== 'non-power-of-two' && i.code !== 'texture-too-large');
  if (!layout || fatal.length) throw new AtlasError(issues.map((i) => i.message));
  for (const i of issues) if (i.code === 'non-power-of-two' || i.code === 'texture-too-large') warnings.push(i.message);
  if (p.extrude > p.padding) {
    throw new AtlasError([`Edge extrusion (${p.extrude}px) needs at least as much padding (${p.padding}px), otherwise it would overwrite neighbouring frames.`]);
  }

  let trimRect: Rect | null = null;
  let source = frames;
  if (p.trim) {
    let u: Rect | null = null;
    for (const f of frames) u = unionRect(u, alphaBounds(f, 1));
    if (u && (u.w < frames[0]!.width || u.h < frames[0]!.height)) {
      trimRect = u;
      source = frames.map((f) => cropImage(f, u.x, u.y, u.w, u.h));
    }
  }

  const atlas = createImage(p.texture.width, p.texture.height);
  const placements: Placement[] = [];
  for (let i = 0; i < source.length; i++) {
    const { col, row } = frameToCell(i, p.grid, p.order);
    const cell: Rect = { x: col * layout.cellWidth, y: row * layout.cellHeight, w: layout.cellWidth, h: layout.cellHeight };
    const inner: Rect = { x: cell.x + p.padding, y: cell.y + p.padding, w: layout.innerWidth, h: layout.innerHeight };
    const fitted = fitImage(source[i]!, inner.w, inner.h, p.fit, p.center);
    blit(fitted, atlas, inner.x, inner.y);
    if (p.extrude > 0) extrudeEdges(atlas, inner, p.extrude);
    placements.push({ frame: i, col, row, cell, inner });
  }

  const wasted = layout.capacity - source.length;
  if (wasted > 0) warnings.push(`${wasted} of ${layout.capacity} grid cells are empty.`);
  return { image: atlas, layout, placements, frameCount: source.length, trimRect, warnings };
}

/**
 * Fills fully-transparent pixels with the colour of the nearest visible neighbour
 * (iterative dilation). Prevents dark/odd fringes when the GPU bilinearly filters
 * across a sprite edge, and gives block compression sane colours to work with.
 * Alpha is never modified.
 */
export function bleedTransparentColor(img: RgbaImage, passes = 8): RgbaImage {
  const out = createImage(img.width, img.height);
  out.data.set(img.data);
  const { width: w, height: h } = img;
  const known = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) known[i] = img.data[i * 4 + 3]! > 0 ? 1 : 0;
  for (let pass = 0; pass < passes; pass++) {
    const next = new Uint8Array(known);
    let changed = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (known[i]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const j = ny * w + nx;
            if (!known[j]) continue;
            r += out.data[j * 4]!; g += out.data[j * 4 + 1]!; b += out.data[j * 4 + 2]!; n++;
          }
        }
        if (n > 0) {
          out.data[i * 4] = r / n; out.data[i * 4 + 1] = g / n; out.data[i * 4 + 2] = b / n;
          next[i] = 1;
          changed = true;
        }
      }
    }
    known.set(next);
    if (!changed) break;
  }
  return out;
}
