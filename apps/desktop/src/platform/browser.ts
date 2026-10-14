/**
 * Browser implementation of the platform: IndexedDB for storage, <video>/ImageDecoder for media.
 * Used for development, automated UI tests and a web build. It is honest about what it cannot do:
 * no FFmpeg, no real frame-rate probe, and NO binary YPT (that needs the desktop bridge).
 */
import { checkIntegrity, createAsset, parseProject, sanitizeFilename, type Asset, type Clip, type Project } from '@vfxforge/core';
import { decodeApngFrames, decodePng, sha256Hex, sniffBytes, type RgbaImage } from '@vfxforge/media';
import { generateSpriteFrames } from '@vfxforge/particles';
import { unzipSync, zipSync } from 'fflate';
import type { ExtractOptions, FrameService, Platform, ProjectStore, ProjectSummary } from './types';

const MAX_BROWSER_BYTES = 1024 * 1024 * 1024;

/* --------------------------------------------------------------- IndexedDB */

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('vfxforge', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const s of ['assets', 'projects', 'autosave']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open the local database'));
  });
  return dbPromise;
}

async function idb<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise<T>((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/* ----------------------------------------------------------------- helpers */

const urlCache = new Map<string, string>();

async function loadBlob(asset: Asset): Promise<Blob> {
  const blob = await idb<Blob | undefined>('assets', 'readonly', (s) => s.get(asset.sha256));
  if (!blob) throw new Error(`The stored copy of "${asset.name}" is missing from this browser's storage. Re-import it.`);
  return blob;
}

async function bitmapFrom(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  } catch {
    throw new Error('The browser could not decode this image (it may be corrupt or use an unsupported codec).');
  }
}

function imageDataOf(source: CanvasImageSource, w: number, h: number): RgbaImage {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: true })!;
  ctx.drawImage(source, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: new Uint8ClampedArray(d.data.buffer.slice(0)) };
}

/** Target size from the clip's extraction settings, matching FFmpeg's `force_original_aspect_ratio=decrease`. */
function targetSize(srcW: number, srcH: number, clip: Clip): { w: number; h: number } {
  const { width, height, keepAspect } = clip.extract;
  if (width && height) {
    if (!keepAspect) return { w: width, h: height };
    const s = Math.min(width / srcW, height / srcH);
    return { w: Math.max(1, Math.round(srcW * s)), h: Math.max(1, Math.round(srcH * s)) };
  }
  if (width) return { w: width, h: keepAspect ? Math.max(1, Math.round((srcH * width) / srcW)) : srcH };
  if (height) return { w: keepAspect ? Math.max(1, Math.round((srcW * height) / srcH)) : srcW, h: height };
  return { w: srcW, h: srcH };
}

/** True when any pixel of a (down-scaled) frame is not fully opaque. Reads decoded pixels, so it is about the actual picture, not the container. */
function hasTransparency(source: CanvasImageSource, w: number, h: number): boolean {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = Math.max(1, Math.round((size * h) / Math.max(1, w)));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;
  ctx.drawImage(source, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i]! < 250) return true;
  return false;
}

function once(target: EventTarget, ok: string, bad = 'error', ms = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => cleanup(new Error(`Timed out waiting for the video (${ok}).`)), ms);
    const onOk = () => cleanup();
    const onBad = () => cleanup(new Error('The browser could not decode this video (unsupported codec or corrupt file).'));
    const cleanup = (err?: Error) => {
      clearTimeout(t);
      target.removeEventListener(ok, onOk);
      target.removeEventListener(bad, onBad);
      err ? reject(err) : resolve();
    };
    target.addEventListener(ok, onOk, { once: true });
    target.addEventListener(bad, onBad, { once: true });
  });
}

async function loadVideo(url: string): Promise<HTMLVideoElement> {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.crossOrigin = 'anonymous';
  v.src = url;
  await once(v, 'loadeddata');
  return v;
}

async function extractVideo(url: string, clip: Clip, opts: ExtractOptions): Promise<RgbaImage[]> {
  const video = await loadVideo(url);
  try {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (duration <= 0) throw new Error('The video has no readable duration.');
    const { startSec, endSec, fps, frameSkip, maxFrames } = clip.extract;
    const end = Math.min(endSec ?? duration, duration);
    if (startSec >= end) throw new Error(`The start time (${startSec.toFixed(2)} s) is beyond the end of the video (${duration.toFixed(2)} s).`);
    const step = (frameSkip + 1) / fps;
    const times: number[] = [];
    for (let t = startSec; t < end - 1e-6 && times.length < maxFrames; t += step) times.push(Math.min(t, Math.max(0, duration - 0.001)));
    const { w, h } = targetSize(video.videoWidth, video.videoHeight, clip);
    const frames: RgbaImage[] = [];
    for (let i = 0; i < times.length; i++) {
      if (opts.signal?.aborted) throw new DOMException('Extraction cancelled', 'AbortError');
      video.currentTime = times[i]!;
      await once(video, 'seeked');
      frames.push(imageDataOf(video, w, h));
      opts.onProgress?.(i + 1, times.length);
    }
    if (clip.extract.interpolation !== 'none') opts.onNote?.('Frame interpolation needs FFmpeg (desktop app); the browser extracted plain frames instead.');
    return frames;
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

/** Animated GIF / WebP / APNG via WebCodecs `ImageDecoder` (Chromium) or fast-png (APNG only). */
async function extractAnimated(blob: Blob, mime: string, clip: Clip, opts: ExtractOptions): Promise<RgbaImage[]> {
  const out: RgbaImage[] = [];
  const Decoder = (globalThis as unknown as { ImageDecoder?: new (init: { data: ReadableStream | ArrayBuffer; type: string }) => { tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } | null }; decode(o: { frameIndex: number }): Promise<{ image: VideoFrame }>; close(): void } }).ImageDecoder;
  if (Decoder) {
    const dec = new Decoder({ data: await blob.arrayBuffer(), type: mime });
    await dec.tracks.ready;
    const total = dec.tracks.selectedTrack?.frameCount ?? 1;
    const stride = clip.extract.frameSkip + 1;
    for (let i = 0; i < total && out.length < clip.extract.maxFrames; i += stride) {
      if (opts.signal?.aborted) throw new DOMException('Extraction cancelled', 'AbortError');
      const { image } = await dec.decode({ frameIndex: i });
      const { w, h } = targetSize(image.displayWidth, image.displayHeight, clip);
      out.push(imageDataOf(image, w, h));
      image.close();
      opts.onProgress?.(out.length, Math.min(clip.extract.maxFrames, Math.ceil(total / stride)));
    }
    dec.close();
    return out;
  }
  if (mime === 'image/apng' || mime === 'image/png') {
    const anim = decodeApngFrames(new Uint8Array(await blob.arrayBuffer()));
    return anim.frames.slice(0, clip.extract.maxFrames);
  }
  throw new Error('This browser cannot decode animated images of this type. Use the desktop app (FFmpeg) or convert the animation to a video.');
}

class BrowserFrames implements FrameService {
  async getFrames(clip: Clip, project: Project, signal?: AbortSignal): Promise<RgbaImage[]> {
    return this.extract(clip, project, { signal });
  }

  async extract(clip: Clip, project: Project, opts: ExtractOptions = {}): Promise<RgbaImage[]> {
    if (clip.generator) return generateSpriteFrames(clip.generator, (d, t) => opts.onProgress?.(d, t));
    if (!clip.assetId) throw new Error(`Clip "${clip.name}" has no source media.`);
    const asset = project.assets[clip.assetId];
    if (!asset) throw new Error(`Clip "${clip.name}" refers to media that is no longer in the project.`);
    const blob = await loadBlob(asset);
    if (asset.kind === 'video') {
      const url = URL.createObjectURL(blob);
      try {
        return await extractVideo(url, clip, opts);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    if (asset.kind === 'image') {
      if (asset.mime === 'image/gif' || asset.mime === 'image/webp' || asset.mime === 'image/apng') {
        try {
          const frames = await extractAnimated(blob, asset.mime, clip, opts);
          if (frames.length) return frames;
        } catch (e) {
          if (asset.mime === 'image/apng' || (e instanceof DOMException && e.name === 'AbortError')) throw e;
          // a still GIF/WebP: fall through to the single-image path
        }
      }
      if (asset.mime === 'image/png') {
        const bytes = new Uint8Array(await blob.arrayBuffer());
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
    throw new Error(`"${asset.name}" is a 3D model, not frame media.`);
  }
}

/* ----------------------------------------------------------------- storage */

class BrowserProjects implements ProjectStore {
  async list(): Promise<ProjectSummary[]> {
    const d = await db();
    return new Promise((resolve, reject) => {
      const out: ProjectSummary[] = [];
      const req = d.transaction('projects', 'readonly').objectStore('projects').openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve(out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)));
        const p = c.value as Project;
        out.push({ id: p.id, name: p.name, modifiedAt: p.modifiedAt });
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async save(project: Project): Promise<void> {
    const json = JSON.parse(JSON.stringify(project)) as unknown;
    const checked = parseProject(json);
    if (!checked.ok) throw new Error('Refusing to save an invalid project: ' + checked.errors.slice(0, 3).join('; '));
    await idb('projects', 'readwrite', (s) => s.put(json, project.id));
    await this.clearAutosave(project.id);
  }

  async open(id: string): Promise<Project> {
    const raw = await idb<unknown>('projects', 'readonly', (s) => s.get(id));
    if (!raw) throw new Error('That project no longer exists in this browser.');
    const r = parseProject(raw);
    if (!r.ok) throw new Error('The stored project is damaged: ' + r.errors.slice(0, 3).join('; '));
    return r.project;
  }

  async remove(id: string): Promise<void> {
    await idb('projects', 'readwrite', (s) => s.delete(id));
    await this.clearAutosave(id);
  }

  async exportBundle(project: Project): Promise<Uint8Array> {
    const files: Record<string, Uint8Array> = { 'project.json': new TextEncoder().encode(JSON.stringify(project, null, 2)) };
    for (const a of Object.values(project.assets)) {
      files[a.file] = new Uint8Array(await (await loadBlob(a)).arrayBuffer());
    }
    return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, [v, { level: k.startsWith('assets/') ? 0 : 6 }] as [Uint8Array, { level: 0 | 6 }]])));
  }

  async importBundle(bytes: Uint8Array): Promise<Project> {
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
      const sniffed = sniffBytes(data.subarray(0, 8192));
      if (sniffed.category === 'unknown') throw new Error(`"${a.name}" in the bundle is not recognised media (checked its file signature).`);
      if ((await sha256Hex(data)) !== a.sha256) throw new Error(`"${a.name}" in the bundle does not match its recorded checksum; the bundle is corrupt or was modified.`);
      await idb('assets', 'readwrite', (s) => s.put(new Blob([data.slice().buffer as ArrayBuffer], { type: a.mime }), a.sha256));
    }
    const integrity = checkIntegrity(project);
    if (integrity.length) throw new Error('The bundle project is inconsistent: ' + integrity.slice(0, 3).join('; '));
    return project;
  }

  async autosave(project: Project): Promise<void> {
    await idb('autosave', 'readwrite', (s) => s.put({ at: Date.now(), project: JSON.parse(JSON.stringify(project)) }, project.id));
  }

  async recovery(id: string): Promise<Project | null> {
    const snap = await idb<{ at: number; project: unknown } | undefined>('autosave', 'readonly', (s) => s.get(id));
    if (!snap) return null;
    const saved = await idb<{ modifiedAt?: string } | undefined>('projects', 'readonly', (s) => s.get(id));
    const savedAt = saved?.modifiedAt ? Date.parse(saved.modifiedAt) : 0;
    const r = parseProject(snap.project);
    return r.ok && Date.parse(r.project.modifiedAt) > savedAt ? r.project : null;
  }

  async latestAutosave(): Promise<Project | null> {
    const d = await db();
    const best = await new Promise<{ at: number; project: unknown } | null>((resolve, reject) => {
      let top: { at: number; project: unknown } | null = null;
      const req = d.transaction('autosave', 'readonly').objectStore('autosave').openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve(top);
        const v = c.value as { at: number; project: unknown };
        if (!top || v.at > top.at) top = v;
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });
    if (!best) return null;
    const r = parseProject(best.project);
    if (!r.ok) return null;
    const saved = await idb<{ modifiedAt?: string } | undefined>('projects', 'readonly', (s) => s.get(r.project.id));
    return !saved || Date.parse(r.project.modifiedAt) > Date.parse(saved.modifiedAt ?? '') ? r.project : null;
  }

  async clearAutosave(id: string): Promise<void> {
    await idb('autosave', 'readwrite', (s) => s.delete(id));
  }
}

/* ---------------------------------------------------------------- platform */

export function createBrowserPlatform(): Platform {
  return {
    kind: 'browser',
    label: 'Browser',
    features: { ffmpeg: false, accurateProbe: false, binaryYpt: false, nativeProjects: false, interpolation: false },

    async importAsset(source, onProgress) {
      if (typeof source === 'string') throw new Error('The browser build cannot open files by path.');
      if (source.size === 0) throw new Error(`"${source.name}" is empty.`);
      if (source.size > MAX_BROWSER_BYTES) throw new Error(`"${source.name}" is larger than 1 GiB; the browser build cannot hold it in memory. Use the desktop app for very large media.`);
      const head = new Uint8Array(await source.slice(0, 8192).arrayBuffer());
      const sniffed = sniffBytes(head);
      if (sniffed.category === 'unknown') {
        throw new Error(`"${source.name}" is not a recognised image, video or 3D model. VFXForge checks the file's contents, not its extension.`);
      }
      onProgress?.(0.1);
      const bytes = new Uint8Array(await source.arrayBuffer());
      const sha = await sha256Hex(bytes);
      onProgress?.(0.6);
      await idb('assets', 'readwrite', (s) => s.put(new Blob([bytes.buffer as ArrayBuffer], { type: sniffed.mime }), sha));

      let info: Asset['info'] = null;
      if (sniffed.category === 'image') {
        const bmp = await bitmapFrom(new Blob([bytes.buffer as ArrayBuffer], { type: sniffed.mime }));
        info = { width: bmp.width, height: bmp.height, durationSec: null, fps: null, frameCount: sniffed.kind === 'gif' || sniffed.kind === 'apng' || sniffed.kind === 'webp' ? null : 1, hasAlpha: sniffed.kind !== 'jpeg' && hasTransparency(bmp, bmp.width, bmp.height), codec: sniffed.kind };
        bmp.close();
      } else if (sniffed.category === 'video') {
        const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: sniffed.mime }));
        try {
          const v = await loadVideo(url);
          info = { width: v.videoWidth, height: v.videoHeight, durationSec: Number.isFinite(v.duration) ? v.duration : null, fps: null, frameCount: null, hasAlpha: hasTransparency(v, v.videoWidth, v.videoHeight), codec: sniffed.kind };
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      onProgress?.(1);
      return createAsset({
        kind: sniffed.category === 'model' ? 'model' : sniffed.category,
        name: sanitizeFilename(source.name),
        file: `assets/${sha}.${sniffed.ext}`,
        sha256: sha,
        bytes: bytes.length,
        mime: sniffed.mime,
        info,
      });
    },

    async assetUrl(asset) {
      const hit = urlCache.get(asset.sha256);
      if (hit) return hit;
      const url = URL.createObjectURL(await loadBlob(asset));
      urlCache.set(asset.sha256, url);
      return url;
    },

    async assetBytes(asset) {
      return new Uint8Array(await (await loadBlob(asset)).arrayBuffer());
    },

    frames: new BrowserFrames(),
    projects: new BrowserProjects(),
    converter: null,

    async converterStatus() {
      return { available: false, detail: 'Binary .ypt creation needs the desktop app with the CodeWalker bridge (docs/YPT_BRIDGE.md). The browser build can export validated .ypt.xml + DDS (source-only) for CodeWalker.' };
    },

    async saveFile(name, bytes, mime) {
      const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: mime });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = sanitizeFilename(name);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      return 'saved';
    },

    async pickFiles({ accept, multiple }) {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept.join(',');
        input.multiple = !!multiple;
        input.onchange = () => resolve(Array.from(input.files ?? []));
        input.oncancel = () => resolve([]);
        input.click();
      });
    },
  };
}
