import { createEmitter, linearCurve, type Emitter } from '@vfxforge/core';
import { describe, expect, it } from 'vitest';
import { GRAVITY, ParticleSim, createInstanceBuffers, noise3 } from '../src';

/** A bare emitter: no gravity/drag/spread/rotation, fixed lifetime, point shape, straight up. */
function bare(over: (e: Emitter) => void = () => {}): Emitter {
  const e = createEmitter('t', null);
  e.seed = 1234;
  e.shape = { type: 'point', size: [0, 0, 0], radius: 0, angle: 0, fromShell: false };
  e.physics.speed = { min: 2, max: 2 };
  e.physics.direction = [0, 1, 0];
  e.physics.spread = 0;
  e.physics.randomness = 0;
  e.physics.gravity = 0;
  e.physics.drag = 0;
  e.physics.acceleration = [0, 0, 0];
  e.physics.drift = [0, 0, 0];
  e.physics.turbulence = { strength: 0, frequency: 1 };
  e.emission.lifetime = { min: 1, max: 1 };
  e.emission.maxParticles = 5000;
  e.emission.startDelay = 0;
  e.emission.duration = 10;
  e.emission.loop = false;
  e.particle.size = { min: 0.1, max: 0.1 };
  e.particle.rotation = { min: 0, max: 0 };
  e.particle.angularVelocity = { min: 0, max: 0 };
  over(e);
  return e;
}

const run = (sim: ParticleSim, seconds: number, dt = 1 / 60) => {
  for (let t = 0; t < seconds - 1e-9; t += dt) sim.step(dt);
};

describe('emission', () => {
  it('continuous: spawns about rate × time particles', () => {
    const sim = new ParticleSim(bare((e) => { e.emission.mode = 'continuous'; e.emission.rate = 100; }), { frameCount: 1 });
    run(sim, 0.5);
    expect(sim.totalSpawned).toBeGreaterThanOrEqual(49);
    expect(sim.totalSpawned).toBeLessThanOrEqual(51);
    expect(sim.count).toBe(sim.totalSpawned); // all within their 1 s life
  });

  it('continuous: live count follows Little\'s law (rate × lifetime) in steady state', () => {
    const sim = new ParticleSim(bare((e) => { e.emission.mode = 'continuous'; e.emission.rate = 200; e.emission.lifetime = { min: 0.5, max: 0.5 }; e.emission.loop = true; }), { frameCount: 1 });
    run(sim, 3);
    expect(sim.count).toBeGreaterThanOrEqual(98);
    expect(sim.count).toBeLessThanOrEqual(102);
  });

  it('continuous: stops after `duration` when not looping, keeps going when looping', () => {
    const once = new ParticleSim(bare((e) => { e.emission.mode = 'continuous'; e.emission.rate = 100; e.emission.duration = 0.5; }), { frameCount: 1 });
    run(once, 2);
    expect(once.totalSpawned).toBeGreaterThanOrEqual(49);
    expect(once.totalSpawned).toBeLessThanOrEqual(51);
    expect(once.finished).toBe(true);
    const loop = new ParticleSim(bare((e) => { e.emission.mode = 'continuous'; e.emission.rate = 100; e.emission.duration = 0.5; e.emission.loop = true; }), { frameCount: 1 });
    run(loop, 2);
    expect(loop.totalSpawned).toBeGreaterThanOrEqual(199);
    expect(loop.finished).toBe(false);
  });

  it('honours startDelay exactly', () => {
    const sim = new ParticleSim(bare((e) => { e.emission.mode = 'continuous'; e.emission.rate = 100; e.emission.startDelay = 0.5; }), { frameCount: 1 });
    run(sim, 0.49);
    expect(sim.totalSpawned).toBe(0);
    run(sim, 0.2);
    expect(sim.totalSpawned).toBeGreaterThan(5);
  });

  it('burst: emits burstCount at t=0 and every interval inside the duration window', () => {
    const sim = new ParticleSim(bare((e) => { e.emission.mode = 'burst'; e.emission.burstCount = 7; e.emission.interval = 0.5; e.emission.duration = 2; }), { frameCount: 1 });
    run(sim, 0.01);
    expect(sim.totalSpawned).toBe(7);
    run(sim, 0.5);
    expect(sim.totalSpawned).toBe(14);
    run(sim, 5);
    expect(sim.totalSpawned).toBe(28); // bursts at 0, .5, 1, 1.5 — the one at t=2 is outside the window
    expect(sim.finished).toBe(true);
  });

  it('burst + loop repeats the window; one-shot fires once (or once per window when looping)', () => {
    const b = new ParticleSim(bare((e) => { e.emission.mode = 'burst'; e.emission.burstCount = 5; e.emission.interval = 0.5; e.emission.duration = 1; e.emission.loop = true; e.emission.lifetime = { min: 0.1, max: 0.1 }; }), { frameCount: 1 });
    run(b, 2.01);
    expect(b.totalSpawned).toBe(5 * 4 + 5); // t = 0, .5 | 1, 1.5 | 2
    const one = new ParticleSim(bare((e) => { e.emission.mode = 'oneShot'; e.emission.burstCount = 9; }), { frameCount: 1 });
    run(one, 3);
    expect(one.totalSpawned).toBe(9);
    const looped = new ParticleSim(bare((e) => { e.emission.mode = 'oneShot'; e.emission.burstCount = 9; e.emission.duration = 1; e.emission.loop = true; }), { frameCount: 1 });
    run(looped, 2.5);
    expect(looped.totalSpawned).toBe(27);
  });

  it('never exceeds maxParticles', () => {
    const sim = new ParticleSim(bare((e) => { e.emission.mode = 'continuous'; e.emission.rate = 1000; e.emission.maxParticles = 50; e.emission.lifetime = { min: 5, max: 5 }; }), { frameCount: 1 });
    run(sim, 2);
    expect(sim.count).toBe(50);
  });

  it('particles die when their lifetime ends', () => {
    const sim = new ParticleSim(bare((e) => { e.emission.mode = 'oneShot'; e.emission.burstCount = 20; e.emission.lifetime = { min: 0.2, max: 0.4 }; }), { frameCount: 1 });
    run(sim, 0.1);
    expect(sim.count).toBe(20);
    run(sim, 0.4);
    expect(sim.count).toBe(0);
  });
});

describe('physics (checked against analytic solutions)', () => {
  it('ballistic motion under gravity: y = v0·t − ½·g·t²', () => {
    const sim = new ParticleSim(bare((e) => { e.emission.mode = 'oneShot'; e.emission.burstCount = 1; e.physics.gravity = 1; e.physics.speed = { min: 5, max: 5 }; e.emission.lifetime = { min: 3, max: 3 }; }), { frameCount: 1 });
    run(sim, 1 / 60 + 1);
    const p = sim.snapshot(0);
    const t = p.age;
    const expected = 5 * t - 0.5 * GRAVITY * t * t;
    expect(p.pos[1]).toBeCloseTo(expected, 1);
    expect(p.vel[1]).toBeCloseTo(5 - GRAVITY * t, 1);
    expect(p.pos[0]).toBeCloseTo(0, 6);
  });

  it('gravity multiplier scales the pull linearly (and can be negative = buoyancy)', () => {
    const mk = (g: number) => {
      const sim = new ParticleSim(bare((e) => { e.emission.mode = 'oneShot'; e.emission.burstCount = 1; e.physics.gravity = g; e.physics.speed = { min: 0, max: 0 }; e.emission.lifetime = { min: 2, max: 2 }; }), { frameCount: 1 });
      run(sim, 1);
      return sim.snapshot(0).pos[1];
    };
    expect(mk(2) / mk(1)).toBeCloseTo(2, 1);
    expect(mk(-1)).toBeGreaterThan(0);
    expect(mk(0)).toBeCloseTo(0, 6);
  });

  it('drag decays velocity exponentially: v(t) = v0·e^(−k·t)', () => {
    const sim = new ParticleSim(bare((e) => { e.emission.mode = 'oneShot'; e.emission.burstCount = 1; e.physics.drag = 2; e.physics.speed = { min: 10, max: 10 }; e.emission.lifetime = { min: 5, max: 5 }; }), { frameCount: 1 });
    run(sim, 1);
    const p = sim.snapshot(0);
    expect(p.vel[1]).toBeCloseTo(10 * Math.exp(-2 * p.age), 1);
  });

  it('constant acceleration: x = ½·a·t² (no initial velocity)', () => {
    const sim = new ParticleSim(bare((e) => { e.emission.mode = 'oneShot'; e.emission.burstCount = 1; e.physics.speed = { min: 0, max: 0 }; e.physics.acceleration = [4, 0, 0]; e.emission.lifetime = { min: 3, max: 3 }; }), { frameCount: 1 });
    run(sim, 1);
    const p = sim.snapshot(0);
    expect(p.pos[0]).toBeCloseTo(0.5 * 4 * p.age * p.age, 1);
  });

  it('attractor pulls particles toward its position', () => {
    const sim = new ParticleSim(bare((e) => { e.emission.mode = 'oneShot'; e.emission.burstCount = 1; e.physics.speed = { min: 0, max: 0 }; e.physics.attractor = { enabled: true, position: [10, 0, 0], strength: 8 }; e.emission.lifetime = { min: 3, max: 3 }; }), { frameCount: 1 });
    run(sim, 1);
    expect(sim.snapshot(0).pos[0]).toBeGreaterThan(2);
    expect(Math.abs(sim.snapshot(0).pos[1])).toBeLessThan(1e-4);
  });

  it('drift moves particles at constant velocity regardless of other forces', () => {
    const sim = new ParticleSim(bare((e) => { e.emission.mode = 'oneShot'; e.emission.burstCount = 1; e.physics.speed = { min: 0, max: 0 }; e.physics.drift = [0, 0, 2]; e.emission.lifetime = { min: 3, max: 3 }; }), { frameCount: 1 });
    run(sim, 1);
    const p = sim.snapshot(0);
    expect(p.pos[2]).toBeCloseTo(2 * p.age, 1);
  });

  it('turbulence perturbs trajectories deterministically; zero strength is exactly straight', () => {
    const mk = (strength: number) => {
      const sim = new ParticleSim(bare((e) => { e.emission.mode = 'oneShot'; e.emission.burstCount = 1; e.physics.turbulence = { strength, frequency: 1.3 }; e.emission.lifetime = { min: 3, max: 3 }; }), { frameCount: 1 });
      run(sim, 1);
      return sim.snapshot(0).pos;
    };
    expect(mk(0)[0]).toBe(0);
    expect(Math.abs(mk(6)[0]) + Math.abs(mk(6)[2])).toBeGreaterThan(0.01);
    expect(mk(6)).toEqual(mk(6));
    const n = [noise3(0.3, 1.2, 2.5), noise3(0.3, 1.2, 2.5)];
    expect(n[0]).toBe(n[1]);
    for (let i = 0; i < 200; i++) expect(Math.abs(noise3(i * 0.37, i * 0.11, i * 0.73))).toBeLessThanOrEqual(1);
  });

  it('speedOverLife scales the displacement rate', () => {
    const sim = new ParticleSim(bare((e) => { e.emission.mode = 'oneShot'; e.emission.burstCount = 1; e.physics.speed = { min: 4, max: 4 }; e.physics.speedOverLife = linearCurve([[0, 0], [1, 0]]); e.emission.lifetime = { min: 2, max: 2 }; }), { frameCount: 1 });
    run(sim, 1);
    expect(sim.snapshot(0).pos[1]).toBeCloseTo(0, 5);
  });

  it('integration is exact for gravity + linear drag at ANY step size (checked at each particle\'s own age)', () => {
    // dv/dt = a − k·v  =>  y(t) = (a/k)·t + (v0 − a/k)(1 − e^(−k·t))/k
    const k = 0.5;
    const a = -GRAVITY;
    const v0 = 6;
    const analytic = (t: number) => ({
      y: (a / k) * t + ((v0 - a / k) * (1 - Math.exp(-k * t))) / k,
      v: (v0 - a / k) * Math.exp(-k * t) + a / k,
    });
    for (const dt of [1 / 15, 1 / 30, 1 / 60, 1 / 240]) {
      const sim = new ParticleSim(bare((e) => { e.emission.mode = 'oneShot'; e.emission.burstCount = 1; e.physics.gravity = 1; e.physics.drag = k; e.physics.speed = { min: v0, max: v0 }; e.emission.lifetime = { min: 5, max: 5 }; }), { frameCount: 1 });
      for (let t = 0; t < 1.5 - 1e-9; t += dt) sim.step(dt);
      const p = sim.snapshot(0);
      const exp = analytic(p.age);
      expect(p.pos[1], `dt=${dt}`).toBeCloseTo(exp.y, 3);
      expect(p.vel[1], `dt=${dt}`).toBeCloseTo(exp.v, 3);
    }
  });
});

describe('shapes and directions', () => {
  it('cone spread: every direction is within the half-angle of the base direction', () => {
    const spread = 20;
    const sim = new ParticleSim(bare((e) => { e.emission.mode = 'oneShot'; e.emission.burstCount = 2000; e.physics.spread = spread; e.emission.lifetime = { min: 5, max: 5 }; }), { frameCount: 1 });
    run(sim, 1 / 60);
    let max = 0;
    let sum = 0;
    for (let i = 0; i < sim.count; i++) {
      const v = sim.snapshot(i).vel;
      const l = Math.hypot(...v);
      const ang = (Math.acos(v[1] / l) * 180) / Math.PI;
      max = Math.max(max, ang);
      sum += ang;
    }
    expect(max).toBeLessThanOrEqual(spread + 0.5);
    expect(max).toBeGreaterThan(spread - 3); // the cap really is filled
    // uniform on the cap: mean angle sits between 0 and the half-angle, not clustered at either end
    expect(sum / sim.count).toBeGreaterThan(spread * 0.5);
    expect(sum / sim.count).toBeLessThan(spread * 0.9);
  });

  it('spread = 0 gives exactly the configured direction; 180 covers the whole sphere', () => {
    const straight = new ParticleSim(bare((e) => { e.emission.mode = 'oneShot'; e.emission.burstCount = 50; e.physics.direction = [1, 1, 0]; e.emission.lifetime = { min: 5, max: 5 }; }), { frameCount: 1 });
    straight.step(1 / 60);
    for (let i = 0; i < straight.count; i++) {
      const v = straight.snapshot(i).vel;
      expect(v[0]).toBeCloseTo(v[1], 3);
      expect(v[2]).toBeCloseTo(0, 5);
      expect(Math.hypot(...v)).toBeCloseTo(2, 3);
    }
    const all = new ParticleSim(bare((e) => { e.emission.mode = 'oneShot'; e.emission.burstCount = 1000; e.physics.spread = 180; e.emission.lifetime = { min: 5, max: 5 }; }), { frameCount: 1 });
    all.step(1 / 60);
    let down = 0;
    for (let i = 0; i < all.count; i++) if (all.snapshot(i).vel[1] < 0) down++;
    expect(down).toBeGreaterThan(400);
    expect(down).toBeLessThan(600);
  });

  it('speed stays within [min, max]', () => {
    const sim = new ParticleSim(bare((e) => { e.emission.mode = 'oneShot'; e.emission.burstCount = 500; e.physics.speed = { min: 1, max: 3 }; e.emission.lifetime = { min: 5, max: 5 }; }), { frameCount: 1 });
    sim.step(1e-4);
    for (let i = 0; i < sim.count; i++) {
      const s = Math.hypot(...sim.snapshot(i).vel);
      expect(s).toBeGreaterThanOrEqual(0.99);
      expect(s).toBeLessThanOrEqual(3.01);
    }
  });

  it('shapes spawn inside their volumes', () => {
    const spawnAt = (shape: Emitter['shape']) => {
      const sim = new ParticleSim(bare((e) => { e.emission.mode = 'oneShot'; e.emission.burstCount = 500; e.shape = shape; e.physics.speed = { min: 0, max: 0 }; e.emission.lifetime = { min: 5, max: 5 }; }), { frameCount: 1 });
      sim.step(1e-4);
      return Array.from({ length: sim.count }, (_, i) => sim.snapshot(i).pos);
    };
    for (const p of spawnAt({ type: 'box', size: [2, 4, 6], radius: 0, angle: 0, fromShell: false })) {
      expect(Math.abs(p[0])).toBeLessThanOrEqual(1.001);
      expect(Math.abs(p[1])).toBeLessThanOrEqual(2.001);
      expect(Math.abs(p[2])).toBeLessThanOrEqual(3.001);
    }
    const sphere = spawnAt({ type: 'sphere', size: [0, 0, 0], radius: 2, angle: 0, fromShell: false });
    expect(Math.max(...sphere.map((p) => Math.hypot(...p)))).toBeLessThanOrEqual(2.001);
    const shell = spawnAt({ type: 'sphere', size: [0, 0, 0], radius: 2, angle: 0, fromShell: true });
    for (const p of shell) expect(Math.hypot(...p)).toBeCloseTo(2, 2);
    for (const p of spawnAt({ type: 'circle', size: [0, 0, 0], radius: 1.5, angle: 0, fromShell: false })) {
      expect(p[1]).toBe(0);
      expect(Math.hypot(p[0], p[2])).toBeLessThanOrEqual(1.501);
    }
    for (const p of spawnAt({ type: 'point', size: [9, 9, 9], radius: 9, angle: 0, fromShell: false })) expect(p).toEqual([0, 0, 0]);
    const boxShell = spawnAt({ type: 'box', size: [2, 2, 2], radius: 0, angle: 0, fromShell: true });
    for (const p of boxShell) expect(Math.max(Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]))).toBeCloseTo(1, 4);
  });

  it('a cone shape widens the emission by its own angle', () => {
    const sim = new ParticleSim(bare((e) => { e.emission.mode = 'oneShot'; e.emission.burstCount = 2000; e.shape = { type: 'cone', size: [0, 0, 0], radius: 0.1, angle: 30, fromShell: false }; e.physics.spread = 0; e.emission.lifetime = { min: 5, max: 5 }; }), { frameCount: 1 });
    sim.step(1 / 60);
    let max = 0;
    for (let i = 0; i < sim.count; i++) {
      const v = sim.snapshot(i).vel;
      max = Math.max(max, (Math.acos(v[1] / Math.hypot(...v)) * 180) / Math.PI);
    }
    expect(max).toBeLessThanOrEqual(30.5);
    expect(max).toBeGreaterThan(27);
  });

  it('emitter transform is baked into spawned particles (position, rotation, scale)', () => {
    const sim = new ParticleSim(bare((e) => {
      e.emission.mode = 'oneShot';
      e.emission.burstCount = 1;
      e.physics.speed = { min: 2, max: 2 };
      e.transform = { position: [1, 2, 3], rotation: [0, 0, -90], scale: [1, 1, 1], space: 'local' };
      e.emission.lifetime = { min: 5, max: 5 };
    }), { frameCount: 1 });
    sim.step(1e-4);
    const p = sim.snapshot(0);
    expect(p.pos[0]).toBeCloseTo(1, 2);
    expect(p.pos[1]).toBeCloseTo(2, 2);
    expect(p.vel[0]).toBeCloseTo(2, 3); // +Y velocity rotated -90° about Z becomes +X
    expect(p.vel[1]).toBeCloseTo(0, 3);
    const scaled = new ParticleSim(bare((e) => { e.emission.mode = 'oneShot'; e.emission.burstCount = 1; e.transform.scale = [2, 2, 2]; e.particle.size = { min: 0.1, max: 0.1 }; e.emission.lifetime = { min: 5, max: 5 }; }), { frameCount: 1 });
    scaled.step(1e-4);
    expect(scaled.snapshot(0).size).toBeCloseTo(0.2, 6);
  });

  it('world-space emitters spawn at the attachment frame and then stay put when it moves', () => {
    const e = bare((x) => { x.emission.mode = 'continuous'; x.emission.rate = 120; x.physics.speed = { min: 0, max: 0 }; x.transform.space = 'world'; x.emission.lifetime = { min: 5, max: 5 }; x.emission.duration = 100; });
    const sim = new ParticleSim(e, { frameCount: 1 });
    for (let i = 0; i < 60; i++) sim.step(1 / 60, { position: [i * 0.1, 0, 0], rotation: [0, 0, 0] }); // frame slides along +X
    const xs = Array.from({ length: sim.count }, (_, i) => sim.snapshot(i).pos[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(4); // spread out behind the moving emitter
    const local = new ParticleSim({ ...e, transform: { ...e.transform, space: 'local' } }, { frameCount: 1 });
    for (let i = 0; i < 60; i++) local.step(1 / 60, { position: [i * 0.1, 0, 0], rotation: [0, 0, 0] });
    for (let i = 0; i < local.count; i++) expect(local.snapshot(i).pos[0]).toBeCloseTo(0, 5); // local space ignores the frame
  });
});

describe('determinism and scrubbing', () => {
  const emitter = () => bare((e) => { e.emission.mode = 'continuous'; e.emission.rate = 80; e.physics.spread = 25; e.physics.speed = { min: 1, max: 3 }; e.physics.gravity = 0.3; e.physics.turbulence = { strength: 2, frequency: 1 }; e.emission.lifetime = { min: 0.4, max: 0.9 }; e.emission.loop = true; });

  it('the same seed reproduces the same particles; a different seed does not', () => {
    const a = new ParticleSim(emitter(), { frameCount: 1, seed: 7 });
    const b = new ParticleSim(emitter(), { frameCount: 1, seed: 7 });
    const c = new ParticleSim(emitter(), { frameCount: 1, seed: 8 });
    run(a, 1.3);
    run(b, 1.3);
    run(c, 1.3);
    expect(a.count).toBe(b.count);
    for (let i = 0; i < a.count; i++) expect(a.snapshot(i)).toEqual(b.snapshot(i));
    expect(JSON.stringify(Array.from({ length: c.count }, (_, i) => c.snapshot(i)))).not.toBe(JSON.stringify(Array.from({ length: a.count }, (_, i) => a.snapshot(i))));
  });

  it('seek(t) equals stepping to t, and reset() restarts identically', () => {
    const stepped = new ParticleSim(emitter(), { frameCount: 1, seed: 3 });
    run(stepped, 1.0);
    const sought = new ParticleSim(emitter(), { frameCount: 1, seed: 3 });
    sought.seek(1.0);
    expect(sought.count).toBe(stepped.count);
    for (let i = 0; i < stepped.count; i++) {
      expect(sought.snapshot(i).pos[0]).toBeCloseTo(stepped.snapshot(i).pos[0], 3);
      expect(sought.snapshot(i).pos[1]).toBeCloseTo(stepped.snapshot(i).pos[1], 3);
    }
    const again = new ParticleSim(emitter(), { frameCount: 1, seed: 3 });
    run(again, 0.5);
    again.reset();
    run(again, 1.0);
    expect(again.count).toBe(stepped.count);
    expect(again.snapshot(0)).toEqual(stepped.snapshot(0));
  });

  it('large frame hitches are subdivided and stay stable', () => {
    const a = new ParticleSim(emitter(), { frameCount: 1, seed: 5 });
    a.step(2.0); // one 2-second hitch
    expect(a.count).toBeGreaterThan(20);
    for (let i = 0; i < a.count; i++) for (const c of a.snapshot(i).pos) expect(Number.isFinite(c)).toBe(true);
    a.step(0); // zero and negative steps are ignored
    a.step(-1);
    expect(a.count).toBeGreaterThan(20);
  });
});

describe('render data (fill)', () => {
  it('applies size/alpha/colour over life', () => {
    const sim = new ParticleSim(bare((e) => {
      e.emission.mode = 'oneShot';
      e.emission.burstCount = 1;
      e.emission.lifetime = { min: 1, max: 1 };
      e.particle.size = { min: 1, max: 1 };
      e.particle.sizeOverLife = linearCurve([[0, 0], [1, 2]]);
      e.particle.alphaOverLife = linearCurve([[0, 1], [1, 0]]);
      e.particle.color = [1, 0.5, 0.25, 0.8];
      e.particle.colorOverLife = { stops: [{ t: 0, color: [1, 1, 1, 1] }, { t: 1, color: [0, 0, 0, 1] }] };
      e.particle.glow = 2.5;
    }), { frameCount: 1 });
    sim.step(1e-3);
    sim.step(0.5 - 1e-3);
    const out = createInstanceBuffers(4);
    expect(sim.fill(out)).toBe(1);
    expect(out.sizeRot[0]).toBeCloseTo(1, 1); // size 1 × curve(0.5)=1
    expect(out.color[3]).toBeCloseTo(0.8 * 0.5, 1); // colour alpha × particle alpha × alpha curve
    expect(out.color[0]).toBeCloseTo(0.5, 1); // gradient halfway, × tint r=1
    expect(out.color[1]).toBeCloseTo(0.25, 1); // gradient .5 × tint g=.5
    expect(out.frame[3]).toBe(2.5);
  });

  const frameAt = (cfg: (e: Emitter) => void, frames: number, age: number) => {
    const sim = new ParticleSim(bare((e) => { e.emission.mode = 'oneShot'; e.emission.burstCount = 1; e.emission.lifetime = { min: 1, max: 1 }; cfg(e); }), { frameCount: frames });
    sim.step(1e-3);
    sim.step(age - 1e-3);
    const out = createInstanceBuffers(2);
    sim.fill(out);
    return { a: out.frame[0]!, b: out.frame[1]!, blend: out.frame[2]! };
  };

  it('flipbook overLife: plays every frame once across the particle\'s life', () => {
    const seen = new Set<number>();
    for (let age = 0.01; age < 0.999; age += 0.01) seen.add(frameAt((e) => { e.animation.mode = 'overLife'; e.animation.blendFrames = false; }, 16, age).a);
    expect([...seen].sort((x, y) => x - y)).toEqual(Array.from({ length: 16 }, (_, i) => i));
    const mid = frameAt((e) => { e.animation.mode = 'overLife'; e.animation.blendFrames = true; }, 16, 0.53);
    expect(mid.a).toBe(8);
    expect(mid.b).toBe(9);
    expect(mid.blend).toBeCloseTo(0.48, 1);
  });

  it('flipbook fps: advances at the configured rate and loops', () => {
    expect(frameAt((e) => { e.animation.mode = 'fps'; e.animation.fps = 8; e.animation.loop = true; e.animation.blendFrames = false; }, 16, 0.52).a).toBe(4); // 0.52 s × 8 fps = 4.16
    expect(frameAt((e) => { e.animation.mode = 'fps'; e.animation.fps = 40; e.animation.loop = true; e.animation.blendFrames = false; }, 16, 0.52).a).toBe(4); // 20.8 frames -> wraps to 4.8
    expect(frameAt((e) => { e.animation.mode = 'fps'; e.animation.fps = 40; e.animation.loop = false; e.animation.blendFrames = false; }, 16, 0.52).a).toBe(15); // clamps on the last frame
  });

  it('flipbook range and fixed mode', () => {
    const r = frameAt((e) => { e.animation.mode = 'overLife'; e.animation.startFrame = 4; e.animation.endFrame = 7; e.animation.blendFrames = false; }, 16, 0.99);
    expect(r.a).toBe(7);
    expect(frameAt((e) => { e.animation.mode = 'overLife'; e.animation.startFrame = 4; e.animation.endFrame = 7; e.animation.blendFrames = false; }, 16, 0.01).a).toBe(4);
    expect(frameAt((e) => { e.animation.mode = 'fixed'; e.animation.startFrame = 9; }, 16, 0.7).a).toBe(9);
    expect(frameAt((e) => { e.animation.mode = 'overLife'; }, 1, 0.7).a).toBe(0); // single-frame sheet
  });

  it('randomStart decorrelates particles', () => {
    const sim = new ParticleSim(bare((e) => { e.emission.mode = 'oneShot'; e.emission.burstCount = 200; e.emission.lifetime = { min: 1, max: 1 }; e.animation.mode = 'fixed'; e.animation.randomStart = true; e.animation.blendFrames = false; }), { frameCount: 16 });
    sim.step(0.01);
    const out = createInstanceBuffers(300);
    const n = sim.fill(out);
    const frames = new Set(Array.from({ length: n }, (_, i) => out.frame[i * 4]));
    expect(frames.size).toBeGreaterThan(10);
  });

  it('exposes velocity direction + speed for velocity-aligned sprites', () => {
    const sim = new ParticleSim(bare((e) => { e.emission.mode = 'oneShot'; e.emission.burstCount = 1; e.physics.direction = [0, 0, -1]; e.physics.speed = { min: 3, max: 3 }; e.emission.lifetime = { min: 5, max: 5 }; }), { frameCount: 1 });
    sim.step(0.01);
    const out = createInstanceBuffers(2);
    sim.fill(out);
    expect(out.velocity[2]).toBeCloseTo(-1, 3);
    expect(out.velocity[3]).toBeCloseTo(3, 2);
  });

  it('never writes past the buffer', () => {
    const sim = new ParticleSim(bare((e) => { e.emission.mode = 'oneShot'; e.emission.burstCount = 100; e.emission.lifetime = { min: 5, max: 5 }; }), { frameCount: 1 });
    sim.step(0.01);
    expect(sim.fill(createInstanceBuffers(10))).toBe(10);
  });
});
