import type { Platform } from '../platform';
import type { EngineClient } from './engine';

export interface AppServices {
  platform: Platform;
  engine: EngineClient;
}

let current: AppServices | null = null;

export function setServices(s: AppServices | null): void {
  current = s;
}

export function svc(): AppServices {
  if (!current) throw new Error('The application services are not initialised yet.');
  return current;
}

export function maybeSvc(): AppServices | null {
  return current;
}
