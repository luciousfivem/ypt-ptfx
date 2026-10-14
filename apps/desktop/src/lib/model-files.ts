/**
 * The one definition of which files the import pickers offer. The weapon-model picker, the generic
 * Import picker and the platform layers all read it, so the lists cannot drift apart.
 *
 * `.ydr` (a GTA V drawable resource) is offered on the desktop app only: it is an RSC7 binary that
 * the CodeWalker converter bridge turns into a GLB at import time. The browser build has no
 * converter, so it never offers it and explains why if one is chosen or dropped anyway.
 */
import type { Asset } from '@vfxforge/core';
import type { PickFilter } from '../platform/types';

export const MEDIA_EXTENSIONS = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.gif', '.png', '.jpg', '.jpeg', '.webp'] as const;
export const MODEL_EXTENSIONS = ['.glb', '.gltf', '.obj', '.fbx'] as const;
export const YDR_EXTENSION = '.ydr';

/** Extensions are only a hint for the pickers; the importers identify files by content. */
export const isYdrName = (name: string): boolean => name.trim().toLowerCase().endsWith(YDR_EXTENSION);

/** A model asset that the desktop importer converted from a .ydr: it keeps the source's name but stores the GLB. */
export const isConvertedYdr = (asset: Pick<Asset, 'kind' | 'name' | 'file'>): boolean =>
  asset.kind === 'model' && isYdrName(asset.name) && asset.file.toLowerCase().endsWith('.glb');

export interface PickerSpec {
  /** Every extension the picker allows (the browser's `accept` list). */
  accept: string[];
  /** The desktop dialog's file-type dropdown, in order: everything allowed first. */
  filters: PickFilter[];
}

const bare = (exts: readonly string[]) => exts.map((e) => e.replace(/^\./, ''));

function spec(media: readonly string[], desktop: boolean): PickerSpec {
  const models = bare(MODEL_EXTENSIONS);
  const accept = [...media, ...MODEL_EXTENSIONS, ...(desktop ? [YDR_EXTENSION] : [])];
  return {
    accept,
    filters: [
      { name: 'Supported files', extensions: bare(accept) },
      { name: `3D models (${models.join(', ')})`, extensions: models },
      ...(desktop ? [{ name: 'GTA V drawable (ydr)', extensions: ['ydr'] }] : []),
    ],
  };
}

/** The weapon-model picker. */
export const modelPicker = (platformKind: 'tauri' | 'browser'): PickerSpec => spec([], platformKind === 'tauri');

/** The generic Import picker (media and models). */
export const importPicker = (platformKind: 'tauri' | 'browser'): PickerSpec => spec(MEDIA_EXTENSIONS, platformKind === 'tauri');

/** What the browser build says when a .ydr is chosen or dropped (it cannot convert one). */
export const YDR_BROWSER_ERROR =
  'A GTA V .ydr drawable has to be converted to a GLB first. That needs the VFXForge desktop app with the CodeWalker converter bridge (docs/YPT_BRIDGE.md); the browser build cannot read it. Exporting the model as .glb works in both.';
