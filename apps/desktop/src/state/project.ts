/**
 * The project document store. The document is immutable and edited only through `edit()`
 * (immer), so every History entry is a cheap structural-sharing snapshot and "dirty" is simply
 * "the present document is not the one that was last saved".
 */
import { History, createProject, nowIso, type Project } from '@vfxforge/core';
import { produce, type Draft } from 'immer';
import { create } from 'zustand';

export interface EditOptions {
  /** Edits with the same key within the coalesce window fold into one undo step (sliders, drags). */
  coalesceKey?: string;
}

interface ProjectState {
  project: Project;
  /** Bumped on every change; handy as an effect dependency. */
  rev: number;
  saved: Project | null;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | undefined;
  redoLabel: string | undefined;
  edit: (label: string, recipe: (draft: Draft<Project>) => void, opts?: EditOptions) => void;
  undo: () => void;
  redo: () => void;
  /** Replaces the document and clears history (new / open / recovery). */
  load: (project: Project, opts?: { saved?: boolean }) => void;
  markSaved: (project?: Project) => void;
}

const initial = createProject('Untitled Effect');
const history = new History<Project>(initial, { limit: 300, coalesceMs: 900 });

function snapshot(saved: Project | null) {
  return {
    project: history.present,
    rev: history.version,
    dirty: history.present !== saved,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    undoLabel: history.undoLabel,
    redoLabel: history.redoLabel,
  };
}

export const useProject = create<ProjectState>((set, get) => ({
  // a brand-new project has nothing to lose, so it starts clean
  ...snapshot(initial),
  saved: initial,

  edit(label, recipe, opts = {}) {
    const next = produce(history.present, (d) => {
      recipe(d);
    });
    if (next === history.present) return;
    const stamped = produce(next, (d) => {
      d.modifiedAt = nowIso();
    });
    history.commit(stamped, { label, coalesceKey: opts.coalesceKey });
    set(snapshot(get().saved));
  },

  undo() {
    if (history.undo()) set(snapshot(get().saved));
  },

  redo() {
    if (history.redo()) set(snapshot(get().saved));
  },

  load(project, opts = {}) {
    history.reset(project);
    const saved = opts.saved === false ? null : project;
    set({ ...snapshot(saved), saved });
  },

  markSaved(project) {
    const saved = project ?? history.present;
    set({ saved, dirty: history.present !== saved });
  },
}));

/** Non-reactive access for services and event handlers. */
export const getProject = () => useProject.getState().project;
export const editProject = (label: string, recipe: (draft: Draft<Project>) => void, opts?: EditOptions) => useProject.getState().edit(label, recipe, opts);
