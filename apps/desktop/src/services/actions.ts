/**
 * Application commands. All business logic that touches several stores or services lives here so
 * components stay thin and the same commands serve menus, buttons, shortcuts and tests.
 */
import {
  createAttachment,
  createClip,
  createEffect,
  createEmitter,
  createProject,
  createSheet,
  exportPresetPackage,
  importPresetPackage,
  newId,
  nextPowerOfTwo,
  sanitizeFilename,
  sanitizeIdentifier,
  suggestGrid,
  uniqueName,
  type Asset,
  type AttachmentPoint,
  type Clip,
  type Emitter,
  type Project,
  type Sheet,
} from '@vfxforge/core';
import { findPreset, instantiatePreset } from '@vfxforge/particles';
import { useDerived } from '../state/derived';
import { editProject, getProject, useProject } from '../state/project';
import { runtimeCommands } from '../state/runtime';
import { toast, useUi } from '../state/ui';
import { defaultAttachmentSpecs } from '../viewport/weapons';
import { svc } from './app';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/* ------------------------------------------------------------------ projects */

export function newProject(name = 'Untitled Effect'): void {
  useProject.getState().load(createProject(name));
  useUi.getState().select({ kind: 'none' });
  useUi.getState().setMode('particles');
  useUi.getState().setLeftTab('presets');
}

export async function saveProject(): Promise<boolean> {
  const { platform } = svc();
  const project = getProject();
  try {
    await platform.projects.save(project);
    useProject.getState().markSaved(project);
    toast('ok', `Saved “${project.name}”.`);
    return true;
  } catch (e) {
    toast('error', `Could not save: ${errMsg(e)}`);
    return false;
  }
}

export async function openProject(id: string): Promise<void> {
  const { platform } = svc();
  try {
    const p = await platform.projects.open(id);
    useProject.getState().load(p);
    useUi.getState().select({ kind: 'none' });
    toast('ok', `Opened “${p.name}”.`);
  } catch (e) {
    toast('error', `Could not open the project: ${errMsg(e)}`);
  }
}

export async function saveBundle(): Promise<void> {
  const { platform } = svc();
  const p = getProject();
  try {
    const bytes = await platform.projects.exportBundle(p);
    const r = await platform.saveFile(`${sanitizeFilename(p.name)}.vfxforge`, bytes, 'application/zip');
    if (r === 'saved') toast('ok', 'Project bundle written.');
  } catch (e) {
    toast('error', `Could not write the bundle: ${errMsg(e)}`);
  }
}

export async function openBundle(): Promise<void> {
  const { platform } = svc();
  const files = await platform.pickFiles({ accept: ['.vfxforge', '.zip'], title: 'Open project bundle' });
  const f = files[0];
  if (!f || typeof f === 'string') return;
  try {
    const project = await platform.projects.importBundle(new Uint8Array(await f.arrayBuffer()));
    useProject.getState().load(project, { saved: false });
    useUi.getState().select({ kind: 'none' });
    toast('ok', `Imported “${project.name}”.`);
  } catch (e) {
    toast('error', errMsg(e));
  }
}

/* -------------------------------------------------------------------- import */

const defaultSheetGeometry = (frames: number): Pick<Sheet, 'grid' | 'texture'> => {
  const grid = suggestGrid(frames, 1);
  const side = Math.max(grid.cols, grid.rows);
  const size = Math.min(2048, Math.max(512, nextPowerOfTwo(side * 256)));
  return { grid, texture: { width: size, height: size } };
};

/** Creates a clip (and a spritesheet for it) from an imported image/video asset. */
export function createClipFromAsset(asset: Asset): { clip: Clip; sheet: Sheet } {
  const clip = createClip(asset.name.replace(/\.[a-z0-9]+$/i, ''), asset.id);
  if (asset.kind === 'video') {
    const dur = asset.info?.durationSec ?? 1;
    clip.extract.maxFrames = 16;
    clip.extract.fps = Math.max(1, Math.min(30, Math.round((16 / Math.max(0.1, dur)) * 100) / 100));
    // effect footage is usually shot on black; footage that already has transparency needs no keying
    clip.keying.mode = asset.info?.hasAlpha ? 'none' : 'black';
  } else {
    const animated = asset.info?.frameCount !== 1;
    clip.extract.maxFrames = animated ? 64 : 1;
    // a still picture is left untouched (keying a photo would eat its dark areas); animations on black are keyed
    clip.keying.mode = animated && !asset.info?.hasAlpha ? 'black' : 'none';
  }
  const sheet = createSheet(clip.name, clip.id);
  const frames = Math.max(1, clip.extract.maxFrames);
  Object.assign(sheet, defaultSheetGeometry(Math.min(frames, 16)));
  sheet.fps = clip.extract.fps;
  return { clip, sheet };
}

export async function importFiles(files: Array<File | string>): Promise<void> {
  const { platform } = svc();
  const ui = useUi.getState();
  for (const f of files) {
    const label = typeof f === 'string' ? (f.split(/[\\/]/).pop() ?? f) : f.name;
    const jobId = `import:${label}:${Date.now()}`;
    ui.setJob(jobId, { label: `Importing ${label}`, progress: null });
    try {
      const asset = await platform.importAsset(f, (p) => useUi.getState().setJob(jobId, { label: `Importing ${label}`, progress: p }));
      const existing = Object.values(getProject().assets).find((a) => a.sha256 === asset.sha256);
      if (existing) {
        toast('info', `“${label}” is already in this project.`);
        useUi.getState().select({ kind: 'asset', id: existing.id });
        continue;
      }
      if (asset.kind === 'model') {
        editProject(`Import ${asset.name}`, (d) => {
          d.assets[asset.id] = asset;
          d.weapon.modelAssetId = asset.id;
          d.weapon.preset = 'custom';
        });
        useUi.getState().select({ kind: 'weapon' });
        useUi.getState().setMode('weapon');
        toast('ok', `Imported 3D model “${asset.name}” and set it as the preview weapon.`);
      } else {
        const { clip, sheet } = createClipFromAsset(asset);
        editProject(`Import ${asset.name}`, (d) => {
          d.assets[asset.id] = asset;
          d.clips[clip.id] = clip;
          d.sheets[sheet.id] = { ...sheet, textureName: uniqueName(sheet.textureName, new Set(Object.values(d.sheets).map((s) => s.textureName))) };
        });
        useUi.getState().select({ kind: 'clip', id: clip.id });
        useUi.getState().setMode('sprite');
        toast('ok', `Imported “${asset.name}”. A clip and spritesheet were created — tune them in the Sprite Editor.`);
      }
    } catch (e) {
      toast('error', `${label}: ${errMsg(e)}`);
    } finally {
      useUi.getState().setJob(jobId, null);
    }
  }
}

export async function pickAndImport(): Promise<void> {
  const { platform } = svc();
  const files = await platform.pickFiles({
    accept: ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.gif', '.png', '.jpg', '.jpeg', '.webp', '.glb', '.gltf', '.obj', '.fbx'],
    multiple: true,
    title: 'Import media or a 3D model',
  });
  if (files.length) await importFiles(files);
}

export function assetUsage(project: Project, assetId: string): string[] {
  const uses: string[] = [];
  for (const c of Object.values(project.clips)) if (c.assetId === assetId) uses.push(`clip “${c.name}”`);
  if (project.weapon.modelAssetId === assetId) uses.push('the preview weapon');
  return uses;
}

export function deleteAsset(assetId: string): void {
  const p = getProject();
  const uses = assetUsage(p, assetId);
  if (uses.length) {
    toast('warn', `Cannot remove this asset: it is used by ${uses.join(', ')}.`);
    return;
  }
  editProject('Remove asset', (d) => {
    delete d.assets[assetId];
  });
}

/* --------------------------------------------------------- clips and sheets */

/** Frames the processed clip currently yields (from the live preview when available). */
export function frameCountOf(clipId: string): number {
  const p = getProject();
  const clip = p.clips[clipId];
  if (!clip) return 1;
  for (const s of Object.values(p.sheets)) {
    if (s.clipId !== clipId) continue;
    const prev = useDerived.getState().sheets[s.id]?.preview;
    if (prev) return prev.frameCount;
  }
  return clip.generator?.frames ?? clip.procedural?.frames ?? clip.extract.maxFrames;
}

/** Re-grids every sheet of a clip so it holds the clip's frames in square cells. */
export function fitGridToFrames(sheetId: string, frames?: number): void {
  const p = getProject();
  const sheet = p.sheets[sheetId];
  if (!sheet) return;
  const n = Math.max(1, frames ?? frameCountOf(sheet.clipId));
  const geo = defaultSheetGeometry(n);
  editProject('Fit grid to frames', (d) => {
    const s = d.sheets[sheetId]!;
    s.grid = geo.grid;
    s.texture = geo.texture;
    s.range = null;
  });
}

export function addSheetForClip(clipId: string): string | null {
  const p = getProject();
  const clip = p.clips[clipId];
  if (!clip) return null;
  const sheet = createSheet(clip.name, clip.id);
  Object.assign(sheet, defaultSheetGeometry(Math.min(16, frameCountOf(clipId))));
  sheet.textureName = uniqueName(sheet.textureName, new Set(Object.values(p.sheets).map((s) => s.textureName)));
  editProject('Add spritesheet', (d) => {
    d.sheets[sheet.id] = sheet;
  });
  useUi.getState().select({ kind: 'sheet', id: sheet.id });
  return sheet.id;
}

export function deleteClip(clipId: string): void {
  const p = getProject();
  const sheetIds = Object.values(p.sheets).filter((s) => s.clipId === clipId).map((s) => s.id);
  const used = Object.values(p.effects).flatMap((e) => e.emitters).filter((em) => em.sheetId && sheetIds.includes(em.sheetId));
  if (used.length) {
    toast('warn', `Cannot delete this clip: emitters still use its spritesheet (${used.map((u) => u.name).slice(0, 3).join(', ')}).`);
    return;
  }
  editProject('Delete clip', (d) => {
    for (const id of sheetIds) delete d.sheets[id];
    delete d.clips[clipId];
  });
  useUi.getState().select({ kind: 'none' });
}

export function deleteSheet(sheetId: string): void {
  const p = getProject();
  const used = Object.values(p.effects).flatMap((e) => e.emitters).filter((em) => em.sheetId === sheetId);
  if (used.length) {
    toast('warn', `Cannot delete this spritesheet: ${used.length} emitter(s) use it.`);
    return;
  }
  editProject('Delete spritesheet', (d) => {
    delete d.sheets[sheetId];
  });
  useUi.getState().select({ kind: 'none' });
}

/* ------------------------------------------------------------- effects / layers */

export function ensureDefaultAttachments(): boolean {
  const p = getProject();
  if (p.weapon.attachments.length > 0) return false;
  addDefaultAttachments();
  return true;
}

export function addDefaultAttachments(): void {
  const p = getProject();
  const taken = new Set(p.weapon.attachments.map((a) => a.kind));
  const specs = defaultAttachmentSpecs(p.weapon.preset).filter((s) => !taken.has(s.kind));
  if (specs.length === 0) {
    toast('info', 'The default attachment points already exist.');
    return;
  }
  editProject('Add default attachment points', (d) => {
    for (const s of specs) {
      const a = createAttachment(s.kind, s.name);
      a.position = s.position;
      d.weapon.attachments.push(a);
    }
  });
}

export function addAttachment(kind: AttachmentPoint['kind']): string {
  const a = createAttachment(kind);
  editProject('Add attachment point', (d) => {
    d.weapon.attachments.push(a);
  });
  useUi.getState().select({ kind: 'attachment', id: a.id });
  return a.id;
}

export function deleteAttachment(id: string): void {
  editProject('Delete attachment point', (d) => {
    d.weapon.attachments = d.weapon.attachments.filter((a) => a.id !== id);
    for (const e of Object.values(d.effects)) for (const em of e.emitters) if (em.attachmentId === id) em.attachmentId = null;
  });
  useUi.getState().select({ kind: 'none' });
}

export function addPreset(presetId: string): void {
  const preset = findPreset(presetId);
  if (!preset) return;
  const p = getProject();
  const taken = new Set(Object.values(p.sheets).map((s) => s.textureName));
  let n = 1;
  let suffix = '';
  while (taken.has(sanitizeIdentifier(preset.id + (suffix ? `_${suffix}` : '')))) suffix = String(++n);
  const inst = instantiatePreset(preset, { uniqueSuffix: suffix || undefined });
  const addedAttachments = ensureDefaultAttachments();
  const att = getProject().weapon.attachments;
  const muzzle = att.find((a) => a.kind === 'muzzle');
  const em = inst.effect.emitters[0]!;
  if (muzzle && em.triggers.includes('fired')) em.attachmentId = muzzle.id;
  editProject(`Add preset ${preset.name}`, (d) => {
    d.clips[inst.clip.id] = inst.clip;
    d.sheets[inst.sheet.id] = inst.sheet;
    d.effects[inst.effect.id] = inst.effect;
  });
  useUi.getState().select({ kind: 'emitter', effectId: inst.effect.id, id: em.id });
  // show the effect: shots are events, so fire once for presets that react to them
  if (em.triggers.includes('fired')) setTimeout(() => runtimeCommands.fire(), 450);
  toast('ok', `Added “${preset.name}”.${addedAttachments ? ' Default weapon attachment points were created.' : ''}`);
}

export function addEffect(name = 'New Effect'): string {
  const p = getProject();
  const fx = createEffect(name);
  fx.ptfxName = uniqueName(fx.ptfxName, new Set(Object.values(p.effects).map((e) => e.ptfxName)));
  const em = createEmitter('Emitter 1', null);
  fx.emitters.push(em);
  editProject('Add effect', (d) => {
    d.effects[fx.id] = fx;
  });
  useUi.getState().select({ kind: 'emitter', effectId: fx.id, id: em.id });
  useUi.getState().setLeftTab('layers');
  return fx.id;
}

export function addEmitter(effectId: string): void {
  const p = getProject();
  const fx = p.effects[effectId];
  if (!fx) return;
  if (fx.emitters.length >= 32) {
    toast('warn', 'An effect can hold at most 32 emitters.');
    return;
  }
  const em = createEmitter(`Emitter ${fx.emitters.length + 1}`, fx.emitters[0]?.sheetId ?? null);
  editProject('Add emitter', (d) => {
    d.effects[effectId]!.emitters.push(em);
  });
  useUi.getState().select({ kind: 'emitter', effectId, id: em.id });
}

export function duplicateEmitter(effectId: string, emitterId: string): void {
  const p = getProject();
  const src = p.effects[effectId]?.emitters.find((e) => e.id === emitterId);
  if (!src) return;
  const copy: Emitter = { ...structuredClone(src), id: newId('em'), name: `${src.name} copy`, seed: Math.floor(Math.random() * 0xffffffff) };
  editProject('Duplicate emitter', (d) => {
    const list = d.effects[effectId]!.emitters;
    list.splice(list.findIndex((e) => e.id === emitterId) + 1, 0, copy);
  });
  useUi.getState().select({ kind: 'emitter', effectId, id: copy.id });
}

export function deleteEmitter(effectId: string, emitterId: string): void {
  editProject('Delete emitter', (d) => {
    const fx = d.effects[effectId];
    if (!fx) return;
    fx.emitters = fx.emitters.filter((e) => e.id !== emitterId);
    if (fx.emitters.length === 0) delete d.effects[effectId];
  });
  useUi.getState().select({ kind: 'none' });
}

export function deleteEffect(effectId: string): void {
  editProject('Delete effect', (d) => {
    delete d.effects[effectId];
  });
  useUi.getState().select({ kind: 'none' });
}

export function duplicateEffect(effectId: string): void {
  const p = getProject();
  const src = p.effects[effectId];
  if (!src) return;
  const copy = structuredClone(src);
  copy.id = newId('fx');
  copy.name = `${src.name} copy`;
  copy.ptfxName = uniqueName(sanitizeIdentifier(`${src.ptfxName}_copy`), new Set(Object.values(p.effects).map((e) => e.ptfxName)));
  for (const em of copy.emitters) {
    em.id = newId('em');
    em.seed = Math.floor(Math.random() * 0xffffffff);
  }
  editProject('Duplicate effect', (d) => {
    d.effects[copy.id] = copy;
  });
  useUi.getState().select({ kind: 'emitter', effectId: copy.id, id: copy.emitters[0]!.id });
}

export function moveEmitter(effectId: string, emitterId: string, dir: -1 | 1): void {
  editProject('Reorder emitter', (d) => {
    const list = d.effects[effectId]?.emitters;
    if (!list) return;
    const i = list.findIndex((e) => e.id === emitterId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j]!, list[i]!];
  });
}

/* ----------------------------------------------------------- preset sharing */

export async function exportEffectPackage(effectIds: string[]): Promise<void> {
  const { platform } = svc();
  const p = getProject();
  const r = exportPresetPackage(p, effectIds, { name: p.effects[effectIds[0]!]?.name ?? 'Effect', author: p.export.author });
  if (!r.ok) {
    toast('error', r.errors.join(' '));
    return;
  }
  const bytes = new TextEncoder().encode(JSON.stringify(r.package, null, 2));
  const res = await platform.saveFile(`${sanitizeFilename(r.package.name)}.vfxpreset.json`, bytes, 'application/json');
  if (res === 'saved') toast('ok', 'Preset package written.');
}

export async function importEffectPackage(): Promise<void> {
  const { platform } = svc();
  const files = await platform.pickFiles({ accept: ['.json'], title: 'Import preset package' });
  const f = files[0];
  if (!f || typeof f === 'string') return;
  try {
    if (f.size > 5 * 1024 * 1024) throw new Error('That file is larger than 5 MiB; it is not a preset package.');
    const json = JSON.parse(await f.text()) as unknown;
    const r = importPresetPackage(json, getProject());
    if (!r.ok) throw new Error(r.errors.slice(0, 3).join(' '));
    editProject(`Import preset ${r.name}`, (d) => {
      for (const c of r.clips) d.clips[c.id] = c;
      for (const s of r.sheets) d.sheets[s.id] = s;
      for (const e of r.effects) d.effects[e.id] = e;
    });
    const first = r.effects[0]!;
    useUi.getState().select({ kind: 'emitter', effectId: first.id, id: first.emitters[0]!.id });
    toast('ok', `Imported “${r.name}” (${r.effects.length} effect${r.effects.length === 1 ? '' : 's'}).`);
  } catch (e) {
    toast('error', `Preset package rejected: ${errMsg(e)}`);
  }
}
