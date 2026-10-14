import { createBrowserPlatform } from './browser';
import type { Platform } from './types';

export * from './types';

let instance: Platform | null = null;

/** Picks the Tauri implementation inside the desktop shell, otherwise the browser one. */
export async function getPlatform(): Promise<Platform> {
  if (instance) return instance;
  const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  if (inTauri) {
    const [{ createTauriPlatform }, { useProject }] = await Promise.all([import('./tauri'), import('../state/project')]);
    instance = await createTauriPlatform({ activeProjectId: () => useProject.getState().project.id });
  } else {
    instance = createBrowserPlatform();
  }
  return instance;
}

/** Test seam: install a platform without touching globals. */
export function setPlatform(p: Platform): void {
  instance = p;
}
