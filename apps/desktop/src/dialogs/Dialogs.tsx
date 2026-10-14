import { FolderOpen, History, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Dialog, EmptyState, Field, Kbd, NumberField, Segmented, SelectField, SwitchField, TextField } from '../components/ui';
import { DesktopTools } from './DesktopTools';
import { newProject, openBundle, openProject } from '../services/actions';
import { svc } from '../services/app';
import type { ConverterStatus, ProjectSummary } from '../platform';
import { useProject } from '../state/project';
import { toast, useUi } from '../state/ui';

/* ------------------------------------------------------------------ settings */

export function SettingsDialog() {
  const open = useUi((s) => s.dialog === 'settings');
  const close = useUi((s) => s.closeDialog);
  const settings = useUi((s) => s.settings);
  const patch = useUi((s) => s.patchSettings);
  const [conv, setConv] = useState<ConverterStatus | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void svc().platform.converterStatus().then((c) => live && setConv(c));
    return () => {
      live = false;
    };
  }, [open]);
  const platform = open ? svc().platform : null;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} title="Settings" description="Preferences are stored on this device.">
      <div className="space-y-3">
        <Field label="Theme">
          <Segmented label="Theme" value={settings.theme} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} onChange={(theme) => patch({ theme })} />
        </Field>
        <Field label="Preview quality" hint="Auto lowers the render resolution and bloom when the frame rate drops.">
          <SelectField value={settings.quality} options={[{ value: 'auto', label: 'Auto' }, { value: 'high', label: 'High' }, { value: 'medium', label: 'Medium' }, { value: 'low', label: 'Low' }]} onChange={(quality) => patch({ quality })} />
        </Field>
        <Field label="Bloom"><SwitchField checked={settings.bloom} onChange={(bloom) => patch({ bloom })} label="Bloom" /></Field>
        <Field label="Floor grid"><SwitchField checked={settings.showGrid} onChange={(showGrid) => patch({ showGrid })} label="Floor grid" /></Field>
        <Field label="Autosave" hint="Recoverable snapshots; your saved project is never overwritten by autosave.">
          <NumberField value={settings.autosaveSeconds} min={5} max={600} step={5} unit="s" onChange={(autosaveSeconds) => patch({ autosaveSeconds })} />
        </Field>
        <Field label="Confirm deletes"><SwitchField checked={settings.confirmDestructive} onChange={(confirmDestructive) => patch({ confirmDestructive })} label="Confirm destructive actions" /></Field>
        <hr className="border-lines" />
        <div className="space-y-1 text-[12px]">
          <p className="font-medium text-fg">Environment</p>
          <p className="text-muted">Platform: {platform?.label} ({platform?.kind})</p>
          <ul className="space-y-0.5 text-muted">
            <li>FFmpeg frame extraction: {platform?.features.ffmpeg ? <Badge tone="ok">available</Badge> : <Badge tone="warn">desktop app only</Badge>}</li>
            <li>Binary .ypt creation: {conv === null ? '…' : conv.available ? <Badge tone="ok">available{conv.codewalkerCore ? ` · ${conv.codewalkerCore}` : ''}</Badge> : <Badge tone="warn">unavailable</Badge>}</li>
          </ul>
          {conv && !conv.available && <p className="text-[11.5px] leading-snug text-dim">{conv.detail}</p>}
        </div>
        {platform?.tools && <DesktopTools onChanged={() => void svc().platform.converterStatus().then(setConv)} />}
      </div>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- new / open */

export function NewProjectDialog() {
  const open = useUi((s) => s.dialog === 'new');
  const close = useUi((s) => s.closeDialog);
  const dirty = useProject((s) => s.dirty);
  const [name, setName] = useState('My Weapon Effect');
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="New project"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} onClick={() => { newProject(name.trim()); close(); }}>Create</Button>
        </>
      }
    >
      <Field label="Name"><TextField autoFocus value={name} maxLength={120} onChange={setName} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) { newProject(name.trim()); close(); } }} /></Field>
      {dirty && <p className="mt-3 text-[11.5px] text-warn">The current project has unsaved changes. Creating a new project discards them (an autosave snapshot may still be recoverable).</p>}
    </Dialog>
  );
}

export function OpenProjectDialog() {
  const open = useUi((s) => s.dialog === 'open');
  const close = useUi((s) => s.closeDialog);
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const reload = () => void svc().platform.projects.list().then(setList).catch((e) => toast('error', String(e)));
  useEffect(() => {
    if (open) {
      setList(null);
      reload();
    }
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} title="Open project" description="Projects saved on this device." footer={<Button icon={<FolderOpen className="size-3.5" aria-hidden />} onClick={() => { close(); void openBundle(); }}>Open a bundle file…</Button>}>
      {list === null ? (
        <p className="text-[12px] text-muted">Loading…</p>
      ) : list.length === 0 ? (
        <EmptyState title="No saved projects">Save the current project with Ctrl+S, or open a .vfxforge bundle.</EmptyState>
      ) : (
        <ul className="divide-y divide-lines rounded-md border border-lines">
          {list.map((p) => (
            <li key={p.id} className="flex items-center gap-2 px-3 py-2">
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => { close(); void openProject(p.id); }}>
                <span className="block truncate text-[12.5px] font-medium">{p.name}</span>
                <span className="block text-[10.5px] text-dim">{new Date(p.modifiedAt).toLocaleString()}</span>
              </button>
              <Button size="xs" variant="ghost" aria-label={`Delete ${p.name}`} icon={<Trash2 className="size-3.5" aria-hidden />} onClick={async () => {
                if (useUi.getState().settings.confirmDestructive && !window.confirm(`Delete “${p.name}” from this device? This cannot be undone.`)) return;
                await svc().platform.projects.remove(p.id);
                reload();
              }} />
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ recovery */

export function RecoveryDialog() {
  const open = useUi((s) => s.dialog === 'recovery');
  const close = useUi((s) => s.closeDialog);
  const [info, setInfo] = useState<{ name: string; modifiedAt: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    void svc().platform.projects.latestAutosave().then((p) => setInfo(p ? { name: p.name, modifiedAt: p.modifiedAt } : null));
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Recover unsaved work?"
      description="VFXForge did not close cleanly last time."
      footer={
        <>
          <Button
            variant="ghost"
            onClick={async () => {
              const p = await svc().platform.projects.latestAutosave();
              if (p) await svc().platform.projects.clearAutosave(p.id);
              close();
            }}
          >
            Discard
          </Button>
          <Button
            variant="primary"
            icon={<History className="size-3.5" aria-hidden />}
            onClick={async () => {
              const p = await svc().platform.projects.latestAutosave();
              if (p) {
                useProject.getState().load(p, { saved: false });
                toast('ok', `Recovered “${p.name}”. Save it to keep these changes.`);
              }
              close();
            }}
          >
            Recover
          </Button>
        </>
      }
    >
      {info ? <p className="text-[12.5px]">“{info.name}” — snapshot from {new Date(info.modifiedAt).toLocaleString()}.</p> : <p className="text-[12px] text-muted">Looking for a snapshot…</p>}
    </Dialog>
  );
}

/* ----------------------------------------------------------------- shortcuts */

export const SHORTCUTS: Array<[string, string]> = [
  ['Ctrl+N', 'New project'],
  ['Ctrl+O', 'Open project'],
  ['Ctrl+S', 'Save project'],
  ['Ctrl+I', 'Import media or model'],
  ['Ctrl+E', 'Export'],
  ['Ctrl+Z', 'Undo'],
  ['Ctrl+Shift+Z / Ctrl+Y', 'Redo'],
  ['Space', 'Play / pause the preview'],
  ['F', 'Fire'],
  ['R', 'Reload'],
  ['Home', 'Restart the preview'],
  ['W / E', 'Gizmo: move / rotate'],
  ['1 / 2 / 3', 'Sprite editor / particle editor / weapon preview'],
  ['Delete', 'Delete the selected layer or attachment point'],
  ['Ctrl+D', 'Duplicate the selected emitter'],
  ['?', 'This list'],
];

export function ShortcutsDialog() {
  const open = useUi((s) => s.dialog === 'shortcuts');
  const close = useUi((s) => s.closeDialog);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} title="Keyboard shortcuts">
      <table className="w-full text-[12px]">
        <tbody>
          {SHORTCUTS.map(([k, d]) => (
            <tr key={k} className="border-b border-lines last:border-0">
              <td className="w-48 py-1.5"><Kbd>{k}</Kbd></td>
              <td className="py-1.5 text-muted">{d}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}

/* --------------------------------------------------------------------- about */

export function AboutDialog() {
  const open = useUi((s) => s.dialog === 'about');
  const close = useUi((s) => s.closeDialog);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} title="About VFXForge" description="Weapon particle effect studio for FiveM">
      <div className="space-y-3 text-[12px] leading-relaxed text-muted">
        <p className="text-fg">VFXForge turns images and video into animated spritesheets, lets you build particle effects around them, previews those effects on a weapon, and exports a validated FiveM resource.</p>
        <div>
          <p className="mb-1 font-medium text-fg">Verified</p>
          <ul className="list-disc space-y-0.5 pl-5">
            <li>Media → spritesheet → PNG / DDS (BC1, BC3, BGRA8; DDS files are validated).</li>
            <li>Generated <code>.ypt.xml</code> is schema-checked and converted to a binary <code>.ypt</code> by CodeWalker, which re-reads it to confirm the structure.</li>
            <li>The generated Lua is syntax-checked and its behaviour (no duplicate loops, cleanup on weapon switch, no per-frame polling) is tested against a mocked FiveM runtime.</li>
          </ul>
        </div>
        <div>
          <p className="mb-1 font-medium text-fg">Not verifiable outside the game</p>
          <ul className="list-disc space-y-0.5 pl-5">
            <li>How GTA V renders the exported particle rules (several engine values are inferred and labelled so in the fidelity report).</li>
            <li>How a flipbook frame id maps to a UV rectangle in the engine (clip-region data).</li>
            <li>The 3D preview is a WebGL approximation, not GTA V&apos;s renderer.</li>
          </ul>
        </div>
      </div>
    </Dialog>
  );
}

export function Dialogs() {
  return (
    <>
      <SettingsDialog />
      <NewProjectDialog />
      <OpenProjectDialog />
      <RecoveryDialog />
      <ShortcutsDialog />
      <AboutDialog />
    </>
  );
}
