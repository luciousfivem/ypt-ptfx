import { create } from 'zustand';

export type Mode = 'sprite' | 'particles' | 'weapon';
export type Theme = 'dark' | 'light';
export type Selection =
  | { kind: 'none' }
  | { kind: 'asset'; id: string }
  | { kind: 'clip'; id: string }
  | { kind: 'sheet'; id: string }
  | { kind: 'emitter'; effectId: string; id: string }
  | { kind: 'effect'; id: string }
  | { kind: 'attachment'; id: string }
  | { kind: 'weapon' };

export interface Toast {
  id: number;
  tone: 'info' | 'ok' | 'warn' | 'error';
  text: string;
}

export interface Settings {
  theme: Theme;
  quality: 'auto' | 'high' | 'medium' | 'low';
  bloom: boolean;
  autosaveSeconds: number;
  showGrid: boolean;
  confirmDestructive: boolean;
}

export const DEFAULT_SETTINGS: Settings = { theme: 'dark', quality: 'auto', bloom: true, autosaveSeconds: 20, showGrid: true, confirmDestructive: true };

const SETTINGS_KEY = 'vfxforge.settings.v1';

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* storage unavailable: use defaults */
  }
  return DEFAULT_SETTINGS;
}

export type DialogId = 'none' | 'export' | 'settings' | 'open' | 'new' | 'shortcuts' | 'about' | 'recovery';

interface UiState {
  mode: Mode;
  selection: Selection;
  dialog: DialogId;
  settings: Settings;
  toasts: Toast[];
  leftTab: 'assets' | 'presets' | 'layers';
  rightTab: 'inspect' | 'weapon' | 'export';
  /** Busy indicators for long jobs (id -> label, 0..1 or null when indeterminate). */
  jobs: Record<string, { label: string; progress: number | null }>;
  setMode: (m: Mode) => void;
  select: (s: Selection) => void;
  openDialog: (d: DialogId) => void;
  closeDialog: () => void;
  patchSettings: (p: Partial<Settings>) => void;
  toast: (tone: Toast['tone'], text: string) => void;
  dismissToast: (id: number) => void;
  setLeftTab: (t: UiState['leftTab']) => void;
  setRightTab: (t: UiState['rightTab']) => void;
  setJob: (id: string, job: { label: string; progress: number | null } | null) => void;
}

let toastId = 1;

export const useUi = create<UiState>((set, get) => ({
  mode: 'particles',
  selection: { kind: 'none' },
  dialog: 'none',
  settings: loadSettings(),
  toasts: [],
  leftTab: 'presets',
  rightTab: 'inspect',
  jobs: {},
  setMode: (mode) => set({ mode }),
  select: (selection) => set({ selection }),
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: 'none' }),
  patchSettings: (p) => {
    const settings = { ...get().settings, ...p };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* storage unavailable: setting applies for this session only */
    }
    set({ settings });
  },
  toast: (tone, text) => {
    const id = toastId++;
    set({ toasts: [...get().toasts.slice(-3), { id, tone, text }] });
    setTimeout(() => get().dismissToast(id), tone === 'error' ? 9000 : 4500);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setLeftTab: (leftTab) => set({ leftTab }),
  setRightTab: (rightTab) => set({ rightTab }),
  setJob: (id, job) => {
    const jobs = { ...get().jobs };
    if (job) jobs[id] = job;
    else delete jobs[id];
    set({ jobs });
  },
}));

export const toast = (tone: Toast['tone'], text: string) => useUi.getState().toast(tone, text);
