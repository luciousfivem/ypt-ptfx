/**
 * Curve editor: drag keys, double-click to add, Delete/right-click to remove, per-key easing.
 * Pointer events with capture keep drags working outside the SVG; every drag is a "live" change
 * (coalesced into one undo step by the caller) followed by a final commit.
 */
import { EASES, evalCurve, normaliseCurve, type Curve, type Ease } from '@vfxforge/core';
import { Trash2 } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';
import { Button, NumberField, SelectField } from '../components/ui';

const W = 260;
const H = 96;
const PAD = 8;

export interface CurveEditorProps {
  value: Curve;
  onChange: (curve: Curve, live: boolean) => void;
  yMin?: number;
  yMax?: number;
  /** What the horizontal axis means, shown under the plot. */
  xLabel?: string;
  yLabel?: string;
  presets?: boolean;
}

const PRESETS: Array<{ label: string; keys: Curve['keys'] }> = [
  { label: 'Flat', keys: [{ t: 0, v: 1, ease: 'linear' }, { t: 1, v: 1, ease: 'linear' }] },
  { label: 'Fade out', keys: [{ t: 0, v: 1, ease: 'smooth' }, { t: 1, v: 0, ease: 'linear' }] },
  { label: 'Fade in', keys: [{ t: 0, v: 0, ease: 'smooth' }, { t: 1, v: 1, ease: 'linear' }] },
  { label: 'Bell', keys: [{ t: 0, v: 0, ease: 'smooth' }, { t: 0.5, v: 1, ease: 'smooth' }, { t: 1, v: 0, ease: 'linear' }] },
  { label: 'Pop', keys: [{ t: 0, v: 0.2, ease: 'easeOut' }, { t: 0.15, v: 1, ease: 'smooth' }, { t: 1, v: 0.6, ease: 'linear' }] },
];

export function CurveEditor({ value, onChange, yMin = 0, yMax = 1, xLabel = 'life', yLabel, presets = true }: CurveEditorProps) {
  const id = useId();
  const svg = useRef<SVGSVGElement>(null);
  const [sel, setSel] = useState(0);
  const drag = useRef<{ index: number } | null>(null);
  const span = yMax - yMin || 1;

  const toX = (t: number) => PAD + t * (W - PAD * 2);
  const toY = (v: number) => H - PAD - ((v - yMin) / span) * (H - PAD * 2);
  const fromPointer = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const py = ((e.clientY - r.top) / r.height) * H;
    return {
      t: Math.min(1, Math.max(0, (px - PAD) / (W - PAD * 2))),
      v: Math.min(yMax, Math.max(yMin, yMin + ((H - PAD - py) / (H - PAD * 2)) * span)),
    };
  };

  const path = useMemo(() => {
    const pts: string[] = [];
    for (let i = 0; i <= 80; i++) {
      const t = i / 80;
      pts.push(`${i === 0 ? 'M' : 'L'}${toX(t).toFixed(1)},${toY(evalCurve(value, t)).toFixed(1)}`);
    }
    return pts.join(' ');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, yMin, yMax]);

  const keys = value.keys;
  const idx = Math.min(sel, keys.length - 1);
  const cur = keys[idx];

  const emit = (next: Curve, live: boolean) => onChange(next, live);

  const moveKey = (index: number, t: number, v: number, live: boolean) => {
    const keysCopy = keys.map((k) => ({ ...k }));
    keysCopy[index] = { ...keysCopy[index]!, t, v };
    const sorted = normaliseCurve({ keys: keysCopy });
    // keep the dragged key selected after re-sorting
    const moved = sorted.keys.findIndex((k) => k.t === t && k.v === v);
    if (moved >= 0) {
      drag.current = drag.current ? { index: moved } : null;
      setSel(moved);
    }
    emit(sorted, live);
  };

  const removeKey = (index: number) => {
    if (keys.length <= 1) return;
    emit({ keys: keys.filter((_, i) => i !== index) }, false);
    setSel(Math.max(0, index - 1));
  };

  return (
    <div className="space-y-1.5">
      <svg
        ref={svg}
        viewBox={`0 0 ${W} ${H}`}
        role="application"
        aria-label={`Curve editor${yLabel ? `: ${yLabel}` : ''}. Double-click to add a key, drag keys to move, Delete removes the selected key.`}
        tabIndex={0}
        className="w-full touch-none rounded-md border border-line bg-panel2"
        onDoubleClick={(e) => {
          const { t, v } = fromPointer(e);
          const next = normaliseCurve({ keys: [...keys, { t, v, ease: 'smooth' as Ease }] });
          emit(next, false);
          setSel(next.keys.findIndex((k) => k.t === t));
        }}
        onKeyDown={(e) => {
          if ((e.key === 'Delete' || e.key === 'Backspace') && cur) {
            e.preventDefault();
            removeKey(idx);
          }
        }}
      >
        <defs>
          <pattern id={`${id}-g`} width={(W - PAD * 2) / 4} height={(H - PAD * 2) / 2} patternUnits="userSpaceOnUse" x={PAD} y={PAD}>
            <path d={`M ${(W - PAD * 2) / 4} 0 L 0 0 0 ${(H - PAD * 2) / 2}`} fill="none" stroke="var(--line-soft)" strokeWidth="1" />
          </pattern>
        </defs>
        <rect x={PAD} y={PAD} width={W - PAD * 2} height={H - PAD * 2} fill={`url(#${id}-g)`} />
        {yMin < 0 && yMax > 0 && <line x1={PAD} x2={W - PAD} y1={toY(0)} y2={toY(0)} stroke="var(--line)" strokeDasharray="3 3" />}
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
        {keys.map((k, i) => (
          <circle
            key={i}
            cx={toX(k.t)}
            cy={toY(k.v)}
            r={i === idx ? 5.5 : 4.5}
            fill={i === idx ? 'var(--fg)' : 'var(--panel)'}
            stroke="var(--accent)"
            strokeWidth="2"
            className="cursor-grab active:cursor-grabbing"
            onPointerDown={(e) => {
              e.stopPropagation();
              (e.currentTarget as SVGCircleElement).setPointerCapture(e.pointerId);
              drag.current = { index: i };
              setSel(i);
            }}
            onPointerMove={(e) => {
              if (!drag.current) return;
              const { t, v } = fromPointer(e);
              moveKey(drag.current.index, t, v, true);
            }}
            onPointerUp={(e) => {
              if (!drag.current) return;
              const { t, v } = fromPointer(e);
              moveKey(drag.current.index, t, v, false);
              drag.current = null;
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              removeKey(i);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          />
        ))}
      </svg>
      <div className="flex items-center justify-between text-[10px] text-dim">
        <span>{xLabel} →</span>
        <span>{yLabel ?? ''} {yMin}…{yMax}</span>
      </div>
      {cur && (
        <div className="grid grid-cols-[1fr_1fr_1.3fr_auto] items-center gap-1">
          <NumberField label="t" value={cur.t} min={0} max={1} step={0.01} onChange={(t, live) => moveKey(idx, t, cur.v, live)} />
          <NumberField label="v" value={cur.v} min={yMin} max={yMax} step={span / 100} precision={3} onChange={(v, live) => moveKey(idx, cur.t, v, live)} />
          <SelectField
            label="Easing of the segment after this key"
            value={cur.ease}
            options={EASES.map((e) => ({ value: e, label: e }))}
            onChange={(ease) => emit({ keys: keys.map((k, i) => (i === idx ? { ...k, ease } : k)) }, false)}
          />
          <button type="button" aria-label="Delete key" disabled={keys.length <= 1} onClick={() => removeKey(idx)} className="flex size-7 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-danger disabled:opacity-30">
            <Trash2 className="size-3.5" aria-hidden />
          </button>
        </div>
      )}
      {presets && (
        <div className="flex flex-wrap gap-1">
          {PRESETS.map((p) => (
            <Button key={p.label} size="xs" variant="ghost" onClick={() => emit({ keys: p.keys.map((k) => ({ ...k, v: yMin + k.v * span })) }, false)}>
              {p.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
