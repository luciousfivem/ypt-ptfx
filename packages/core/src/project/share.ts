/**
 * Effect-preset sharing: a small, self-contained JSON package holding effects plus the clips and
 * sheets they depend on. Only PROCEDURAL clips travel (generator clips carry no media bytes), so
 * packages are tiny, safe to open and carry no copyrighted footage. Every field is re-validated on
 * import and every id is regenerated so an imported package can never overwrite or alias existing
 * project data.
 */
import { z } from 'zod';
import { newId } from './defaults';
import { ClipSchema, EffectSchema, SheetSchema, type Clip, type Effect, type Project, type Sheet } from './schema';

export const PRESET_PACKAGE_FORMAT = 'vfxforge-preset-package' as const;

const PackageSchema = z.object({
  format: z.literal(PRESET_PACKAGE_FORMAT),
  version: z.literal(1),
  name: z.string().min(1).max(120),
  author: z.string().max(80).default(''),
  clips: z.array(ClipSchema).max(64),
  sheets: z.array(SheetSchema).max(64),
  effects: z.array(EffectSchema).min(1).max(32),
});
export type PresetPackage = z.infer<typeof PackageSchema>;

export type ExportPackageResult = { ok: true; package: PresetPackage } | { ok: false; errors: string[] };

/** Bundles effects (and what they need) from a project. Fails if an effect depends on media. */
export function exportPresetPackage(project: Project, effectIds: string[], meta: { name: string; author?: string }): ExportPackageResult {
  const errors: string[] = [];
  const effects: Effect[] = [];
  const sheets = new Map<string, Sheet>();
  const clips = new Map<string, Clip>();
  for (const id of effectIds) {
    const fx = project.effects[id];
    if (!fx) {
      errors.push(`Effect ${id} does not exist.`);
      continue;
    }
    effects.push(fx);
    for (const em of fx.emitters) {
      if (!em.sheetId) continue;
      const sheet = project.sheets[em.sheetId];
      if (!sheet) continue;
      sheets.set(sheet.id, sheet);
      const clip = project.clips[sheet.clipId];
      if (clip) clips.set(clip.id, clip);
    }
  }
  for (const c of clips.values()) {
    if (c.assetId !== null) errors.push(`Clip "${c.name}" uses imported media, which cannot be shared in a preset package. Only procedural/generator clips can.`);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, package: { format: PRESET_PACKAGE_FORMAT, version: 1, name: meta.name, author: meta.author ?? '', clips: [...clips.values()], sheets: [...sheets.values()], effects } };
}

export type ImportPackageResult = { ok: true; clips: Clip[]; sheets: Sheet[]; effects: Effect[]; name: string } | { ok: false; errors: string[] };

/** Validates untrusted package JSON and returns entities with fresh ids and collision-free names. */
export function importPresetPackage(json: unknown, existing: Pick<Project, 'effects' | 'sheets'>): ImportPackageResult {
  const parsed = PackageSchema.safeParse(json);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  const pkg = parsed.data;
  const bad = pkg.clips.filter((c) => c.assetId !== null);
  if (bad.length) return { ok: false, errors: [`Package clip "${bad[0]!.name}" references media; packages may only contain procedural clips.`] };

  const clipIds = new Map<string, string>();
  const sheetIds = new Map<string, string>();
  const takenTex = new Set(Object.values(existing.sheets).map((s) => s.textureName));
  const takenFx = new Set(Object.values(existing.effects).map((e) => e.ptfxName));
  const unique = (base: string, taken: Set<string>) => {
    let n = base;
    for (let i = 2; taken.has(n); i++) n = `${base.slice(0, 44)}_${i}`;
    taken.add(n);
    return n;
  };

  const clips = pkg.clips.map((c) => {
    const id = newId('clip');
    clipIds.set(c.id, id);
    return { ...c, id };
  });
  const sheets: Sheet[] = [];
  for (const s of pkg.sheets) {
    const clipId = clipIds.get(s.clipId);
    if (!clipId) return { ok: false, errors: [`Sheet "${s.name}" references a clip that is not in the package.`] };
    const id = newId('sheet');
    sheetIds.set(s.id, id);
    sheets.push({ ...s, id, clipId, textureName: unique(s.textureName, takenTex) });
  }
  const effects: Effect[] = [];
  for (const e of pkg.effects) {
    const emitters = [];
    for (const em of e.emitters) {
      let sheetId: string | null = null;
      if (em.sheetId !== null) {
        sheetId = sheetIds.get(em.sheetId) ?? null;
        if (!sheetId) return { ok: false, errors: [`Emitter "${em.name}" references a sheet that is not in the package.`] };
      }
      emitters.push({ ...em, id: newId('em'), sheetId, attachmentId: null });
    }
    effects.push({ ...e, id: newId('fx'), ptfxName: unique(e.ptfxName, takenFx), emitters });
  }
  return { ok: true, clips, sheets, effects, name: pkg.name };
}
