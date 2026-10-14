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
/** Where a stored model really came from when that is not the file itself: a GTA V .ydr converted to GLB by the bridge. */
export type ModelOrigin = 'ydr';

export const MODEL_NOTES: Record<ModelFormat, string> = {
  glb: 'GLB (binary glTF): fully supported, textures embedded.',
  gltf: 'glTF: supported when everything is embedded (data: URIs). Files that reference external textures/buffers cannot be loaded; use a .glb.',
  obj: 'OBJ: geometry only (materials/MTL are not loaded); shown with a neutral material.',
  fbx: 'FBX: EXPERIMENTAL. three.js reads many FBX files but not all; if it fails or looks wrong, export a .glb instead.',
};

/** Shown instead of the generic GLB note for a model that was converted from a .ydr. */
export const YDR_NOTE = `Converted from a GTA V .ydr drawable when it was imported (the .ydr itself is not stored in the project). The converter already maps GTA axes (Z-up) to the preview's Y-up, so leave Rotation at 0 and do not use the Z-up preset; if the barrel does not point toward −Z, pick a Y-up Orientation. GTA units are metres, so Scale 1 is real size.`;

export interface LoadedModel {
  root: Group;
  /** Bounding-box size and centre in the model's own units, before any scale. */
  size: [number, number, number];
  triangles: number;
  warnings: string[];
  /** "ydr" when the GLB was produced by the .ydr converter (read from its own metadata); null for every other model. */
  origin: ModelOrigin | null;
  dispose: () => void;
}

/* ------------------------------------------------------------- .ydr provenance */

const LODS = ['high', 'med', 'low', 'vlow'] as const;
type Lod = (typeof LODS)[number];
const MAX_CONVERTER_WARNINGS = 12;
const MAX_WARNING_CHARS = 300;

/** What the converter recorded in the GLB (`asset.extras.vfxforge`), after validation. */
export interface YdrProvenance {
  lod: Lod | null;
  lodsAvailable: Lod[];
  windingFlippedGeometries: number | null;
  boneTransformsApplied: boolean | null;
  warnings: string[];
  /** Converter warnings beyond the caps, not kept. */
  warningsDropped: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const asCount = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1e9 ? v : null);
const asLod = (v: unknown): Lod | null => (typeof v === 'string' && (LODS as readonly string[]).includes(v) ? (v as Lod) : null);

/** One line of plain text: control characters become spaces and the length is capped (only the head of a huge string is looked at). */
function oneLine(v: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const head = v.slice(0, max * 4).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
  return head.length > max || v.length > max * 4 ? `${head.slice(0, max)}…` : head;
}

/**
 * Reads the converter's metadata from a glTF `asset` object. A GLB is untrusted input: anything that is
 * not the expected shape is ignored, strings are capped and cleaned, and only the closed set of LOD
 * names is ever shown. Returns null unless the file says it was produced from a .ydr.
 */
export function readYdrProvenance(asset: unknown): YdrProvenance | null {
  if (!isRecord(asset) || !isRecord(asset.extras)) return null;
  const x = asset.extras.vfxforge;
  if (!isRecord(x) || x.source !== 'ydr') return null;
  const lodsAvailable: Lod[] = [];
  if (Array.isArray(x.lodsAvailable)) {
    for (const l of x.lodsAvailable.slice(0, 16)) {
      const lod = asLod(l);
      if (lod && !lodsAvailable.includes(lod)) lodsAvailable.push(lod);
    }
  }
  const raw = Array.isArray(x.warnings) ? x.warnings : [];
  const considered = raw.slice(0, 100);
  const valid = considered.filter((w): w is string => typeof w === 'string').map((w) => oneLine(w, MAX_WARNING_CHARS)).filter((w) => w !== '');
  return {
    lod: asLod(x.lod),
    lodsAvailable,
    windingFlippedGeometries: asCount(x.windingFlippedGeometries),
    boneTransformsApplied: typeof x.boneTransformsApplied === 'boolean' ? x.boneTransformsApplied : null,
    warnings: valid.slice(0, MAX_CONVERTER_WARNINGS),
    warningsDropped: Math.max(0, valid.length - MAX_CONVERTER_WARNINGS) + (raw.length - considered.length),
  };
}

/** The honest list of what a converted drawable is and is not, ready for the warnings panel. */
export function ydrWarnings(p: YdrProvenance): string[] {
  const out = ['Converted from a GTA V .ydr: geometry only. GTA textures and shaders are not converted; the model is shown with a neutral material.'];
  if (p.lod) {
    const others = p.lodsAvailable.filter((l) => l !== p.lod);
    out.push(`Level of detail shown: ${p.lod}${others.length ? ` (the drawable also has ${others.join(', ')}; other levels are not imported)` : ''}.`);
  }
  for (const w of p.warnings) out.push(`Converter: ${w}`);
  if (p.warningsDropped > 0) out.push(`${p.warningsDropped} more converter warning(s) are not shown.`);
  const flipped = p.windingFlippedGeometries;
  // the converter counts every reversed geometry: judged from its own vertex normals, or (when it has none) following the rest of the drawable
  if (flipped) out.push(`${flipped} geometr${flipped === 1 ? 'y had its' : 'ies had their'} triangle order reversed so the faces point outward (decided from the vertex normals, or from the rest of the drawable where a geometry has none).`);
  if (p.boneTransformsApplied === true) out.push('Parts bound to skeleton bones were placed with the drawable\'s bone transforms; skinned parts are shown unposed.');
  else if (p.boneTransformsApplied === false) out.push('No bone transforms were applied.');
  return out;
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

function parseGltf(bytes: Uint8Array, blocked: string[]): Promise<{ scene: Object3D; asset: unknown }> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Promise((resolve, reject) => {
    new GLTFLoader(sandboxedManager(blocked)).parse(
      buf,
      '',
      (gltf) => resolve({ scene: gltf.scene, asset: gltf.asset }),
      (e) => reject(new Error(`Could not read this glTF/GLB${blocked.length ? ' (it references external files, which are not loaded; use a .glb with everything embedded)' : ''}: ${e instanceof Error ? e.message : String(e)}`)),
    );
  });
}

export async function loadModel(bytes: Uint8Array, format: ModelFormat): Promise<LoadedModel> {
  if (bytes.byteLength > MAX_MODEL_BYTES) throw new Error('This model is larger than 256 MiB, which the preview will not load.');
  const warnings: string[] = [];
  let scene: Object3D;
  let ydr: YdrProvenance | null = null;
  if (format === 'glb' || format === 'gltf') {
    const blocked: string[] = [];
    const parsed = await parseGltf(bytes, blocked);
    scene = parsed.scene;
    ydr = readYdrProvenance(parsed.asset);
    if (ydr) warnings.push(...ydrWarnings(ydr));
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

  return { root, size: [size.x, size.y, size.z], triangles: tris, warnings, origin: ydr ? 'ydr' : null, dispose: () => disposeTree(root) };
}
