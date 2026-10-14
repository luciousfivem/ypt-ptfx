import { Settings2, Sparkles } from 'lucide-react';
import { useEffect } from 'react';
import { EmptyState, PanelFrame, Tabs } from '../components/ui';
import { useProject } from '../state/project';
import { useUi } from '../state/ui';
import { ClipInspector } from './inspectors/ClipInspector';
import { Note } from './inspectors/common';
import { EmitterInspector } from './inspectors/EmitterInspector';
import { AssetInspector, ClipSheetsList, EffectInspector, ExportSettingsPanel, SheetFooter } from './inspectors/ProjectInspectors';
import { SheetInspector } from './inspectors/SheetInspector';
import { AttachmentInspector, WeaponInspector } from './inspectors/WeaponInspector';

export function Inspector() {
  const selection = useUi((s) => s.selection);
  const tab = useUi((s) => s.rightTab);
  const setTab = useUi((s) => s.setRightTab);
  const mode = useUi((s) => s.mode);
  const exists = useProject((s) => {
    const sel = selection;
    switch (sel.kind) {
      case 'asset': return !!s.project.assets[sel.id];
      case 'clip': return !!s.project.clips[sel.id];
      case 'sheet': return !!s.project.sheets[sel.id];
      case 'effect': return !!s.project.effects[sel.id];
      case 'emitter': return !!s.project.effects[sel.effectId]?.emitters.some((e) => e.id === sel.id);
      case 'attachment': return s.project.weapon.attachments.some((a) => a.id === sel.id);
      default: return true;
    }
  });

  // selecting something always brings the matching inspector forward
  useEffect(() => {
    if (selection.kind === 'weapon') setTab('weapon');
    else if (selection.kind !== 'none') setTab('inspect');
  }, [selection, setTab]);
  useEffect(() => {
    if (mode === 'weapon') setTab('weapon');
  }, [mode, setTab]);

  return (
    <PanelFrame title="Inspector" bodyClassName="flex flex-col overflow-hidden">
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as typeof tab)}
        tabs={[
          { value: 'inspect', label: 'Inspector' },
          { value: 'weapon', label: 'Weapon' },
          { value: 'export', label: 'Export' },
        ]}
      />
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="inspector-body">
        {tab === 'weapon' && (selection.kind === 'attachment' && exists ? <><AttachmentInspector id={selection.id} /><WeaponInspector /></> : <WeaponInspector />)}
        {tab === 'export' && <ExportSettingsPanel />}
        {tab === 'inspect' && (!exists ? <Note>That item no longer exists.</Note> : <Selected />)}
      </div>
    </PanelFrame>
  );
}

function Selected() {
  const sel = useUi((s) => s.selection);
  switch (sel.kind) {
    case 'asset':
      return <AssetInspector id={sel.id} />;
    case 'clip':
      return (
        <>
          <ClipInspector clipId={sel.id} />
          <ClipSheetsList clipId={sel.id} />
        </>
      );
    case 'sheet':
      return (
        <>
          <SheetInspector sheetId={sel.id} />
          <SheetFooter sheetId={sel.id} />
        </>
      );
    case 'effect':
      return <EffectInspector id={sel.id} />;
    case 'emitter':
      return (
        <>
          <EffectInspector id={sel.effectId} />
          <EmitterInspector effectId={sel.effectId} emitterId={sel.id} />
        </>
      );
    case 'attachment':
      return <AttachmentInspector id={sel.id} />;
    case 'weapon':
      return <WeaponInspector />;
    default:
      return (
        <EmptyState icon={<Sparkles className="size-8" aria-hidden />} title="Nothing selected">
          Pick a preset from the library, an effect in Layers, or a clip in Assets to edit it here.
          <span className="mt-2 flex items-center justify-center gap-1 text-dim">
            <Settings2 className="size-3.5" aria-hidden /> Resource and weapon settings are on the Export and Weapon tabs.
          </span>
        </EmptyState>
      );
  }
}
