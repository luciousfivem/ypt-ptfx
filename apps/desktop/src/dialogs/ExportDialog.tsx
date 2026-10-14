import { estimateProject, textureBytes, type Estimate } from '@vfxforge/export';
import { mipLevelCount } from '@vfxforge/media';
import type { Issue, MappingNote } from '@vfxforge/ypt';
import { AlertTriangle, CheckCircle2, Download, FileArchive, FileCode2, Info, Loader2, PackageCheck, ShieldAlert, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Dialog, Field, NumberField, Progress, Section, SelectField, SwitchField, TextField } from '../components/ui';
import { cn } from '../lib/cn';
import { svc } from '../services/app';
import { useDerived } from '../state/derived';
import { useExport } from '../state/export';
import { useProject } from '../state/project';
import { toast, useUi } from '../state/ui';

const STAGE_LABEL: Record<string, string> = {
  frames: 'Extracting frames',
  sheets: 'Building spritesheets',
  flipbook: 'Validating flipbook layout',
  model: 'Mapping effects to particle rules',
  xml: 'Writing and validating .ypt.xml',
  binary: 'Creating the binary .ypt (CodeWalker)',
  resource: 'Packaging the FiveM resource',
};
const STAGES = Object.keys(STAGE_LABEL);

const MIB = 1048576;
const fmtBytes = (n: number) => (n >= MIB ? `${(n / MIB).toFixed(2)} MiB` : `${(n / 1024).toFixed(1)} KiB`);

export function ExportDialog() {
  const open = useUi((s) => s.dialog === 'export');
  const close = useUi((s) => s.closeDialog);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} title="Export FiveM resource" description="Builds a validated .ypt, its textures and a ready-to-run FiveM resource." wide>
      {open && <ExportBody />}
    </Dialog>
  );
}

function ExportBody() {
  const project = useProject((s) => s.project);
  const sheets = useDerived((s) => s.sheets);
  const ex = useExport();
  const [converter, setConverter] = useState<{ available: boolean; detail: string; codewalkerCore?: string | null } | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let live = true;
    void svc().platform.converterStatus().then((c) => live && setConverter(c));
    return () => {
      live = false;
    };
  }, []);

  /* ---- pre-flight, computed from the live project (no engine run) ---- */
  const preflight = useMemo(() => {
    const checks: Array<{ ok: boolean | 'warn'; text: string }> = [];
    const emitters = Object.values(project.effects).flatMap((e) => e.emitters.filter((em) => em.enabled));
    checks.push({ ok: emitters.length > 0, text: emitters.length ? `${emitters.length} enabled emitter(s) in ${Object.keys(project.effects).length} effect(s)` : 'No enabled emitters' });
    const used = [...new Set(emitters.map((e) => e.sheetId).filter((x): x is string => !!x))];
    const unassigned = emitters.filter((e) => !e.sheetId);
    checks.push({ ok: unassigned.length === 0, text: unassigned.length ? `${unassigned.length} emitter(s) have no spritesheet: ${unassigned.slice(0, 3).map((e) => e.name).join(', ')}` : 'Every emitter has a spritesheet' });
    for (const id of used) {
      const sh = project.sheets[id];
      const st = sheets[id];
      if (!sh) continue;
      if (!st || st.status === 'extracting' || st.status === 'processing') checks.push({ ok: 'warn', text: `Spritesheet “${sh.name}” is still being prepared` });
      else if (st.status === 'error') checks.push({ ok: false, text: `Spritesheet “${sh.name}”: ${st.error}` });
      else if (st.preview?.flipbook.status === 'invalid') checks.push({ ok: false, text: `Spritesheet “${sh.name}” has flipbook layout errors (see the Sheet inspector)` });
      else checks.push({ ok: true, text: `Spritesheet “${sh.name}”: ${st.preview?.frameCount} frames, ${sh.texture.width}×${sh.texture.height} ${sh.dds.format}` });
    }
    const costs = used.flatMap((id) => {
      const sh = project.sheets[id];
      const st = sheets[id];
      if (!sh) return [];
      const mips = sh.dds.mipmaps ? mipLevelCount(sh.texture.width, sh.texture.height) : 1;
      return [{ sheetId: id, textureName: sh.textureName, width: sh.texture.width, height: sh.texture.height, frames: st?.preview?.frameCount ?? 0, format: sh.dds.format, mips, bytes: textureBytes(sh.texture.width, sh.texture.height, sh.dds.format, mips) }];
    });
    const estimate: Estimate = estimateProject(project, costs);
    return { checks, estimate, ready: checks.every((c) => c.ok !== false) };
  }, [project, sheets]);

  const stale = ex.result && ex.resultFor !== project.modifiedAt;
  const r = ex.result;
  const canBuild = !ex.running && preflight.ready && (converter?.available || ex.options.allowSourceOnly);

  const save = async (name: string, bytes: Uint8Array, mime: string) => {
    const res = await svc().platform.saveFile(name, bytes, mime);
    if (res === 'saved') toast('ok', `${name} written.`);
  };

  return (
    <div className="space-y-4" data-testid="export-body">
      {/* readiness */}
      <Section title="Pre-flight">
        <ul className="space-y-1" aria-label="Pre-flight checks">
          {preflight.checks.map((c, i) => (
            <li key={i} className="flex items-start gap-2 text-[12px]">
              {c.ok === true ? <CheckCircle2 className="mt-px size-4 shrink-0 text-ok" aria-hidden /> : c.ok === 'warn' ? <Loader2 className="mt-px size-4 shrink-0 animate-spin text-warn" aria-hidden /> : <XCircle className="mt-px size-4 shrink-0 text-danger" aria-hidden />}
              <span className={c.ok === false ? 'text-danger' : 'text-fg'}>{c.text}</span>
            </li>
          ))}
          <li className="flex items-start gap-2 text-[12px]">
            {converter?.available ? <PackageCheck className="mt-px size-4 shrink-0 text-ok" aria-hidden /> : <ShieldAlert className="mt-px size-4 shrink-0 text-warn" aria-hidden />}
            <span>
              {converter === null ? 'Checking the converter…' : converter.available ? `Binary .ypt converter ready${converter.codewalkerCore ? ` (${converter.codewalkerCore})` : ''}` : converter.detail}
            </span>
          </li>
        </ul>
        <div className="mt-2 grid grid-cols-3 gap-2 text-center">
          <Stat label="Texture memory" value={fmtBytes(preflight.estimate.textureBytes)} />
          <Stat label="Peak particles" value={String(preflight.estimate.totalPeakParticles)} />
          <Stat label="Effect rules" value={String(preflight.estimate.effects.length)} />
        </div>
        {preflight.estimate.issues.length > 0 && <IssueList issues={preflight.estimate.issues} />}
        <p className="text-[10.5px] text-dim">Cost figures are rules of thumb chosen for this tool, not documented GTA V limits.</p>
      </Section>

      {/* options */}
      <Section title="Resource options" defaultOpen={false}>
        <Field label="Test command" hint="Players type /command in chat to replay the effects.">
          <div className="flex items-center gap-2">
            <SwitchField checked={ex.options.enableTestCommand} onChange={(v) => ex.patchOptions({ enableTestCommand: v })} label="Include test command" />
            <TextField mono value={ex.options.testCommand} maxLength={32} onChange={(v) => ex.patchOptions({ testCommand: v.toLowerCase().replace(/[^a-z0-9_]/g, '') })} disabled={!ex.options.enableTestCommand} />
          </div>
        </Field>
        <Field label="Min. interval" hint="Rate-limits one-shot effects (anti-flood for automatic weapons).">
          <NumberField value={ex.options.minIntervalMs} min={0} max={2000} step={10} unit="ms" onChange={(v) => ex.patchOptions({ minIntervalMs: v })} />
        </Field>
        <Field label="Sync others" hint="Adds a validated, rate-limited server relay so nearby players see your effects.">
          <SwitchField checked={ex.options.syncEnabled} onChange={(v) => ex.patchOptions({ syncEnabled: v })} label="Sync to nearby players" />
        </Field>
        {ex.options.syncEnabled && <Field label="Sync radius"><NumberField value={ex.options.syncRadius} min={5} max={1000} step={5} unit="m" onChange={(v) => ex.patchOptions({ syncRadius: v })} /></Field>}
        <Field label="Debug prints"><SwitchField checked={ex.options.debug} onChange={(v) => ex.patchOptions({ debug: v })} label="Debug prints" /></Field>
        {!converter?.available && (
          <Field label="Source-only" hint="Without the converter the package contains .ypt.xml + DDS to convert in CodeWalker. It will NOT load an effect by itself.">
            <SwitchField checked={ex.options.allowSourceOnly} onChange={(v) => ex.patchOptions({ allowSourceOnly: v })} label="Allow a source-only package" />
          </Field>
        )}
      </Section>

      {project.export.yptStrategy === 'donor' && <DonorPanel />}

      {/* run */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="md" loading={ex.running} disabled={!canBuild} onClick={() => void ex.run()} data-testid="run-export" icon={<PackageCheck className="size-4" aria-hidden />}>
          {ex.running ? 'Building…' : r ? 'Rebuild export' : 'Build export'}
        </Button>
        {ex.running && <Button onClick={ex.abort}>Cancel</Button>}
        {!canBuild && !ex.running && (
          <span className="text-[11.5px] text-muted">
            {!preflight.ready ? 'Fix the failing checks above first.' : !converter?.available ? 'No converter: enable “Allow a source-only package” in the options to export XML + DDS only.' : ''}
          </span>
        )}
      </div>

      {(ex.running || ex.stages.length > 0) && !r && (
        <ol className="space-y-1" aria-label="Export progress">
          {STAGES.map((s) => {
            const idx = ex.stages.findIndex((x) => x.stage === s);
            const last = ex.stages.length ? STAGES.indexOf(ex.stages[ex.stages.length - 1]!.stage) : -1;
            const state = idx < 0 ? 'todo' : STAGES.indexOf(s) < last || !ex.running ? 'done' : 'active';
            return (
              <li key={s} className={cn('flex items-center gap-2 text-[12px]', state === 'todo' && 'text-dim')}>
                {state === 'done' ? <CheckCircle2 className="size-4 text-ok" aria-hidden /> : state === 'active' ? <Loader2 className="size-4 animate-spin text-accent" aria-hidden /> : <span className="size-4 rounded-full border border-line" aria-hidden />}
                {STAGE_LABEL[s]}
              </li>
            );
          })}
          {ex.running && <Progress value={null} label="Export running" />}
        </ol>
      )}

      {ex.error && (
        <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger" role="alert">
          {ex.error}
        </div>
      )}

      {r && (
        <section aria-label="Export result" className="space-y-3" data-testid="export-result">
          <StatusBanner status={r.report.status} stale={!!stale} />
          {r.report.blockers.length > 0 && <IssueList issues={r.report.blockers} title="Blocking problems" />}

          {r.report.status !== 'blocked' && (
            <div className="flex flex-wrap gap-2">
              {r.zip && <Button variant="primary" icon={<FileArchive className="size-4" aria-hidden />} onClick={() => void save(`${project.export.resourceName}.zip`, r.zip!, 'application/zip')} data-testid="save-zip">Save resource ZIP</Button>}
              {r.ypt && <Button icon={<Download className="size-4" aria-hidden />} onClick={() => void save(`${project.export.assetName}.ypt`, r.ypt!, 'application/octet-stream')}>.ypt</Button>}
              {r.xml && <Button icon={<FileCode2 className="size-4" aria-hidden />} onClick={() => void save(`${project.export.assetName}.ypt.xml`, new TextEncoder().encode(r.xml!), 'application/xml')}>.ypt.xml</Button>}
              {r.sheets.map((s) => (
                <span key={s.sheetId} className="flex gap-1">
                  <Button size="sm" onClick={() => void save(s.ddsFileName, s.dds, 'image/vnd.ms-dds')}>{s.ddsFileName}</Button>
                  <Button size="sm" variant="ghost" onClick={() => void save(`${s.textureName}.png`, s.png, 'image/png')}>PNG</Button>
                </span>
              ))}
            </div>
          )}

          {r.files && (
            <details className="rounded-md border border-lines">
              <summary className="cursor-pointer px-3 py-1.5 text-[12px] text-muted">Resource contents ({Object.keys(r.files).length} files)</summary>
              <ul className="space-y-0.5 px-3 pb-2 font-mono text-[11px]">
                {Object.entries(r.files).map(([name, bytes]) => (
                  <li key={name} className="flex justify-between"><span>{name}</span><span className="text-dim">{fmtBytes(bytes.byteLength)}</span></li>
                ))}
              </ul>
            </details>
          )}

          {r.report.converter.used && (
            <p className="flex items-start gap-2 text-[12px] text-ok">
              <CheckCircle2 className="mt-px size-4 shrink-0" aria-hidden />
              CodeWalker{r.report.converter.codewalkerCore ? ` ${r.report.converter.codewalkerCore}` : ''} loaded the binary YPT (RSC7 v{r.report.converter.resourceVersion}) and its structure matched the XML.
            </p>
          )}

          <FidelityReport mapping={r.report.mapping} showAll={showAll} setShowAll={setShowAll} />
          <IssueList issues={r.report.issues.filter((i) => i.severity !== 'error')} title="Notes and warnings" />

          <div className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-[11.5px] leading-relaxed text-warn">
            <p className="mb-0.5 flex items-center gap-1.5 font-semibold"><AlertTriangle className="size-3.5" aria-hidden /> Not yet verified in the game</p>
            Everything above was checked structurally (schema, texture formats, CodeWalker round-trip, Lua syntax and behaviour with a mocked runtime). Whether the engine <em>renders</em> the effect, and how a flipbook frame id maps to a UV rectangle, can only be confirmed by running GTA V/FiveM. Follow the in-game checklist at the end of the README inside the ZIP (the full version is <code>docs/FIVEM_TEST_CHECKLIST.md</code>).
          </div>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-lines bg-panel2 px-2 py-1.5">
      <div className="font-mono text-[14px] text-fg">{value}</div>
      <div className="text-[10.5px] text-dim">{label}</div>
    </div>
  );
}

function StatusBanner({ status, stale }: { status: 'complete' | 'source-only' | 'blocked'; stale: boolean }) {
  const cfg = {
    complete: { tone: 'border-ok/40 bg-ok/10 text-ok', icon: <CheckCircle2 className="size-5" aria-hidden />, title: 'Export complete', text: 'Validated binary .ypt and resource are ready.' },
    'source-only': { tone: 'border-warn/40 bg-warn/10 text-warn', icon: <ShieldAlert className="size-5" aria-hidden />, title: 'Source-only package', text: 'No binary .ypt was produced. Convert the .ypt.xml with CodeWalker before the resource can load an effect.' },
    blocked: { tone: 'border-danger/40 bg-danger/10 text-danger', icon: <XCircle className="size-5" aria-hidden />, title: 'Export blocked', text: 'Nothing was written because validation failed. Details below.' },
  }[status];
  return (
    <div className={cn('flex items-start gap-3 rounded-lg border px-3 py-2.5', cfg.tone)} role="status">
      {cfg.icon}
      <div>
        <p className="text-[13px] font-semibold">{cfg.title}</p>
        <p className="text-[11.5px] opacity-90">{cfg.text}</p>
        {stale && <p className="mt-1 text-[11.5px] font-medium text-warn">The project changed after this export was built. Rebuild before using these files.</p>}
      </div>
    </div>
  );
}

function IssueList({ issues, title }: { issues: Issue[]; title?: string }) {
  if (issues.length === 0) return null;
  return (
    <div>
      {title && <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</h4>}
      <ul className="space-y-1">
        {issues.map((i, k) => (
          <li key={k} className={cn('flex gap-2 text-[11.5px] leading-snug', i.severity === 'error' ? 'text-danger' : i.severity === 'warning' ? 'text-warn' : 'text-muted')}>
            {i.severity === 'error' ? <XCircle className="mt-px size-3.5 shrink-0" aria-hidden /> : i.severity === 'warning' ? <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden /> : <Info className="mt-px size-3.5 shrink-0" aria-hidden />}
            <span>
              {i.where && <strong className="font-medium">{i.where}: </strong>}
              {i.message}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const STATUS_TONE: Record<MappingNote['status'], 'ok' | 'warn' | 'danger' | 'neutral'> = { mapped: 'ok', approximated: 'warn', unsupported: 'danger', 'preview-only': 'neutral' };

function FidelityReport({ mapping, showAll, setShowAll }: { mapping: MappingNote[]; showAll: boolean; setShowAll: (v: boolean) => void }) {
  const rows = showAll ? mapping : mapping.filter((m) => m.status !== 'mapped' || m.confidence !== 'verified');
  const counts = useMemo(() => {
    const c = { mapped: 0, approximated: 0, unsupported: 0, 'preview-only': 0 } as Record<MappingNote['status'], number>;
    for (const m of mapping) c[m.status]++;
    return c;
  }, [mapping]);
  return (
    <details className="rounded-md border border-lines" open>
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-1.5 text-[12px] text-muted">
        Fidelity report — what is and is not carried into the game
        <Badge tone="ok">{counts.mapped} mapped</Badge>
        <Badge tone="warn">{counts.approximated} approximated</Badge>
        <Badge tone="danger">{counts.unsupported} not exported</Badge>
        <Badge>{counts['preview-only']} preview-only</Badge>
      </summary>
      <div className="px-3 pb-2">
        <label className="mb-1 flex items-center gap-2 text-[11px] text-muted">
          <SwitchField checked={showAll} onChange={setShowAll} label="Show every property" /> Show every property (default hides the verified ones)
        </label>
        <div className="max-h-64 overflow-auto rounded border border-lines">
          <table className="w-full text-left text-[11px]">
            <thead className="sticky top-0 bg-panel2 text-dim">
              <tr><th className="px-2 py-1">Where</th><th className="px-2 py-1">Property</th><th className="px-2 py-1">Status</th><th className="px-2 py-1">Confidence</th><th className="px-2 py-1">Detail</th></tr>
            </thead>
            <tbody>
              {rows.map((m, i) => (
                <tr key={i} className="border-t border-lines align-top">
                  <td className="px-2 py-1 text-muted">{m.effect}{m.emitter ? ` / ${m.emitter}` : ''}</td>
                  <td className="px-2 py-1 font-mono">{m.property}</td>
                  <td className="px-2 py-1"><Badge tone={STATUS_TONE[m.status]}>{m.status}</Badge></td>
                  <td className="px-2 py-1">{m.confidence}</td>
                  <td className="px-2 py-1 text-muted">{m.detail}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={5} className="px-2 py-2 text-dim">Everything is verified.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
}

function DonorPanel() {
  const ex = useExport();
  const d = ex.donor?.load.inspect.summary;
  return (
    <Section title="Donor template">
      <p className="text-[11.5px] leading-snug text-muted">The donor strategy patches a <code>.ypt.xml</code> you exported with CodeWalker from a PTFX that already renders in your game. Only the texture, frame range and names change; every other value is carried through untouched.</p>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void ex.loadDonorFile()}>{ex.donor ? 'Choose another donor…' : 'Choose donor .ypt.xml…'}</Button>
        {ex.donor && <><span className="truncate font-mono text-[11px] text-muted">{ex.donor.fileName}</span><Button size="xs" variant="ghost" onClick={ex.clearDonor}>Remove</Button></>}
      </div>
      {!ex.donor && <p className="text-[11.5px] text-danger">Load a donor, or switch the YPT build to “Generate” on the Export tab.</p>}
      {d && (
        <>
          <Field label="Keep effects">
            <ChipSelect options={d.effects} value={ex.donorSel.effects} onChange={(effects) => ex.setDonorSel({ effects })} />
          </Field>
          <Field label="Replace texture">
            <SelectField value={ex.donorSel.textureName ?? '__none'} options={[{ value: '__none', label: '(keep donor texture)' }, ...d.textures.map((t) => ({ value: t.name, label: t.name, hint: `${t.width}×${t.height}` }))]} onChange={(v) => ex.setDonorSel({ textureName: v === '__none' ? null : v })} />
          </Field>
          <Field label="Patch particles">
            <ChipSelect options={d.particles} value={ex.donorSel.particles} onChange={(particles) => ex.setDonorSel({ particles })} />
          </Field>
        </>
      )}
    </Section>
  );
}

function ChipSelect({ options, value, onChange }: { options: string[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex max-h-28 flex-wrap gap-1 overflow-auto">
      {options.map((o) => {
        const on = value.includes(o);
        return (
          <button key={o} type="button" aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== o) : [...value, o])} className={cn('h-6 rounded-md border px-2 font-mono text-[10.5px]', on ? 'border-accent bg-accent/20 text-fg' : 'border-line text-muted hover:text-fg')}>
            {o}
          </button>
        );
      })}
    </div>
  );
}
