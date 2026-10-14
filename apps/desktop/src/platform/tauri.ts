/**
 * Desktop platform: the Tauri shell. All heavy or privileged work (FFmpeg, the CodeWalker
 * bridge, project folders, atomic writes) happens in Rust behind validated commands; this file is
 * the typed, defensive client for them.
 *
 * Project data lives under the app data folder, one folder per project id:
 *   <app data>/projects/<id>/{project.json, assets/<sha256>.<ext>, autosave/}
 */
import { Channel, invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { checkIntegrity, createAsset, parseProject, sanitizeFilename, type Asset, type Clip, type MediaInfo, type Project } from '@vfxforge/core';
import type { ConvertResult, ConvertService } from '@vfxforge/export';
import { decodePng, sha256Hex, sniffBytes, type RgbaImage } from '@vfxforge/media';
import { generateSpriteFrames } from '@vfxforge/particles';
import { unzipSync, zipSync } from 'fflate';
import type { ConverterStatus, ExtractOptions, FrameService, Platform, PlatformFeatures, ProjectStore, ProjectSummary, ToolPaths, ToolsApi, ToolsStatus } from './types';
import { packWire, unpackWire } from './wire';
import { bitmapFrom, extractAnimated, hasTransparency, imageDataOf, targetSize } from './web-media';

/* ------------------------------------------------------------------ errors */

/** Rust errors arrive as `{ code, message }`; turn them into real Errors that keep the code. */
export function toError(e: unknown): Error {
  if (e instanceof Error) return e;
  if (e && typeof e === 'object' && 'message' in e) {
    const err = new Error(String((e as { message: unknown }).message));
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') {
      (err as Error & { code?: string }).code = code;
      if (code === 'cancelled') err.name = 'AbortError';
    }
    return err;
  }
  return new Error(typeof e === 'string' ? e : 'The desktop core reported an unknown error.');
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toError(e);
  }
}

async function callRaw(cmd: string, body: Uint8Array): Promise<Uint8Array> {
  try {
    const res = await invoke<ArrayBuffer>(cmd, body);
    return new Uint8Array(res);
  } catch (e) {
    throw toError(e);
  }
}

async function callBytes(cmd: string, args: Record<string, unknown>): Promise<Uint8Array> {
  try {
    return new Uint8Array(await invoke<ArrayBuffer>(cmd, args));
  } catch (e) {
    throw toError(e);
  }
}

/* --------------------------------------------------------------- data shapes */

interface RustMediaInfo {
  width: number;
  height: number;
  duration_sec: number | null;
  fps: number | null;
  frame_count: number | null;
  has_alpha: boolean;
  codec: string | null;
}

interface ImportResult {
  relPath: string;
  sha256: string;
  bytes: number;
  kind: string;
  category: 'image' | 'video' | 'model' | 'unknown';
  mime: string;
  deduplicated: boolean;
  info: RustMediaInfo | null;
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

const num = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? null : v);

function mediaInfoFrom(r: RustMediaInfo): MediaInfo {
  return {
    width: Math.max(1, Math.min(16384, Math.round(r.width))),
    height: Math.max(1, Math.min(16384, Math.round(r.height))),
    durationSec: num(r.duration_sec),
    fps: num(r.fps),
    frameCount: r.frame_count === null ? null : Math.max(0, Math.round(r.frame_count)),
    hasAlpha: r.has_alpha,
    codec: r.codec,
  };
}

/* ----------------------------------------------------------------- platform */

export interface TauriPlatformOptions {
  /** Id of the project assets are currently imported into. */
  activeProjectId: () => string;
}

let jobCounter = 0;

export async function createTauriPlatform(opts: TauriPlatformOptions): Promise<Platform> {
  let status: ToolsStatus = await call<ToolsStatus>('tool_status');
  const urlCache = new Map<string, string>();
  const pid = () => opts.activeProjectId();

  const toolsApi: ToolsApi = {
    status: async () => (status = await call<ToolsStatus>('tool_status')),
    setPaths: async (paths: ToolPaths) => (status = await call<ToolsStatus>('set_tool_paths', { paths })),
  };

  const assetBytes = (asset: Asset) => callBytes('read_asset', { projectId: pid(), relPath: asset.file });

  /* ---- frames ---- */
  class DesktopFrames implements FrameService {
    async getFrames(clip: Clip, project: Project, signal?: AbortSignal): Promise<RgbaImage[]> {
      return this.extract(clip, project, { signal });
    }

    async extract(clip: Clip, project: Project, o: ExtractOptions = {}): Promise<RgbaImage[]> {
      if (clip.generator) return generateSpriteFrames(clip.generator, (d, t) => o.onProgress?.(d, t));
      if (!clip.assetId) throw new Error(`Clip "${clip.name}" has no source media.`);
      const asset = project.assets[clip.assetId];
      if (!asset) throw new Error(`Clip "${clip.name}" refers to media that is no longer in the project.`);
      if (asset.kind === 'model') throw new Error(`"${asset.name}" is a 3D model, not frame media.`);
      if (o.signal?.aborted) throw new DOMException('Extraction cancelled', 'AbortError');

      const animatedImage = asset.mime === 'image/gif' || asset.mime === 'image/apng';
      const ffmpegPath = asset.kind === 'video' || (animatedImage && status.ffmpeg.available);
      if (ffmpegPath) {
        if (!status.ffmpeg.available) throw new Error(`Video import needs FFmpeg. ${status.ffmpeg.detail}`);
        return this.viaFfmpeg(clip, asset, o);
      }
      // stills and WebP animations are decoded by the web engine (FFmpeg has no WebP demuxer here)
      const bytes = await assetBytes(asset);
      const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: asset.mime });
      if (asset.mime === 'image/webp' || animatedImage) {
        try {
          const frames = await extractAnimated(blob, asset.mime, clip, o);
          if (frames.length) return frames;
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') throw e;
          if (asset.mime === 'image/apng') throw e;
        }
      }
      if (asset.mime === 'image/png') {
        try {
          return [decodePng(bytes)];
        } catch {
          /* fall back to the browser decoder */
        }
      }
      const bmp = await bitmapFrom(blob);
      const { w, h } = targetSize(bmp.width, bmp.height, clip);
      const img = imageDataOf(bmp, w, h);
      bmp.close();
      return [img];
    }

    private async viaFfmpeg(clip: Clip, asset: Asset, o: ExtractOptions): Promise<RgbaImage[]> {
      const jobId = `extract-${Date.now().toString(36)}-${++jobCounter}`;
      const progress = new Channel<{ done: number; expected: number | null }>();
      progress.onmessage = (p) => o.onProgress?.(p.done, p.expected);
      const onAbort = () => void call('cancel_job', { jobId }).catch(() => undefined);
      o.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const e = clip.extract;
        const reply = await callBytes('extract_frames_cmd', {
          jobId,
          projectId: pid(),
          args: {
            assetRelPath: asset.file,
            startSec: e.startSec,
            endSec: e.endSec,
            fps: e.fps,
            frameSkip: e.frameSkip,
            maxFrames: e.maxFrames,
            width: e.width,
            height: e.height,
            keepAspect: e.keepAspect,
            interpolation: e.interpolation,
          },
          onProgress: progress,
        });
        const { json, blobs } = unpackWire<{ count: number }>(reply);
        if (json.count !== blobs.length || blobs.length === 0) throw new Error('FFmpeg produced no frames.');
        return blobs.map((b) => decodePng(b));
      } finally {
        o.signal?.removeEventListener('abort', onAbort);
      }
    }
  }

  /* ---- projects ---- */
  const parseDoc = (json: string): Project => {
    const r = parseProject(JSON.parse(json));
    if (!r.ok) throw new Error('The stored project is damaged: ' + r.errors.slice(0, 3).join('; '));
    return r.project;
  };

  const projects: ProjectStore = {
    list: () => call<ProjectSummary[]>('list_projects'),
    async save(project) {
      const checked = parseProject(JSON.parse(JSON.stringify(project)));
      if (!checked.ok) throw new Error('Refusing to save an invalid project: ' + checked.errors.slice(0, 3).join('; '));
      await call('save_project', { projectId: project.id, json: JSON.stringify(project, null, 2) });
    },
    async open(id) {
      const loaded = await call<{ json: string; recoveredFromBackup: boolean }>('load_project', { projectId: id });
      return parseDoc(loaded.json);
    },
    remove: (id) => call('delete_project', { projectId: id }),

    async exportBundle(project) {
      const files: Record<string, [Uint8Array, { level: 0 | 6 }]> = {
        'project.json': [new TextEncoder().encode(JSON.stringify(project, null, 2)), { level: 6 }],
      };
      for (const a of Object.values(project.assets)) files[a.file] = [await callBytes('read_asset', { projectId: project.id, relPath: a.file }), { level: 0 }];
      return zipSync(files);
    },

    async importBundle(bytes) {
      let files: Record<string, Uint8Array>;
      try {
        files = unzipSync(bytes);
      } catch {
        throw new Error('That file is not a VFXForge project bundle (it is not a valid ZIP archive).');
      }
      const doc = files['project.json'];
      if (!doc) throw new Error('The bundle has no project.json.');
      const parsed = parseProject(JSON.parse(new TextDecoder().decode(doc)));
      if (!parsed.ok) throw new Error('The bundle contains an invalid project: ' + parsed.errors.slice(0, 3).join('; '));
      const project = parsed.project;
      for (const a of Object.values(project.assets)) {
        const data = files[a.file];
        if (!data) throw new Error(`The bundle is missing "${a.file}".`);
        if (sniffBytes(data.subarray(0, 8192)).category === 'unknown') throw new Error(`"${a.name}" in the bundle is not recognised media (checked its file signature).`);
        if ((await sha256Hex(data)) !== a.sha256) throw new Error(`"${a.name}" in the bundle does not match its recorded checksum; the bundle is corrupt or was modified.`);
        try {
          await invoke('import_bundle_asset', packWire({ projectId: project.id, relPath: a.file }, [data]));
        } catch (e) {
          throw toError(e);
        }
      }
      const integrity = checkIntegrity(project);
      if (integrity.length) throw new Error('The bundle project is inconsistent: ' + integrity.slice(0, 3).join('; '));
      return project;
    },

    autosave: (project) => call('autosave_project', { projectId: project.id, json: JSON.stringify(project) }),
    async recovery(id) {
      const json = await call<string | null>('recovery_for', { projectId: id });
      return json ? parseDoc(json) : null;
    },
    async latestAutosave() {
      const found = await call<{ projectId: string; json: string } | null>('latest_autosave');
      if (!found) return null;
      try {
        return parseDoc(found.json);
      } catch {
        return null;
      }
    },
    clearAutosave: (id) => call('clear_autosave', { projectId: id }),
  };

  /* ---- converter ---- */
  const converter: ConvertService = {
    async convert({ xml, dds, gen9, assetName }): Promise<ConvertResult> {
      const names = Object.keys(dds);
      const reply = await callRaw('convert_ypt', packWire({ xml, gen9, assetName, files: names }, names.map((n) => dds[n]!)));
      const { json, blobs } = unpackWire<{ roundTripOk: boolean; mismatches: string[]; resourceVersion: number; codewalkerCore: string | null }>(reply);
      const ypt = blobs[0];
      if (!ypt) throw new Error('The converter returned no file.');
      return { ypt: ypt.slice(), roundTripOk: json.roundTripOk, mismatches: json.mismatches ?? [], resourceVersion: json.resourceVersion, codewalkerCore: json.codewalkerCore ?? null };
    },
  };

  const platform: Platform = {
    kind: 'tauri',
    label: 'Desktop',
    get features(): PlatformFeatures {
      return { ffmpeg: status.ffmpeg.available, accurateProbe: status.ffprobe.available, binaryYpt: status.bridge.available, nativeProjects: true, interpolation: status.ffmpeg.available };
    },
    frames: new DesktopFrames(),
    projects,
    get converter() {
      return status.bridge.available ? converter : null;
    },
    tools: toolsApi,

    async refresh() {
      status = await call<ToolsStatus>('tool_status');
    },

    async converterStatus(): Promise<ConverterStatus> {
      status = await call<ToolsStatus>('tool_status');
      return status.bridge;
    },

    async importAsset(source, onProgress) {
      if (typeof source !== 'string') throw new Error('Choose files with the Import button or drop them on the window; the desktop app imports by file path.');
      onProgress?.(0.1);
      const r = await call<ImportResult>('import_asset', { projectId: pid(), source });
      onProgress?.(0.7);
      if (r.category === 'unknown') throw new Error(`"${baseName(source)}" is not a recognised image, video or 3D model.`);
      let info: MediaInfo | null = r.info ? mediaInfoFrom(r.info) : null;
      if (!info && r.category === 'image') {
        // no ffprobe: the web engine can still read an image's size and transparency
        const bytes = await callBytes('read_asset', { projectId: pid(), relPath: r.relPath });
        const bmp = await bitmapFrom(new Blob([bytes.slice().buffer as ArrayBuffer], { type: r.mime }));
        info = { width: bmp.width, height: bmp.height, durationSec: null, fps: null, frameCount: r.kind === 'gif' || r.kind === 'apng' || r.kind === 'webp' ? null : 1, hasAlpha: r.kind !== 'jpeg' && hasTransparency(bmp, bmp.width, bmp.height), codec: r.kind };
        bmp.close();
      }
      onProgress?.(1);
      return createAsset({ kind: r.category, name: sanitizeFilename(baseName(source)), file: r.relPath, sha256: r.sha256, bytes: r.bytes, mime: r.mime, info });
    },

    async assetUrl(asset) {
      const hit = urlCache.get(asset.sha256);
      if (hit) return hit;
      const bytes = await assetBytes(asset);
      const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: asset.mime }));
      urlCache.set(asset.sha256, url);
      return url;
    },
    assetBytes,

    async saveFile(name, bytes, mime) {
      const ext = name.includes('.') ? name.split('.').pop()! : '';
      void mime;
      const chosen = await saveDialog({ defaultPath: sanitizeFilename(name), filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined });
      if (!chosen) return 'cancelled';
      try {
        await invoke('write_user_file', packWire({ path: chosen }, [bytes]));
      } catch (e) {
        throw toError(e);
      }
      return 'saved';
    },

    async pickFiles({ accept, multiple, title }) {
      const extensions = accept.map((a) => a.replace(/^\./, '')).filter((a) => /^[a-z0-9.]+$/i.test(a));
      const picked = await openDialog({ multiple: !!multiple, title, filters: extensions.length ? [{ name: 'Supported files', extensions }] : undefined });
      if (!picked) return [];
      return Array.isArray(picked) ? picked : [picked];
    },

    async onFilesDropped(cb, onHover) {
      const un = await getCurrentWebview().onDragDropEvent((ev) => {
        const p = ev.payload;
        if (p.type === 'enter' || p.type === 'over') onHover?.(true);
        else if (p.type === 'leave') onHover?.(false);
        else if (p.type === 'drop') {
          onHover?.(false);
          if (p.paths.length) cb(p.paths);
        }
      });
      return un;
    },
  };
  return platform;
}
