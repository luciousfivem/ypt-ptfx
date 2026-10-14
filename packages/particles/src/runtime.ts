/**
 * Weapon-event simulation: what the generated FiveM script will DO at runtime.
 *
 * It deliberately mirrors `packages/fivem/templates/client.lua`:
 *  - looped emitters (continuous + loop) start once on their trigger and are never duplicated,
 *  - one-shot emitters start a fresh instance per trigger, throttled per emitter,
 *  - switching the weapon away stops every looped instance immediately,
 *  - 'switched' + 'equipped' + 'idle' fire when a tracked weapon is selected,
 *  - 'reloaded' fires once per reload, 'manual' only when asked.
 *
 * so the preview's "fire / reload / switch" buttons show the behaviour the script implements.
 */
import { startsLooped, type Emitter, type Project, type TriggerEvent } from '@vfxforge/core';
import { IDENTITY_FRAME, ParticleSim, type EmitterFrame } from './sim';

export interface RuntimeInstance {
  id: number;
  effectId: string;
  emitter: Emitter;
  sim: ParticleSim;
  looped: boolean;
}

export interface RuntimeOptions {
  /** Number of frames in an emitter's spritesheet (the sheet is generated elsewhere). */
  frameCountOf: (emitter: Emitter) => number;
  /** Minimum time between one-shot starts of the same emitter (mirrors Config minIntervalMs). */
  minIntervalMs?: number;
}

export class RuntimeSimulator {
  instances: RuntimeInstance[] = [];
  equipped = false;
  private nextId = 1;
  private clockMs = 0;
  private lastStart = new Map<string, number>();
  private readonly minInterval: number;

  constructor(
    private project: Project,
    private readonly opts: RuntimeOptions,
  ) {
    this.minInterval = opts.minIntervalMs ?? 50;
  }

  /** Swap in an edited project without losing running instances' timing. */
  setProject(project: Project): void {
    this.project = project;
  }

  reset(): void {
    this.instances = [];
    this.equipped = false;
    this.clockMs = 0;
    this.lastStart.clear();
  }

  /* ---- weapon events ---- */

  equip(): void {
    if (this.equipped) return;
    this.equipped = true;
    this.trigger('switched');
    this.trigger('equipped');
    this.trigger('idle');
  }

  /** Putting the weapon away stops looped effects immediately; one-shots run out naturally. */
  switchAway(): void {
    this.equipped = false;
    this.instances = this.instances.filter((i) => !i.looped);
  }

  fire(): void {
    if (this.equipped) this.trigger('fired');
  }

  reload(): void {
    if (this.equipped) this.trigger('reloaded');
  }

  /** Script-triggered effects (`exports[res]:PlayEffect`), independent of weapon state. */
  manual(): void {
    this.trigger('manual');
  }

  trigger(event: TriggerEvent): void {
    for (const effect of Object.values(this.project.effects)) {
      for (const emitter of effect.emitters) {
        if (!emitter.enabled || !emitter.triggers.includes(event)) continue;
        this.start(effect.id, emitter);
      }
    }
  }

  private start(effectId: string, emitter: Emitter): void {
    const looped = startsLooped(emitter);
    if (looped) {
      if (this.instances.some((i) => i.emitter.id === emitter.id && i.looped)) return; // never duplicate a loop
    } else {
      const last = this.lastStart.get(emitter.id);
      if (last !== undefined && this.clockMs - last < this.minInterval) return; // throttle
      this.lastStart.set(emitter.id, this.clockMs);
    }
    // a one-shot start plays its window once even if the emitter's own `loop` flag is set
    const em: Emitter = looped ? emitter : { ...emitter, emission: { ...emitter.emission, loop: false } };
    this.instances.push({
      id: this.nextId++,
      effectId,
      emitter: em,
      sim: new ParticleSim(em, { frameCount: this.opts.frameCountOf(em) }),
      looped,
    });
  }

  /* ---- time ---- */

  update(dt: number, frameFor: (attachmentId: string | null) => EmitterFrame = () => IDENTITY_FRAME): void {
    this.clockMs += dt * 1000;
    for (const inst of this.instances) inst.sim.step(dt, frameFor(inst.emitter.attachmentId));
    this.instances = this.instances.filter((i) => !i.sim.finished);
  }

  get liveParticles(): number {
    return this.instances.reduce((s, i) => s + i.sim.count, 0);
  }
}
