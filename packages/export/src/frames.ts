import { generateSpriteFrames } from '@vfxforge/particles';
import type { FrameSource } from './run';

/**
 * Wraps a platform FrameSource so clips that carry a procedural `generator` (every preset) are
 * rendered in-process, and everything else (video / image clips) is delegated to the platform.
 */
export function withGenerators(inner: FrameSource): FrameSource {
  return {
    async getFrames(clip, project, signal) {
      if (clip.generator) return generateSpriteFrames(clip.generator);
      return inner.getFrames(clip, project, signal);
    },
  };
}

/** A FrameSource for projects that contain only generator clips (presets). */
export const generatorsOnly: FrameSource = {
  async getFrames(clip) {
    throw new Error(`Clip "${clip.name}" has no frame source: it is neither a generator clip nor backed by media.`);
  },
};
