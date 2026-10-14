import type { Platform } from './types';

/** Replaced by the real implementation when the Tauri shell lands (see Task #10). */
export async function createTauriPlatform(): Promise<Platform> {
  throw new Error('The desktop shell is not built into this bundle.');
}
