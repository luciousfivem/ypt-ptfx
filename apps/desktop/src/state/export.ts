import { mipLevelCount } from '@vfxforge/media';
import type { ExportResult } from '@vfxforge/export';
import type { ResourceOptions } from '@vfxforge/fivem';
import { loadDonor, type DonorLoad, type DonorPlan } from '@vfxforge/ypt';
import { create } from 'zustand';
import { svc } from '../services/app';
import { useDerived } from './derived';
import { getProject } from './project';
import { toast } from './ui';

export interface ExportOptionsState {
  testCommand: string;
  enableTestCommand: boolean;
  debug: boolean;
  syncEnabled: boolean;
  syncRadius: number;
  minIntervalMs: number;
  allowSourceOnly: boolean;
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptionsState = {
  testCommand: 'vfxtest',
  enableTestCommand: true,
  debug: false,
  syncEnabled: false,
  syncRadius: 60,
  minIntervalMs: 50,
  allowSourceOnly: false,
};

const KEY = 'vfxforge.export.v1';
const loadOptions = (): ExportOptionsState => {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_EXPORT_OPTIONS, ...(JSON.parse(raw) as Partial<ExportOptionsState>) };
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_EXPORT_OPTIONS;
};

export interface DonorSelection {
  effects: string[];
  textureName: string | null;
  particles: string[];
}

interface ExportState {
  options: ExportOptionsState;
  running: boolean;
  stages: Array<{ stage: string; detail?: string }>;
  result: ExportResult | null;
  /** The project `modifiedAt` the result was produced from; a differing value means the result is stale. */
  resultFor: string | null;
  error: string | null;
  cancel: (() => void) | null;
  donor: { fileName: string; xml: string; load: DonorLoad } | null;
  donorSel: DonorSelection;
  patchOptions: (p: Partial<ExportOptionsState>) => void;
  setDonorSel: (p: Partial<DonorSelection>) => void;
  loadDonorFile: () => Promise<void>;
  clearDonor: () => void;
  run: () => Promise<void>;
  abort: () => void;
}

export const useExport = create<ExportState>((set, get) => ({
  options: loadOptions(),
  running: false,
  stages: [],
  result: null,
  resultFor: null,
  error: null,
  cancel: null,
  donor: null,
  donorSel: { effects: [], textureName: null, particles: [] },

  patchOptions(p) {
    const options = { ...get().options, ...p };
    try {
      localStorage.setItem(KEY, JSON.stringify(options));
    } catch {
      /* ignore */
    }
    set({ options });
  },

  setDonorSel(p) {
    set({ donorSel: { ...get().donorSel, ...p } });
  },

  async loadDonorFile() {
    const { platform } = svc();
    const files = await platform.pickFiles({ accept: ['.xml', '.ypt.xml'], title: 'Choose a donor .ypt.xml' });
    const f = files[0];
    if (!f || typeof f === 'string') return;
    try {
      if (f.size > 20 * 1024 * 1024) throw new Error('That file is larger than 20 MiB; it is not a PTFX donor.');
      const xml = await f.text();
      const load = loadDonor(xml);
      const s = load.inspect.summary!;
      set({ donor: { fileName: f.name, xml, load }, donorSel: { effects: s.effects.slice(0, 1), textureName: s.textures[0]?.name ?? null, particles: s.particles.slice(0, 1) } });
      toast('ok', `Loaded donor “${f.name}” (${s.effects.length} effects, ${s.textures.length} textures).`);
    } catch (e) {
      toast('error', `Donor rejected: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  clearDonor() {
    set({ donor: null, donorSel: { effects: [], textureName: null, particles: [] } });
  },

  async run() {
    if (get().running) return;
    const { engine } = svc();
    const project = getProject();
    const o = get().options;
    const resource: Partial<ResourceOptions> = {
      testCommand: o.testCommand,
      enableTestCommand: o.enableTestCommand,
      debug: o.debug,
      minIntervalMs: o.minIntervalMs,
      sync: { enabled: o.syncEnabled, radius: o.syncRadius, minIntervalMs: 60 },
    };

    let donor: { xml: string; plan: Omit<DonorPlan, 'assetName'> } | null = null;
    if (project.export.yptStrategy === 'donor') {
      const d = get().donor;
      const sel = get().donorSel;
      if (d) {
        const used = Object.values(project.effects).flatMap((e) => e.emitters).find((em) => em.enabled && em.sheetId);
        const sheet = used?.sheetId ? project.sheets[used.sheetId] : undefined;
        const frames = (sheet && useDerived.getState().sheets[sheet.id]?.preview?.frameCount) || 1;
        const plan: Omit<DonorPlan, 'assetName'> = { keepEffects: sel.effects.length ? sel.effects : undefined };
        if (sheet && sel.textureName) {
          plan.texture = {
            donorTextureName: sel.textureName,
            newName: sheet.textureName,
            fileName: `${sheet.textureName}.dds`,
            width: sheet.texture.width,
            height: sheet.texture.height,
            mipLevels: sheet.dds.mipmaps ? mipLevelCount(sheet.texture.width, sheet.texture.height) : 1,
            format: sheet.dds.format === 'BC1' ? 'D3DFMT_DXT1' : sheet.dds.format === 'BC3' ? 'D3DFMT_DXT5' : 'D3DFMT_A8R8G8B8',
          };
          plan.particles = sel.particles.map((particleName) => ({ particleName, texFrameMin: 0, texFrameMax: Math.max(0, frames - 1), animFps: sheet.fps }));
        }
        donor = { xml: d.xml, plan };
      }
    }

    set({ running: true, stages: [], result: null, error: null });
    const job = engine.runExport(project, { resource, donor, allowSourceOnly: o.allowSourceOnly }, (stage, detail) => set({ stages: [...get().stages, { stage, detail }] }));
    set({ cancel: job.cancel });
    try {
      const result = await job.promise;
      set({ result, resultFor: project.modifiedAt });
    } catch (e) {
      const aborted = e instanceof Error && (e.name === 'AbortError' || e.name === 'Cancelled');
      set({ error: aborted ? 'Export cancelled.' : e instanceof Error ? e.message : String(e) });
    } finally {
      set({ running: false, cancel: null });
    }
  },

  abort() {
    get().cancel?.();
  },
}));
