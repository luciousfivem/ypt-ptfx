/**
 * Browser-side media helpers shared by the browser platform and the desktop platform
 * (still images, WebP animations and alpha detection are decoded by the web engine in both).
 */
import type { Clip } from '@vfxforge/core';
import { decodeApngFrames, type RgbaImage } from '@vfxforge/media';
import type { ExtractOptions } from './types';

export async function bitmapFrom(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  } catch {
    throw new Error('The browser could not decode this image (it may be corrupt or use an unsupported codec).');
  }
}

export function imageDataOf(source: CanvasImageSource, w: number, h: number): RgbaImage {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: true })!;
  ctx.drawImage(source, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: new Uint8ClampedArray(d.data.buffer.slice(0)) };
}

/** Target size from the clip's extraction settings, matching FFmpeg's `force_original_aspect_ratio=decrease`. */
export function targetSize(srcW: number, srcH: number, clip: Clip): { w: number; h: number } {
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
export function hasTransparency(source: CanvasImageSource, w: number, h: number): boolean {
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

export function once(target: EventTarget, ok: string, bad = 'error', ms = 15000): Promise<void> {
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

export async function loadVideo(url: string): Promise<HTMLVideoElement> {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.crossOrigin = 'anonymous';
  v.src = url;
  await once(v, 'loadeddata');
  return v;
}

/** Animated GIF / WebP / APNG via WebCodecs `ImageDecoder` (Chromium) or fast-png (APNG only). */
export async function extractAnimated(blob: Blob, mime: string, clip: Clip, opts: ExtractOptions): Promise<RgbaImage[]> {
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

