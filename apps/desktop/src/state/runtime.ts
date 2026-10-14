import { create } from 'zustand';
import type { ModelInfo, ViewportEngine, ViewportStats } from '../viewport/engine';

interface RuntimeState {
  /** The live 3D engine (null until the viewport has mounted, or when WebGL is unavailable). */
  viewport: ViewportEngine | null;
  webgl: 'pending' | 'ok' | 'unsupported';
  stats: ViewportStats | null;
  modelInfo: ModelInfo | null;
  modelError: string | null;
  playing: boolean;
  equipped: boolean;
  autoFire: boolean;
  speed: number;
  gizmo: 'translate' | 'rotate';
  set: (p: Partial<Omit<RuntimeState, 'set'>>) => void;
}

export const useRuntime = create<RuntimeState>((set) => ({
  viewport: null,
  webgl: 'pending',
  stats: null,
  modelInfo: null,
  modelError: null,
  playing: true,
  equipped: true,
  autoFire: false,
  speed: 1,
  gizmo: 'translate',
  set: (p) => set(p),
}));

/** Weapon-event commands used by buttons and shortcuts. No-ops (with no error) when there is no viewport. */
export const runtimeCommands = {
  play(on: boolean) {
    const v = useRuntime.getState().viewport;
    v?.setPlaying(on);
    useRuntime.getState().set({ playing: on });
  },
  toggle() {
    runtimeCommands.play(!useRuntime.getState().playing);
  },
  restart() {
    useRuntime.getState().viewport?.restart();
  },
  fire() {
    useRuntime.getState().viewport?.fire();
  },
  reload() {
    useRuntime.getState().viewport?.reload();
  },
  manual() {
    useRuntime.getState().viewport?.manual();
  },
  equip(on: boolean) {
    const s = useRuntime.getState();
    s.viewport?.setEquipped(on);
    s.set({ equipped: on, autoFire: on ? s.autoFire : false });
  },
  autoFire(on: boolean) {
    const s = useRuntime.getState();
    s.viewport?.setAutoFire(on);
    s.set({ autoFire: on && s.equipped });
  },
  speed(v: number) {
    useRuntime.getState().viewport?.setSpeed(v);
    useRuntime.getState().set({ speed: v });
  },
};
