import { MessageChannel } from 'node:worker_threads';
import { createProject, type Clip, type Project } from '@vfxforge/core';
import { findPreset, generateSpriteFrames, instantiatePreset } from '@vfxforge/particles';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serve, type Port } from '../src/lib/rpc';
import type { Platform } from '../src/platform';
import { EngineClient, previewClip, rawKey } from '../src/services/engine';
import { startDerivedService, useDerived, resetDerived } from '../src/state/derived';
import { editProject, useProject } from '../src/state/project';
import { createEngine, type EngineHost } from '../src/workers/engine-core';

function pair(): [Port, Port] {
  const { port1, port2 } = new MessageChannel();
  const wrap = (p: typeof port1): Port => {
    const w: Port = { postMessage: (m, t) => p.postMessage(m, (t ?? []) as never), onmessage: null };
    p.on('message', (data) => w.onmessage?.({ data }));
    return w;
  };
  return [wrap(port1), wrap(port2)];
}

function fakePlatform(counter: { extracts: number }): Platform {
  return {
    kind: 'browser',
    label: 'test',
    features: { ffmpeg: false, accurateProbe: false, binaryYpt: false, nativeProjects: false, interpolation: false },
    frames: {
      async getFrames(clip: Clip) {
        return this.extract(clip);
      },
      async extract(clip: Clip) {
        counter.extracts++;
        return generateSpriteFrames(clip.generator!);
      },
    },
    converter: null,
  } as unknown as Platform;
}

function projectWithPreset(id = 'purple_flames'): Project {
  const p = createProject('t');
  const inst = instantiatePreset(findPreset(id)!, { seed: 7 });
  p.clips[inst.clip.id] = inst.clip;
  p.sheets[inst.sheet.id] = inst.sheet;
  p.effects[inst.effect.id] = inst.effect;
  return p;
}

const until = async (cond: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 15));
  }
};

describe('engine + derived service', () => {
  let counter: { extracts: number };
  let client: EngineClient;
  let stop: () => void;

  beforeEach(() => {
    counter = { extracts: 0 };
    const [a, b] = pair();
    serve<ReturnType<typeof createEngine>, EngineHost>(b, (host) => createEngine(host as unknown as EngineHost));
    client = new EngineClient(fakePlatform(counter), a);
    resetDerived();
  });
  afterEach(() => {
    stop?.();
    client.dispose();
  });

  it('builds the preview atlas of a preset sheet and exposes the flipbook verdict', async () => {
    useProject.getState().load(projectWithPreset());
    stop = startDerivedService(client, { debounceMs: 5 });
    const id = Object.keys(useProject.getState().project.sheets)[0]!;
    await until(() => useDerived.getState().sheets[id]?.status === 'ready');
    const s = useDerived.getState().sheets[id]!;
    expect(s.preview!.frameCount).toBe(16);
    expect(s.preview!.atlas.width).toBe(512);
    expect(s.preview!.frames).toHaveLength(16);
    expect(s.preview!.flipbook.engineVerified).toBe(false);
    expect(s.preview!.flipbook.status).toBe('structurally-valid');
    expect(counter.extracts).toBe(1);
  });

  it('re-runs only the cheap stages when a non-extraction parameter changes', async () => {
    useProject.getState().load(projectWithPreset());
    stop = startDerivedService(client, { debounceMs: 5 });
    const id = Object.keys(useProject.getState().project.sheets)[0]!;
    await until(() => useDerived.getState().sheets[id]?.status === 'ready');
    const v1 = useDerived.getState().sheets[id]!.version;
    const clipId = useProject.getState().project.sheets[id]!.clipId;
    editProject('hue', (d) => {
      d.clips[clipId]!.adjust.hue = 90;
    });
    await until(() => (useDerived.getState().sheets[id]?.version ?? 0) > v1);
    expect(counter.extracts).toBe(1); // raw frames reused
    editProject('padding', (d) => {
      d.sheets[id]!.padding = 2;
    });
    await until(() => (useDerived.getState().sheets[id]?.version ?? 0) > v1 + 1);
    expect(counter.extracts).toBe(1);
  });

  it('re-extracts when an extraction input changes', async () => {
    useProject.getState().load(projectWithPreset());
    stop = startDerivedService(client, { debounceMs: 5 });
    const id = Object.keys(useProject.getState().project.sheets)[0]!;
    await until(() => useDerived.getState().sheets[id]?.status === 'ready');
    const clipId = useProject.getState().project.sheets[id]!.clipId;
    editProject('seed', (d) => {
      d.clips[clipId]!.generator!.seed = 99;
    });
    await until(() => counter.extracts === 2 && useDerived.getState().sheets[id]?.status === 'ready');
  });

  it('keeps the last good preview and reports the error when a sheet becomes invalid', async () => {
    useProject.getState().load(projectWithPreset());
    stop = startDerivedService(client, { debounceMs: 5 });
    const id = Object.keys(useProject.getState().project.sheets)[0]!;
    await until(() => useDerived.getState().sheets[id]?.status === 'ready');
    editProject('bad grid', (d) => {
      d.sheets[id]!.grid = { cols: 1, rows: 1 }; // 16 frames cannot fit in one cell
    });
    await until(() => useDerived.getState().sheets[id]?.status === 'error');
    const s = useDerived.getState().sheets[id]!;
    expect(s.error).toMatch(/frame|cell|capacity|fit/i);
    expect(s.preview).not.toBeNull();
  });

  it('ignores sheets nothing uses', async () => {
    const p = projectWithPreset();
    const eff = Object.values(p.effects)[0]!;
    eff.emitters[0]!.enabled = false;
    useProject.getState().load(p);
    stop = startDerivedService(client, { debounceMs: 5 });
    await new Promise((r) => setTimeout(r, 80));
    expect(counter.extracts).toBe(0);
  });

  it('caps the extraction size for previews without changing the clip', () => {
    const p = projectWithPreset();
    const clip = Object.values(p.clips)[0]!;
    clip.extract.width = 2048;
    clip.extract.height = 1024;
    const pc = previewClip(clip);
    expect(pc.extract.width).toBe(512);
    expect(pc.extract.height).toBe(256);
    expect(clip.extract.width).toBe(2048);
    clip.extract.width = null;
    clip.extract.height = null;
    clip.extract.keepAspect = false;
    expect(previewClip(clip).extract).toMatchObject({ width: 512, height: 512, keepAspect: true });
    expect(rawKey(p, clip, previewClip(clip))).not.toBe(rawKey(p, { ...clip, generator: { ...clip.generator!, seed: 1 } }, previewClip(clip)));
  });

  it('runs the full export through the worker and gates on a missing converter', async () => {
    const p = projectWithPreset();
    const platform = fakePlatform(counter);
    const [a, b] = pair();
    serve<ReturnType<typeof createEngine>, EngineHost>(b, (host) => createEngine(host as unknown as EngineHost));
    const c2 = new EngineClient(platform, a);
    const stages: string[] = [];
    const blocked = await c2.runExport(p, { resource: {} }, (s) => stages.push(s)).promise;
    expect(blocked.report.status).toBe('blocked');
    expect(blocked.report.blockers.some((i) => i.code === 'no-converter')).toBe(true);
    const sourceOnly = await c2.runExport(p, { resource: {}, allowSourceOnly: true }, (s) => stages.push(s)).promise;
    expect(sourceOnly.report.status).toBe('source-only');
    expect(sourceOnly.zip!.byteLength).toBeGreaterThan(1000);
    expect(stages).toContain('frames');
    expect(stages).toContain('resource');
    const sheet = await c2.exportSheet(p, Object.keys(p.sheets)[0]!);
    expect(sheet.png.byteLength).toBeGreaterThan(100);
    expect(sheet.dds.byteLength).toBeGreaterThan(100);
    c2.dispose();
  });
});

describe('raw frame lifetime', () => {
  it('releases superseded raw frames in the worker when a sheet moves to a new extraction', async () => {
    const counter = { extracts: 0 };
    const [a, b] = pair();
    const engine = createEngine({ getFrames: async () => [], convert: async () => { throw new Error('x'); }, stage: () => undefined });
    serve<ReturnType<typeof createEngine>, EngineHost>(b, () => engine);
    const client = new EngineClient(fakePlatform(counter), a);
    resetDerived();
    useProject.getState().load(projectWithPreset());
    const stop = startDerivedService(client, { debounceMs: 5 });
    const id = Object.keys(useProject.getState().project.sheets)[0]!;
    await until(() => useDerived.getState().sheets[id]?.status === 'ready');
    const clipId = useProject.getState().project.sheets[id]!.clipId;
    const keyOf = () => rawKey(useProject.getState().project, useProject.getState().project.clips[clipId]!, previewClip(useProject.getState().project.clips[clipId]!));
    const first = keyOf();
    expect(engine.hasRaw(first)).toBe(true);
    editProject('seed', (d) => {
      d.clips[clipId]!.generator!.seed = 1234;
    });
    await until(() => counter.extracts === 2 && useDerived.getState().sheets[id]?.status === 'ready');
    await until(() => !engine.hasRaw(first));
    expect(engine.hasRaw(keyOf())).toBe(true);
    stop();
    client.dispose();
  });
});
