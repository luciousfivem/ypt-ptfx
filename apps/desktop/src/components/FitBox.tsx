import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn';

/** Centres its child in the largest box of the given aspect ratio that fits the available space (never distorts). */
export function FitBox({ aspect, children, className }: { aspect: number; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      if (cw < 2 || ch < 2 || !(aspect > 0)) return setBox(null);
      const w = Math.min(cw, ch * aspect);
      setBox({ w: Math.floor(w), h: Math.floor(w / aspect) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect]);
  return (
    <div ref={ref} className={cn('flex size-full items-center justify-center', className)}>
      {box && (
        <div className="relative" style={{ width: box.w, height: box.h }}>
          {children}
        </div>
      )}
    </div>
  );
}
