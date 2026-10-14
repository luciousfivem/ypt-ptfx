/**
 * Cost estimates shown in the Export Optimisation panel and the README.
 *
 * IMPORTANT: the thresholds below are rules of thumb chosen for this tool, NOT documented
 * GTA V limits. They exist to flag effects that are likely to be expensive; they never block an
 * export by themselves.
 */
import type { Effect, Emitter, Project } from '@vfxforge/core';
import { err, info, warn, type Issue } from '@vfxforge/ypt';

export interface SheetCost {
  sheetId: string;
  textureName: string;
  width: number;
  height: number;
  frames: number;
  format: 'BC1' | 'BC3' | 'BGRA8';
  mips: number;
  bytes: number;
}

export interface EffectCost {
  effect: string;
  emitters: number;
  /** Little's-law estimate of simultaneously live particles. */
  peakParticles: number;
  /** Upper bound on sprite batches per live effect instance (the engine may merge same-texture batches). */
  drawCallsUpperBound: number;
}

export interface Estimate {
  sheets: SheetCost[];
  textureBytes: number;
  effects: EffectCost[];
  totalPeakParticles: number;
  issues: Issue[];
}

const MIB = 1024 * 1024;

export function bytesPerPixel(format: SheetCost['format']): number {
  return format === 'BC1' ? 0.5 : format === 'BC3' ? 1 : 4;
}

export function textureBytes(width: number, height: number, format: SheetCost['format'], mips: number): number {
  const base = width * height * bytesPerPixel(format);
  return Math.round(mips > 1 ? base * (4 / 3) : base);
}

/** Peak concurrent particles for one emitter. */
export function peakParticles(em: Emitter): number {
  const life = (em.emission.lifetime.min + em.emission.lifetime.max) / 2;
  let n: number;
  switch (em.emission.mode) {
    case 'continuous':
      n = em.emission.rate * life;
      break;
    case 'burst':
      n = em.emission.burstCount * Math.max(1, Math.ceil(life / em.emission.interval));
      break;
    case 'oneShot':
      n = em.emission.burstCount;
      break;
  }
  return Math.min(Math.ceil(n), em.emission.maxParticles);
}

export function estimateEffect(effect: Effect): EffectCost {
  const active = effect.emitters.filter((e) => e.enabled);
  return {
    effect: effect.name,
    emitters: active.length,
    peakParticles: active.reduce((s, e) => s + peakParticles(e), 0),
    drawCallsUpperBound: active.length,
  };
}

export function estimateProject(project: Project, sheetCosts: SheetCost[]): Estimate {
  const issues: Issue[] = [];
  const effects = Object.values(project.effects).map(estimateEffect);
  const totalPeakParticles = effects.reduce((s, e) => s + e.peakParticles, 0);
  const total = sheetCosts.reduce((s, c) => s + c.bytes, 0);

  for (const c of sheetCosts) {
    if (c.width * c.height >= 4096 * 4096) {
      issues.push(warn('cost-huge-texture', `Texture "${c.textureName}" is ${c.width}x${c.height}: very large for a particle sprite (${(c.bytes / MIB).toFixed(1)} MiB).`, c.textureName));
    }
    if (c.format === 'BGRA8' && c.width * c.height >= 1024 * 1024) {
      issues.push(warn('cost-uncompressed', `Texture "${c.textureName}" is uncompressed ${c.width}x${c.height} (${(c.bytes / MIB).toFixed(1)} MiB); BC3 would be 4x smaller.`, c.textureName));
    }
    if (c.frames > 64) issues.push(info('cost-many-frames', `Texture "${c.textureName}" holds ${c.frames} frames.`, c.textureName));
  }
  if (total > 32 * MIB) issues.push(err('cost-memory-error', `Texture dictionary is about ${(total / MIB).toFixed(1)} MiB — far too heavy for a single weapon effect.`));
  else if (total > 16 * MIB) issues.push(warn('cost-memory', `Texture dictionary is about ${(total / MIB).toFixed(1)} MiB; consider a smaller atlas or BC3/BC1.`));

  for (const e of effects) {
    if (e.peakParticles > 300) issues.push(warn('cost-particles', `Effect "${e.effect}" may have ~${e.peakParticles} live particles at once. Many alpha/additive layers cause overdraw, especially with large sprites.`, e.effect));
    if (e.emitters > 6) issues.push(warn('cost-emitters', `Effect "${e.effect}" has ${e.emitters} emitters; each is a separate draw batch.`, e.effect));
  }
  for (const eff of Object.values(project.effects)) {
    for (const em of eff.emitters) {
      if (em.enabled && em.particle.size.max > 1.5 && em.blend !== 'alpha') {
        issues.push(warn('cost-overdraw', `Emitter "${em.name}": ${em.particle.size.max} m sprites with additive blending cause heavy overdraw.`, em.name));
      }
    }
  }
  if (totalPeakParticles > 1000) issues.push(warn('cost-total-particles', `The project may have ~${totalPeakParticles} live particles if every effect plays at once.`));
  return { sheets: sheetCosts, textureBytes: total, effects, totalPeakParticles, issues };
}
