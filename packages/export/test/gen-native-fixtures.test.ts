/**
 * Regenerates the tiny XML + DDS fixtures used by the Rust converter integration test
 * (native/vfxforge-native/tests/convert_integration.rs):
 *
 *   VFXFORGE_GEN_NATIVE_FIXTURES=1 npx vitest run packages/export/test/gen-native-fixtures.test.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createProject } from '@vfxforge/core';
import { findPreset, instantiatePreset } from '@vfxforge/particles';
import { describe, expect, it } from 'vitest';
import { generatorsOnly, runExport, withGenerators } from '../src';

const OUT = resolve(__dirname, '../../../native/vfxforge-native/tests/fixtures');

describe.skipIf(!process.env.VFXFORGE_GEN_NATIVE_FIXTURES)('native test fixtures', () => {
  it('writes tiny.ypt.xml and tinyfx.dds', async () => {
    const p = createProject('tiny');
    p.export.assetName = 'tiny_fx';
    const inst = instantiatePreset(findPreset('purple_flames')!, { frames: 4, frameSize: 32, seed: 3 });
    inst.sheet.textureName = 'tinyfx';
    inst.sheet.dds = { format: 'BC3', mipmaps: false };
    p.clips[inst.clip.id] = inst.clip;
    p.sheets[inst.sheet.id] = inst.sheet;
    p.effects[inst.effect.id] = inst.effect;
    const r = await runExport(p, withGenerators(generatorsOnly), null, { resource: {}, allowSourceOnly: true });
    expect(r.report.blockers.map((b) => b.message)).toEqual([]);
    expect(r.xml).toBeTruthy();
    mkdirSync(OUT, { recursive: true });
    writeFileSync(resolve(OUT, 'tiny_fx.ypt.xml'), r.xml!);
    writeFileSync(resolve(OUT, 'tinyfx.dds'), r.sheets[0]!.dds);
  });
});
