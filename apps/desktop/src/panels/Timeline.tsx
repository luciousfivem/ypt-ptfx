import { startsLooped, type Emitter } from '@vfxforge/core';
import { Pause, Play, RefreshCcw } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { EmptyState, IconButton, PanelFrame, SelectField } from '../components/ui';
import { cn } from '../lib/cn';
import { useProject } from '../state/project';
import { runtimeCommands, useRuntime } from '../state/runtime';
import { useUi } from '../state/ui';

interface Lane {
  effectId: string;
  effectName: string;
  em: Emitter;
}

/** Time span an emitter occupies: [start, emissionEnd, lastParticleDies]. */
function spans(em: Emitter): [number, number, number] {
  const start = em.emission.startDelay;
  const emissionEnd = start + (em.emission.mode === 'oneShot' ? 0.05 : em.emission.duration);
  return [start, emissionEnd, emissionEnd + em.emission.lifetime.max];
}

export function Timeline() {
  const effects = useProject((s) => s.project.effects);
  const selection = useUi((s) => s.selection);
  const select = useUi((s) => s.select);
  const playing = useRuntime((s) => s.playing);
  const speed = useRuntime((s) => s.speed);
  const lanes = useMemo<Lane[]>(() => Object.values(effects).flatMap((fx) => fx.emitters.map((em) => ({ effectId: fx.id, effectName: fx.name, em }))), [effects]);
  const total = useMemo(() => {
    let t = 3;
    for (const l of lanes) {
      const [, end, die] = spans(l.em);
      t = Math.max(t, startsLooped(l.em) ? end + l.em.emission.lifetime.max : die);
    }
    return Math.ceil(Math.min(30, t));
  }, [lanes]);

  const head = useRef<HTMLDivElement>(null);
  const readout = useRef<HTMLSpanElement>(null);
  const area = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = useRuntime.getState().viewport;
      const t = v ? v.time % total : 0;
      if (head.current) head.current.style.left = `${(t / total) * 100}%`;
      if (readout.current) readout.current.textContent = `${t.toFixed(2)} s`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [total]);

  const scrub = (clientX: number) => {
    const r = area.current?.getBoundingClientRect();
    if (!r) return;
    const t = Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * total;
    useRuntime.getState().viewport?.seek(t);
  };

  return (
    <PanelFrame
      title="Timeline"
      bodyClassName="flex min-h-0 flex-col overflow-hidden"
      actions={
        <>
          <span ref={readout} className="mr-1 font-mono text-[11px] text-muted" aria-live="off">0.00 s</span>
          <IconButton label={playing ? 'Pause (Space)' : 'Play (Space)'} onClick={runtimeCommands.toggle}>{playing ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}</IconButton>
          <IconButton label="Restart" onClick={runtimeCommands.restart}><RefreshCcw className="size-4" aria-hidden /></IconButton>
          <div className="w-[84px]">
            <SelectField
              label="Playback speed"
              value={String(speed)}
              options={[0.25, 0.5, 1, 2].map((v) => ({ value: String(v), label: `${v}×` }))}
              onChange={(v) => runtimeCommands.speed(Number(v))}
            />
          </div>
        </>
      }
    >
      {lanes.length === 0 ? (
        <EmptyState title="Nothing to time yet">Emitters appear here with their start delay, emission window and particle lifetime.</EmptyState>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[168px_1fr] overflow-auto">
          <div className="sticky left-0 z-10 border-r border-lines bg-panel">
            <div className="h-6 border-b border-lines" />
            {lanes.map((l) => (
              <button
                key={l.em.id}
                type="button"
                onClick={() => select({ kind: 'emitter', effectId: l.effectId, id: l.em.id })}
                className={cn('flex h-7 w-full items-center gap-1.5 truncate border-b border-lines px-2 text-left text-[11.5px] hover:bg-raised', selection.kind === 'emitter' && selection.id === l.em.id && 'bg-accent/20', !l.em.enabled && 'text-dim line-through')}
              >
                <span className="size-2 shrink-0 rounded-full" style={{ background: l.em.blend === 'additive' ? 'var(--accent)' : 'var(--accent-2)' }} />
                <span className="truncate">{l.em.name}</span>
              </button>
            ))}
          </div>
          <div
            ref={area}
            className="relative min-w-[360px] cursor-col-resize"
            onPointerDown={(e) => {
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              scrub(e.clientX);
            }}
            onPointerMove={(e) => e.buttons === 1 && scrub(e.clientX)}
          >
            <div className="relative h-6 border-b border-lines">
              {Array.from({ length: total + 1 }, (_, i) => (
                <span key={i} className="absolute top-0 h-full border-l border-lines pl-1 font-mono text-[9.5px] leading-6 text-dim" style={{ left: `${(i / total) * 100}%` }}>
                  {i}s
                </span>
              ))}
            </div>
            {lanes.map((l) => {
              const [start, end, die] = spans(l.em);
              const looped = startsLooped(l.em);
              const x = (t: number) => `${(Math.min(total, t) / total) * 100}%`;
              const bursts: number[] = [];
              if (l.em.emission.mode === 'burst') for (let t = start; t < end && bursts.length < 64; t += l.em.emission.interval) bursts.push(t);
              if (l.em.emission.mode === 'oneShot') bursts.push(start);
              return (
                <div key={l.em.id} className={cn('relative h-7 border-b border-lines', !l.em.enabled && 'opacity-40')}>
                  <div className="absolute top-1.5 h-4 rounded-sm bg-accent/25" style={{ left: x(start), width: `calc(${x(looped ? total : die)} - ${x(start)})` }} title="Particle lifetime tail" />
                  <div className="absolute top-1.5 h-4 rounded-sm bg-accent" style={{ left: x(start), width: `calc(${x(looped ? total : end)} - ${x(start)})` }} title={looped ? 'Loops until the weapon is put away' : 'Emission window'} />
                  {looped && <span className="absolute top-1.5 text-[10px] leading-4 text-white" style={{ left: `calc(${x(start)} + 4px)` }}>∞</span>}
                  {bursts.map((t, i) => (
                    <span key={i} className="absolute top-2 size-2.5 -translate-x-1/2 rotate-45 bg-white" style={{ left: x(t) }} />
                  ))}
                </div>
              );
            })}
            <div ref={head} className="pointer-events-none absolute inset-y-0 z-10 w-px bg-accent2 shadow-[0_0_6px_var(--accent-2)]" style={{ left: '0%' }}>
              <span className="absolute -left-1 top-0 size-2 rotate-45 bg-accent2" />
            </div>
          </div>
        </div>
      )}
    </PanelFrame>
  );
}
