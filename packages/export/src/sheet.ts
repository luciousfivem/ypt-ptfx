/**
 * One sheet, from raw frames to atlas. Shared by the full export, the single-sheet PNG/DDS
 * buttons and the live preview, so all of them produce exactly the same pixels.
 */
import type { Clip, Sheet } from '@vfxforge/core';
import {
  bleedTransparentColor,
  buildAtlas,
  encodeDds,
  encodePng,
  expandHolds,
  mipLevelCount,
  processClip,
  type AtlasResult,
  type ProcessedClip,
  type RgbaImage,
} from '@vfxforge/media';

export function atlasParams(sheet: Sheet) {
  return {
    grid: sheet.grid,
    texture: sheet.texture,
    order: sheet.order,
    padding: sheet.padding,
    extrude: sheet.extrude,
    fit: sheet.fit,
    trim: sheet.trim,
    center: sheet.center,
    range: sheet.range,
  };
}

export interface RenderedSheet {
  processed: ProcessedClip;
  atlas: AtlasResult;
  /** The atlas with colour bled into transparent texels (what is written to PNG/DDS). */
  image: RgbaImage;
  mips: number;
}

/** raw frames + clip + sheet -> atlas. Throws AtlasError / PipelineCancelled / RangeError with readable messages. */
export function renderSheet(raw: RgbaImage[], clip: Clip, sheet: Sheet): RenderedSheet {
  const processed = processClip(raw, clip);
  const expanded = expandHolds(processed.frames, processed.durations);
  const atlas = buildAtlas(expanded, atlasParams(sheet));
  const image = bleedTransparentColor(atlas.image);
  const mips = sheet.dds.mipmaps ? mipLevelCount(sheet.texture.width, sheet.texture.height) : 1;
  return { processed, atlas, image, mips };
}

export interface EncodedSheet extends RenderedSheet {
  png: Uint8Array;
  dds: Uint8Array;
  ddsFileName: string;
}

export function encodeSheet(raw: RgbaImage[], clip: Clip, sheet: Sheet): EncodedSheet {
  const r = renderSheet(raw, clip, sheet);
  return { ...r, png: encodePng(r.atlas.image), dds: encodeDds(r.image, sheet.dds), ddsFileName: `${sheet.textureName}.dds` };
}
