import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadModel, readYdrProvenance, YDR_NOTE, ydrWarnings } from '../src/viewport/models';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const golden = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, `${name}.glb`)));

/** Rewrites the JSON chunk of a GLB (the BIN chunk is carried over untouched). */
function patchGlb(glb: Uint8Array, patch: (json: Record<string, any>) => void): Uint8Array {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen))) as Record<string, any>;
  patch(json);
  const text = new TextEncoder().encode(JSON.stringify(json));
  const padded = new Uint8Array(Math.ceil(text.length / 4) * 4).fill(0x20);
  padded.set(text);
  const rest = glb.subarray(20 + jsonLen);
  const out = new Uint8Array(20 + padded.length + rest.length);
  const odv = new DataView(out.buffer);
  out.set(glb.subarray(0, 12), 0);
  odv.setUint32(8, out.length, true);
  odv.setUint32(12, padded.length, true);
  odv.setUint32(16, 0x4e4f534a, true);
  out.set(padded, 20);
  out.set(rest, 20 + padded.length);
  return out;
}

const withVfx = (name: string, vfxforge: unknown) =>
  patchGlb(golden(name), (j) => {
    j.asset.extras = { vfxforge };
  });

const near = (a: number[], b: number[], eps = 1e-4) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]!) <= eps);

describe('loadModel on converted drawables (golden GLBs from the bridge)', () => {
  it('cube: 12 triangles, 1.0 x 0.5 x 2.0 m (GTA y-length 2 became glTF z), origin ydr, no winding or bone lines', async () => {
    const m = await loadModel(golden('cube_pnct'), 'glb');
    expect(m.origin).toBe('ydr');
    expect(m.triangles).toBe(12);
    expect(near(m.size, [1, 0.5, 2])).toBe(true);
    expect(m.warnings).toEqual([
      'Converted from a GTA V .ydr: geometry only. GTA textures and shaders are not converted; the model is shown with a neutral material.',
      'Level of detail shown: high.',
      'No bone transforms were applied.',
    ]);
    m.dispose();
  });

  it('the gen9 cube loads as the same mesh', async () => {
    const a = await loadModel(golden('cube_pnct'), 'glb');
    const b = await loadModel(golden('cube_pnct_gen9'), 'glb');
    expect(b.origin).toBe('ydr');
    expect(b.triangles).toBe(a.triangles);
    expect(near(b.size, a.size)).toBe(true);
    expect(b.warnings).toEqual(a.warnings);
  });

  it('multi-LOD drawable: 22 triangles, LOD and the other level named, converter warning relayed, one reversed geometry', async () => {
    const m = await loadModel(golden('multi_lod'), 'glb');
    expect(m.origin).toBe('ydr');
    expect(m.triangles).toBe(22);
    expect(near(m.size, [3, 0.5, 1.25])).toBe(true);
    expect(m.warnings).toContain('Level of detail shown: high (the drawable also has med; other levels are not imported).');
    expect(m.warnings.some((w) => w.startsWith('Converter: model_1 geometry 0 has no normals'))).toBe(true);
    expect(m.warnings).toContain('1 geometry had its triangle order reversed so the faces point outward (decided from the vertex normals, or from the rest of the drawable where a geometry has none).');
    expect(m.warnings).toContain('No bone transforms were applied.');
    m.dispose();
  });

  it('the med LOD is its own, smaller model', async () => {
    const m = await loadModel(golden('multi_lod_med'), 'glb');
    expect(m.triangles).toBe(12);
    expect(near(m.size, [1, 0.5, 1])).toBe(true);
    expect(m.warnings).toContain('Level of detail shown: med (the drawable also has high; other levels are not imported).');
    expect(m.warnings.some((w) => /reversed/.test(w))).toBe(false);
  });

  it('bone-bound drawable: 48 triangles over 4 models, bone placement reported, skinned-model warning relayed', async () => {
    const m = await loadModel(golden('bone_bound'), 'glb');
    expect(m.triangles).toBe(48);
    expect(near(m.size, [2, 1.25, 1.75])).toBe(true);
    expect(m.warnings).toContain('Parts bound to skeleton bones were placed with the drawable\'s bone transforms; skinned parts are shown unposed.');
    expect(m.warnings.some((w) => w.startsWith('Converter: 1 skinned model(s) (model_2) exported in bind pose'))).toBe(true);
    expect(m.warnings).toContain('1 geometry had its triangle order reversed so the faces point outward (decided from the vertex normals, or from the rest of the drawable where a geometry has none).');
    expect(m.warnings).not.toContain('No bone transforms were applied.');
    // four nodes, one mesh each, as the converter promises
    const names: string[] = [];
    m.root.traverse((o) => {
      if (/^model_\d+$/.test(o.name)) names.push(o.name);
    });
    expect(names.sort()).toEqual(['model_0', 'model_1', 'model_2', 'model_3']);
  });

  it('the model is centred on its bounding box like every other model', async () => {
    const m = await loadModel(golden('cube_pnct'), 'glb');
    const { Box3 } = await import('three');
    const b = new Box3().setFromObject(m.root);
    const c = b.getCenter(b.min.clone());
    expect(near([c.x, c.y, c.z], [0, 0, 0])).toBe(true);
  });
});

describe('models that did not come from a .ydr are unchanged', () => {
  it('a GLB without the converter metadata has origin null and no YDR text', async () => {
    const plain = patchGlb(golden('cube_pnct'), (j) => {
      delete j.asset.extras;
    });
    const m = await loadModel(plain, 'glb');
    expect(m.origin).toBeNull();
    expect(m.triangles).toBe(12);
    expect(m.warnings).toEqual([]);
  });

  it.each([
    ['another source', { source: 'blender' }],
    ['upper-case source', { source: 'YDR' }],
    ['no source', { lod: 'high' }],
    ['a string', 'ydr'],
    ['an array', [{ source: 'ydr' }]],
    ['null', null],
  ])('metadata with %s is ignored', async (_label, vfx) => {
    const m = await loadModel(withVfx('cube_pnct', vfx), 'glb');
    expect(m.origin).toBeNull();
    expect(m.warnings).toEqual([]);
  });

  it('asset.extras that is not an object is ignored', async () => {
    const m = await loadModel(
      patchGlb(golden('cube_pnct'), (j) => {
        j.asset.extras = 'vfxforge';
      }),
      'glb',
    );
    expect(m.origin).toBeNull();
  });

  it('OBJ keeps its own warning and origin null', async () => {
    const obj = new TextEncoder().encode('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
    const m = await loadModel(obj, 'obj');
    expect(m.origin).toBeNull();
    expect(m.warnings).toEqual(['OBJ materials are not loaded; the model is shown untextured.']);
  });
});

describe('hostile converter metadata', () => {
  it('wrong types and values are dropped, text is cleaned and capped, nothing throws', async () => {
    const huge = 'x'.repeat(200_000);
    const m = await loadModel(
      withVfx('cube_pnct', {
        source: 'ydr',
        lod: '<img src=x onerror=alert(1)>',
        lodsAvailable: ['high', 'high', 'bogus', 7, null, '<b>med</b>'],
        windingFlippedGeometries: -5,
        boneTransformsApplied: 'yes',
        warnings: ['  padded  ', 42, null, {}, ['nested'], huge, 'line one\nline two\u0000\u001b[31mred', ''],
      }),
      'glb',
    );
    expect(m.origin).toBe('ydr');
    expect(m.warnings[0]).toMatch(/^Converted from a GTA V \.ydr: geometry only/);
    // the invalid LOD, count and flag produce no lines at all
    expect(m.warnings.some((w) => /Level of detail|reversed|bone transform/i.test(w))).toBe(false);
    const converter = m.warnings.filter((w) => w.startsWith('Converter: '));
    expect(converter.map((w) => w.slice('Converter: '.length))).toEqual(['padded', `${'x'.repeat(300)}…`, 'line one line two [31mred']);
    for (const w of m.warnings) {
      // eslint-disable-next-line no-control-regex
      expect(w).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      expect(w.length).toBeLessThanOrEqual(400);
    }
  });

  it('thousands of warnings are capped and the overflow is counted', () => {
    const p = readYdrProvenance({ extras: { vfxforge: { source: 'ydr', warnings: Array.from({ length: 5000 }, (_, i) => `w${i}`) } } })!;
    expect(p.warnings).toHaveLength(12);
    expect(p.warningsDropped).toBe(100 - 12 + 4900);
    const lines = ydrWarnings(p);
    expect(lines.filter((l) => l.startsWith('Converter: '))).toHaveLength(12);
    expect(lines).toContain('4988 more converter warning(s) are not shown.');
  });

  it('only the closed set of LOD names is ever shown', () => {
    const p = readYdrProvenance({ extras: { vfxforge: { source: 'ydr', lod: 'vlow', lodsAvailable: ['vlow', 'low', 'x'.repeat(50), 'high', 'low'] } } })!;
    expect(p.lod).toBe('vlow');
    expect(p.lodsAvailable).toEqual(['vlow', 'low', 'high']);
    expect(ydrWarnings(p)[1]).toBe('Level of detail shown: vlow (the drawable also has low, high; other levels are not imported).');
  });

  it('non-integer, negative, absurd and non-numeric counts are not trusted', () => {
    for (const bad of [-1, 1.5, 1e12, Number.NaN, Infinity, '3', null, {}]) {
      const p = readYdrProvenance({ extras: { vfxforge: { source: 'ydr', windingFlippedGeometries: bad } } })!;
      expect(p.windingFlippedGeometries).toBeNull();
    }
    expect(readYdrProvenance({ extras: { vfxforge: { source: 'ydr', windingFlippedGeometries: 3 } } })!.windingFlippedGeometries).toBe(3);
    expect(ydrWarnings(readYdrProvenance({ extras: { vfxforge: { source: 'ydr', windingFlippedGeometries: 3 } } })!)).toContain('3 geometries had their triangle order reversed so the faces point outward (decided from the vertex normals, or from the rest of the drawable where a geometry has none).');
  });

  it('anything that is not an asset object with the expected shape gives null', () => {
    for (const v of [undefined, null, 0, 'ydr', [], {}, { extras: null }, { extras: [] }, { extras: {} }, { extras: { vfxforge: null } }, { extras: { vfxforge: { source: 'ydr ' } } }]) {
      expect(readYdrProvenance(v)).toBeNull();
    }
    expect(readYdrProvenance({ extras: { vfxforge: { source: 'ydr' } } })).toMatchObject({ lod: null, lodsAvailable: [], warnings: [], boneTransformsApplied: null });
  });
});

describe('the YDR note', () => {
  it('names the provenance and the orientation advice, and does not repeat the generic GLB claim', () => {
    expect(YDR_NOTE).toMatch(/\.ydr/);
    expect(YDR_NOTE).toMatch(/not stored/);
    expect(YDR_NOTE).toMatch(/Orientation/);
    expect(YDR_NOTE).not.toMatch(/fully supported/);
  });
});
