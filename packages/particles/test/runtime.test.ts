import { createEffect, createEmitter, createProject, type Emitter, type Project, type TriggerEvent } from '@vfxforge/core';
import { describe, expect, it } from 'vitest';
import { RuntimeSimulator } from '../src';

function emitterWith(name: string, triggers: TriggerEvent[], over: (e: Emitter) => void = () => {}): Emitter {
  const e = createEmitter(name, null);
  e.triggers = triggers;
  e.emission.maxParticles = 500;
  over(e);
  return e;
}

function projectWith(...emitters: Emitter[]): Project {
  const p = createProject('t');
  const fx = createEffect('fx');
  fx.emitters.push(...emitters);
  p.effects[fx.id] = fx;
  return p;
}

const burst = (n: string, triggers: TriggerEvent[]) =>
  emitterWith(n, triggers, (e) => { e.emission.mode = 'burst'; e.emission.burstCount = 4; e.emission.duration = 0.3; e.emission.loop = false; e.emission.lifetime = { min: 0.2, max: 0.2 }; });
const aura = (n: string, triggers: TriggerEvent[]) =>
  emitterWith(n, triggers, (e) => { e.emission.mode = 'continuous'; e.emission.rate = 20; e.emission.loop = true; e.emission.lifetime = { min: 0.5, max: 0.5 }; });

const make = (p: Project, minIntervalMs = 50) => new RuntimeSimulator(p, { frameCountOf: () => 16, minIntervalMs });
const run = (r: RuntimeSimulator, s: number) => { for (let t = 0; t < s - 1e-9; t += 1 / 60) r.update(1 / 60); };

describe('RuntimeSimulator mirrors the generated Lua', () => {
  it('nothing happens until a tracked weapon is equipped', () => {
    const r = make(projectWith(burst('b', ['fired']), aura('a', ['idle'])));
    r.fire();
    r.reload();
    run(r, 0.5);
    expect(r.instances).toHaveLength(0);
    r.equip();
    expect(r.instances.map((i) => i.emitter.name)).toEqual(['a']); // the idle loop starts; one-shot waits for fire
  });

  it('fire starts a one-shot per shot, throttled like Config.minIntervalMs', () => {
    const r = make(projectWith(burst('b', ['fired'])), 100);
    r.equip();
    r.fire();
    r.fire(); // same instant -> throttled
    expect(r.instances).toHaveLength(1);
    run(r, 0.12);
    r.fire();
    expect(r.instances.length).toBeGreaterThanOrEqual(1);
    expect(r.instances.filter((i) => !i.sim.finished).length).toBeLessThanOrEqual(2);
  });

  it('one-shot instances finish and are removed', () => {
    const r = make(projectWith(burst('b', ['fired'])));
    r.equip();
    r.fire();
    run(r, 1);
    expect(r.instances).toHaveLength(0);
    expect(r.liveParticles).toBe(0);
  });

  it('a burst emitter whose loop flag is set still plays ONCE per trigger (loop = repeat is not exportable)', () => {
    const e = burst('b', ['fired']);
    e.emission.loop = true;
    const r = make(projectWith(e));
    r.equip();
    r.fire();
    run(r, 2);
    expect(r.instances).toHaveLength(0);
  });

  it('looped effects are never duplicated, even if triggered repeatedly', () => {
    const r = make(projectWith(aura('a', ['idle', 'fired', 'manual'])));
    r.equip();
    r.fire();
    r.fire();
    r.manual();
    r.equip();
    expect(r.instances.filter((i) => i.looped)).toHaveLength(1);
  });

  it('switching away stops loops immediately but lets one-shots finish', () => {
    const r = make(projectWith(aura('a', ['idle']), burst('b', ['fired'])));
    r.equip();
    r.fire();
    run(r, 0.05);
    expect(r.instances.map((i) => i.emitter.name).sort()).toEqual(['a', 'b']);
    r.switchAway();
    expect(r.instances.map((i) => i.emitter.name)).toEqual(['b']);
    run(r, 1);
    expect(r.instances).toHaveLength(0);
    r.fire(); // unarmed: ignored
    expect(r.instances).toHaveLength(0);
  });

  it('re-equipping restarts the idle loop', () => {
    const r = make(projectWith(aura('a', ['idle'])));
    r.equip();
    r.switchAway();
    expect(r.instances).toHaveLength(0);
    r.equip();
    expect(r.instances).toHaveLength(1);
    const first = r.instances[0]!.id;
    r.switchAway();
    r.equip();
    expect(r.instances[0]!.id).not.toBe(first);
  });

  it('equip fires switched + equipped + idle triggers; reload fires reloaded; manual works unarmed', () => {
    const r = make(projectWith(burst('sw', ['switched']), burst('eq', ['equipped']), burst('rl', ['reloaded']), burst('mn', ['manual'])));
    r.manual();
    expect(r.instances.map((i) => i.emitter.name)).toEqual(['mn']);
    r.reset();
    r.equip();
    expect(r.instances.map((i) => i.emitter.name).sort()).toEqual(['eq', 'sw']);
    r.reload();
    expect(r.instances.map((i) => i.emitter.name)).toContain('rl');
  });

  it('disabled emitters are ignored and the project can be edited live', () => {
    const e = burst('b', ['fired']);
    e.enabled = false;
    const p = projectWith(e);
    const r = make(p);
    r.equip();
    r.fire();
    expect(r.instances).toHaveLength(0);
    const edited = structuredClone(p);
    Object.values(edited.effects)[0]!.emitters[0]!.enabled = true;
    r.setProject(edited);
    r.fire();
    expect(r.instances).toHaveLength(1);
  });

  it('passes the attachment frame to world-space emitters', () => {
    const e = aura('w', ['idle']);
    e.transform.space = 'world';
    e.attachmentId = 'att';
    e.physics.speed = { min: 0, max: 0 };
    const r = make(projectWith(e));
    r.equip();
    const seen: Array<string | null> = [];
    for (let i = 0; i < 30; i++) r.update(1 / 60, (id) => { seen.push(id); return { position: [i * 0.1, 0, 0], rotation: [0, 0, 0] }; });
    expect(seen.every((s) => s === 'att')).toBe(true);
    const xs = Array.from({ length: r.instances[0]!.sim.count }, (_, i) => r.instances[0]!.sim.snapshot(i).pos[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(1);
  });
});

describe('RuntimeSimulator live edits', () => {
  it('re-simulates a changed emitter deterministically at the same time', () => {
    const a = aura('a', ['idle']);
    const p1 = projectWith(a);
    const r = make(p1);
    r.equip();
    run(r, 0.4);
    const before = r.instances[0]!;
    expect(before.sim.time).toBeCloseTo(0.4, 1);
    const p2 = structuredClone(p1);
    const eff = Object.values(p2.effects)[0]!;
    eff.emitters[0]!.emission.rate = 100;
    r.setProject(p2);
    const after = r.instances[0]!;
    expect(after).not.toBe(before);
    expect(after.sim.time).toBeCloseTo(before.sim.time, 1);
    expect(after.sim.count).toBeGreaterThan(before.sim.count); // higher rate shows immediately
    // an identical re-seek reproduces the same particle count as a fresh run to that time
    const fresh = make(p2);
    fresh.equip();
    run(fresh, 0.4);
    expect(after.sim.count).toBe(fresh.instances[0]!.sim.count);
  });

  it('keeps untouched instances, drops removed/disabled ones', () => {
    const a = aura('a', ['idle']);
    const b = aura('b', ['idle']);
    const p1 = projectWith(a, b);
    const r = make(p1);
    r.equip();
    run(r, 0.2);
    const keep = r.instances.find((i) => i.emitter.name === 'a')!;
    const p2 = structuredClone(p1);
    const eff = Object.values(p2.effects)[0]!;
    eff.emitters[1]!.enabled = false;
    // structuredClone breaks identity, so reuse the original object for the untouched emitter
    eff.emitters[0] = a;
    r.setProject(p2);
    expect(r.instances.map((i) => i.emitter.name)).toEqual(['a']);
    expect(r.instances[0]).toBe(keep);
  });

  it('does not duplicate a loop after an edit, and the edited loop keeps running', () => {
    const p1 = projectWith(aura('a', ['idle']));
    const r = make(p1);
    r.equip();
    const p2 = structuredClone(p1);
    Object.values(p2.effects)[0]!.emitters[0]!.particle.glow = 3;
    r.setProject(p2);
    r.equip(); // already equipped: no-op
    r.trigger('idle');
    expect(r.instances).toHaveLength(1);
  });

  it('follows a spritesheet frame-count change', () => {
    let frames = 16;
    const r = new RuntimeSimulator(projectWith(aura('a', ['idle'])), { frameCountOf: () => frames });
    r.equip();
    frames = 4;
    r.refreshFrameCounts();
    expect(r.instances[0]!.sim.cfg.frameCount).toBe(4);
  });

  it('starts an idle emitter added while the weapon is held, but never replays shots', () => {
    const p1 = projectWith(burst('b', ['fired']));
    const r = make(p1);
    r.equip();
    expect(r.instances).toHaveLength(0);
    const p2 = structuredClone(p1);
    const fx = Object.values(p2.effects)[0]!;
    fx.emitters.push(aura('a', ['idle']), burst('b2', ['fired']));
    r.setProject(p2);
    expect(r.instances.map((i) => i.emitter.name)).toEqual(['a']);
  });

  it('starts an emitter when it is re-enabled or gains an idle trigger, and not when holstered', () => {
    const a = aura('a', ['fired']);
    const p1 = projectWith(a);
    const r = make(p1);
    r.equip();
    expect(r.instances).toHaveLength(0);
    const p2 = structuredClone(p1);
    Object.values(p2.effects)[0]!.emitters[0]!.triggers = ['fired', 'idle'];
    r.setProject(p2);
    expect(r.instances).toHaveLength(1);
    r.switchAway();
    const p3 = structuredClone(p2);
    Object.values(p3.effects)[0]!.emitters[0]!.enabled = false;
    r.setProject(p3);
    const p4 = structuredClone(p3);
    Object.values(p4.effects)[0]!.emitters[0]!.enabled = true;
    r.setProject(p4);
    expect(r.instances).toHaveLength(0); // holstered: nothing starts until the weapon is equipped again
    r.equip();
    expect(r.instances).toHaveLength(1);
  });
});
