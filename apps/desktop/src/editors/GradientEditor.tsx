import { evalGradient, type Gradient, type Rgba } from '@vfxforge/core';
import { Trash2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { ColorField, NumberField } from '../components/ui';

const css = (c: Rgba) => `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${c[3]})`;

export function GradientEditor({ value, onChange }: { value: Gradient; onChange: (g: Gradient, live: boolean) => void }) {
  const bar = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState(0);
  const drag = useRef<number | null>(null);
  const stops = value.stops;
  const idx = Math.min(sel, stops.length - 1);
  const cur = stops[idx];

  const background = useMemo(() => {
    const parts: string[] = [];
    const out: Rgba = [0, 0, 0, 1];
    for (let i = 0; i <= 24; i++) {
      evalGradient(value, i / 24, out);
      parts.push(`${css(out)} ${(i / 24) * 100}%`);
    }
    return `linear-gradient(90deg, ${parts.join(', ')})`;
  }, [value]);

  const tAt = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };

  const commit = (next: Gradient, live: boolean) => onChange({ stops: [...next.stops].sort((a, b) => a.t - b.t) }, live);

  return (
    <div className="space-y-1.5">
      <div
        ref={bar}
        className="checker relative h-6 rounded-md border border-line"
        onDoubleClick={(e) => {
          const t = tAt(e.clientX);
          const out: Rgba = [1, 1, 1, 1];
          evalGradient(value, t, out);
          const next = { stops: [...stops, { t, color: [...out] as Rgba }] };
          commit(next, false);
          setSel(next.stops.length - 1);
        }}
      >
        <div className="absolute inset-0 rounded-md" style={{ background }} />
        {stops.map((s, i) => (
          <button
            key={i}
            type="button"
            aria-label={`Gradient stop ${i + 1} at ${Math.round(s.t * 100)}%`}
            className="absolute top-full -mt-1 h-4 w-3 -translate-x-1/2 cursor-grab rounded-b-sm border-2 active:cursor-grabbing"
            style={{ left: `${s.t * 100}%`, background: css([s.color[0], s.color[1], s.color[2], 1]), borderColor: i === idx ? 'var(--fg)' : 'var(--line)' }}
            onPointerDown={(e) => {
              e.stopPropagation();
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              drag.current = i;
              setSel(i);
            }}
            onPointerMove={(e) => {
              if (drag.current === null) return;
              const t = tAt(e.clientX);
              commit({ stops: stops.map((st, k) => (k === drag.current ? { ...st, t } : st)) }, true);
            }}
            onPointerUp={(e) => {
              if (drag.current === null) return;
              const t = tAt(e.clientX);
              commit({ stops: stops.map((st, k) => (k === drag.current ? { ...st, t } : st)) }, false);
              drag.current = null;
            }}
          />
        ))}
      </div>
      <div className="h-3" />
      {cur && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <NumberField label="t" value={cur.t} min={0} max={1} step={0.01} className="w-[88px]" onChange={(t, live) => commit({ stops: stops.map((s, i) => (i === idx ? { ...s, t } : s)) }, live)} />
            <div className="min-w-0 flex-1">
              <ColorField alpha value={cur.color} onChange={(c, live) => commit({ stops: stops.map((s, i) => (i === idx ? { ...s, color: c as Rgba } : s)) }, live)} />
            </div>
            <button
              type="button"
              aria-label="Delete stop"
              disabled={stops.length <= 1}
              onClick={() => {
                commit({ stops: stops.filter((_, i) => i !== idx) }, false);
                setSel(0);
              }}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-danger disabled:opacity-30"
            >
              <Trash2 className="size-3.5" aria-hidden />
            </button>
          </div>
        </div>
      )}
      <p className="text-[10.5px] text-dim">Double-click the bar to add a stop; drag stops to move them.</p>
    </div>
  );
}
