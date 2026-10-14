import type { Vec3 } from '@vfxforge/core';

/**
 * Euler rotations (degrees, applied X then Y then Z) that bring a model authored with a common
 * convention into VFXForge's: barrel toward −Z, up toward +Y. `apps/desktop/test/euler.test.ts`
 * verifies each one numerically.
 */
export interface ModelOrientation {
  id: string;
  label: string;
  rotation: Vec3;
  /** Direction the model's barrel points in its own file, and its up axis. */
  barrel: Vec3;
  up: Vec3;
}

export const MODEL_ORIENTATIONS: ModelOrientation[] = [
  { id: 'y-up-minus-z', label: 'Y-up, barrel −Z (already correct)', rotation: [0, 0, 0], barrel: [0, 0, -1], up: [0, 1, 0] },
  { id: 'y-up-plus-z', label: 'Y-up, barrel +Z', rotation: [0, 180, 0], barrel: [0, 0, 1], up: [0, 1, 0] },
  { id: 'y-up-plus-x', label: 'Y-up, barrel +X', rotation: [0, 90, 0], barrel: [1, 0, 0], up: [0, 1, 0] },
  { id: 'y-up-minus-x', label: 'Y-up, barrel −X', rotation: [0, -90, 0], barrel: [-1, 0, 0], up: [0, 1, 0] },
  { id: 'z-up-plus-y', label: 'Z-up, barrel +Y (GTA / Blender)', rotation: [-90, 0, 0], barrel: [0, 1, 0], up: [0, 0, 1] },
];
