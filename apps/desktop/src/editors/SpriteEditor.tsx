import { PRESET_GRIDS } from '@vfxforge/core';
import { arrangeSequence } from '@vfxforge/media';
import { ChevronLeft, ChevronRight, Copy, Download, FileImage, Pause, Play, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, EmptyState, IconButton, NumberField, PanelFrame, Progress, Segmented } from '../components/ui';
import { FitBox } from '../components/FitBox';
import { RgbaCanvas } from '../components/RgbaCanvas';
import { cn } from '../lib/cn';
import { pickAndImport } from '../services/actions';
import { svc } from '../services/app';
import { useDerived } from '../state/derived';
import { editProject, useProject } from '../state/project';
import { toast, useUi } from '../state/ui';

type Compare = 'after' | 'before' | 'split';
type Backdrop = 'checker' | 'black' | 'white';

const BACKDROP: Record<Backdrop, string> = { checker: 'checker checker-anim', black: 'bg-black', white: 'bg-white' };

/** The sheet the editor is working on: the selected one, the first sheet of the selected clip, or the first sheet. */
function useActiveSheetId(): string | null {
  const selection = useUi((s) => s.selection);
  const sheets = useProject((s) => s.project.sheets);
  const emitterSheet = useProject((s) => (selection.kind === 'emitter' ? s.project.effects[selection.effectId]?.emitters.find((e) => e.id === selection.id)?.sheetId : null));
  return useMemo(() => {
    if (selection.kind === 'sheet' && sheets[selection.id]) return selection.id;
    if (selection.kind === 'clip') {
      const s = Object.values(sheets).find((x) => x.clipId === selection.id);
      if (s) return s.id;
    }
    if (emitterSheet && sheets[emitterSheet]) return emitterSheet;
    return Object.keys(sheets)[0] ?? null;
  }, [selection, sheets, emitterSheet]);
}

export function SpriteEditor() {
  const sheetId = useActiveSheetId();
  const sheet = useProject((s) => (sheetId ? s.project.sheets[sheetId] : undefined));
  const clip = useProject((s) => (sheet ? s.project.clips[sheet.clipId] : undefined));
  const st = useDerived((s) => (sheetId ? s.sheets[sheetId] : undefined));
  const preview = st?.preview ?? null;
  const [compare, setCompare] = useState<Compare>('after');
  const [backdrop, setBackdrop] = useState<Backdrop>('checker');
  const [playing, setPlaying] = useState(true);
  const [pos, setPos] = useState(0);
  const [split, setSplit] = useState(0.5);
  const [listSel, setListSel] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const select = useUi((s) => s.select);

  /* the flipbook sequence: indices into preview.frames, holds expanded exactly as the atlas builder does */
  const seq = useMemo(() => {
    if (!preview) return [] as number[];
    const out: number[] = [];
    preview.frames.forEach((_, i) => {
      const reps = Math.max(1, Math.round(preview.durations[i] ?? 1));
      for (let r = 0; r < reps; r++) out.push(i);
    });
    return out;
  }, [preview]);

  /* which raw frame each output frame came from (for before/after) */
  const srcOf = useMemo(() => {
    if (!preview || !clip) return [] as number[];
    try {
      return arrangeSequence(
        preview.base.map((_, i) => i),
        clip.frames,
        clip.playback,
      ).items;
    } catch {
      return [];
    }
  }, [preview, clip]);

  useEffect(() => {
    if (!playing || !preview || seq.length < 2) return;
    const fps = Math.max(0.5, preview.fps);
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const tick = (t: number) => {
      acc += (t - last) / 1000;
      last = t;
      const step = Math.floor(acc * fps);
      if (step > 0) {
        acc -= step / fps;
        setPos((p) => (p + step) % seq.length);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, preview, seq.length]);

  const cur = seq.length ? seq[pos % seq.length]! : 0;
  const after = preview?.frames[cur];
  const before = preview ? preview.source[srcOf[cur] ?? cur] : undefined;

  if (!sheet || !clip) {
    return (
      <PanelFrame title="Sprite Editor">
        <EmptyState icon={<FileImage className="size-9" aria-hidden />} title="No spritesheet yet">
          Import an MP4, GIF or image to turn it into an animated spritesheet, or add a preset from the library.
          <div className="mt-3 flex justify-center gap-2">
            <Button variant="primary" onClick={() => void pickAndImport()}>Import media…</Button>
            <Button onClick={() => useUi.getState().setLeftTab('presets')}>Browse presets</Button>
          </div>
        </EmptyState>
      </PanelFrame>
    );
  }

  const list = clip.frames ?? (preview ? preview.base.map((_, i) => ({ src: i, hold: 1 })) : []);
  const setList = (next: Array<{ src: number; hold: number }> | null, label: string) =>
    editProject(label, (d) => {
      const c = d.clips[clip.id];
      if (c) c.frames = next;
    }, { coalesceKey: `clip:${clip.id}:frames` });
  const li = Math.min(listSel, Math.max(0, list.length - 1));

  const exportFile = async (kind: 'png' | 'dds') => {
    const { engine, platform } = svc();
    const project = useProject.getState().project;
    setBusy(kind);
    try {
      const r = await engine.exportSheet(project, sheet.id);
      const bytes = kind === 'png' ? r.png : r.dds;
      const name = kind === 'png' ? `${sheet.textureName}.png` : r.ddsFileName;
      const res = await platform.saveFile(name, bytes, kind === 'png' ? 'image/png' : 'image/vnd.ms-dds');
      if (res === 'saved') toast('ok', `${name} written (${(bytes.byteLength / 1024).toFixed(0)} KiB, ${r.frameCount} frames).`);
      for (const w of r.warnings) toast('warn', w);
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <PanelFrame
      title={`Sprite Editor — ${sheet.name}`}
      bodyClassName="flex flex-col overflow-hidden"
      actions={
        <>
          <Button size="xs" variant="ghost" onClick={() => select({ kind: 'clip', id: clip.id })}>Clip settings</Button>
          <Button size="xs" variant="ghost" onClick={() => select({ kind: 'sheet', id: sheet.id })}>Sheet settings</Button>
          <Button size="xs" loading={busy === 'png'} icon={<Download className="size-3" aria-hidden />} onClick={() => void exportFile('png')} disabled={!preview}>PNG</Button>
          <Button size="xs" loading={busy === 'dds'} icon={<Download className="size-3" aria-hidden />} onClick={() => void exportFile('dds')} disabled={!preview}>DDS</Button>
        </>
      }
    >
      {st && (st.status === 'extracting' || st.status === 'processing') && (
        <div className="px-3 pt-2"><Progress value={st.progress} label={st.status === 'extracting' ? 'Extracting frames' : 'Processing'} /></div>
      )}
      {st?.status === 'error' && (
        <div className="m-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[11.5px] text-danger" role="alert">
          {st.error}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 p-2 lg:grid-cols-2">
        {/* animation preview */}
        <section className="flex min-h-0 flex-col rounded-lg border border-lines bg-panel2/40" aria-label="Animation preview">
          <header className="flex flex-wrap items-center gap-2 border-b border-lines px-2 py-1.5">
            <IconButton label={playing ? 'Pause' : 'Play'} onClick={() => setPlaying((p) => !p)}>{playing ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}</IconButton>
            <Segmented label="Compare" value={compare} options={[{ value: 'after', label: 'After' }, { value: 'split', label: 'Split' }, { value: 'before', label: 'Before' }]} onChange={setCompare} />
            <Segmented label="Backdrop" value={backdrop} options={[{ value: 'checker', label: 'Alpha' }, { value: 'black', label: 'Black' }, { value: 'white', label: 'White' }]} onChange={setBackdrop} />
            <span className="ml-auto font-mono text-[10.5px] text-dim">{seq.length ? `${(pos % seq.length) + 1}/${seq.length}` : '—'} · {preview ? preview.fps.toFixed(1) : '—'} fps</span>
          </header>
          <div className={cn('relative flex min-h-[160px] flex-1 items-center justify-center overflow-hidden', BACKDROP[backdrop])}>
            {!preview && <span className="text-[12px] text-dim">Preparing frames…</span>}
            {preview && compare === 'after' && <RgbaCanvas image={after} className="size-full object-contain" label="Processed frame" />}
            {preview && compare === 'before' && <RgbaCanvas image={before} className="size-full object-contain" label="Source frame" />}
            {preview && compare === 'split' && (
              <div className="relative size-full">
                <div className="absolute inset-0"><RgbaCanvas image={after} className="size-full object-contain" label="Processed frame" /></div>
                <div className="absolute inset-0" style={{ clipPath: `inset(0 ${(1 - split) * 100}% 0 0)` }}><RgbaCanvas image={before} className="size-full bg-black object-contain" label="Source frame" /></div>
                <input type="range" min={0} max={1} step={0.001} value={split} aria-label="Before/after split" onChange={(e) => setSplit(Number(e.target.value))} className="absolute inset-x-2 bottom-1 accent-[var(--accent)]" />
                <div className="pointer-events-none absolute inset-y-0 w-px bg-white/70" style={{ left: `${split * 100}%` }} />
                <Badge className="absolute left-1 top-1">Source</Badge>
                <Badge className="absolute right-1 top-1" tone="accent">Processed</Badge>
              </div>
            )}
          </div>
          {preview && preview.notes.length > 0 && <p className="border-t border-lines px-2 py-1 text-[10.5px] leading-snug text-dim">{preview.notes[0]}</p>}
        </section>

        {/* atlas */}
        <section className="flex min-h-0 flex-col rounded-lg border border-lines bg-panel2/40" aria-label="Spritesheet atlas">
          <header className="flex flex-wrap items-center gap-2 border-b border-lines px-2 py-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">Atlas</span>
            <div className="flex gap-1">
              {PRESET_GRIDS.map((g) => (
                <Button key={g} size="xs" variant={sheet.grid.cols === g && sheet.grid.rows === g ? 'primary' : 'ghost'} onClick={() => editProject('Grid preset', (d) => { const s = d.sheets[sheet.id]; if (s) s.grid = { cols: g, rows: g }; }, { coalesceKey: `sheet:${sheet.id}:grid` })}>
                  {g}×{g}
                </Button>
              ))}
            </div>
            <span className="ml-auto font-mono text-[10.5px] text-dim">
              {sheet.texture.width}×{sheet.texture.height} · {preview?.frameCount ?? '—'}/{sheet.grid.cols * sheet.grid.rows} · {sheet.dds.format}
            </span>
          </header>
          <div className={cn('relative flex min-h-[160px] flex-1 items-center justify-center overflow-hidden', BACKDROP[backdrop])}>
            {preview && (
              <FitBox aspect={sheet.texture.width / sheet.texture.height}>
                <RgbaCanvas image={preview.atlas} className="size-full max-h-none max-w-none" label={`Spritesheet atlas ${sheet.grid.cols} by ${sheet.grid.rows}`} />
                <svg viewBox={`0 0 ${sheet.grid.cols} ${sheet.grid.rows}`} preserveAspectRatio="none" className="pointer-events-none absolute inset-0 size-full" aria-hidden>
                  {Array.from({ length: sheet.grid.cols + 1 }, (_, i) => <line key={`v${i}`} x1={i} x2={i} y1={0} y2={sheet.grid.rows} stroke="var(--accent-2)" strokeOpacity="0.55" strokeWidth="0.02" vectorEffect="non-scaling-stroke" />)}
                  {Array.from({ length: sheet.grid.rows + 1 }, (_, i) => <line key={`h${i}`} y1={i} y2={i} x1={0} x2={sheet.grid.cols} stroke="var(--accent-2)" strokeOpacity="0.55" strokeWidth="0.02" vectorEffect="non-scaling-stroke" />)}
                  {preview.placements.length > 0 && (() => {
                    const frame = pos % Math.max(1, preview.frameCount);
                    const p = preview.placements[Math.min(frame, preview.placements.length - 1)];
                    return p ? <rect x={p.col} y={p.row} width={1} height={1} fill="var(--accent)" fillOpacity="0.18" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" /> : null;
                  })()}
                </svg>
              </FitBox>
            )}
          </div>
        </section>
      </div>

      {/* frame list */}
      <section className="shrink-0 border-t border-lines bg-panel" aria-label="Frame list">
        <header className="flex flex-wrap items-center gap-1 px-2 py-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">Frames</span>
          <Badge>{list.length}</Badge>
          <div className="ml-2 flex items-center gap-0.5">
            <IconButton label="Move frame left" disabled={li <= 0} onClick={() => { const n = [...list]; [n[li - 1], n[li]] = [n[li]!, n[li - 1]!]; setList(n, 'Reorder frame'); setListSel(li - 1); }}><ChevronLeft className="size-4" aria-hidden /></IconButton>
            <IconButton label="Move frame right" disabled={li >= list.length - 1} onClick={() => { const n = [...list]; [n[li + 1], n[li]] = [n[li]!, n[li + 1]!]; setList(n, 'Reorder frame'); setListSel(li + 1); }}><ChevronRight className="size-4" aria-hidden /></IconButton>
            <IconButton label="Duplicate frame" onClick={() => { const n = [...list]; n.splice(li + 1, 0, { ...list[li]! }); setList(n, 'Duplicate frame'); setListSel(li + 1); }} disabled={!list.length}><Copy className="size-4" aria-hidden /></IconButton>
            <IconButton label="Delete frame" disabled={list.length <= 1} onClick={() => { setList(list.filter((_, i) => i !== li), 'Delete frame'); setListSel(Math.max(0, li - 1)); }}><Trash2 className="size-4" aria-hidden /></IconButton>
            <IconButton label="Reset frame list" disabled={!clip.frames} onClick={() => setList(null, 'Reset frame list')}><RotateCcw className="size-4" aria-hidden /></IconButton>
          </div>
          {list[li] && (
            <div className="ml-2 flex items-center gap-1 text-[11px] text-muted">
              Hold
              <NumberField className="w-[84px]" value={list[li]!.hold} min={0.05} max={64} step={1} onChange={(v) => setList(list.map((e, i) => (i === li ? { ...e, hold: v } : e)), 'Frame hold')} />
              <span className="text-dim">× (rounded to whole cells on export)</span>
            </div>
          )}
        </header>
        <div className="flex gap-1.5 overflow-x-auto px-2 pb-2" role="listbox" aria-label="Frames">
          {list.map((e, i) => (
            <button
              key={i}
              type="button"
              role="option"
              aria-selected={i === li}
              onClick={() => setListSel(i)}
              className={cn('relative size-[72px] shrink-0 overflow-hidden rounded-md border bg-black/30', i === li ? 'border-accent ring-1 ring-accent' : 'border-line hover:border-accent/60')}
            >
              <span className={cn('absolute inset-0', BACKDROP[backdrop === 'checker' ? 'checker' : backdrop])}>
                <RgbaCanvas image={preview?.base[e.src]} className="size-full object-contain" />
              </span>
              <span className="absolute bottom-0 left-0 rounded-tr bg-black/60 px-1 font-mono text-[9.5px] text-white">{i + 1}</span>
              {e.hold !== 1 && <span className="absolute bottom-0 right-0 rounded-tl bg-accent px-1 font-mono text-[9.5px] text-white">×{e.hold}</span>}
            </button>
          ))}
        </div>
      </section>
    </PanelFrame>
  );
}
