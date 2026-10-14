/**
 * Flipbook Compatibility Validator.
 *
 * Checks a configured spritesheet against what we can actually KNOW about GTA V flipbook
 * particles — and is explicit about what we cannot.
 *
 * Verified (CodeWalker source): frames are addressed by integer ids via
 * ParticleRule.TexFrameIDMin/Max and ptxu_AnimateTexture.LastFrameID.
 *
 * NOT verifiable here: how a frame id becomes a UV rectangle. The user's brief names
 * `ptxclipregions.dat`; CodeWalker has no reference to it, so we cannot read, write or check it.
 * The validator therefore NEVER reports "compatible with the game". Its best verdict is
 * `structurally-valid`, with the engine-side question left open as a warning that links to
 * the in-game test checklist.
 */
import { computeGridLayout, frameToCell, isPowerOfTwo, sanitizeIdentifier, type FrameOrder } from '@vfxforge/core';
import { err, info, warn, type Issue } from './validate';

export type FlipbookTarget = 'fivem-legacy' | 'fivem-enhanced';

export interface FlipbookInput {
  textureName: string;
  frameCount: number;
  grid: { cols: number; rows: number };
  texture: { width: number; height: number };
  order: FrameOrder;
  padding: number;
  mipmaps: boolean;
  /** Frame ids referenced by TexFrameIDMin/Max. */
  frameRange: { min: number; max: number };
  target: FlipbookTarget;
  strategy: 'generate' | 'donor';
  /** Donor strategy: the atlas layout the DONOR's clip regions were authored for. */
  donorGrid?: { cols: number; rows: number } | null;
  donorTextureName?: string | null;
}

export interface SuggestedFix {
  field: 'textureName' | 'texture' | 'grid' | 'frameRange';
  from: string;
  to: string;
  reason: string;
}

export interface FlipbookReport {
  status: 'invalid' | 'structurally-valid';
  /** Always false: in-engine behaviour cannot be verified outside the game. */
  engineVerified: false;
  issues: Issue[];
  fixes: SuggestedFix[];
  /** Frame id -> UV rectangle table implied by our grid (for the docs / Lua comments). */
  frameTable: Array<{ frame: number; col: number; row: number; u0: number; v0: number; u1: number; v1: number }>;
}

export function validateFlipbook(input: FlipbookInput): FlipbookReport {
  const issues: Issue[] = [];
  const fixes: SuggestedFix[] = [];
  const { grid, texture } = input;

  const { layout, issues: gridIssues } = computeGridLayout(grid, texture, input.padding, input.frameCount);
  for (const g of gridIssues) {
    if (g.code === 'non-power-of-two') {
      issues.push(err('fb-pot', `${g.message} GTA textures must be power-of-two.`));
      fixes.push({ field: 'texture', from: `${texture.width}x${texture.height}`, to: `${nextPow2(texture.width)}x${nextPow2(texture.height)}`, reason: 'next power-of-two size' });
    } else if (g.code === 'non-integer-cell') {
      issues.push(err('fb-cell', g.message));
    } else if (g.code === 'too-many-frames') {
      issues.push(err('fb-capacity', g.message));
    } else if (g.code === 'padding-too-large') {
      issues.push(err('fb-padding', g.message));
    } else if (g.code === 'texture-too-large') {
      issues.push(err('fb-size', g.message));
    } else {
      issues.push(err('fb-dims', g.message));
    }
  }

  if (layout) {
    if (layout.cellWidth !== layout.cellHeight) {
      issues.push(warn('fb-nonsquare', `Cells are ${layout.cellWidth}x${layout.cellHeight}. Particle sprites are normally square; non-square cells will look stretched unless the sprite is authored for them.`));
    }
    if (!isPowerOfTwo(layout.cols) || !isPowerOfTwo(layout.rows)) {
      issues.push(warn('fb-grid-pot', `Grid ${layout.cols}x${layout.rows} is not a power of two in each axis; clip-region based flipbooks are conventionally power-of-two (UNVERIFIED).`));
    }
    if (input.padding > 0) {
      issues.push(warn('fb-padding-uv', `Padding of ${input.padding}px keeps the visible art inside each cell, but UV rectangles still cover the whole cell. That is correct for a uniform grid; it is not for engines that read per-frame tight rectangles.`));
    }
  }

  const frames = input.frameCount;
  if (input.frameRange.min < 0 || input.frameRange.max >= frames || input.frameRange.max < input.frameRange.min) {
    issues.push(err('fb-range', `Frame ids ${input.frameRange.min}..${input.frameRange.max} fall outside the ${frames} frame(s) in the sheet.`));
    fixes.push({ field: 'frameRange', from: `${input.frameRange.min}..${input.frameRange.max}`, to: `0..${Math.max(0, frames - 1)}`, reason: 'clamp to the available frames' });
  }

  const tn = input.textureName;
  const safe = sanitizeIdentifier(tn, 'vfxforge_sheet');
  if (tn !== safe) {
    issues.push(err('fb-name', `Texture name "${tn}" is not a lowercase identifier (a-z, 0-9, _).`));
    fixes.push({ field: 'textureName', from: tn, to: safe, reason: 'lowercase identifier' });
  }
  if (tn.length > 0 && tn.length > 32) issues.push(warn('fb-name-length', `Texture name "${tn}" is ${tn.length} characters; keep it short to stay well inside any name-length limits (UNVERIFIED).`));
  issues.push(
    info(
      'fb-name-uniqueness',
      `Use a texture name that does not exist in the base game or other resources: texture dictionaries are looked up by name hash, so a duplicate name can replace — or be replaced by — another texture.`,
    ),
  );

  if (input.strategy === 'donor') {
    if (input.donorTextureName && input.donorTextureName.toLowerCase() !== tn.toLowerCase()) {
      issues.push(warn('fb-donor-name', `The donor rule references texture "${input.donorTextureName}". Community reports say a replacement texture must keep the original's name to be picked up; renaming "${tn}" is only safe if every reference was updated.`));
    }
    if (input.donorGrid && (input.donorGrid.cols !== grid.cols || input.donorGrid.rows !== grid.rows)) {
      issues.push(err('fb-donor-grid', `The donor's flipbook is authored for a ${input.donorGrid.cols}x${input.donorGrid.rows} grid but this sheet is ${grid.cols}x${grid.rows}. The game maps frame ids to UVs with data tied to the donor, so a different grid will sample the wrong regions.`));
      fixes.push({ field: 'grid', from: `${grid.cols}x${grid.rows}`, to: `${input.donorGrid.cols}x${input.donorGrid.rows}`, reason: 'match the donor atlas layout' });
    } else if (!input.donorGrid) {
      issues.push(warn('fb-donor-grid-unknown', 'Enter the donor atlas grid (e.g. 8x8) so VFXForge can verify that your sheet matches the layout the donor was authored for.'));
    }
  } else {
    issues.push(
      warn(
        'fb-clipregions',
        'CANNOT VERIFY: GTA V resolves frame ids to UV rectangles with engine data (ptxclipregions.dat is the name given in the project brief; its format and whether a custom texture name can be added to it from a FiveM resource are unknown to VFXForge and absent from CodeWalker). A generated YPT with a custom atlas name may show the whole sheet, a single frame, or animate incorrectly. Use the donor-template workflow with a texture name and grid the game already defines, or confirm with docs/FIVEM_TEST_CHECKLIST.md.',
      ),
    );
  }

  if (input.target === 'fivem-enhanced') {
    issues.push(warn('fb-enhanced', 'Enhanced (gen9) output is experimental: CodeWalker converts texture views via EnsureGen9(), but gen9-specific particle differences were not verified. FiveM itself runs on the legacy game build.'));
  }
  if (frames > 64) issues.push(warn('fb-many-frames', `${frames} frames is a large flipbook; check texture memory (${texture.width}x${texture.height}).`));
  if (!input.mipmaps) {
    issues.push(info('fb-mips', 'No mipmaps: sprites seen at a distance may shimmer. Mip chains are recommended for textures drawn at varying sizes.'));
  }

  const frameTable: FlipbookReport['frameTable'] = [];
  if (layout) {
    for (let f = 0; f < Math.min(frames, layout.capacity); f++) {
      const { col, row } = frameToCell(f, grid, input.order);
      frameTable.push({ frame: f, col, row, u0: col / grid.cols, v0: row / grid.rows, u1: (col + 1) / grid.cols, v1: (row + 1) / grid.rows });
    }
  }
  const status = issues.some((i) => i.severity === 'error') ? 'invalid' : 'structurally-valid';
  return { status, engineVerified: false, issues, fixes, frameTable };
}

function nextPow2(n: number): number {
  return n <= 1 ? 1 : 2 ** Math.ceil(Math.log2(n));
}
