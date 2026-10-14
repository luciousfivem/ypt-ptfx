import type { Emitter } from './schema';

/**
 * Will the runtime script start this emitter as a LOOPED particle (kept alive until stopped)?
 *
 * Shared by the YPT exporter, the generated Lua bindings and the preview's event simulation so
 * all three agree. Only continuous emission can be looped. A burst/one-shot emitter is always a
 * one-shot start per trigger: its "loop" flag means "repeat the burst", which a single YPT effect
 * cannot express.
 */
export function startsLooped(em: Pick<Emitter, 'emission'>): boolean {
  return em.emission.mode === 'continuous' && em.emission.loop;
}
