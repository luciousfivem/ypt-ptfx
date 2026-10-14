/**
 * Deterministic CPU particle simulation.
 *
 * One `ParticleSim` simulates ONE emitter in the emitter's own local space (scene axes: +Y up,
 * barrel toward -Z). The same class drives the live WebGL preview and the automated tests, so
 * what the tests verify is exactly what the user sees.
 *
 * NOTE: this simulates VFXForge's emitter model. It is NOT the GTA V particle system; the YPT
 * export maps these parameters onto GTA rules with the fidelity reported by `buildYptModel`.
 */
import {
  Rng,
  evalCurve,
  evalGradient,
  hashString,
  rotateEulerXYZ,
  type Emitter,
  type Rgba,
  type Vec3,
} from '@vfxforge/core';
import { noise3 } from './noise';

export const GRAVITY = 9.81;

export interface EmitterFrame {
  /** Emitter -> world translation (used only when emitter.transform.space === 'world'). */
  position: Vec3;
  /** Emitter -> world rotation as XYZ Euler degrees (same convention as the project schema). */
  rotation: Vec3;
}

export const IDENTITY_FRAME: EmitterFrame = { position: [0, 0, 0], rotation: [0, 0, 0] };

/** Everything the renderer needs per live particle, packed for upload. */
export interface InstanceBuffers {
  /** xyz position (emitter-local for local space, world for world space) */
  position: Float32Array;
  /** x = size (m), y = rotation (rad), z = aspect, w = unused */
  sizeRot: Float32Array;
  /** straight-alpha RGBA, already multiplied by the over-life curves */
  color: Float32Array;
  /** x = frame A, y = frame B, z = blend 0..1, w = glow */
  frame: Float32Array;
  /** xyz = unit velocity direction, w = speed (m/s) */
  velocity: Float32Array;
}

export function createInstanceBuffers(capacity: number): InstanceBuffers {
  return {
    position: new Float32Array(capacity * 3),
    sizeRot: new Float32Array(capacity * 4),
    color: new Float32Array(capacity * 4),
    frame: new Float32Array(capacity * 4),
    velocity: new Float32Array(capacity * 4),
  };
}

const TAU = Math.PI * 2;
const DEG2RAD = Math.PI / 180;

export interface SimConfig {
  /** Number of frames in the assigned spritesheet (1 when none). */
  frameCount: number;
  /** Overrides the emitter's own seed (used by the tests and the "reseed" button). */
  seed?: number;
}

export class ParticleSim {
  /** SoA particle state. */
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly size: Float32Array;
  private readonly rot: Float32Array;
  private readonly angVel: Float32Array;
  private readonly rnd: Float32Array;

  private rng: Rng;
  private readonly seed: number;
  private spawnAccumulator = 0;
  private burstCycle = 0;
  private burstK = 0;
  private burstDone = false;
  private oneShotCycle = 0;

  /** Seconds since the system was (re)started. */
  time = 0;
  count = 0;
  readonly capacity: number;
  /** Total particles spawned since reset (useful for tests and stats). */
  totalSpawned = 0;
  /** When false the system no longer emits (live particles finish their lives). */
  emitting = true;

  constructor(
    public emitter: Emitter,
    public cfg: SimConfig,
  ) {
    this.capacity = Math.max(1, emitter.emission.maxParticles);
    const n = this.capacity;
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.size = new Float32Array(n);
    this.rot = new Float32Array(n);
    this.angVel = new Float32Array(n);
    this.rnd = new Float32Array(n);
    this.seed = cfg.seed ?? emitter.seed ?? hashString(emitter.id);
    this.rng = new Rng(this.seed);
  }

  reset(): void {
    this.rng = new Rng(this.seed);
    this.count = 0;
    this.time = 0;
    this.spawnAccumulator = 0;
    this.burstCycle = 0;
    this.burstK = 0;
    this.burstDone = false;
    this.oneShotCycle = 0;
    this.totalSpawned = 0;
    this.emitting = true;
  }

  /** Re-simulates from t=0 to `t` in fixed steps so timeline scrubbing is exact and repeatable. */
  seek(t: number, frame: EmitterFrame = IDENTITY_FRAME, dt = 1 / 60): void {
    this.reset();
    const steps = Math.min(20_000, Math.floor(t / dt));
    for (let i = 0; i < steps; i++) this.step(dt, frame);
    const rest = t - steps * dt;
    if (rest > 1e-6) this.step(rest, frame);
  }

  /** Advances the simulation by `dt` seconds. Large steps are subdivided for stability. */
  step(dt: number, frame: EmitterFrame = IDENTITY_FRAME): void {
    if (dt <= 0) return;
    const maxStep = 1 / 30;
    while (dt > maxStep) {
      this.substep(maxStep, frame);
      dt -= maxStep;
    }
    this.substep(dt, frame);
  }

  private substep(dt: number, frame: EmitterFrame): void {
    this.integrate(dt);
    const prev = this.time;
    this.time += dt;
    if (this.emitting) this.emit(prev, this.time, dt, frame);
  }

  /* ------------------------------------------------------------------ emission */

  /**
   * Emission schedule, in "emitter time" that starts counting after `startDelay`:
   *   continuous  rate particles/s for `duration` seconds (forever when looping)
   *   burst       `burstCount` particles every `interval` s inside each `duration` window
   *               (the window repeats when looping)
   *   oneShot     `burstCount` particles once at the start (again each `duration` when looping)
   */
  private emit(t0: number, t1: number, dt: number, frame: EmitterFrame): void {
    const e = this.emitter.emission;
    if (t1 <= e.startDelay) return;
    const l0 = Math.max(0, t0 - e.startDelay);
    const l1 = t1 - e.startDelay;

    if (e.mode === 'continuous') {
      const to = e.loop ? l1 : Math.min(l1, e.duration);
      const span = Math.max(0, to - l0);
      if (span <= 0) return;
      this.spawnAccumulator += e.rate * span;
      const n = Math.floor(this.spawnAccumulator);
      this.spawnAccumulator -= n;
      for (let i = 0; i < n; i++) this.spawn(frame, (i / Math.max(1, n)) * dt); // spread over the step
      return;
    }

    if (e.mode === 'burst') {
      while (!this.burstDone) {
        const kTime = this.burstK * e.interval;
        if (kTime >= e.duration - 1e-9) {
          // this window is exhausted
          if (!e.loop) {
            this.burstDone = true;
            break;
          }
          this.burstCycle++;
          this.burstK = 0;
          continue;
        }
        if (this.burstCycle * e.duration + kTime > l1 + 1e-9) break;
        for (let i = 0; i < e.burstCount; i++) this.spawn(frame, 0);
        this.burstK++;
      }
      return;
    }

    // one-shot
    while (this.oneShotCycle * e.duration <= l1 + 1e-9 && (e.loop || this.oneShotCycle === 0)) {
      for (let i = 0; i < e.burstCount; i++) this.spawn(frame, 0);
      this.oneShotCycle++;
      if (!e.loop) break;
    }
  }

  private spawn(frame: EmitterFrame, preAge: number): void {
    if (this.count >= this.capacity) return;
    const em = this.emitter;
    const rng = this.rng;
    const i = this.count++;
    this.totalSpawned++;

    // position inside the emitter shape (emitter-local, then offset by the emitter transform)
    const p = this.samplePosition(rng);
    const dir = this.sampleDirection(rng);
    const speed = rng.range(em.physics.speed.min, em.physics.speed.max);

    // emitter transform (position/rotation/scale) is baked into spawned particles; the attachment
    // frame is applied by the renderer (local space) or here (world space)
    const tf = em.transform;
    let pos: Vec3 = [p[0] * tf.scale[0], p[1] * tf.scale[1], p[2] * tf.scale[2]];
    pos = rotateEulerXYZ(pos, tf.rotation);
    pos = [pos[0] + tf.position[0], pos[1] + tf.position[1], pos[2] + tf.position[2]];
    let vel: Vec3 = rotateEulerXYZ([dir[0] * speed, dir[1] * speed, dir[2] * speed], tf.rotation);
    if (tf.space === 'world') {
      pos = rotateEulerXYZ(pos, frame.rotation);
      pos = [pos[0] + frame.position[0], pos[1] + frame.position[1], pos[2] + frame.position[2]];
      vel = rotateEulerXYZ(vel, frame.rotation);
    }

    this.px[i] = pos[0];
    this.py[i] = pos[1];
    this.pz[i] = pos[2];
    this.vx[i] = vel[0];
    this.vy[i] = vel[1];
    this.vz[i] = vel[2];
    this.life[i] = Math.max(0.01, rng.range(em.emission.lifetime.min, em.emission.lifetime.max));
    this.age[i] = Math.min(preAge, this.life[i]! - 1e-4);
    this.size[i] = rng.range(em.particle.size.min, em.particle.size.max) * ((tf.scale[0] + tf.scale[1] + tf.scale[2]) / 3);
    this.rot[i] = rng.range(em.particle.rotation.min, em.particle.rotation.max) * DEG2RAD;
    this.angVel[i] = rng.range(em.particle.angularVelocity.min, em.particle.angularVelocity.max) * DEG2RAD;
    this.rnd[i] = rng.next();
  }

  private samplePosition(rng: Rng): Vec3 {
    const s = this.emitter.shape;
    switch (s.type) {
      case 'point':
      case 'directional':
        return [0, 0, 0];
      case 'box': {
        const shell = s.fromShell;
        let x = rng.signed() * s.size[0] * 0.5;
        let y = rng.signed() * s.size[1] * 0.5;
        let z = rng.signed() * s.size[2] * 0.5;
        if (shell) {
          // push one random axis to its face
          const axis = rng.int(0, 2);
          const sign = rng.next() < 0.5 ? -1 : 1;
          if (axis === 0) x = sign * s.size[0] * 0.5;
          else if (axis === 1) y = sign * s.size[1] * 0.5;
          else z = sign * s.size[2] * 0.5;
        }
        return [x, y, z];
      }
      case 'sphere': {
        const u = rng.signed();
        const phi = rng.next() * TAU;
        const r = s.fromShell ? s.radius : s.radius * Math.cbrt(rng.next());
        const sinT = Math.sqrt(Math.max(0, 1 - u * u));
        return [r * sinT * Math.cos(phi), r * u, r * sinT * Math.sin(phi)];
      }
      case 'circle':
      case 'cone': {
        // a disc in the plane perpendicular to the emission direction is handled by the caller's
        // direction; here the disc lies in the XZ plane around the origin
        const phi = rng.next() * TAU;
        const r = s.fromShell ? s.radius : s.radius * Math.sqrt(rng.next());
        return [r * Math.cos(phi), 0, r * Math.sin(phi)];
      }
    }
  }

  private sampleDirection(rng: Rng): Vec3 {
    const ph = this.emitter.physics;
    const shape = this.emitter.shape;
    const base = normalize(ph.direction, [0, 1, 0]);
    // cone shapes add their own half-angle on top of the generic spread
    const spreadDeg = Math.min(180, ph.spread + (shape.type === 'cone' ? shape.angle : 0));
    const cosMax = Math.cos(spreadDeg * DEG2RAD);
    const cosT = 1 - rng.next() * (1 - cosMax); // uniform on the spherical cap
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    const phi = rng.next() * TAU;
    const [t, b] = basis(base);
    let d: Vec3 = [
      base[0] * cosT + (t[0] * Math.cos(phi) + b[0] * Math.sin(phi)) * sinT,
      base[1] * cosT + (t[1] * Math.cos(phi) + b[1] * Math.sin(phi)) * sinT,
      base[2] * cosT + (t[2] * Math.cos(phi) + b[2] * Math.sin(phi)) * sinT,
    ];
    if (ph.randomness > 0) {
      const r = randomUnit(rng);
      d = normalize([d[0] + r[0] * ph.randomness, d[1] + r[1] * ph.randomness, d[2] + r[2] * ph.randomness], d);
    }
    return d;
  }

  /* --------------------------------------------------------------- integration */

  private integrate(dt: number): void {
    const em = this.emitter;
    const ph = em.physics;
    const ax = ph.acceleration[0];
    const ay = ph.acceleration[1] - GRAVITY * ph.gravity;
    const az = ph.acceleration[2];
    const k = ph.drag;
    const decay = Math.exp(-k * dt);
    const turb = ph.turbulence.strength;
    const freq = ph.turbulence.frequency;
    const att = ph.attractor;
    for (let i = 0; i < this.count; ) {
      this.age[i] = this.age[i]! + dt;
      if (this.age[i]! >= this.life[i]!) {
        this.kill(i);
        continue; // the swapped-in particle is processed at index i
      }
      const t = this.age[i]! / this.life[i]!;
      // total acceleration this step: constant forces + turbulence + attractor
      let fx = ax;
      let fy = ay;
      let fz = az;
      if (turb > 0) {
        fx += noise3(this.px[i]! * freq + this.rnd[i]! * 17, this.py[i]! * freq, this.pz[i]! * freq + this.time * 0.8) * turb;
        fy += noise3(this.px[i]! * freq + 31.7, this.py[i]! * freq + this.rnd[i]! * 13, this.pz[i]! * freq + this.time * 0.8) * turb;
        fz += noise3(this.px[i]! * freq - 17.3, this.py[i]! * freq + 5.1, this.pz[i]! * freq + this.rnd[i]! * 11 + this.time * 0.8) * turb;
      }
      if (att.enabled && att.strength !== 0) {
        const dx = att.position[0] - this.px[i]!;
        const dy = att.position[1] - this.py[i]!;
        const dz = att.position[2] - this.pz[i]!;
        const k = att.strength / (Math.hypot(dx, dy, dz) || 1e-6);
        fx += dx * k;
        fy += dy * k;
        fz += dz * k;
      }
      // Exact solution of  dv/dt = a − k·v  over the step (a constant):
      //   v' = v·e^(−k·dt) + (a/k)(1 − e^(−k·dt))
      //   Δx = (a/k)·dt + (v − a/k)(1 − e^(−k·dt))/k
      // so trajectories do not depend on the frame rate. k → 0 degenerates to v·dt + ½·a·dt².
      const ox = this.vx[i]!;
      const oy = this.vy[i]!;
      const oz = this.vz[i]!;
      let vx: number, vy: number, vz: number, dxp: number, dyp: number, dzp: number;
      if (k < 1e-6) {
        vx = ox + fx * dt;
        vy = oy + fy * dt;
        vz = oz + fz * dt;
        dxp = ox * dt + 0.5 * fx * dt * dt;
        dyp = oy * dt + 0.5 * fy * dt * dt;
        dzp = oz * dt + 0.5 * fz * dt * dt;
      } else {
        const ek = 1 - decay; // 1 − e^(−k·dt)
        const ik = 1 / k;
        vx = ox * decay + fx * ik * ek;
        vy = oy * decay + fy * ik * ek;
        vz = oz * decay + fz * ik * ek;
        dxp = fx * ik * dt + (ox - fx * ik) * ek * ik;
        dyp = fy * ik * dt + (oy - fy * ik) * ek * ik;
        dzp = fz * ik * dt + (oz - fz * ik) * ek * ik;
      }
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.vz[i] = vz;
      const sm = ph.speedOverLife.keys.length > 1 ? evalCurve(ph.speedOverLife, t) : 1;
      this.px[i] = this.px[i]! + dxp * sm + ph.drift[0] * dt;
      this.py[i] = this.py[i]! + dyp * sm + ph.drift[1] * dt;
      this.pz[i] = this.pz[i]! + dzp * sm + ph.drift[2] * dt;
      this.rot[i] = this.rot[i]! + this.angVel[i]! * dt;
      i++;
    }
  }

  private kill(i: number): void {
    const last = --this.count;
    if (i === last) return;
    this.px[i] = this.px[last]!;
    this.py[i] = this.py[last]!;
    this.pz[i] = this.pz[last]!;
    this.vx[i] = this.vx[last]!;
    this.vy[i] = this.vy[last]!;
    this.vz[i] = this.vz[last]!;
    this.age[i] = this.age[last]!;
    this.life[i] = this.life[last]!;
    this.size[i] = this.size[last]!;
    this.rot[i] = this.rot[last]!;
    this.angVel[i] = this.angVel[last]!;
    this.rnd[i] = this.rnd[last]!;
  }

  /* ------------------------------------------------------------------ rendering */

  /** True when emission is finished and no particles remain (the effect can be discarded). */
  get finished(): boolean {
    const e = this.emitter.emission;
    let over = !this.emitting;
    if (!over && !e.loop) {
      if (e.mode === 'continuous') over = this.time >= e.startDelay + e.duration;
      else if (e.mode === 'burst') over = this.burstDone;
      else over = this.oneShotCycle > 0;
    }
    return over && this.count === 0;
  }

  /** Fills `out` with one entry per live particle and returns the count. */
  fill(out: InstanceBuffers): number {
    const em = this.emitter;
    const pr = em.particle;
    const an = em.animation;
    const frames = Math.max(1, this.cfg.frameCount);
    const last = Math.max(0, Math.min(frames - 1, an.endFrame ?? frames - 1));
    const first = Math.max(0, Math.min(last, an.startFrame));
    const span = last - first + 1;
    const rgba: Rgba = [1, 1, 1, 1];
    const n = Math.min(this.count, out.position.length / 3);
    for (let i = 0; i < n; i++) {
      const t = this.age[i]! / this.life[i]!;
      out.position[i * 3] = this.px[i]!;
      out.position[i * 3 + 1] = this.py[i]!;
      out.position[i * 3 + 2] = this.pz[i]!;

      out.sizeRot[i * 4] = this.size[i]! * Math.max(0, evalCurve(pr.sizeOverLife, t));
      out.sizeRot[i * 4 + 1] = this.rot[i]!;
      out.sizeRot[i * 4 + 2] = pr.aspect;
      out.sizeRot[i * 4 + 3] = 0;

      evalGradient(pr.colorOverLife, t, rgba);
      const alpha = rgba[3] * pr.color[3] * Math.max(0, Math.min(1, evalCurve(pr.alphaOverLife, t)));
      out.color[i * 4] = rgba[0] * pr.color[0];
      out.color[i * 4 + 1] = rgba[1] * pr.color[1];
      out.color[i * 4 + 2] = rgba[2] * pr.color[2];
      out.color[i * 4 + 3] = alpha;

      // flipbook frame: f is a position in [0, span) within the frame range
      let f = 0;
      if (an.mode === 'overLife') f = t * span;
      else if (an.mode === 'fps') f = this.age[i]! * an.fps;
      if (span === 1 || an.mode === 'fixed') f = 0;
      if (an.randomStart) f += this.rnd[i]! * span;
      const wrap = (an.mode === 'fps' && an.loop) || an.randomStart;
      f = wrap ? ((f % span) + span) % span : Math.min(f, span - 1e-3);
      const whole = Math.floor(f);
      const fa = first + whole;
      const fb = wrap ? first + ((whole + 1) % span) : Math.min(last, fa + 1);
      out.frame[i * 4] = fa;
      out.frame[i * 4 + 1] = fb;
      out.frame[i * 4 + 2] = an.blendFrames ? f - whole : 0;
      out.frame[i * 4 + 3] = pr.glow;

      const sp = Math.hypot(this.vx[i]!, this.vy[i]!, this.vz[i]!);
      const inv = sp > 1e-6 ? 1 / sp : 0;
      out.velocity[i * 4] = this.vx[i]! * inv;
      out.velocity[i * 4 + 1] = this.vy[i]! * inv;
      out.velocity[i * 4 + 2] = this.vz[i]! * inv;
      out.velocity[i * 4 + 3] = sp;
    }
    return n;
  }

  /** Read-only access for tests and the stats overlay. */
  snapshot(i: number): { pos: Vec3; vel: Vec3; age: number; life: number; size: number } {
    return { pos: [this.px[i]!, this.py[i]!, this.pz[i]!], vel: [this.vx[i]!, this.vy[i]!, this.vz[i]!], age: this.age[i]!, life: this.life[i]!, size: this.size[i]! };
  }
}

/* ------------------------------------------------------------------- helpers */

function normalize(v: readonly number[], fallback: readonly number[]): Vec3 {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  if (l < 1e-9) return [fallback[0]!, fallback[1]!, fallback[2]!];
  return [v[0]! / l, v[1]! / l, v[2]! / l];
}

/** Two unit vectors perpendicular to `n` and to each other. */
export function basis(n: Vec3): [Vec3, Vec3] {
  const a: Vec3 = Math.abs(n[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  const t = normalize([a[1] * n[2] - a[2] * n[1], a[2] * n[0] - a[0] * n[2], a[0] * n[1] - a[1] * n[0]], [1, 0, 0]);
  const b: Vec3 = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
  return [t, b];
}

function randomUnit(rng: Rng): Vec3 {
  const u = rng.signed();
  const phi = rng.next() * TAU;
  const s = Math.sqrt(Math.max(0, 1 - u * u));
  return [s * Math.cos(phi), u, s * Math.sin(phi)];
}
