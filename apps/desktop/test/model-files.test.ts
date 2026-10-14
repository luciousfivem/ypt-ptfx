import { describe, expect, it } from 'vitest';
import { importPicker, isConvertedYdr, isYdrName, MEDIA_EXTENSIONS, MODEL_EXTENSIONS, modelPicker, YDR_BROWSER_ERROR } from '../src/lib/model-files';

describe('isYdrName', () => {
  it('matches the extension, any case, and nothing else', () => {
    expect(isYdrName('w_ar_k2light.ydr')).toBe(true);
    expect(isYdrName('W_AR.YDR')).toBe(true);
    expect(isYdrName(' pistol.ydr ')).toBe(true);
    expect(isYdrName('x.ydr.glb')).toBe(false);
    expect(isYdrName('x.ydd')).toBe(false);
    expect(isYdrName('ydr')).toBe(false);
    expect(isYdrName('')).toBe(false);
  });
});

describe('isConvertedYdr', () => {
  it('is a model named .ydr whose stored file is the converted GLB', () => {
    expect(isConvertedYdr({ kind: 'model', name: 'w_ar_k2light.ydr', file: `assets/${'a'.repeat(64)}.glb` })).toBe(true);
    expect(isConvertedYdr({ kind: 'model', name: 'box.glb', file: `assets/${'a'.repeat(64)}.glb` })).toBe(false);
    // a name ending in .ydr alone does not make it converted (the stored file must be the GLB)
    expect(isConvertedYdr({ kind: 'model', name: 'odd.ydr', file: `assets/${'a'.repeat(64)}.obj` })).toBe(false);
    expect(isConvertedYdr({ kind: 'image', name: 'x.ydr', file: `assets/${'a'.repeat(64)}.glb` })).toBe(false);
  });
});

describe('weapon-model picker', () => {
  it('desktop: everything first, then the 3D models, then the GTA V drawable', () => {
    const p = modelPicker('tauri');
    expect(p.accept).toEqual(['.glb', '.gltf', '.obj', '.fbx', '.ydr']);
    expect(p.filters).toEqual([
      { name: 'Supported files', extensions: ['glb', 'gltf', 'obj', 'fbx', 'ydr'] },
      { name: '3D models (glb, gltf, obj, fbx)', extensions: ['glb', 'gltf', 'obj', 'fbx'] },
      { name: 'GTA V drawable (ydr)', extensions: ['ydr'] },
    ]);
  });

  it('browser: .ydr is never offered, anywhere', () => {
    const p = modelPicker('browser');
    expect(p.accept).toEqual(['.glb', '.gltf', '.obj', '.fbx']);
    expect(JSON.stringify(p)).not.toMatch(/ydr/i);
    expect(p.filters.map((f) => f.name)).toEqual(['Supported files', '3D models (glb, gltf, obj, fbx)']);
  });
});

describe('generic import picker', () => {
  it('desktop: media and models, with the same three dropdown entries in order', () => {
    const p = importPicker('tauri');
    expect(p.accept).toEqual([...MEDIA_EXTENSIONS, ...MODEL_EXTENSIONS, '.ydr']);
    expect(p.filters.map((f) => f.name)).toEqual(['Supported files', '3D models (glb, gltf, obj, fbx)', 'GTA V drawable (ydr)']);
    const union = p.filters[0]!.extensions;
    expect(union).toEqual(p.accept.map((e) => e.slice(1)));
    // every narrower entry is a subset of the first one
    for (const f of p.filters.slice(1)) for (const e of f.extensions) expect(union).toContain(e);
    expect(union).toContain('webm');
  });

  it('browser: no .ydr in the accept list or the filters', () => {
    const p = importPicker('browser');
    expect(p.accept).toEqual([...MEDIA_EXTENSIONS, ...MODEL_EXTENSIONS]);
    expect(JSON.stringify(p)).not.toMatch(/ydr/i);
    expect(p.filters).toHaveLength(2);
  });

  it('every extension is a plain lower-case token the dialog sanitiser keeps', () => {
    for (const kind of ['tauri', 'browser'] as const) for (const p of [modelPicker(kind), importPicker(kind)]) for (const f of p.filters) for (const e of f.extensions) expect(e).toMatch(/^[a-z0-9]+$/);
  });
});

describe('the browser message for a .ydr', () => {
  it('says what is needed and what works instead', () => {
    expect(YDR_BROWSER_ERROR).toMatch(/desktop app/);
    expect(YDR_BROWSER_ERROR).toMatch(/converter bridge/);
    expect(YDR_BROWSER_ERROR).toMatch(/\.glb/);
  });
});
