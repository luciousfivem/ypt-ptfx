export type Vec3 = [number, number, number];

export const vec3 = {
  zero: (): Vec3 => [0, 0, 0],
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  length: (a: Vec3): number => Math.hypot(a[0], a[1], a[2]),
  normalize(a: Vec3, fallback: Vec3 = [0, 0, 1]): Vec3 {
    const l = Math.hypot(a[0], a[1], a[2]);
    return l < 1e-9 ? [...fallback] : [a[0] / l, a[1] / l, a[2] / l];
  },
};

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

/**
 * Rotates `v` by XYZ Euler angles in degrees (applied X, then Y, then Z — the same
 * order three.js uses for `Euler('XYZ')` when composing intrinsic rotations as
 * R = Rz * Ry * Rx applied to column vectors).
 */
export function rotateEulerXYZ(v: Vec3, eulerDeg: Vec3): Vec3 {
  const [rx, ry, rz] = [eulerDeg[0] * DEG2RAD, eulerDeg[1] * DEG2RAD, eulerDeg[2] * DEG2RAD];
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(rx), Math.sin(rx), Math.cos(ry), Math.sin(ry), Math.cos(rz), Math.sin(rz)];
  let [x, y, z] = v;
  // Rx
  let y1 = y * cx - z * sx;
  let z1 = y * sx + z * cx;
  y = y1;
  z = z1;
  // Ry
  const x2 = x * cy + z * sy;
  const z2 = -x * sy + z * cy;
  x = x2;
  z = z2;
  // Rz
  const x3 = x * cz - y * sz;
  const y3 = x * sz + y * cz;
  x = x3;
  y = y3;
  return [x, y, z];
}
