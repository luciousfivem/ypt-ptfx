import type { RgbaImage } from '@vfxforge/media';
import { useEffect, useRef } from 'react';
import { cn } from '../lib/cn';

/** Draws a straight-alpha RGBA image. Transparency shows whatever is behind the canvas (e.g. the checkerboard). */
export function RgbaCanvas({ image, className, pixelated = false, label }: { image: RgbaImage | null | undefined; className?: string; pixelated?: boolean; label?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !image) return;
    if (c.width !== image.width || c.height !== image.height) {
      c.width = image.width;
      c.height = image.height;
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data.buffer as ArrayBuffer, image.data.byteOffset, image.data.byteLength), image.width, image.height), 0, 0);
  }, [image]);
  return <canvas ref={ref} role={label ? 'img' : undefined} aria-label={label} className={cn('block max-h-full max-w-full', pixelated && '[image-rendering:pixelated]', className)} />;
}
