import { spawnSync } from 'node:child_process';
import { createProject, parseProject } from '@vfxforge/core';
import { PRESETS, instantiatePreset } from '@vfxforge/particles';
import { inspectYptXml } from '@vfxforge/ypt';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { generatorsOnly, runExport, withGenerators } from '../src';
import { BRIDGE, BridgeConvertService, bridgeAvailable } from './node-adapters';

const frames = withGenerators(generatorsOnly);

describe('presets as complete projects', () => {
  it('a preset needs no media file: the generator wrapper renders it', async () => {
    const inst = instantiatePreset(PRESETS[0]!, { seed: 1, frameSize: 32 });
    const p = createProject('p');
    p.clips[inst.clip.id] = inst.clip;
    const out = await frames.getFrames(inst.clip, p);
    expect(out).toHaveLength(16);
    expect(out[0]!.width).toBe(32);
    await expect(frames.getFrames({ ...inst.clip, generator: null }, p)).rejects.toThrow(/no frame source/);
  });
});

describe.skipIf(!bridgeAvailable)(`every preset exports a verified binary YPT through the real CodeWalker bridge (${bridgeAvailable ? BRIDGE : 'bridge not built'})`, () => {
  it.each(PRESETS.map((p) => [p.id, p] as const))('%s', async (_id, preset) => {
    const inst = instantiatePreset(preset, { seed: 7, frameSize: 64 });
    const project = createProject(preset.name);
    project.clips[inst.clip.id] = inst.clip;
    project.sheets[inst.sheet.id] = inst.sheet;
    project.effects[inst.effect.id] = inst.effect;
    project.export.resourceName = 'fx_' + preset.id;
    project.export.assetName = 'vfx_' + preset.id;
    expect(parseProject(JSON.parse(JSON.stringify(project))).ok).toBe(true);

    const result = await runExport(project, frames, new BridgeConvertService(), { resource: {} });
    const errors = result.report.issues.filter((i) => i.severity === 'error');
    expect(errors, errors.map((e) => e.message).join('; ')).toEqual([]);
    expect(result.report.status).toBe('complete');
    expect(result.report.converter.roundTripOk).toBe(true);
    expect(inspectYptXml(result.xml!).ok).toBe(true);
    const files = unzipSync(result.zip!);
    expect(Object.keys(files)).toContain(`fx_${preset.id}/stream/vfx_${preset.id}.ypt`);
    // trigger wiring survives into the Lua config
    const cfg = new TextDecoder().decode(files[`fx_${preset.id}/config.lua`]);
    for (const t of preset.triggers) expect(cfg).toContain(`'${t}'`);
    expect(spawnSync('luac5.4', ['-p', '-'], { input: cfg }).status).toBe(0);
  }, 120_000);
});
