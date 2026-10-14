import { PRESET_GRIDS, PRESET_RESOLUTIONS, computeGridLayout, isValidIdentifier, sanitizeIdentifier, type Sheet } from '@vfxforge/core';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { Badge, Button, Field, NumberField, Section, SelectField, SwitchField, TextField } from '../../components/ui';
import { fitGridToFrames } from '../../services/actions';
import { useDerived } from '../../state/derived';
import { useProject } from '../../state/project';
import { Note, patchSheet } from './common';
import { useShallow } from 'zustand/react/shallow';

const fmtBytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(2)} MiB` : `${(n / 1024).toFixed(1)} KiB`);

export function SheetInspector({ sheetId }: { sheetId: string }) {
  const sheet = useProject((s) => s.project.sheets[sheetId]);
  const clipName = useProject((s) => (sheet ? s.project.clips[sheet.clipId]?.name : undefined));
  const textureNames = useProject(useShallow((s) => Object.values(s.project.sheets).filter((x) => x.id !== sheetId).map((x) => x.textureName)));
  const st = useDerived((s) => s.sheets[sheetId]);
  if (!sheet) return <Note>This spritesheet no longer exists.</Note>;
  const set = (label: string, key: string, fn: (s: Sheet) => void) => patchSheet(sheetId, label, key, fn);
  const preview = st?.preview ?? null;
  const frames = preview?.frameCount ?? 0;
  const { layout, issues } = computeGridLayout(sheet.grid, sheet.texture, sheet.padding, frames || undefined);
  const dup = textureNames.includes(sheet.textureName);
  const nameOk = isValidIdentifier(sheet.textureName) && !dup;

  return (
    <div>
      <Section title="Spritesheet">
        <Field label="Name">
          <TextField value={sheet.name} maxLength={120} onChange={(v) => v.trim() && set('Rename sheet', 'name', (s) => void (s.name = v))} />
        </Field>
        <Field label="Clip">
          <span className="text-[12px] text-fg">{clipName ?? '—'}</span>
        </Field>
        <Field label="Texture name" hint={dup ? 'Another spritesheet already uses this name.' : 'Lowercase letters, digits and underscores; this is the texture name inside the YPT.'}>
          <TextField mono invalid={!nameOk} value={sheet.textureName} maxLength={48} onChange={(v) => set('Texture name', 'tn', (s) => void (s.textureName = sanitizeIdentifier(v, 'sheet')))} />
        </Field>
        <Field label="Playback fps">
          <NumberField value={sheet.fps} min={0.1} max={120} step={0.5} unit="fps" onChange={(v) => set('Sheet fps', 'fps', (s) => void (s.fps = v))} />
        </Field>
      </Section>

      <Section title="Atlas layout">
        <Field label="Columns">
          <NumberField value={sheet.grid.cols} min={1} max={64} step={1} onChange={(v) => set('Columns', 'grid', (s) => void (s.grid.cols = v))} />
        </Field>
        <Field label="Rows">
          <NumberField value={sheet.grid.rows} min={1} max={64} step={1} onChange={(v) => set('Rows', 'grid', (s) => void (s.grid.rows = v))} />
        </Field>
        <div className="flex gap-1">
          {PRESET_GRIDS.map((g) => (
            <Button key={g} size="xs" variant={sheet.grid.cols === g && sheet.grid.rows === g ? 'primary' : 'secondary'} onClick={() => set('Grid preset', 'grid', (s) => void (s.grid = { cols: g, rows: g }))}>
              {g}×{g}
            </Button>
          ))}
        </div>
        <Field label="Width">
          <SelectField value={String(sheet.texture.width)} options={textureSizes(sheet.texture.width)} onChange={(v) => set('Texture width', 'tex', (s) => void (s.texture.width = Number(v)))} />
        </Field>
        <Field label="Height">
          <SelectField value={String(sheet.texture.height)} options={textureSizes(sheet.texture.height)} onChange={(v) => set('Texture height', 'tex', (s) => void (s.texture.height = Number(v)))} />
        </Field>
        <Field label="Frame order">
          <SelectField value={sheet.order} options={[{ value: 'row-major', label: 'Row by row →' }, { value: 'column-major', label: 'Column by column ↓' }]} onChange={(v) => set('Frame order', 'order', (s) => void (s.order = v))} />
        </Field>
        <Field label="Padding"><NumberField value={sheet.padding} min={0} max={64} step={1} unit="px" onChange={(v) => set('Padding', 'pad', (s) => void (s.padding = v))} /></Field>
        <Field label="Edge extrude" hint="Repeats border pixels outward to stop bilinear bleed between frames.">
          <NumberField value={sheet.extrude} min={0} max={16} step={1} unit="px" onChange={(v) => set('Extrude', 'ext', (s) => void (s.extrude = v))} />
        </Field>
        <Field label="Fit">
          <SelectField value={sheet.fit} options={[{ value: 'contain', label: 'Contain (letterbox)' }, { value: 'cover', label: 'Cover (crop)' }, { value: 'stretch', label: 'Stretch' }]} onChange={(v) => set('Fit mode', 'fit', (s) => void (s.fit = v))} />
        </Field>
        <Field label="Centre"><SwitchField checked={sheet.center} onChange={(v) => set('Centre frames', 'center', (s) => void (s.center = v))} label="Centre frames" /></Field>
        <Field label="Trim empty" hint="Crops all frames by their shared content bounds.">
          <SwitchField checked={sheet.trim} onChange={(v) => set('Trim', 'trim', (s) => void (s.trim = v))} label="Trim" />
        </Field>
        <div className="flex gap-1">
          <Button size="xs" onClick={() => fitGridToFrames(sheetId)} disabled={!frames}>Fit grid to {frames || '…'} frames</Button>
        </div>
        {layout && (
          <Note>
            Cells {layout.cellWidth}×{layout.cellHeight} px · {layout.capacity} slots{frames ? ` · ${frames} used` : ''}
            {preview?.layout && frames > layout.capacity ? ' (too many frames!)' : ''}
          </Note>
        )}
      </Section>

      <Section title="Texture output">
        <Field label="Format">
          <SelectField
            value={sheet.dds.format}
            options={[
              { value: 'BC3', label: 'BC3 / DXT5', hint: 'smooth alpha' },
              { value: 'BC1', label: 'BC1 / DXT1', hint: 'no/1-bit alpha' },
              { value: 'BGRA8', label: 'BGRA8', hint: 'uncompressed' },
            ]}
            onChange={(v) => set('DDS format', 'fmt', (s) => void (s.dds.format = v))}
          />
        </Field>
        <Field label="Mipmaps"><SwitchField checked={sheet.dds.mipmaps} onChange={(v) => set('Mipmaps', 'mips', (s) => void (s.dds.mipmaps = v))} label="Mipmaps" /></Field>
        {sheet.dds.format === 'BC1' && <Note tone="warn">BC1 keeps only 1 bit of transparency: soft particle edges will turn into hard edges. Use BC3 for smoke, fire and glow.</Note>}
        {preview && <Note>DDS file ≈ {fmtBytes(preview.ddsBytes)} · texture memory ≈ {fmtBytes(preview.vramBytes)}</Note>}
      </Section>

      <Section title="Flipbook compatibility">
        {st?.status === 'error' && (
          <div className="flex gap-2 rounded-md border border-danger/40 bg-danger/10 p-2 text-[11.5px] text-danger" role="alert">
            <XCircle className="mt-px size-4 shrink-0" aria-hidden />
            <span>{st.error}</span>
          </div>
        )}
        {issues.map((i) => (
          <div key={i.code} className="flex gap-2 text-[11.5px] text-danger">
            <XCircle className="mt-px size-3.5 shrink-0" aria-hidden /> {i.message}
          </div>
        ))}
        {preview ? (
          <>
            <div className="flex items-center gap-1.5">
              <Badge tone={preview.flipbook.status === 'structurally-valid' ? 'ok' : 'danger'}>
                {preview.flipbook.status === 'structurally-valid' ? <CheckCircle2 className="size-3" aria-hidden /> : <XCircle className="size-3" aria-hidden />}
                {preview.flipbook.status === 'structurally-valid' ? 'Structurally valid' : 'Invalid'}
              </Badge>
              <Badge tone="warn"><Info className="size-3" aria-hidden /> In-game behaviour unverified</Badge>
            </div>
            <ul className="space-y-1.5">
              {preview.flipbook.issues.map((i, k) => (
                <li key={k} className={`flex gap-2 text-[11px] leading-snug ${i.severity === 'error' ? 'text-danger' : i.severity === 'warning' ? 'text-warn' : 'text-muted'}`}>
                  {i.severity === 'error' ? <XCircle className="mt-px size-3.5 shrink-0" aria-hidden /> : i.severity === 'warning' ? <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden /> : <Info className="mt-px size-3.5 shrink-0" aria-hidden />}
                  <span>{i.message}</span>
                </li>
              ))}
            </ul>
            {preview.flipbook.fixes.length > 0 && (
              <div className="space-y-1">
                {preview.flipbook.fixes.map((f, k) => (
                  <Note key={k}>Suggestion: {f.field} {f.from} → {f.to} ({f.reason})</Note>
                ))}
              </div>
            )}
            {preview.warnings.map((w, k) => (
              <Note key={k} tone="warn">{w}</Note>
            ))}
          </>
        ) : (
          <Note>Building the preview…</Note>
        )}
      </Section>
    </div>
  );
}

function textureSizes(current: number) {
  const sizes: number[] = [...PRESET_RESOLUTIONS, 8192];
  if (!sizes.includes(current)) sizes.push(current);
  return [...new Set(sizes)].sort((a, b) => a - b).map((n) => ({ value: String(n), label: `${n} px`, hint: Number.isInteger(Math.log2(n)) ? undefined : 'not power-of-two' }));
}
