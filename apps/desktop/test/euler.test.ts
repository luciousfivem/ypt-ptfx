import { DEG2RAD, rotateEulerXYZ, type Vec3 } from '@vfxforge/core';
import { Euler, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

/**
 * The simulator, the exporter and the viewport must rotate things identically. The core helper
 * applies X, then Y, then Z to the vector (R = Rz·Ry·Rx), which is three.js `Euler(x, y, z, 'ZYX')`
 * — NOT three's default 'XYZ'. The viewport therefore sets `rotation.order = 'ZYX'`.
 */
describe('euler convention', () => {
  const cases: Array<[Vec3, Vec3]> = [
    [[1, 0, 0], [90, 0, 0]],
    [[0, 0, -1], [30, 45, 60]],
    [[0.3, -0.7, 0.2], [-80, 20, 140]],
    [[1, 2, 3], [10, 20, 30]],
  ];
  it('matches three.js Euler order ZYX', () => {
    for (const [v, e] of cases) {
      const a = rotateEulerXYZ(v, e);
      const t = new Vector3(...v).applyEuler(new Euler(e[0] * DEG2RAD, e[1] * DEG2RAD, e[2] * DEG2RAD, 'ZYX'));
      expect(a[0]).toBeCloseTo(t.x, 9);
      expect(a[1]).toBeCloseTo(t.y, 9);
      expect(a[2]).toBeCloseTo(t.z, 9);
    }
  });
  it('differs from three.js default XYZ for multi-axis rotations (so the order must be set explicitly)', () => {
    const [v, e] = cases[2]!;
    const a = rotateEulerXYZ(v, e);
    const t = new Vector3(...v).applyEuler(new Euler(e[0] * DEG2RAD, e[1] * DEG2RAD, e[2] * DEG2RAD, 'XYZ'));
    expect(Math.abs(a[0] - t.x) + Math.abs(a[1] - t.y) + Math.abs(a[2] - t.z)).toBeGreaterThan(0.1);
  });
});

import { MODEL_ORIENTATIONS } from '../src/viewport/orientations';

describe('model orientation presets', () => {
  for (const o of MODEL_ORIENTATIONS) {
    it(`${o.label}: barrel -> -Z and up -> +Y`, () => {
      const barrel = rotateEulerXYZ(o.barrel, o.rotation);
      const up = rotateEulerXYZ(o.up, o.rotation);
      expect(barrel[0]).toBeCloseTo(0, 9);
      expect(barrel[1]).toBeCloseTo(0, 9);
      expect(barrel[2]).toBeCloseTo(-1, 9);
      expect(up[0]).toBeCloseTo(0, 9);
      expect(up[1]).toBeCloseTo(1, 9);
      expect(up[2]).toBeCloseTo(0, 9);
    });
  }
});
