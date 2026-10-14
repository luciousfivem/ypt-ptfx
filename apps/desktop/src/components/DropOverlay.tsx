import { UploadCloud } from 'lucide-react';
import { useEffect, useState } from 'react';
import { importFiles } from '../services/actions';
import { maybeSvc } from '../services/app';

/** Window-wide drag & drop import. Files are validated by content in the platform layer, never by extension. */
export function DropOverlay() {
  const [active, setActive] = useState(false);
  useEffect(() => {
    // desktop: the native window reports drops (the web engine's own drag & drop never fires there)
    const platform = maybeSvc()?.platform;
    if (platform?.onFilesDropped) {
      let off: (() => void) | undefined;
      let dead = false;
      void platform.onFilesDropped((paths) => void importFiles(paths), setActive).then((u) => (dead ? u() : (off = u)));
      return () => {
        dead = true;
        off?.();
      };
    }
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setActive(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setActive(false);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setActive(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) void importFiles(files);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);
  if (!active) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-[150] flex items-center justify-center bg-black/55 backdrop-blur-sm" aria-hidden>
      <div className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-accent bg-panel/90 px-14 py-10">
        <UploadCloud className="size-10 text-accent" />
        <p className="text-[15px] font-semibold">Drop to import</p>
        <p className="text-[12px] text-muted">Video, GIF, image or 3D model</p>
      </div>
    </div>
  );
}
