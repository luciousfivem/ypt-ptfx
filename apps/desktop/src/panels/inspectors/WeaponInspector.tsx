import { ATTACHMENT_KINDS, ENVIRONMENTS, WEAPON_PRESETS, type AttachmentPoint, type Weapon } from '@vfxforge/core';
import { Box, Crosshair, Plus, Trash2, Upload } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Field, IconButton, NumberField, Section, SelectField, TextField, Vec3Field } from '../../components/ui';
import { cn } from '../../lib/cn';
import { addAttachment, addDefaultAttachments, deleteAttachment, importFiles } from '../../services/actions';
import { svc } from '../../services/app';
import { editProject, useProject } from '../../state/project';
import { useRuntime } from '../../state/runtime';
import { useUi } from '../../state/ui';
import { isYdrName, modelPicker } from '../../lib/model-files';
import { MODEL_ORIENTATIONS } from '../../viewport/orientations';
import { MODEL_NOTES, YDR_NOTE, modelFormatOf } from '../../viewport/models';
import { Note } from './common';

const PRESET_LABEL: Record<Weapon['preset'], string> = { pistol: 'Pistol', smg: 'SMG', rifle: 'Assault rifle', shotgun: 'Shotgun', sniper: 'Sniper rifle', custom: 'Custom model' };
const ENV_LABEL: Record<(typeof ENVIRONMENTS)[number], string> = {
  darkStudio: 'Dark studio',
  neutralStudio: 'Neutral studio',
  daylight: 'Daylight',
  night: 'Night',
  firstPerson: 'First-person view',
  thirdPerson: 'Third-person view',
};

const setWeapon = (label: string, key: string, fn: (w: Weapon) => void) => editProject(label, (d) => fn(d.weapon), { coalesceKey: `weapon:${key}` });

export function WeaponInspector() {
  const weapon = useProject((s) => s.project.weapon);
  const model = useProject((s) => (s.project.weapon.modelAssetId ? s.project.assets[s.project.weapon.modelAssetId] : undefined));
  const modelInfo = useRuntime((s) => s.modelInfo);
  const modelError = useRuntime((s) => s.modelError);
  const selection = useUi((s) => s.selection);
  const [target, setTarget] = useState(0.4);
  const [kind, setKind] = useState<AttachmentPoint['kind']>('muzzle');
  const select = useUi((s) => s.select);

  const pickModel = async () => {
    const { accept, filters } = modelPicker(svc().platform.kind);
    const files = await svc().platform.pickFiles({ accept, filters, title: 'Import a weapon model' });
    if (files.length) await importFiles(files);
  };

  const autoFit = () => {
    const m = useRuntime.getState().viewport?.measureModel();
    if (!m) return;
    const longest = Math.max(...m.size);
    if (longest <= 0) return;
    const current = weapon.modelScale;
    const unscaled = longest / current;
    setWeapon('Auto-fit model scale', 'scale', (w) => void (w.modelScale = Math.round((target / unscaled) * 100000) / 100000));
  };

  return (
    <div>
      <Section title="Preview weapon">
        <Field label="Weapon">
          <SelectField
            value={weapon.preset}
            options={WEAPON_PRESETS.filter((p) => p !== 'custom' || weapon.modelAssetId).map((p) => ({ value: p, label: PRESET_LABEL[p] }))}
            onChange={(v) => setWeapon('Weapon preset', 'preset', (w) => void (w.preset = v))}
          />
        </Field>
        <Field label="Environment">
          <SelectField value={weapon.environment} options={ENVIRONMENTS.map((e) => ({ value: e, label: ENV_LABEL[e] }))} onChange={(v) => setWeapon('Environment', 'env', (w) => void (w.environment = v))} />
        </Field>
        <Note>The built-in weapons are simple stand-ins for scale and placement. They are not GTA V models.</Note>
      </Section>

      <Section title="3D model">
        {model ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 rounded-md border border-line bg-panel2 px-2 py-1.5">
              <Box className="size-4 shrink-0 text-accent" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] text-fg">{model.name}</p>
                <p className="text-[10.5px] text-dim">
                  {modelInfo ? `${modelInfo.triangles.toLocaleString()} triangles · ${modelInfo.size.map((n) => n.toFixed(2)).join(' × ')} (model units)` : 'loading…'}
                </p>
              </div>
              <IconButton label="Remove model" onClick={() => editProject('Remove weapon model', (d) => void ((d.weapon.modelAssetId = null), (d.weapon.preset = d.weapon.preset === 'custom' ? 'pistol' : d.weapon.preset)))}>
                <Trash2 className="size-3.5" aria-hidden />
              </IconButton>
            </div>
            {modelError && <Note tone="danger">{modelError}</Note>}
            {modelInfo?.warnings.map((w, i) => <Note key={i} tone="warn">{w}</Note>)}
            {(() => {
              // the loaded file says where it came from; until it has loaded, the stored name (kept from the .ydr) stands in
              if (modelInfo ? modelInfo.origin === 'ydr' : isYdrName(model.name)) return <Note>{YDR_NOTE}</Note>;
              const f = modelFormatOf(model.file);
              return f ? <Note>{MODEL_NOTES[f]}</Note> : null;
            })()}
            <Field label="Scale"><NumberField value={weapon.modelScale} min={0.0001} max={1000} step={0.01} precision={4} onChange={(v) => setWeapon('Model scale', 'scale', (w) => void (w.modelScale = v))} /></Field>
            <Field label="Auto-fit">
              <div className="flex gap-1">
                <NumberField value={target} min={0.05} max={3} step={0.05} precision={2} unit="m" onChange={(v) => setTarget(v)} />
                <Button size="sm" onClick={autoFit}>Fit</Button>
              </div>
            </Field>
            <Field label="Rotation"><Vec3Field value={weapon.modelRotation} step={1} precision={1} onChange={(v) => setWeapon('Model rotation', 'rot', (w) => void (w.modelRotation = v))} /></Field>
            <Field label="Orientation">
              <SelectField
                value="__pick"
                options={[{ value: '__pick', label: 'Set from convention…' }, ...MODEL_ORIENTATIONS.map((o) => ({ value: o.id, label: o.label }))]}
                onChange={(id) => {
                  const o = MODEL_ORIENTATIONS.find((x) => x.id === id);
                  if (o) setWeapon('Model orientation', 'rot', (w) => void (w.modelRotation = [...o.rotation]));
                }}
              />
            </Field>
            <Note>Fix the scale so 1 unit = 1 metre and orient the barrel toward −Z (up = +Y). Attachment offsets are exported in GTA axes from that convention.</Note>
          </div>
        ) : (
          <EmptyModel onPick={pickModel} desktop={svc().platform.kind === 'tauri'} />
        )}
      </Section>

      <Section
        title="Attachment points"
        actions={
          <Badge tone="neutral" className="mr-1">
            {weapon.attachments.length}
          </Badge>
        }
      >
        <ul className="space-y-0.5" aria-label="Attachment points">
          {weapon.attachments.map((a) => {
            const active = selection.kind === 'attachment' && selection.id === a.id;
            return (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => select({ kind: 'attachment', id: a.id })}
                  className={cn('flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] hover:bg-raised', active && 'bg-accent/20 text-fg')}
                >
                  <Crosshair className="size-3.5 text-accent" aria-hidden />
                  <span className="flex-1 truncate">{a.name}</span>
                  <span className="text-[10.5px] text-dim">{a.kind}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex gap-1">
          <SelectField value={kind} options={ATTACHMENT_KINDS.map((k) => ({ value: k, label: k }))} onChange={setKind} />
          <Button size="sm" icon={<Plus className="size-3.5" aria-hidden />} onClick={() => addAttachment(kind)}>Add</Button>
        </div>
        <Button size="xs" variant="ghost" onClick={addDefaultAttachments}>Add default points for this weapon</Button>
        <Note>Click a point in the 3D view (or here) to move it with the gizmo. Offsets are in metres, in weapon space.</Note>
      </Section>
    </div>
  );
}

function EmptyModel({ onPick, desktop }: { onPick: () => void; desktop: boolean }) {
  return (
    <div className="space-y-2">
      <Note>Import your own weapon to preview effects on it: GLB / glTF (recommended), OBJ, or FBX (experimental). The model is only used for the preview and attachment placement; it is never added to the exported resource.</Note>
      <Note>
        {desktop
          ? 'A GTA V drawable (.ydr) can be imported too: the desktop app converts it to a GLB with your CodeWalker converter bridge (Settings > Tools). Geometry only; GTA textures and shaders are not converted.'
          : 'A GTA V drawable (.ydr) needs the desktop app with the CodeWalker converter bridge; here, export the model as .glb first.'}
      </Note>
      <Button icon={<Upload className="size-3.5" aria-hidden />} onClick={onPick}>Import model…</Button>
    </div>
  );
}

export function AttachmentInspector({ id }: { id: string }) {
  const att = useProject((s) => s.project.weapon.attachments.find((a) => a.id === id));
  if (!att) return <Note>This attachment point no longer exists.</Note>;
  const set = (label: string, key: string, fn: (a: AttachmentPoint) => void) =>
    editProject(label, (d) => {
      const a = d.weapon.attachments.find((x) => x.id === id);
      if (a) fn(a);
    }, { coalesceKey: `att:${id}:${key}` });
  return (
    <div>
      <Section title="Attachment point">
        <Field label="Name"><TextField value={att.name} maxLength={80} onChange={(v) => v.trim() && set('Rename attachment', 'name', (a) => void (a.name = v))} /></Field>
        <Field label="Kind"><SelectField value={att.kind} options={ATTACHMENT_KINDS.map((k) => ({ value: k, label: k }))} onChange={(v) => set('Attachment kind', 'kind', (a) => void (a.kind = v))} /></Field>
        <Field label="Position"><Vec3Field value={att.position} step={0.001} precision={4} onChange={(v) => set('Attachment position', 'pos', (a) => void (a.position = v))} /></Field>
        <Field label="Rotation"><Vec3Field value={att.rotation} step={1} precision={1} onChange={(v) => set('Attachment rotation', 'rot', (a) => void (a.rotation = v))} /></Field>
        <Field label="GTA bone" hint="Optional. If set, the script attaches to this bone of the weapon entity instead of its origin.">
          <TextField mono value={att.gtaBone ?? ''} placeholder="e.g. a bone name from your weapon model" maxLength={64} onChange={(v) => set('GTA bone', 'bone', (a) => void (a.gtaBone = v.trim() === '' ? null : v.trim()))} />
        </Field>
        <Note>Bone names are not validated: they depend on the weapon model in your server. The preview cannot show bones. Verify the name in-game.</Note>
        <Button variant="danger" size="sm" icon={<Trash2 className="size-3.5" aria-hidden />} onClick={() => deleteAttachment(id)}>Delete attachment point</Button>
      </Section>
    </div>
  );
}
