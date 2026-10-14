import { describe, expect, it } from 'vitest';
import { createAsset, createClip, createEffect, createEmitter, createProject, createSheet, exportPresetPackage, importPresetPackage, parseProject, type Project } from '../src';

function projectWithPreset(): Project {
  const p = createProject('p');
  const clip = createClip('Flames', null);
  clip.generator = { kind: 'fire', palette: [[0, 0, 0], [1, 0.5, 0]], frames: 16, size: 64, seed: 1, intensity: 1 };
  p.clips[clip.id] = clip;
  const sheet = createSheet('flames', clip.id);
  p.sheets[sheet.id] = sheet;
  const fx = createEffect('Flames');
  fx.emitters.push(createEmitter('e', sheet.id));
  p.effects[fx.id] = fx;
  return p;
}

describe('preset packages', () => {
  it('round-trips an effect with its sheet and clip, regenerating every id', () => {
    const src = projectWithPreset();
    const out = exportPresetPackage(src, Object.keys(src.effects), { name: 'My pack', author: 'me' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const json = JSON.parse(JSON.stringify(out.package));
    const dest = createProject('dest');
    const imp = importPresetPackage(json, dest);
    expect(imp.ok).toBe(true);
    if (!imp.ok) return;
    expect(imp.effects).toHaveLength(1);
    expect(imp.effects[0]!.id).not.toBe(Object.keys(src.effects)[0]);
    expect(imp.effects[0]!.emitters[0]!.sheetId).toBe(imp.sheets[0]!.id);
    expect(imp.sheets[0]!.clipId).toBe(imp.clips[0]!.id);
    // the merged project is valid
    for (const c of imp.clips) dest.clips[c.id] = c;
    for (const s of imp.sheets) dest.sheets[s.id] = s;
    for (const e of imp.effects) dest.effects[e.id] = e;
    expect(parseProject(JSON.parse(JSON.stringify(dest))).ok).toBe(true);
  });

  it('avoids name collisions when imported twice', () => {
    const src = projectWithPreset();
    const out = exportPresetPackage(src, Object.keys(src.effects), { name: 'x' });
    if (!out.ok) throw new Error('export failed');
    const dest = createProject('dest');
    const a = importPresetPackage(JSON.parse(JSON.stringify(out.package)), dest);
    if (!a.ok) throw new Error('import failed');
    for (const s of a.sheets) dest.sheets[s.id] = s;
    for (const e of a.effects) dest.effects[e.id] = e;
    const b = importPresetPackage(JSON.parse(JSON.stringify(out.package)), dest);
    if (!b.ok) throw new Error('import failed');
    expect(b.sheets[0]!.textureName).not.toBe(a.sheets[0]!.textureName);
    expect(b.effects[0]!.ptfxName).not.toBe(a.effects[0]!.ptfxName);
    expect(b.sheets[0]!.textureName).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('refuses to share effects that depend on imported media', () => {
    const p = projectWithPreset();
    const asset = createAsset({ kind: 'video', name: 'a.mp4', file: 'assets/' + 'a'.repeat(64) + '.mp4', sha256: 'a'.repeat(64), bytes: 1, mime: 'video/mp4', info: null });
    p.assets[asset.id] = asset;
    Object.values(p.clips)[0]!.generator = null;
    Object.values(p.clips)[0]!.assetId = asset.id;
    const r = exportPresetPackage(p, Object.keys(p.effects), { name: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/imported media/);
  });

  it('rejects malformed, hostile and media-referencing packages', () => {
    const empty = createProject('e');
    expect(importPresetPackage(null, empty).ok).toBe(false);
    expect(importPresetPackage({ format: 'other' }, empty).ok).toBe(false);
    const src = projectWithPreset();
    const out = exportPresetPackage(src, Object.keys(src.effects), { name: 'x' });
    if (!out.ok) throw new Error('x');
    const json = JSON.parse(JSON.stringify(out.package));
    json.effects[0].ptfxName = "x'; os.exit() --";
    expect(importPresetPackage(json, empty).ok).toBe(false);
    const json2 = JSON.parse(JSON.stringify(out.package));
    json2.clips[0].generator = null;
    json2.clips[0].assetId = 'asset_1';
    const r = importPresetPackage(json2, empty);
    expect(r.ok).toBe(false);
    const json3 = JSON.parse(JSON.stringify(out.package));
    json3.sheets[0].clipId = 'missing';
    expect(importPresetPackage(json3, empty).ok).toBe(false);
    const json4 = JSON.parse(JSON.stringify(out.package));
    json4.effects[0].emitters[0].sheetId = 'missing';
    expect(importPresetPackage(json4, empty).ok).toBe(false);
  });
});
