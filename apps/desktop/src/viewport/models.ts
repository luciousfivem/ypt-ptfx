/**
 * Imports a user's weapon model for preview. Models are untrusted input: they are parsed by
 * three.js loaders in the renderer (never executed), size-limited, and external references
 * (textures/buffers by URL) are NOT followed — a .gltf with external files is reported instead of
 * silently loading from the network or disk.
 */
import { Box3, BufferGeometry, Group, LoadingManager, Material, Mesh, Object3D, Texture, Vector3 } from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

export type ModelFormat = 'glb' | 'gltf' | 'obj' | 'fbx';

export const MODEL_NOTES: Record<ModelFormat, string> = {
  glb: 'GLB (binary glTF): fully supported, textures embedded.',
  gltf: 'glTF: supported when everything is embedded (data: URIs). Files that reference external textures/buffers cannot be loaded; use a .glb.',
  obj: 'OBJ: geometry only (materials/MTL are not loaded); shown with a neutral material.',
  fbx: 'FBX: EXPERIMENTAL. three.js reads many FBX files but not all; if it fails or looks wrong, export a .glb instead.',
};

export interface LoadedModel {
  root: Group;
  /** Bounding-box size and centre in the model's own units, before any scale. */
  size: [number, number, number];
  triangles: number;
  warnings: string[];
  dispose: () => void;
}

const MAX_MODEL_BYTES = 256 * 1024 * 1024;

export function modelFormatOf(file: string): ModelFormat | null {
  const ext = file.split('.').pop()?.toLowerCase();
  return ext === 'glb' || ext === 'gltf' || ext === 'obj' || ext === 'fbx' ? ext : null;
}

function triangleCount(root: Object3D): number {
  let tris = 0;
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    const g = m.geometry as BufferGeometry;
    tris += g.index ? g.index.count / 3 : (g.attributes.position?.count ?? 0) / 3;
  });
  return Math.round(tris);
}

function disposeTree(root: Object3D): void {
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats as Material[]) {
      for (const v of Object.values(mat)) if (v instanceof Texture) v.dispose();
      mat.dispose();
    }
  });
}

const BLANK_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** Only embedded (data:/blob:) resources are allowed; anything else is blocked and reported. */
function sandboxedManager(blocked: string[]): LoadingManager {
  const m = new LoadingManager();
  m.setURLModifier((url) => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return url;
    blocked.push(url);
    return BLANK_PNG;
  });
  return m;
}

function parseGltf(bytes: Uint8Array, blocked: string[]): Promise<Object3D> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Promise((resolve, reject) => {
    new GLTFLoader(sandboxedManager(blocked)).parse(
      buf,
      '',
      (gltf) => resolve(gltf.scene),
      (e) => reject(new Error(`Could not read this glTF/GLB${blocked.length ? ' (it references external files, which are not loaded; use a .glb with everything embedded)' : ''}: ${e instanceof Error ? e.message : String(e)}`)),
    );
  });
}

export async function loadModel(bytes: Uint8Array, format: ModelFormat): Promise<LoadedModel> {
  if (bytes.byteLength > MAX_MODEL_BYTES) throw new Error('This model is larger than 256 MiB, which the preview will not load.');
  const warnings: string[] = [];
  let scene: Object3D;
  if (format === 'glb' || format === 'gltf') {
    const blocked: string[] = [];
    scene = await parseGltf(bytes, blocked);
    if (blocked.length) warnings.push(`${blocked.length} external file reference(s) were not loaded (${blocked.slice(0, 2).join(', ')}${blocked.length > 2 ? ', …' : ''}). Embed textures or use a .glb.`);
  } else if (format === 'obj') {
    scene = new OBJLoader().parse(new TextDecoder().decode(bytes));
    warnings.push('OBJ materials are not loaded; the model is shown untextured.');
  } else {
    try {
      scene = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, '');
    } catch (e) {
      throw new Error(`FBX import is experimental and failed: ${e instanceof Error ? e.message : String(e)}. Export a .glb from your 3D tool instead.`);
    }
    warnings.push('FBX import is experimental.');
  }

  const tris = triangleCount(scene);
  if (tris === 0) {
    disposeTree(scene);
    throw new Error('The file loaded but contains no mesh geometry.');
  }

  // centre the model on its bounding box so scale/rotation act about the middle of the weapon
  const box = new Box3().setFromObject(scene);
  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());
  if (!Number.isFinite(size.x + size.y + size.z) || size.length() === 0) {
    disposeTree(scene);
    throw new Error('The model has no measurable size.');
  }
  const root = new Group();
  scene.position.sub(center);
  root.add(scene);
  if (tris > 500_000) warnings.push(`This model has ${tris.toLocaleString()} triangles; the preview may be slow.`);

  return { root, size: [size.x, size.y, size.z], triangles: tris, warnings, dispose: () => disposeTree(root) };
}
