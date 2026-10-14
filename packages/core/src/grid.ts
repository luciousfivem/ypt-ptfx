/**
 * Spritesheet grid arithmetic. This is the single source of truth for "how do N
 * frames fit into a W x H texture" — used by the generator, the preview, the
 * flipbook validator and the YPT exporter, so they cannot disagree.
 */

export const PRESET_GRIDS = [2, 4, 8, 16] as const;
export const PRESET_RESOLUTIONS = [256, 512, 1024, 2048, 4096] as const;

export interface GridSpec {
  cols: number;
  rows: number;
}

export interface SizeSpec {
  width: number;
  height: number;
}

export interface GridLayout extends GridSpec {
  textureWidth: number;
  textureHeight: number;
  /** Full cell size including padding. */
  cellWidth: number;
  cellHeight: number;
  /** Drawable area of a cell once padding is removed. */
  innerWidth: number;
  innerHeight: number;
  padding: number;
  capacity: number;
}

export type GridIssue =
  | { code: 'non-integer-cell'; message: string }
  | { code: 'padding-too-large'; message: string }
  | { code: 'too-many-frames'; message: string }
  | { code: 'non-power-of-two'; message: string }
  | { code: 'texture-too-large'; message: string }
  | { code: 'invalid-dimensions'; message: string };

export const MAX_TEXTURE_SIZE = 8192;

export function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

export function nextPowerOfTwo(n: number): number {
  if (n <= 1) return 1;
  return 2 ** Math.ceil(Math.log2(n));
}

/**
 * Resolves a grid + texture size + padding to concrete cell geometry and reports
 * every problem found instead of throwing on the first one, so the UI can list
 * them all.
 */
export function computeGridLayout(
  grid: GridSpec,
  texture: SizeSpec,
  padding: number,
  frameCount?: number,
): { layout: GridLayout | null; issues: GridIssue[] } {
  const issues: GridIssue[] = [];
  const { cols, rows } = grid;
  if (![cols, rows, texture.width, texture.height].every((n) => Number.isInteger(n) && n > 0) || padding < 0 || !Number.isInteger(padding)) {
    issues.push({ code: 'invalid-dimensions', message: 'Columns, rows and texture size must be positive integers and padding a non-negative integer.' });
    return { layout: null, issues };
  }
  if (texture.width > MAX_TEXTURE_SIZE || texture.height > MAX_TEXTURE_SIZE) {
    issues.push({ code: 'texture-too-large', message: `Texture exceeds ${MAX_TEXTURE_SIZE}px on one side.` });
  }
  if (!isPowerOfTwo(texture.width) || !isPowerOfTwo(texture.height)) {
    issues.push({ code: 'non-power-of-two', message: 'Texture dimensions are not powers of two; block-compressed GTA textures should be.' });
  }
  const cellWidth = texture.width / cols;
  const cellHeight = texture.height / rows;
  if (!Number.isInteger(cellWidth) || !Number.isInteger(cellHeight)) {
    issues.push({ code: 'non-integer-cell', message: `Texture ${texture.width}x${texture.height} does not divide evenly into ${cols}x${rows} cells.` });
  }
  const innerWidth = Math.floor(cellWidth) - padding * 2;
  const innerHeight = Math.floor(cellHeight) - padding * 2;
  if (innerWidth < 1 || innerHeight < 1) {
    issues.push({ code: 'padding-too-large', message: `Padding of ${padding}px leaves no drawable area in a ${Math.floor(cellWidth)}x${Math.floor(cellHeight)} cell.` });
  }
  const capacity = cols * rows;
  if (frameCount !== undefined && frameCount > capacity) {
    issues.push({ code: 'too-many-frames', message: `${frameCount} frames do not fit in a ${cols}x${rows} grid (capacity ${capacity}).` });
  }
  const fatal = issues.some((i) => i.code === 'non-integer-cell' || i.code === 'padding-too-large' || i.code === 'invalid-dimensions');
  if (fatal) return { layout: null, issues };
  return {
    layout: {
      cols,
      rows,
      textureWidth: texture.width,
      textureHeight: texture.height,
      cellWidth,
      cellHeight,
      innerWidth,
      innerHeight,
      padding,
      capacity,
    },
    issues,
  };
}

export type FrameOrder = 'row-major' | 'column-major';

/** Cell (col,row) for the i-th frame. Top-left origin, matching image space. */
export function frameToCell(index: number, grid: GridSpec, order: FrameOrder = 'row-major'): { col: number; row: number } {
  if (order === 'row-major') return { col: index % grid.cols, row: Math.floor(index / grid.cols) };
  return { col: Math.floor(index / grid.rows), row: index % grid.rows };
}

/** Inverse of {@link frameToCell}. */
export function cellToFrame(col: number, row: number, grid: GridSpec, order: FrameOrder = 'row-major'): number {
  return order === 'row-major' ? row * grid.cols + col : col * grid.rows + row;
}

/** UV rectangle (origin top-left, v pointing DOWN) of frame `index`. */
export function frameUvRect(index: number, grid: GridSpec, order: FrameOrder = 'row-major'): { u0: number; v0: number; u1: number; v1: number } {
  const { col, row } = frameToCell(index, grid, order);
  return { u0: col / grid.cols, v0: row / grid.rows, u1: (col + 1) / grid.cols, v1: (row + 1) / grid.rows };
}

/**
 * Picks the smallest power-of-two grid that holds `frameCount` frames while keeping
 * cells the same aspect as the frames' texture region. `textureAspect` is
 * width/height of the TEXTURE (1 = square): a 2:1 texture gets 2:1 grids (4x2),
 * a square texture gets square grids (4x4) so frames are never distorted.
 */
export function suggestGrid(frameCount: number, textureAspect = 1): GridSpec {
  if (frameCount <= 1) return { cols: 1, rows: 1 };
  for (let rows = 1; rows <= 64; rows *= 2) {
    const cols = rows * textureAspect;
    if (Number.isInteger(cols) && cols >= 1 && cols <= 64 && cols * rows >= frameCount) return { cols, rows };
  }
  // Aspect not representable as a power-of-two grid: fall back to a near-square fit.
  const cols = Math.ceil(Math.sqrt(frameCount * textureAspect));
  return { cols, rows: Math.ceil(frameCount / cols) };
}

/** Fraction of grid cells that are empty (a quick "is this atlas wasteful" metric). */
export function wastedFraction(frameCount: number, grid: GridSpec): number {
  const cap = grid.cols * grid.rows;
  return cap === 0 ? 0 : Math.max(0, cap - frameCount) / cap;
}
