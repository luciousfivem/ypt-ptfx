import { useEffect } from 'react';
import { svc } from '../services/app';
import { useProject } from '../state/project';
import { useUi } from '../state/ui';

/** Periodic recoverable snapshots while there are unsaved changes, plus one when the window is hidden or closing. */
export function useAutosave(): void {
  const seconds = useUi((s) => s.settings.autosaveSeconds);
  useEffect(() => {
    let lastRev = -1;
    const snapshot = async () => {
      const { dirty, project, rev } = useProject.getState();
      if (!dirty || rev === lastRev) return;
      try {
        await svc().platform.projects.autosave(project);
        lastRev = rev;
      } catch (e) {
        console.warn('Autosave failed', e);
      }
    };
    const timer = setInterval(() => void snapshot(), seconds * 1000);
    const onHide = () => {
      if (document.visibilityState === 'hidden') void snapshot();
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      void snapshot();
      if (useProject.getState().dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [seconds]);
}
