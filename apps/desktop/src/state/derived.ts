/**
 * Derived, never-persisted data: the live spritesheet preview of every sheet that matters right
 * now (used by an enabled emitter, or selected). It re-runs only the stages whose inputs
 * changed — project edits are immutable, so "changed" is a reference comparison — and always
 * keeps the previous good result on screen while a new one is being computed.
 */
import type { Clip, Project, Sheet } from '@vfxforge/core';
import { create } from 'zustand';
import type { EngineClient } from '../services/engine';
import type { SheetPreview } from '../workers/engine-core';
import { useProject } from './project';
import { useUi } from './ui';

export interface SheetState {
  status: 'extracting' | 'processing' | 'ready' | 'error';
  progress: number | null;
  error: string | null;
  /** Last successful result (kept while rebuilding). */
  preview: SheetPreview | null;
  /** Bumped whenever `preview` is replaced; lets GPU code know to re-upload the texture. */
  version: number;
}

interface DerivedState {
  sheets: Record<string, SheetState>;
}

export const useDerived = create<DerivedState>(() => ({ sheets: {} }));

const patch = (id: string, p: Partial<SheetState>) =>
  useDerived.setState((s) => ({
    sheets: { ...s.sheets, [id]: { ...(s.sheets[id] ?? { status: 'processing', progress: null, error: null, preview: null, version: 0 }), ...p } },
  }));

function wantedSheets(project: Project, selectedSheet: string | null, selectedClip: string | null): Set<string> {
  const want = new Set<string>();
  for (const e of Object.values(project.effects)) for (const em of e.emitters) if (em.enabled && em.sheetId) want.add(em.sheetId);
  if (selectedSheet) want.add(selectedSheet);
  if (selectedClip) for (const s of Object.values(project.sheets)) if (s.clipId === selectedClip) want.add(s.id);
  return want;
}

interface Built {
  clip: Clip;
  sheet: Sheet;
  target: Project['export']['target'];
  assetSha: string | null;
}

export function startDerivedService(engine: EngineClient, opts: { debounceMs?: number } = {}): () => void {
  const debounceMs = opts.debounceMs ?? 120;
  const built = new Map<string, Built>();
  /** Which raw-frame set each sheet currently uses, so superseded ones can be released from the worker. */
  const rawKeys = new Map<string, string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const running = new Set<string>();
  let queue: Promise<void> = Promise.resolve();
  let stopped = false;

  const selectedIds = () => {
    const sel = useUi.getState().selection;
    return { sheet: sel.kind === 'sheet' ? sel.id : null, clip: sel.kind === 'clip' ? sel.id : null };
  };

  async function rebuild(id: string): Promise<void> {
    if (stopped) return;
    const project = useProject.getState().project;
    const sheet = project.sheets[id];
    const clip = sheet ? project.clips[sheet.clipId] : undefined;
    if (!sheet || !clip) return;
    const target = project.export.target;
    const assetSha = clip.assetId ? (project.assets[clip.assetId]?.sha256 ?? null) : null;
    try {
      patch(id, { status: 'extracting', progress: null, error: null });
      const key = await engine.ensureRaw(project, clip, (p) => patch(id, { status: 'extracting', progress: p.total ? p.done / p.total : null }));
      const previous = rawKeys.get(id);
      rawKeys.set(id, key);
      if (previous && previous !== key && ![...rawKeys.values()].includes(previous)) void engine.dropRaw(previous).catch(() => undefined);
      patch(id, { status: 'processing', progress: null });
      const preview = await engine.buildSheet(key, clip, sheet, target);
      if (stopped) return;
      built.set(id, { clip, sheet, target, assetSha });
      const cur = useDerived.getState().sheets[id];
      patch(id, { status: 'ready', preview, error: null, progress: null, version: (cur?.version ?? 0) + 1 });
    } catch (e) {
      built.set(id, { clip, sheet, target, assetSha }); // do not retry the same failing inputs in a loop
      patch(id, { status: 'error', error: e instanceof Error ? e.message : String(e), progress: null });
    }
  }

  function schedule(id: string): void {
    clearTimeout(timers.get(id));
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        if (running.has(id)) return; // a rebuild is in flight; its completion re-checks staleness
        running.add(id);
        queue = queue
          .then(() => rebuild(id))
          .finally(() => {
            running.delete(id);
            sync(); // inputs may have changed while it ran
          });
      }, debounceMs),
    );
  }

  function sync(): void {
    if (stopped) return;
    const project = useProject.getState().project;
    const sel = selectedIds();
    const want = wantedSheets(project, sel.sheet, sel.clip);
    for (const id of want) {
      const sheet = project.sheets[id];
      const clip = sheet && project.clips[sheet.clipId];
      if (!sheet || !clip) continue;
      const prev = built.get(id);
      const assetSha = clip.assetId ? (project.assets[clip.assetId]?.sha256 ?? null) : null;
      const unchanged = prev && prev.clip === clip && prev.sheet === sheet && prev.target === project.export.target && prev.assetSha === assetSha;
      if (!unchanged && !running.has(id)) schedule(id);
    }
    // forget sheets that no longer exist
    const state = useDerived.getState().sheets;
    const gone = Object.keys(state).filter((id) => !project.sheets[id]);
    if (gone.length) {
      useDerived.setState((s) => {
        const next = { ...s.sheets };
        for (const id of gone) {
          delete next[id];
          built.delete(id);
          const key = rawKeys.get(id);
          rawKeys.delete(id);
          if (key && ![...rawKeys.values()].includes(key)) void engine.dropRaw(key).catch(() => undefined);
        }
        return { sheets: next };
      });
    }
  }

  const unsubProject = useProject.subscribe((s, p) => {
    if (s.project !== p.project) sync();
  });
  const unsubUi = useUi.subscribe((s, p) => {
    if (s.selection !== p.selection) sync();
  });
  sync();

  return () => {
    stopped = true;
    unsubProject();
    unsubUi();
    for (const t of timers.values()) clearTimeout(t);
  };
}

/** Forces every wanted sheet to rebuild (e.g. after the converter or platform changes). */
export function resetDerived(): void {
  useDerived.setState({ sheets: {} });
}
