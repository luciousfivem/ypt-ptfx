import { PRESET_CATEGORIES, PRESETS, generateSpriteFrames, type Preset } from '@vfxforge/particles';
import { startsLooped } from '@vfxforge/core';
import { Box, ChevronDown, ChevronUp, Copy, Eye, EyeOff, FileImage, Film, Layers as LayersIcon, Plus, Search, Share2, Trash2, Upload } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, EmptyState, IconButton, PanelFrame, Tabs } from '../components/ui';
import { cn } from '../lib/cn';
import { addEffect, addEmitter, addPreset, deleteEffect, deleteEmitter, duplicateEffect, duplicateEmitter, exportEffectPackage, importEffectPackage, moveEmitter, pickAndImport } from '../services/actions';
import { svc } from '../services/app';
import { editProject, useProject } from '../state/project';
import { useUi } from '../state/ui';

export function AssetBrowser() {
  const tab = useUi((s) => s.leftTab);
  const setTab = useUi((s) => s.setLeftTab);
  return (
    <PanelFrame title="Library" bodyClassName="flex flex-col overflow-hidden">
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as typeof tab)}
        tabs={[
          { value: 'presets', label: 'Presets' },
          { value: 'assets', label: 'Media' },
          { value: 'layers', label: 'Layers' },
        ]}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'presets' && <PresetLibrary />}
        {tab === 'assets' && <MediaList />}
        {tab === 'layers' && <LayersTab />}
      </div>
    </PanelFrame>
  );
}

/* ----------------------------------------------------------------- presets */

const thumbCache = new Map<string, string>();

function PresetThumb({ preset }: { preset: Preset }) {
  const [url, setUrl] = useState<string | null>(thumbCache.get(preset.id) ?? null);
  useEffect(() => {
    if (url) return;
    let cancelled = false;
    const id = setTimeout(() => {
      if (cancelled) return;
      try {
        const frames = generateSpriteFrames({ ...preset.generator, frames: 6, size: 64, seed: 7, intensity: preset.generator.intensity ?? 1 } as Parameters<typeof generateSpriteFrames>[0]);
        const f = frames[Math.min(2, frames.length - 1)]!;
        const c = document.createElement('canvas');
        c.width = f.width;
        c.height = f.height;
        c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(f.data), f.width, f.height), 0, 0);
        const u = c.toDataURL('image/png');
        thumbCache.set(preset.id, u);
        setUrl(u);
      } catch {
        /* a thumbnail is decoration only */
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [preset, url]);
  return <div className="checker size-full">{url && <img src={url} alt="" className="size-full object-contain" draggable={false} />}</div>;
}

function PresetLibrary() {
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const groups = useMemo(
    () =>
      PRESET_CATEGORIES.map((c) => ({
        category: c,
        items: PRESETS.filter((p) => p.category === c && (!query || p.name.toLowerCase().includes(query) || p.tags.some((t) => t.includes(query)) || p.description.toLowerCase().includes(query))),
      })).filter((g) => g.items.length),
    [query],
  );
  return (
    <div>
      <div className="sticky top-0 z-10 space-y-1.5 border-b border-lines bg-panel p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-dim" aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search 30 presets…" aria-label="Search presets" className="h-7 w-full rounded-md border border-line bg-panel2 pl-7 pr-2 text-[12px] outline-none placeholder:text-dim focus:border-accent" />
        </div>
        <p className="text-[10.5px] leading-snug text-dim">Presets are procedural: sprites are generated from a seed, so there is no copyrighted footage and every preset exports through the real pipeline.</p>
      </div>
      {groups.length === 0 && <EmptyState title="No presets match">Try “fire”, “smoke” or “plasma”.</EmptyState>}
      {groups.map((g) => (
        <section key={g.category} aria-label={g.category}>
          <h3 className="px-3 pb-1 pt-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-dim">{g.category}</h3>
          <div className="grid grid-cols-2 gap-1.5 px-2 pb-1">
            {g.items.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => addPreset(p.id)}
                title={`${p.description}\nClick to add to the project.`}
                data-testid={`preset-${p.id}`}
                className="group overflow-hidden rounded-lg border border-line bg-panel2 text-left transition-colors hover:border-accent focus-visible:border-accent"
              >
                <div className="aspect-[4/3] w-full overflow-hidden bg-black/30">
                  <PresetThumb preset={p} />
                </div>
                <div className="flex items-center justify-between gap-1 px-2 py-1.5">
                  <span className="truncate text-[11.5px] font-medium text-fg">{p.name}</span>
                  <Plus className="size-3.5 shrink-0 text-dim group-hover:text-accent" aria-hidden />
                </div>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------- media */

function AssetThumb({ id }: { id: string }) {
  const asset = useProject((s) => s.project.assets[id]);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (asset?.kind === 'image') {
      svc()
        .platform.assetUrl(asset)
        .then((u) => live && setUrl(u))
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [asset]);
  if (!asset) return null;
  if (asset.kind === 'image' && url) return <img src={url} alt="" className="size-full object-contain" draggable={false} />;
  return <div className="flex size-full items-center justify-center text-dim">{asset.kind === 'video' ? <Film className="size-5" aria-hidden /> : asset.kind === 'model' ? <Box className="size-5" aria-hidden /> : <FileImage className="size-5" aria-hidden />}</div>;
}

function MediaList() {
  const assets = useProject((s) => s.project.assets);
  const clips = useProject((s) => s.project.clips);
  const sheets = useProject((s) => s.project.sheets);
  const selection = useUi((s) => s.selection);
  const select = useUi((s) => s.select);
  const list = Object.values(assets);
  return (
    <div className="p-2">
      <Button className="w-full" variant="primary" icon={<Upload className="size-3.5" aria-hidden />} onClick={() => void pickAndImport()} data-testid="import-button">
        Import media or model…
      </Button>
      <p className="mt-1.5 text-[10.5px] leading-snug text-dim">
        MP4, MOV, WebM, GIF, WebP, PNG, JPG · GLB, glTF, OBJ, FBX
        {svc().platform.kind === 'tauri' && ' · GTA V .ydr (converted to GLB by the converter bridge; geometry only)'}. You can also drop files anywhere in the window. Files are identified by their contents, not their extension.
      </p>

      <h3 className="px-1 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-dim">Imported ({list.length})</h3>
      {list.length === 0 && <p className="px-1 text-[11.5px] text-dim">Nothing imported yet.</p>}
      <ul className="space-y-0.5">
        {list.map((a) => (
          <li key={a.id}>
            <button type="button" onClick={() => select({ kind: 'asset', id: a.id })} className={cn('flex w-full items-center gap-2 rounded-md p-1 text-left hover:bg-raised', selection.kind === 'asset' && selection.id === a.id && 'bg-accent/20')}>
              <span className="checker size-9 shrink-0 overflow-hidden rounded border border-line">
                <AssetThumb id={a.id} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-fg">{a.name}</span>
                <span className="block text-[10.5px] text-dim">
                  {a.kind}
                  {a.info ? ` · ${a.info.width}×${a.info.height}` : ''}
                  {a.info?.durationSec ? ` · ${a.info.durationSec.toFixed(1)}s` : ''}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      <h3 className="px-1 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-dim">Clips & sheets</h3>
      <ul className="space-y-0.5">
        {Object.values(clips).map((c) => (
          <li key={c.id}>
            <button type="button" onClick={() => select({ kind: 'clip', id: c.id })} className={cn('flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] hover:bg-raised', selection.kind === 'clip' && selection.id === c.id && 'bg-accent/20')}>
              <Film className="size-3.5 text-accent2" aria-hidden />
              <span className="truncate">{c.name}</span>
              {c.generator && <Badge className="ml-auto">procedural</Badge>}
            </button>
            <ul className="ml-5 border-l border-lines pl-1">
              {Object.values(sheets).filter((s) => s.clipId === c.id).map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => select({ kind: 'sheet', id: s.id })} className={cn('flex h-6 w-full items-center gap-2 rounded-md px-2 text-left text-[11.5px] text-muted hover:bg-raised hover:text-fg', selection.kind === 'sheet' && selection.id === s.id && 'bg-accent/20 text-fg')}>
                    <span className="truncate">{s.name}</span>
                    <span className="ml-auto text-[10px] text-dim">{s.grid.cols}×{s.grid.rows}</span>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ layers */

function LayersTab() {
  const effects = useProject((s) => s.project.effects);
  const selection = useUi((s) => s.selection);
  const select = useUi((s) => s.select);
  const list = Object.values(effects);
  return (
    <div className="p-2">
      <div className="mb-2 flex gap-1">
        <Button size="sm" icon={<Plus className="size-3.5" aria-hidden />} onClick={() => addEffect()}>Effect</Button>
        <Button size="sm" icon={<Upload className="size-3.5" aria-hidden />} onClick={() => void importEffectPackage()} title="Import a shared preset package (.vfxpreset.json)">Import preset…</Button>
      </div>
      {list.length === 0 && (
        <EmptyState icon={<LayersIcon className="size-7" aria-hidden />} title="No effects yet">
          Add a preset from the Presets tab, or create an empty effect.
        </EmptyState>
      )}
      <ul className="space-y-2">
        {list.map((fx) => (
          <li key={fx.id} className="rounded-lg border border-lines bg-panel2/50">
            <div className={cn('flex h-8 items-center gap-1 rounded-t-lg px-1.5', selection.kind === 'effect' && selection.id === fx.id && 'bg-accent/20')}>
              <button type="button" className="min-w-0 flex-1 truncate px-1 text-left text-[12px] font-medium" onClick={() => select({ kind: 'effect', id: fx.id })}>
                {fx.name}
              </button>
              <IconButton label="Add emitter" onClick={() => addEmitter(fx.id)}><Plus className="size-3.5" aria-hidden /></IconButton>
              <IconButton label="Duplicate effect" onClick={() => duplicateEffect(fx.id)}><Copy className="size-3.5" aria-hidden /></IconButton>
              <IconButton label="Share as preset package" onClick={() => void exportEffectPackage([fx.id])}><Share2 className="size-3.5" aria-hidden /></IconButton>
              <IconButton label="Delete effect" onClick={() => deleteEffect(fx.id)}><Trash2 className="size-3.5" aria-hidden /></IconButton>
            </div>
            <ul className="px-1 pb-1">
              {fx.emitters.map((em, i) => {
                const active = selection.kind === 'emitter' && selection.id === em.id;
                return (
                  <li key={em.id} className={cn('group flex h-7 items-center gap-1 rounded-md pl-1 pr-0.5 hover:bg-raised', active && 'bg-accent/20')}>
                    <IconButton label={em.enabled ? 'Disable emitter' : 'Enable emitter'} onClick={() => editProject('Toggle emitter', (d) => { const e = d.effects[fx.id]?.emitters.find((x) => x.id === em.id); if (e) e.enabled = !e.enabled; })} className="size-6">
                      {em.enabled ? <Eye className="size-3.5" aria-hidden /> : <EyeOff className="size-3.5 text-dim" aria-hidden />}
                    </IconButton>
                    <button type="button" className={cn('min-w-0 flex-1 truncate text-left text-[12px]', !em.enabled && 'text-dim line-through')} onClick={() => select({ kind: 'emitter', effectId: fx.id, id: em.id })}>
                      {em.name}
                    </button>
                    <Badge className="shrink-0">{startsLooped(em) ? 'loop' : em.emission.mode === 'continuous' ? 'timed' : 'burst'}</Badge>
                    <span className={cn('hidden items-center group-hover:flex', active && 'flex')}>
                      <IconButton label="Move up" disabled={i === 0} onClick={() => moveEmitter(fx.id, em.id, -1)} className="size-6"><ChevronUp className="size-3.5" aria-hidden /></IconButton>
                      <IconButton label="Move down" disabled={i === fx.emitters.length - 1} onClick={() => moveEmitter(fx.id, em.id, 1)} className="size-6"><ChevronDown className="size-3.5" aria-hidden /></IconButton>
                      <IconButton label="Duplicate emitter" onClick={() => duplicateEmitter(fx.id, em.id)} className="size-6"><Copy className="size-3.5" aria-hidden /></IconButton>
                      <IconButton label="Delete emitter" onClick={() => deleteEmitter(fx.id, em.id)} className="size-6"><Trash2 className="size-3.5" aria-hidden /></IconButton>
                    </span>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[10.5px] leading-snug text-dim">Layers are emitters. Layers sharing an attachment, triggers and loop behaviour export into one effect rule.</p>
    </div>
  );
}
