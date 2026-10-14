/**
 * Procedural stand-in weapons for the preview. They are simple primitives, NOT GTA V models:
 * their only job is to give effects a recognisable scale and a place to attach to.
 *
 * Space: metres, barrel toward -Z, up +Y, origin near the grip so attachments read naturally.
 */
import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, type BufferGeometry } from 'three';
import type { AttachmentPoint, Weapon } from '@vfxforge/core';

type Vec3 = [number, number, number];
type PresetName = Exclude<Weapon['preset'], 'custom'>;

interface Part {
  shape: 'box' | 'cyl';
  /** box: [w, h, d]  cylinder: [radius, length(along Z), unused] */
  size: Vec3;
  pos: Vec3;
  /** XYZ degrees */
  rot?: Vec3;
  tone: 'metal' | 'dark' | 'grip' | 'accent';
}

interface Spec {
  parts: Part[];
  /** Default attachment points, weapon-local. */
  points: Array<{ kind: AttachmentPoint['kind']; name: string; pos: Vec3 }>;
  /** Approximate overall length, used for auto-fit of imported models. */
  length: number;
}

const SPECS: Record<PresetName, Spec> = {
  pistol: {
    length: 0.22,
    parts: [
      { shape: 'box', size: [0.032, 0.034, 0.19], pos: [0, 0.045, -0.04], tone: 'metal' }, // slide
      { shape: 'box', size: [0.03, 0.022, 0.16], pos: [0, 0.015, -0.025], tone: 'dark' }, // frame
      { shape: 'cyl', size: [0.007, 0.05, 0], pos: [0, 0.047, -0.15], tone: 'dark' }, // barrel tip
      { shape: 'box', size: [0.03, 0.1, 0.045], pos: [0, -0.04, 0.045], rot: [-14, 0, 0], tone: 'grip' }, // grip
      { shape: 'box', size: [0.026, 0.012, 0.05], pos: [0, -0.005, -0.005], tone: 'dark' }, // trigger guard
      { shape: 'box', size: [0.006, 0.02, 0.008], pos: [0, 0.0, 0.0], tone: 'accent' }, // trigger
    ],
    points: [
      { kind: 'muzzle', name: 'Muzzle', pos: [0, 0.047, -0.14] },
      { kind: 'barrel', name: 'Barrel', pos: [0, 0.047, -0.09] },
      { kind: 'slide', name: 'Slide', pos: [0, 0.066, -0.04] },
      { kind: 'receiver', name: 'Ejection port', pos: [0.017, 0.055, -0.03] },
      { kind: 'magazine', name: 'Magazine', pos: [0, -0.09, 0.05] },
      { kind: 'trigger', name: 'Trigger', pos: [0, 0.0, -0.005] },
      { kind: 'grip', name: 'Grip', pos: [0.017, -0.035, 0.045] },
    ],
  },
  smg: {
    length: 0.42,
    parts: [
      { shape: 'box', size: [0.04, 0.06, 0.3], pos: [0, 0.03, -0.1], tone: 'metal' },
      { shape: 'cyl', size: [0.01, 0.12, 0], pos: [0, 0.04, -0.3], tone: 'dark' },
      { shape: 'box', size: [0.034, 0.12, 0.045], pos: [0, -0.07, -0.06], rot: [8, 0, 0], tone: 'dark' },
      { shape: 'box', size: [0.032, 0.1, 0.04], pos: [0, -0.06, 0.07], rot: [-16, 0, 0], tone: 'grip' },
      { shape: 'box', size: [0.03, 0.04, 0.12], pos: [0, 0.03, 0.17], tone: 'dark' },
    ],
    points: [
      { kind: 'muzzle', name: 'Muzzle', pos: [0, 0.04, -0.36] },
      { kind: 'barrel', name: 'Barrel', pos: [0, 0.04, -0.25] },
      { kind: 'receiver', name: 'Receiver', pos: [0.022, 0.05, -0.05] },
      { kind: 'magazine', name: 'Magazine', pos: [0, -0.13, -0.06] },
      { kind: 'trigger', name: 'Trigger', pos: [0, -0.02, 0.0] },
      { kind: 'grip', name: 'Grip', pos: [0.02, -0.05, 0.07] },
    ],
  },
  rifle: {
    length: 0.9,
    parts: [
      { shape: 'box', size: [0.045, 0.08, 0.34], pos: [0, 0.03, -0.05], tone: 'dark' }, // receiver
      { shape: 'cyl', size: [0.012, 0.42, 0], pos: [0, 0.045, -0.43], tone: 'metal' }, // barrel
      { shape: 'box', size: [0.05, 0.05, 0.28], pos: [0, 0.03, -0.35], tone: 'dark' }, // handguard
      { shape: 'box', size: [0.04, 0.16, 0.05], pos: [0, -0.1, -0.05], rot: [10, 0, 0], tone: 'metal' }, // magazine
      { shape: 'box', size: [0.035, 0.11, 0.045], pos: [0, -0.07, 0.07], rot: [-18, 0, 0], tone: 'grip' },
      { shape: 'box', size: [0.04, 0.09, 0.28], pos: [0, 0.0, 0.3], tone: 'grip' }, // stock
      { shape: 'box', size: [0.012, 0.02, 0.03], pos: [0, 0.085, -0.15], tone: 'accent' }, // sight
    ],
    points: [
      { kind: 'muzzle', name: 'Muzzle', pos: [0, 0.045, -0.64] },
      { kind: 'barrel', name: 'Barrel', pos: [0, 0.045, -0.45] },
      { kind: 'receiver', name: 'Receiver', pos: [0.026, 0.05, -0.04] },
      { kind: 'magazine', name: 'Magazine', pos: [0, -0.18, -0.05] },
      { kind: 'trigger', name: 'Trigger', pos: [0, -0.03, 0.02] },
      { kind: 'grip', name: 'Grip', pos: [0.02, -0.06, 0.07] },
    ],
  },
  shotgun: {
    length: 0.95,
    parts: [
      { shape: 'cyl', size: [0.016, 0.62, 0], pos: [0, 0.05, -0.32], tone: 'metal' },
      { shape: 'cyl', size: [0.012, 0.5, 0], pos: [0, 0.015, -0.27], tone: 'dark' }, // magazine tube
      { shape: 'box', size: [0.05, 0.07, 0.22], pos: [0, 0.03, 0.0], tone: 'dark' },
      { shape: 'box', size: [0.055, 0.045, 0.2], pos: [0, 0.0, -0.3], tone: 'grip' }, // pump
      { shape: 'box', size: [0.035, 0.11, 0.045], pos: [0, -0.07, 0.07], rot: [-18, 0, 0], tone: 'grip' },
      { shape: 'box', size: [0.045, 0.1, 0.3], pos: [0, 0.0, 0.3], tone: 'grip' },
    ],
    points: [
      { kind: 'muzzle', name: 'Muzzle', pos: [0, 0.05, -0.64] },
      { kind: 'barrel', name: 'Barrel', pos: [0, 0.05, -0.4] },
      { kind: 'receiver', name: 'Ejection port', pos: [0.03, 0.045, -0.02] },
      { kind: 'magazine', name: 'Shell tube', pos: [0, 0.015, -0.3] },
      { kind: 'trigger', name: 'Trigger', pos: [0, -0.02, 0.02] },
      { kind: 'grip', name: 'Pump grip', pos: [0.03, 0.0, -0.3] },
    ],
  },
  sniper: {
    length: 1.15,
    parts: [
      { shape: 'cyl', size: [0.014, 0.75, 0], pos: [0, 0.05, -0.5], tone: 'metal' },
      { shape: 'box', size: [0.045, 0.08, 0.36], pos: [0, 0.03, -0.0], tone: 'dark' },
      { shape: 'cyl', size: [0.025, 0.3, 0], pos: [0, 0.115, -0.05], tone: 'dark' }, // scope
      { shape: 'cyl', size: [0.03, 0.04, 0], pos: [0, 0.115, -0.22], tone: 'accent' },
      { shape: 'box', size: [0.04, 0.1, 0.04], pos: [0, -0.07, -0.03], tone: 'metal' }, // mag
      { shape: 'box', size: [0.045, 0.12, 0.34], pos: [0, -0.01, 0.34], rot: [-4, 0, 0], tone: 'grip' }, // stock
      { shape: 'box', size: [0.035, 0.1, 0.045], pos: [0, -0.07, 0.1], rot: [-18, 0, 0], tone: 'grip' },
    ],
    points: [
      { kind: 'muzzle', name: 'Muzzle', pos: [0, 0.05, -0.88] },
      { kind: 'barrel', name: 'Barrel', pos: [0, 0.05, -0.55] },
      { kind: 'receiver', name: 'Receiver', pos: [0.026, 0.05, -0.03] },
      { kind: 'magazine', name: 'Magazine', pos: [0, -0.12, -0.03] },
      { kind: 'trigger', name: 'Trigger', pos: [0, -0.03, 0.04] },
      { kind: 'grip', name: 'Grip', pos: [0.02, -0.06, 0.1] },
    ],
  },
};

const TONES: Record<Part['tone'], { color: number; metalness: number; roughness: number }> = {
  metal: { color: 0x7d8594, metalness: 0.85, roughness: 0.35 },
  dark: { color: 0x2b2f3a, metalness: 0.7, roughness: 0.5 },
  grip: { color: 0x1c1d24, metalness: 0.15, roughness: 0.85 },
  accent: { color: 0x8b5cf6, metalness: 0.4, roughness: 0.4 },
};

export function weaponLength(preset: Weapon['preset']): number {
  return preset === 'custom' ? 0.4 : SPECS[preset].length;
}

/** The default attachment points for a preset (used by the "Add default attachments" button). */
export function defaultAttachmentSpecs(preset: Weapon['preset']): Array<{ kind: AttachmentPoint['kind']; name: string; position: Vec3 }> {
  const spec = SPECS[preset === 'custom' ? 'pistol' : preset];
  return spec.points.map((p) => ({ kind: p.kind, name: p.name, position: [...p.pos] as Vec3 }));
}

export interface BuiltWeapon {
  group: Group;
  geometries: BufferGeometry[];
  materials: MeshStandardMaterial[];
}

export function buildProceduralWeapon(preset: PresetName): BuiltWeapon {
  const spec = SPECS[preset];
  const group = new Group();
  group.name = `weapon:${preset}`;
  const geometries: BufferGeometry[] = [];
  const materials = new Map<Part['tone'], MeshStandardMaterial>();
  for (const part of spec.parts) {
    let geo: BufferGeometry;
    if (part.shape === 'box') geo = new BoxGeometry(part.size[0], part.size[1], part.size[2]);
    else {
      geo = new CylinderGeometry(part.size[0], part.size[0], part.size[1], 16);
      geo.rotateX(Math.PI / 2); // length along Z
    }
    geometries.push(geo);
    let mat = materials.get(part.tone);
    if (!mat) {
      mat = new MeshStandardMaterial(TONES[part.tone]);
      materials.set(part.tone, mat);
    }
    const mesh = new Mesh(geo, mat);
    mesh.position.set(...part.pos);
    if (part.rot) {
      mesh.rotation.order = 'ZYX';
      mesh.rotation.set((part.rot[0] * Math.PI) / 180, (part.rot[1] * Math.PI) / 180, (part.rot[2] * Math.PI) / 180);
    }
    group.add(mesh);
  }
  return { group, geometries, materials: [...materials.values()] };
}
