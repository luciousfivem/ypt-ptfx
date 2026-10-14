import { useEffect } from 'react';
import { deleteAttachment, deleteEmitter, duplicateEmitter, newProject, pickAndImport, saveProject } from '../services/actions';
import { useProject } from '../state/project';
import { runtimeCommands, useRuntime } from '../state/runtime';
import { toast, useUi } from '../state/ui';

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
};

/** Global shortcuts. Plain-letter shortcuts never fire while typing; Ctrl combos for undo/redo defer to text fields. */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUi.getState();
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const inField = typing(e.target);
      const dialogOpen = ui.dialog !== 'none';

      if (mod) {
        if (key === 's') {
          e.preventDefault();
          void saveProject();
        } else if (key === 'o') {
          e.preventDefault();
          ui.openDialog('open');
        } else if (key === 'n') {
          e.preventDefault();
          ui.openDialog('new');
        } else if (key === 'i') {
          e.preventDefault();
          void pickAndImport();
        } else if (key === 'e') {
          e.preventDefault();
          ui.openDialog('export');
        } else if (key === 'z' && !inField && !dialogOpen) {
          e.preventDefault();
          if (e.shiftKey) useProject.getState().redo();
          else useProject.getState().undo();
        } else if (key === 'y' && !inField && !dialogOpen) {
          e.preventDefault();
          useProject.getState().redo();
        } else if (key === 'd' && !inField && !dialogOpen) {
          const sel = ui.selection;
          if (sel.kind === 'emitter') {
            e.preventDefault();
            duplicateEmitter(sel.effectId, sel.id);
          }
        }
        return;
      }
      if (inField || dialogOpen || e.altKey) return;

      switch (key) {
        case ' ':
          e.preventDefault();
          runtimeCommands.toggle();
          break;
        case 'f':
          runtimeCommands.fire();
          break;
        case 'r':
          runtimeCommands.reload();
          break;
        case 'home':
          runtimeCommands.restart();
          break;
        case 'w':
          useRuntime.getState().viewport?.setGizmoMode('translate');
          useRuntime.getState().set({ gizmo: 'translate' });
          break;
        case 'e':
          useRuntime.getState().viewport?.setGizmoMode('rotate');
          useRuntime.getState().set({ gizmo: 'rotate' });
          break;
        case '1':
          ui.setMode('sprite');
          break;
        case '2':
          ui.setMode('particles');
          break;
        case '3':
          ui.setMode('weapon');
          break;
        case '?':
          ui.openDialog('shortcuts');
          break;
        case 'delete':
        case 'backspace': {
          const sel = ui.selection;
          if (sel.kind === 'emitter') {
            if (ui.settings.confirmDestructive && !window.confirm('Delete this layer?')) return;
            deleteEmitter(sel.effectId, sel.id);
          } else if (sel.kind === 'attachment') {
            if (ui.settings.confirmDestructive && !window.confirm('Delete this attachment point?')) return;
            deleteAttachment(sel.id);
          } else toast('info', 'Select a layer or an attachment point first.');
          break;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  void newProject;
}
