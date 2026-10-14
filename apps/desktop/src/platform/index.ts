import { createBrowserPlatform } from './browser';
import type { Platform } from './types';

export * from './types';

let instance: Platform | null = null;

/** Picks the Tauri implementation inside the desktop shell, otherwise the browser one. */
export async function getPlatform(): Promise<Platform> {
  if (instance) return instance;
  const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  if (inTauri) {
    const { createTauriPlatform } = await import('./tauri');
    instance = await createTauriPlatform();
  } else {
    instance = createBrowserPlatform();
  }
  return instance;
}

/** Test seam: install a platform without touching globals. */
export function setPlatform(p: Platform): void {
  instance = p;
}
