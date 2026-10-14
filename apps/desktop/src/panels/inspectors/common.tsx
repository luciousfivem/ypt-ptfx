import type { Clip, Emitter, Sheet } from '@vfxforge/core';
import type { Draft } from 'immer';
import { Badge, Tip } from '../../components/ui';
import { editProject } from '../../state/project';

export const patchClip = (id: string, label: string, key: string, fn: (c: Draft<Clip>) => void) =>
  editProject(label, (d) => {
    const c = d.clips[id];
    if (c) fn(c);
  }, { coalesceKey: `clip:${id}:${key}` });

export const patchSheet = (id: string, label: string, key: string, fn: (s: Draft<Sheet>) => void) =>
  editProject(label, (d) => {
    const s = d.sheets[id];
    if (s) fn(s);
  }, { coalesceKey: `sheet:${id}:${key}` });

export const patchEmitter = (effectId: string, emitterId: string, label: string, key: string, fn: (e: Draft<Emitter>) => void) =>
  editProject(label, (d) => {
    const e = d.effects[effectId]?.emitters.find((x) => x.id === emitterId);
    if (e) fn(e);
  }, { coalesceKey: `em:${emitterId}:${key}` });

type Fidelity = 'preview-only' | 'approximated' | 'unsupported';

const FIDELITY: Record<Fidelity, { tone: 'neutral' | 'warn' | 'danger'; label: string }> = {
  'preview-only': { tone: 'neutral', label: 'preview only' },
  approximated: { tone: 'warn', label: 'approximated' },
  unsupported: { tone: 'danger', label: 'not exported' },
};

/** Marks a control whose in-game behaviour differs from (or is absent in) the preview. Text mirrors the exporter's own mapping notes. */
export function FidelityTag({ kind, children }: { kind: Fidelity; children: string }) {
  const f = FIDELITY[kind];
  return (
    <Tip label={children} side="left">
      <span>
        <Badge tone={f.tone} className="cursor-help">
          {f.label}
        </Badge>
      </span>
    </Tip>
  );
}

export function Note({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'warn' | 'danger' | 'ok' }) {
  const color = { muted: 'text-dim', warn: 'text-warn', danger: 'text-danger', ok: 'text-ok' }[tone];
  return <p className={`text-[10.5px] leading-snug ${color}`}>{children}</p>;
}
