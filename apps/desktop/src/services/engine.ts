/**
 * Main-thread client of the engine worker. It owns the pieces only the main thread can do —
 * extracting frames through the platform (FFmpeg / <video>) and calling the native converter —
 * and exposes the engine's operations as ordinary async methods.
 */
import type { Clip, Project } from '@vfxforge/core';
import type { ConvertResult, ExportOptions, ExportResult } from '@vfxforge/export';
import type { RgbaImage } from '@vfxforge/media';
import { createClient, type ClientHandle, type Port } from '../lib/rpc';
import type { Platform } from '../platform';
import type { Engine, SheetPreview } from '../workers/engine-core';

/** Longest side used when extracting for the live preview; export always uses the clip's own settings. */
export const PREVIEW_EXTRACT_CAP = 512;

/** The extraction used for editing: same frames as the export, just no larger than the preview needs. */
export function previewClip(clip: Clip, cap = PREVIEW_EXTRACT_CAP): Clip {
  const { width, height } = clip.extract;
  let w = width;
  let h = height;
  let keepAspect = clip.extract.keepAspect;
  if (w == null && h == null) {
    w = cap;
    h = cap;
    keepAspect = true; // fit inside the box: never distorts, the source aspect is kept
  } else if (w != null && h != null) {
    const s = Math.min(1, cap / Math.max(w, h));
    w = Math.max(1, Math.round(w * s));
    h = Math.max(1, Math.round(h * s));
  } else if (w != null) w = Math.min(w, cap);
  else if (h != null) h = Math.min(h, cap);
  return { ...clip, extract: { ...clip.extract, width: w, height: h, keepAspect } };
}

export function rawKey(project: Project, clip: Clip, preview: Clip): string {
  const asset = clip.assetId ? project.assets[clip.assetId] : null;
  return JSON.stringify([asset?.sha256 ?? null, asset?.kind ?? null, preview.extract, clip.generator]);
}

export type StageListener = (stage: string, detail?: string) => void;

export interface RawProgress {
  done: number;
  total: number | null;
}

export class EngineClient {
  private readonly client: ClientHandle<Engine>;
  private readonly stages = new Map<string, StageListener>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly inflight = new Map<string, Promise<string>>();
  private seq = 1;

  constructor(
    private readonly platform: Platform,
    port: Port,
  ) {
    this.client = createClient<Engine>(port, {
      getFrames: async (jobId: string, clip: Clip, project: Project): Promise<RgbaImage[]> => {
        const signal = this.aborts.get(jobId)?.signal;
        return this.platform.frames.extract(clip, project, { signal });
      },
      convert: async (args: { xml: string; dds: Record<string, Uint8Array>; gen9: boolean; assetName: string }): Promise<ConvertResult> => {
        if (!this.platform.converter) throw new Error('No converter is configured.');
        return this.platform.converter.convert(args);
      },
      stage: (jobId: string, stage: string, detail?: string) => {
        this.stages.get(jobId)?.(stage, detail);
      },
    });
  }

  dispose(): void {
    this.client.dispose();
  }

  /**
   * Makes sure the worker holds the (preview-sized) raw frames for `clip` and returns their key.
   * Concurrent calls for the same key share one extraction.
   */
  ensureRaw(project: Project, clip: Clip, onProgress?: (p: RawProgress) => void, signal?: AbortSignal): Promise<string> {
    const pc = previewClip(clip);
    const key = rawKey(project, clip, pc);
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const job = (async () => {
      if (await this.client.api.hasRaw(key)) return key;
      const frames = await this.platform.frames.extract(pc, project, {
        signal,
        onProgress: (done, total) => onProgress?.({ done, total }),
      });
      const buffers = frames.map((f) => f.data.buffer as ArrayBuffer);
      await this.client.callTransfer('putRaw', [key, frames], buffers);
      return key;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }

  buildSheet(key: string, clip: Clip, sheet: Project['sheets'][string], target: Project['export']['target']): Promise<SheetPreview> {
    return this.client.api.buildSheet(key, clip, sheet, target);
  }

  dropRaw(key: string): Promise<void> {
    return this.client.api.dropRaw(key);
  }

  newJob(onStage?: StageListener): { id: string; signal: AbortSignal; cancel: () => void; done: () => void } {
    const id = `job${this.seq++}`;
    const ctl = new AbortController();
    this.aborts.set(id, ctl);
    if (onStage) this.stages.set(id, onStage);
    return {
      id,
      signal: ctl.signal,
      cancel: () => {
        ctl.abort();
        void this.client.api.cancel(id);
      },
      done: () => {
        this.aborts.delete(id);
        this.stages.delete(id);
      },
    };
  }

  async exportSheet(project: Project, sheetId: string, onStage?: StageListener) {
    const job = this.newJob(onStage);
    try {
      return await this.client.api.exportSheet(job.id, project, sheetId);
    } finally {
      job.done();
    }
  }

  runExport(
    project: Project,
    opts: Pick<ExportOptions, 'resource' | 'donor' | 'allowSourceOnly'>,
    onStage?: StageListener,
  ): { promise: Promise<ExportResult>; cancel: () => void } {
    const job = this.newJob(onStage);
    const promise = this.client.api
      .runExport(job.id, project, { ...opts, hasConverter: !!this.platform.converter })
      .finally(() => job.done());
    return { promise, cancel: job.cancel };
  }
}

let shared: EngineClient | null = null;

export function getEngine(platform: Platform): EngineClient {
  if (shared) return shared;
  const worker = new Worker(new URL('../workers/engine.worker.ts', import.meta.url), { type: 'module' });
  shared = new EngineClient(platform, worker as unknown as Port);
  return shared;
}

export function setEngine(e: EngineClient | null): void {
  shared = e;
}
