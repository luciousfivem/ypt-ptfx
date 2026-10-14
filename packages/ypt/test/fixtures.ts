import { createAsset, createClip, createEffect, createEmitter, createProject, createSheet, type Project } from '@vfxforge/core';
import { applyKey, buildAtlas, bleedTransparentColor, createImage, encodeDds, mipLevelCount, type RgbaImage } from '@vfxforge/media';
import { buildYptModel, writeYptXml, type SheetAsset } from '../src';

/** A soft flame-like blob; frame `i` wobbles so frames differ. */
export function flameFrame(size: number, i: number): RgbaImage {
  const img = createImage(size, size);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c + Math.sin(i) * 2, y - c) / (size * 0.45);
      const v = Math.max(0, 1 - d);
      const o = (y * size + x) * 4;
      img.data[o] = 180 * v;
      img.data[o + 1] = 40 * v * v;
      img.data[o + 2] = 255 * v;
      img.data[o + 3] = 255;
    }
  }
  return img;
}

export interface Fixture {
  project: Project;
  sheets: Record<string, SheetAsset>;
  files: Record<string, Uint8Array>;
  xml: string;
  sheetId: string;
  effectId: string;
}

/** A complete 16-frame purple-flame project: project doc, atlas -> BC3 DDS, YPT XML. */
export function makeFixture(tweak?: (p: Project) => void): Fixture {
  const project = createProject('Purple Flames');
  const asset = createAsset({
    kind: 'video',
    name: 'flames.mp4',
    file: 'assets/' + 'b'.repeat(64) + '.mp4',
    sha256: 'b'.repeat(64),
    bytes: 1,
    mime: 'video/mp4',
    info: { width: 64, height: 64, durationSec: 1, fps: 16, frameCount: 16, hasAlpha: false, codec: 'h264' },
  });
  project.assets[asset.id] = asset;
  const clip = createClip('Flames', asset.id);
  project.clips[clip.id] = clip;
  const sheet = createSheet('purple_flames', clip.id);
  sheet.dds = { format: 'BC3', mipmaps: true };
  project.sheets[sheet.id] = sheet;

  const effect = createEffect('Purple Flames');
  const em = createEmitter('Core', sheet.id);
  effect.emitters.push(em);
  project.effects[effect.id] = effect;
  project.export.assetName = 'vfx_purple';
  tweak?.(project);

  const frames = Array.from({ length: 16 }, (_, i) =>
    applyKey(flameFrame(64, i), { mode: 'black', color: [0, 1, 0], tolerance: 0.02, feather: 0.1, despill: false, keepSourceAlpha: true }),
  );
  const atlas = buildAtlas(frames, {
    grid: sheet.grid,
    texture: sheet.texture,
    order: sheet.order,
    padding: sheet.padding,
    extrude: sheet.extrude,
    fit: sheet.fit,
    trim: false,
    center: true,
    range: null,
  });
  const dds = encodeDds(bleedTransparentColor(atlas.image), sheet.dds);
  const ddsFileName = `${sheet.textureName}.dds`;
  const sheets: Record<string, SheetAsset> = {
    [sheet.id]: {
      sheet,
      frameCount: 16,
      ddsFileName,
      width: sheet.texture.width,
      height: sheet.texture.height,
      mipLevels: mipLevelCount(sheet.texture.width, sheet.texture.height),
      ddsFormat: sheet.dds.format,
    },
  };
  const built = buildYptModel(project, sheets);
  if (built.errors.length) throw new Error('fixture build errors: ' + built.errors.join('; '));
  return { project, sheets, files: { [ddsFileName]: dds }, xml: writeYptXml(built.model), sheetId: sheet.id, effectId: effect.id };
}
