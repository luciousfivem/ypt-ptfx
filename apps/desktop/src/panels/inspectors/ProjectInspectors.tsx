import { isValidIdentifier, sanitizeIdentifier, uniqueName } from '@vfxforge/core';
import { WEAPON_PRESET_NAMES, isWeaponName, weaponHash } from '@vfxforge/fivem';
import { Box, Copy, Film, Plus, Share2, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Field, Section, SelectField, Segmented, TextField } from '../../components/ui';
import { assetUsage, createClipFromAsset, deleteAsset, deleteClip, deleteEffect, deleteSheet, duplicateEffect, exportEffectPackage, addSheetForClip } from '../../services/actions';
import { editProject, getProject, useProject } from '../../state/project';
import { useUi } from '../../state/ui';
import { Note } from './common';
import { useShallow } from 'zustand/react/shallow';

export function AssetInspector({ id }: { id: string }) {
  const asset = useProject((s) => s.project.assets[id]);
  const select = useUi((s) => s.select);
  if (!asset) return <Note>This asset no longer exists.</Note>;
  const uses = assetUsage(getProject(), id);
  const hasClip = Object.values(getProject().clips).some((c) => c.assetId === id);
  return (
    <Section title="Imported asset">
      <Field label="Name"><span className="truncate text-[12px] text-fg">{asset.name}</span></Field>
      <Field label="Type"><span className="text-[12px] text-fg">{asset.kind} · {asset.mime}</span></Field>
      {asset.info && <Field label="Size"><span className="text-[12px] text-fg">{asset.info.width}×{asset.info.height}{asset.info.durationSec ? ` · ${asset.info.durationSec.toFixed(2)} s` : ''}{asset.info.hasAlpha ? ' · alpha' : ''}</span></Field>}
      <Field label="File"><span className="text-[12px] text-fg">{(asset.bytes / 1048576).toFixed(2)} MiB</span></Field>
      <Field label="SHA-256"><span className="break-all font-mono text-[10px] text-dim">{asset.sha256.slice(0, 32)}…</span></Field>
      <Note>{uses.length ? `Used by ${uses.join(', ')}.` : 'Not used yet.'} The original file is stored unchanged, addressed by its hash.</Note>
      <div className="flex flex-wrap gap-1">
        {asset.kind !== 'model' && !hasClip && (
          <Button
            size="sm"
            icon={<Film className="size-3.5" aria-hidden />}
            onClick={() => {
              const { clip, sheet } = createClipFromAsset(asset);
              editProject('Create clip', (d) => {
                d.clips[clip.id] = clip;
                d.sheets[sheet.id] = { ...sheet, textureName: uniqueName(sheet.textureName, new Set(Object.values(d.sheets).map((s) => s.textureName))) };
              });
              select({ kind: 'clip', id: clip.id });
              useUi.getState().setMode('sprite');
            }}
          >
            Create clip
          </Button>
        )}
        {asset.kind === 'model' && (
          <Button size="sm" icon={<Box className="size-3.5" aria-hidden />} onClick={() => editProject('Use as weapon', (d) => void ((d.weapon.modelAssetId = id), (d.weapon.preset = 'custom')))}>
            Use as preview weapon
          </Button>
        )}
        <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" aria-hidden />} onClick={() => deleteAsset(id)}>Remove</Button>
      </div>
    </Section>
  );
}

export function ClipSheetsList({ clipId }: { clipId: string }) {
  const sheets = useProject(useShallow((s) => Object.values(s.project.sheets).filter((x) => x.clipId === clipId)));
  const select = useUi((s) => s.select);
  return (
    <Section title="Spritesheets from this clip">
      {sheets.length === 0 && <Note tone="warn">No spritesheet yet: an emitter needs one.</Note>}
      <ul className="space-y-0.5">
        {sheets.map((s) => (
          <li key={s.id}>
            <button type="button" onClick={() => select({ kind: 'sheet', id: s.id })} className="flex h-7 w-full items-center justify-between rounded-md px-2 text-left text-[12px] hover:bg-raised">
              <span className="truncate">{s.name}</span>
              <span className="text-[10.5px] text-dim">{s.grid.cols}×{s.grid.rows} · {s.texture.width}px · {s.dds.format}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-1">
        <Button size="xs" icon={<Plus className="size-3" aria-hidden />} onClick={() => addSheetForClip(clipId)}>New spritesheet</Button>
        <Button size="xs" variant="danger" icon={<Trash2 className="size-3" aria-hidden />} onClick={() => deleteClip(clipId)}>Delete clip</Button>
      </div>
    </Section>
  );
}

export function SheetFooter({ sheetId }: { sheetId: string }) {
  return (
    <Section title="Manage" defaultOpen={false}>
      <Button size="xs" variant="danger" icon={<Trash2 className="size-3" aria-hidden />} onClick={() => deleteSheet(sheetId)}>Delete spritesheet</Button>
    </Section>
  );
}

export function EffectInspector({ id }: { id: string }) {
  const fx = useProject((s) => s.project.effects[id]);
  const names = useProject(useShallow((s) => Object.values(s.project.effects).filter((e) => e.id !== id).map((e) => e.ptfxName)));
  if (!fx) return <Note>This effect no longer exists.</Note>;
  const dup = names.includes(fx.ptfxName);
  const set = (label: string, key: string, fn: (e: typeof fx) => void) =>
    editProject(label, (d) => {
      const e = d.effects[id];
      if (e) fn(e);
    }, { coalesceKey: `fx:${id}:${key}` });
  return (
    <Section title="Effect">
      <Field label="Name"><TextField value={fx.name} maxLength={120} onChange={(v) => v.trim() && set('Rename effect', 'name', (e) => void (e.name = v))} /></Field>
      <Field label="Rule name" hint={dup ? 'Another effect uses this name.' : 'The effect rule name inside the YPT (lowercase identifier).'}>
        <TextField mono invalid={!isValidIdentifier(fx.ptfxName) || dup} value={fx.ptfxName} maxLength={48} onChange={(v) => set('Rule name', 'rule', (e) => void (e.ptfxName = sanitizeIdentifier(v, 'custom_fx')))} />
      </Field>
      <Note>{fx.emitters.length} emitter{fx.emitters.length === 1 ? '' : 's'}. Emitters with different triggers or loop behaviour are exported as separate effect rules automatically.</Note>
      <div className="flex flex-wrap gap-1">
        <Button size="sm" icon={<Copy className="size-3.5" aria-hidden />} onClick={() => duplicateEffect(id)}>Duplicate</Button>
        <Button size="sm" icon={<Share2 className="size-3.5" aria-hidden />} onClick={() => void exportEffectPackage([id])}>Share as preset…</Button>
        <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" aria-hidden />} onClick={() => deleteEffect(id)}>Delete</Button>
      </div>
    </Section>
  );
}

export function ExportSettingsPanel() {
  const exp = useProject((s) => s.project.export);
  const [weaponInput, setWeaponInput] = useState('');
  const set = (label: string, key: string, fn: (e: typeof exp) => void) => editProject(label, (d) => fn(d.export), { coalesceKey: `export:${key}` });
  const normalized = weaponInput.trim().toUpperCase().replace(/\s+/g, '_');
  const weaponOk = isWeaponName(normalized);
  const addWeapon = (name: string) => {
    if (!isWeaponName(name) || exp.weapons.includes(name)) return;
    set('Add weapon', 'weapons', (e) => void e.weapons.push(name));
    setWeaponInput('');
  };
  return (
    <div>
      <Section title="Resource">
        <Field label="Resource name" hint="The FiveM resource folder name (lowercase identifier).">
          <TextField mono invalid={!isValidIdentifier(exp.resourceName)} value={exp.resourceName} maxLength={48} onChange={(v) => set('Resource name', 'res', (e) => void (e.resourceName = v.toLowerCase().replace(/[^a-z0-9_]/g, '_')))} />
        </Field>
        <Field label="PTFX asset" hint="Name of the .ypt the script requests (UseParticleFxAsset).">
          <TextField mono invalid={!isValidIdentifier(exp.assetName)} value={exp.assetName} maxLength={48} onChange={(v) => set('Asset name', 'asset', (e) => void (e.assetName = v.toLowerCase().replace(/[^a-z0-9_]/g, '_')))} />
        </Field>
        <Field label="Author"><TextField value={exp.author} maxLength={80} onChange={(v) => set('Author', 'author', (e) => void (e.author = v))} /></Field>
      </Section>
      <Section title="Target">
        <Segmented
          label="Game target"
          value={exp.target}
          options={[{ value: 'fivem-legacy', label: 'FiveM Legacy', title: 'GTA V Legacy (gen8): RSC7 v68' }, { value: 'fivem-enhanced', label: 'Enhanced (gen9)' }]}
          onChange={(v) => set('Target', 'target', (e) => void (e.target = v))}
        />
        <Note>{exp.target === 'fivem-legacy' ? 'Legacy builds read the standard gen8 YPT; this is the best-tested path (binary verified by CodeWalker).' : 'Enhanced (gen9) binaries are produced by CodeWalker and re-read to verify the structure; in-game behaviour on Enhanced has not been verified.'}</Note>
        <Field label="YPT build">
          <Segmented label="YPT build strategy" value={exp.yptStrategy} options={[{ value: 'generate', label: 'Generate' }, { value: 'donor', label: 'Donor template' }]} onChange={(v) => set('YPT strategy', 'strat', (e) => void (e.yptStrategy = v))} />
        </Field>
        <Note>{exp.yptStrategy === 'generate' ? 'Generate writes the particle rules from scratch. Their in-game rendering is UNVERIFIED.' : 'Donor patches an existing .ypt.xml (exported from CodeWalker from a PTFX that renders in your game) so only textures, timing and colours change. Load the donor in the Export dialog.'}</Note>
      </Section>
      <Section title="Weapons">
        <div className="flex flex-wrap gap-1">
          {exp.weapons.map((w) => (
            <Badge key={w} tone="accent" className="gap-1">
              <span className="font-mono">{w}</span>
              <button type="button" aria-label={`Remove ${w}`} onClick={() => set('Remove weapon', 'weapons', (e) => void (e.weapons = e.weapons.filter((x) => x !== w)))}>
                <X className="size-3" aria-hidden />
              </button>
            </Badge>
          ))}
          {exp.weapons.length === 0 && <Note>Empty: the effects play for ANY weapon the player holds.</Note>}
        </div>
        <div className="flex gap-1">
          <TextField mono value={weaponInput} placeholder="WEAPON_…" invalid={weaponInput !== '' && !weaponOk} onChange={setWeaponInput} onKeyDown={(e) => e.key === 'Enter' && addWeapon(normalized)} />
          <Button size="sm" disabled={!weaponOk || exp.weapons.includes(normalized)} onClick={() => addWeapon(normalized)}>Add</Button>
        </div>
        <SelectField
          value="__pick"
          options={[{ value: '__pick', label: 'Add a common weapon…' }, ...Object.values(WEAPON_PRESET_NAMES).flat().map((n) => ({ value: n, label: n }))]}
          onChange={(v) => v !== '__pick' && addWeapon(v)}
        />
        {weaponOk && <Note>Hash: {weaponHash(normalized).hex} (joaat)</Note>}
        <Note>Names are only checked for shape. Custom/add-on weapons are common; make sure the name exists on your server.</Note>
      </Section>
    </div>
  );
}
