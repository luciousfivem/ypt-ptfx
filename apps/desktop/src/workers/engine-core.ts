/**
 * The compute engine. A plain module so it runs unchanged in a Web Worker (production) and in
 * Node (tests). It owns the heavy, CPU-bound work — keying, atlas building, DDS/PNG encoding,
 * the export pipeline — and keeps the raw frames of every clip so that slider edits only
 * re-run the cheap, non-destructive stages.
 *
 * Everything that needs the platform (extracting frames, the native converter) is asked of the
 * main thread through `EngineHost`, so the same code serves the browser and the Tauri build.
 */
import { computeGridLayout, type Clip, type GridIssue, type GridLayout, type Project, type Sheet } from '@vfxforge/core';
import {
  encodeSheet,
  renderSheet,
  runExport,
  textureBytes,
  type ConvertResult,
  type ExportOptions,
  type ExportResult,
  type FrameSource,
} from '@vfxforge/export';
import { expectedDdsSize, resizeImage, type Placement, type RgbaImage } from '@vfxforge/media';
import { validateFlipbook, type FlipbookReport } from '@vfxforge/ypt';

export type EngineHost = {
  /** Full-resolution frames for export (the platform extracts them: FFmpeg or <video>). */
  getFrames(jobId: string, clip: Clip, project: Project): Promise<RgbaImage[]>;
  convert(args: { xml: string; dds: Record<string, Uint8Array>; gen9: boolean; assetName: string }): Promise<ConvertResult>;
  stage(jobId: string, stage: string, detail?: string): void;
};

export interface SheetPreview {
  /** Atlas for display / GPU upload, capped at `ATLAS_PREVIEW_MAX` px on its longest side. */
  atlas: RgbaImage;
  layout: GridLayout | null;
  gridIssues: GridIssue[];
  placements: Placement[];
  frameCount: number;
  /** Processed frames after the frame list / reverse / ping-pong, capped at `THUMB_MAX` px (animation preview). */
  frames: RgbaImage[];
  /** Processed frames in natural order (what `Clip.frames[].src` indexes), capped at `THUMB_MAX` px. */
  base: RgbaImage[];
  /** Number of raw frames extracted for this clip. */
  rawCount: number;
  /** Matching source frames (before processing) for before/after. */
  source: RgbaImage[];
  durations: number[];
  fps: number;
  notes: string[];
  warnings: string[];
  flipbook: FlipbookReport;
  ddsBytes: number;
  vramBytes: number;
  ms: number;
}

export const ATLAS_PREVIEW_MAX = 1024;
export const THUMB_MAX = 192;

function capDim(img: RgbaImage, max: number): RgbaImage {
  const m = Math.max(img.width, img.height);
  if (m <= max) return img;
  const s = max / m;
  return resizeImage(img, Math.max(1, Math.round(img.width * s)), Math.max(1, Math.round(img.height * s)));
}

export class JobCancelled extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'AbortError';
  }
}

export function createEngine(host: EngineHost) {
  /** key -> raw frames. Bounded LRU so a few big videos cannot exhaust memory. */
  const raw = new Map<string, RgbaImage[]>();
  const MAX_RAW_BYTES = 768 * 1024 * 1024;
  const rawBytes = (frames: RgbaImage[]) => frames.reduce((s, f) => s + f.data.byteLength, 0);
  const jobs = new Map<string, AbortController>();

  function touch(key: string): RgbaImage[] | undefined {
    const f = raw.get(key);
    if (f) {
      raw.delete(key);
      raw.set(key, f);
    }
    return f;
  }

  function evict(): void {
    let total = 0;
    for (const f of raw.values()) total += rawBytes(f);
    for (const k of raw.keys()) {
      if (total <= MAX_RAW_BYTES || raw.size <= 1) break;
      total -= rawBytes(raw.get(k)!);
      raw.delete(k);
    }
  }

  function need(key: string): RgbaImage[] {
    const f = touch(key);
    if (!f) throw new Error('The source frames are no longer cached. Re-extract the clip.');
    return f;
  }

  const frameSource = (jobId: string): FrameSource => ({
    async getFrames(clip, project, signal) {
      if (signal?.aborted) throw new JobCancelled();
      host.stage(jobId, 'frames', clip.name);
      return host.getFrames(jobId, clip, project);
    },
  });

  return {
    hasRaw(key: string): boolean {
      return raw.has(key);
    },

    putRaw(key: string, frames: RgbaImage[]): number {
      if (frames.length === 0) throw new Error('No frames were extracted from the source.');
      raw.set(key, frames);
      evict();
      return frames.length;
    },

    dropRaw(key: string): void {
      raw.delete(key);
    },

    /** Runs the clip pipeline + atlas for the editor / viewport. Cheap enough to call on every edit. */
    buildSheet(key: string, clip: Clip, sheet: Sheet, target: 'fivem-legacy' | 'fivem-enhanced' = 'fivem-legacy'): SheetPreview {
      const t0 = performance.now();
      const frames = need(key);
      const { layout, issues: gridIssues } = computeGridLayout(sheet.grid, sheet.texture, sheet.padding);
      const { processed, atlas } = renderSheet(frames, clip, sheet);
      const mips = sheet.dds.mipmaps ? Math.floor(Math.log2(Math.max(sheet.texture.width, sheet.texture.height))) + 1 : 1;
      const flipbook = validateFlipbook({
        textureName: sheet.textureName,
        frameCount: atlas.frameCount,
        grid: sheet.grid,
        texture: sheet.texture,
        order: sheet.order,
        padding: sheet.padding,
        mipmaps: sheet.dds.mipmaps,
        frameRange: { min: 0, max: Math.max(0, atlas.frameCount - 1) },
        target,
        strategy: 'generate',
        donorGrid: null,
        donorTextureName: null,
      });
      return {
        atlas: capDim(atlas.image, ATLAS_PREVIEW_MAX),
        layout,
        gridIssues,
        placements: atlas.placements,
        frameCount: atlas.frameCount,
        frames: processed.frames.map((f) => capDim(f, THUMB_MAX)),
        base: processed.base.map((f) => capDim(f, THUMB_MAX)),
        rawCount: frames.length,
        source: frames.map((f) => capDim(f, THUMB_MAX)),
        durations: processed.durations,
        fps: processed.fps,
        notes: processed.notes,
        warnings: atlas.warnings,
        flipbook,
        ddsBytes: expectedDdsSize(sheet.dds.format, sheet.texture.width, sheet.texture.height, mips),
        vramBytes: textureBytes(sheet.texture.width, sheet.texture.height, sheet.dds.format, mips),
        ms: performance.now() - t0,
      };
    },

    /** Full-resolution PNG + DDS for one sheet ("Export PNG/DDS"). */
    async exportSheet(jobId: string, project: Project, sheetId: string): Promise<{ png: Uint8Array; dds: Uint8Array; ddsFileName: string; frameCount: number; warnings: string[] }> {
      const ctl = new AbortController();
      jobs.set(jobId, ctl);
      try {
        const sheet = project.sheets[sheetId];
        if (!sheet) throw new Error('That spritesheet no longer exists.');
        const clip = project.clips[sheet.clipId];
        if (!clip) throw new Error('The spritesheet has no clip.');
        const frames = await frameSource(jobId).getFrames(clip, project, ctl.signal);
        if (ctl.signal.aborted) throw new JobCancelled();
        host.stage(jobId, 'sheets', sheet.name);
        const enc = encodeSheet(frames, clip, sheet);
        return { png: enc.png, dds: enc.dds, ddsFileName: enc.ddsFileName, frameCount: enc.atlas.frameCount, warnings: enc.atlas.warnings };
      } finally {
        jobs.delete(jobId);
      }
    },

    /** The whole export. Progress is reported through `host.stage`; `cancel(jobId)` aborts between stages. */
    async runExport(
      jobId: string,
      project: Project,
      opts: Pick<ExportOptions, 'resource' | 'donor' | 'allowSourceOnly'> & { hasConverter: boolean },
    ): Promise<ExportResult> {
      const ctl = new AbortController();
      jobs.set(jobId, ctl);
      try {
        return await runExport(
          project,
          frameSource(jobId),
          opts.hasConverter
            ? {
                convert: (args) => {
                  host.stage(jobId, 'binary', args.assetName);
                  return host.convert(args);
                },
              }
            : null,
          {
            resource: opts.resource,
            donor: opts.donor,
            allowSourceOnly: opts.allowSourceOnly,
            signal: ctl.signal,
            onStage: (s, d) => host.stage(jobId, s, d),
          },
        );
      } catch (e) {
        if (e instanceof Error && (e.name === 'Cancelled' || e.name === 'AbortError')) throw new JobCancelled();
        throw e;
      } finally {
        jobs.delete(jobId);
      }
    },

    cancel(jobId: string): boolean {
      const j = jobs.get(jobId);
      j?.abort();
      return !!j;
    },
  };
}

export type Engine = ReturnType<typeof createEngine>;
