import { createClip, createProject, type Project } from '@vfxforge/core';
import { createImage, encodePng, sha256Hex } from '@vfxforge/media';
import { zipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { packWire, unpackWire } from '../src/platform/wire';

type Handler = (args: unknown) => unknown | Promise<unknown>;
const fake = vi.hoisted(() => ({
  handlers: new Map<string, (args: unknown) => unknown | Promise<unknown>>(),
  calls: [] as Array<{ cmd: string; args: unknown }>,
  dialogSave: null as string | null,
  dialogOpen: null as string | string[] | null,
  dialogOpenOptions: null as Record<string, unknown> | null,
}));

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
  invoke: async (cmd: string, args: unknown) => {
    fake.calls.push({ cmd, args });
    const h = fake.handlers.get(cmd);
    if (!h) throw { code: 'invalid_param', message: `no handler for ${cmd}` };
    return h(args);
  },
}));
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => undefined }) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: async () => fake.dialogSave,
  open: async (o: Record<string, unknown>) => {
    fake.dialogOpenOptions = o;
    return fake.dialogOpen;
  },
}));

import { importPicker, modelPicker } from '../src/lib/model-files';
import { conversionNote, createTauriPlatform, dialogFilters, toError } from '../src/platform/tauri';

const toolStatus = (over: { ffmpeg?: boolean; bridge?: boolean } = {}) => ({
  ffmpeg: { available: over.ffmpeg ?? true, path: '/usr/bin/ffmpeg', version: 'ffmpeg 7', detail: 'ready' },
  ffprobe: { available: over.ffmpeg ?? true, path: '/usr/bin/ffprobe', version: null, detail: 'ready' },
  bridge: { available: over.bridge ?? true, detail: 'ok', version: '1', codewalkerCore: 'cw-1' },
  paths: { ffmpeg: null, ffprobe: null, dotnet: null, dll: null },
});

const on = (cmd: string, h: Handler) => fake.handlers.set(cmd, h);
const buf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
const png = (v: number) => {
  const img = createImage(2, 2);
  for (let i = 0; i < 4; i++) img.data.set([v, 0, 0, 255], i * 4);
  return encodePng(img);
};

beforeEach(() => {
  fake.handlers.clear();
  fake.calls.length = 0;
  fake.dialogSave = null;
  fake.dialogOpen = null;
  fake.dialogOpenOptions = null;
  on('tool_status', () => toolStatus());
});

const make = (id = 'proj_test') => createTauriPlatform({ activeProjectId: () => id });

describe('error mapping', () => {
  it('turns Rust errors into Errors that keep their code, and cancellation into AbortError', () => {
    const e = toError({ code: 'tool_missing', message: 'ffmpeg was not found' });
    expect(e.message).toBe('ffmpeg was not found');
    expect((e as Error & { code?: string }).code).toBe('tool_missing');
    expect(toError({ code: 'cancelled', message: 'Operation cancelled' }).name).toBe('AbortError');
    expect(toError('plain').message).toBe('plain');
    expect(toError(undefined).message).toMatch(/unknown error/);
  });
});

describe('capabilities follow the real tool status', () => {
  it('exposes the converter only while the bridge is available, and refreshes after tool changes', async () => {
    on('tool_status', () => toolStatus({ bridge: false }));
    const p = await make();
    expect(p.features.binaryYpt).toBe(false);
    expect(p.converter).toBeNull();
    on('tool_status', () => toolStatus({ bridge: true }));
    await p.refresh!();
    expect(p.features.binaryYpt).toBe(true);
    expect(p.converter).not.toBeNull();
    expect((await p.converterStatus()).codewalkerCore).toBe('cw-1');
  });

  it('reports FFmpeg-dependent features as unavailable without it', async () => {
    on('tool_status', () => toolStatus({ ffmpeg: false }));
    const p = await make();
    expect(p.features.ffmpeg).toBe(false);
    expect(p.features.interpolation).toBe(false);
  });
});

describe('importing', () => {
  it('imports by path into the active project and maps ffprobe data to the project model', async () => {
    on('import_asset', (a) => {
      expect(a).toEqual({ projectId: 'proj_test', source: 'C:\\media\\Muzzle Flash.mp4' });
      return { relPath: `assets/${'a'.repeat(64)}.mp4`, sha256: 'a'.repeat(64), bytes: 1234, kind: 'mp4', category: 'video', mime: 'video/mp4', deduplicated: false, info: { width: 640, height: 360, duration_sec: 2.5, fps: 24, frame_count: 60, has_alpha: false, codec: 'h264' } };
    });
    const asset = await (await make()).importAsset('C:\\media\\Muzzle Flash.mp4');
    expect(asset).toMatchObject({ kind: 'video', file: `assets/${'a'.repeat(64)}.mp4`, mime: 'video/mp4', bytes: 1234 });
    expect(asset.name).not.toMatch(/[\\/:]/);
    expect(asset.info).toEqual({ width: 640, height: 360, durationSec: 2.5, fps: 24, frameCount: 60, hasAlpha: false, codec: 'h264' });
  });

  it('surfaces a missing FFmpeg as a readable error', async () => {
    on('import_asset', () => {
      throw { code: 'tool_missing', message: 'ffprobe was not found. Install FFmpeg…' };
    });
    await expect((await make()).importAsset('/x.mp4')).rejects.toThrow(/ffprobe was not found/);
  });

  it('refuses browser File objects: the desktop app imports by path', async () => {
    await expect((await make()).importAsset(new File([new Uint8Array(4)], 'a.png'))).rejects.toThrow(/by file path/);
  });

  describe('a .ydr drawable converted to a GLB by the core', () => {
    const sha = 'c'.repeat(64);
    const converted = (over: Record<string, unknown> = {}) => ({
      relPath: `assets/${sha}.glb`,
      sha256: sha,
      bytes: 2264,
      kind: 'glb',
      category: 'model',
      mime: 'model/gltf-binary',
      deduplicated: false,
      info: null,
      convertedFrom: 'ydr',
      conversion: { lod: 'high', models: 2, geometries: 3, vertices: 44, triangles: 22, warnings: ['model_1 geometry 0 has no normals'] },
      ...over,
    });

    it('keeps the source name but points at the stored GLB, and reports the conversion once', async () => {
      on('import_asset', (a) => {
        expect(a).toEqual({ projectId: 'proj_test', source: 'C:\\mods\\w_ar_k2light.ydr' });
        return converted();
      });
      const notes: string[] = [];
      const asset = await (await make()).importAsset('C:\\mods\\w_ar_k2light.ydr', undefined, (m) => notes.push(m));
      expect(asset).toMatchObject({ kind: 'model', name: 'w_ar_k2light.ydr', file: `assets/${sha}.glb`, sha256: sha, mime: 'model/gltf-binary', bytes: 2264, info: null });
      expect(notes).toHaveLength(1);
      // short enough to read before the toast goes (singular "warning" for one)
      expect(notes[0]).toBe('Converted from .ydr (high level of detail, 2 models, 22 triangles): geometry only. 1 converter warning in the 3D model panel.');
      // nothing else was asked of the core: no ffprobe pass, no second read
      expect(fake.calls.filter((c) => c.cmd !== 'tool_status').map((c) => c.cmd)).toEqual(['import_asset']);
    });

    it('works without a note callback', async () => {
      on('import_asset', () => converted());
      await expect((await make()).importAsset('/x/w.ydr')).resolves.toMatchObject({ name: 'w.ydr', kind: 'model' });
    });

    it('an ordinary import never produces a note, even from an old core that sends no conversion fields', async () => {
      on('import_asset', () => ({ relPath: `assets/${sha}.glb`, sha256: sha, bytes: 10, kind: 'glb', category: 'model', mime: 'model/gltf-binary', deduplicated: false, info: null }));
      const notes: string[] = [];
      const asset = await (await make()).importAsset('/x/box.glb', undefined, (m) => notes.push(m));
      expect(asset.name).toBe('box.glb');
      expect(notes).toEqual([]);
    });

    it('core errors for a .ydr keep their text and code (bridge missing, too old, not a drawable)', async () => {
      for (const [code, message] of [
        ['tool_missing', 'The CodeWalker bridge is not configured. Set it up in Settings > Tools (docs/YPT_BRIDGE.md); exporting the model as .glb works without it.'],
        ['invalid_param', '"x.ydr" is not a GTA V resource file.'],
      ] as const) {
        on('import_asset', () => {
          throw { code, message };
        });
        await expect((await make()).importAsset('/x/x.ydr')).rejects.toMatchObject({ message, code });
      }
    });

    it('conversionNote validates what the core sent', () => {
      expect(conversionNote({})).toBeNull();
      expect(conversionNote({ convertedFrom: undefined, conversion: { lod: 'high' } as never })).toBeNull();
      expect(conversionNote({ convertedFrom: 'ydr' })).toBe('Converted from .ydr: geometry only.');
      const hostile = conversionNote({ convertedFrom: 'ydr', conversion: { lod: '<b>x</b>', models: -3, triangles: 'many', warnings: 'none' } as never });
      expect(hostile).toBe('Converted from .ydr: geometry only.');
      expect(conversionNote({ convertedFrom: 'ydr', conversion: { lod: 'med', models: 1, geometries: 1, vertices: 24, triangles: 12, warnings: ['a', 'b'] } })).toBe(
        'Converted from .ydr (med level of detail, 1 model, 12 triangles): geometry only. 2 converter warnings in the 3D model panel.',
      );
    });
  });
});

describe('frame extraction through FFmpeg', () => {
  const project = (): { p: Project; clipId: string } => {
    const p = createProject('t');
    const clip = createClip('c', 'asset1');
    p.assets.asset1 = { id: 'asset1', kind: 'video', name: 'v.mp4', file: `assets/${'b'.repeat(64)}.mp4`, sha256: 'b'.repeat(64), bytes: 1, mime: 'video/mp4', info: null, importedAt: '' };
    p.clips[clip.id] = clip;
    return { p, clipId: clip.id };
  };

  it('sends only validated numbers and decodes the PNG frames it gets back', async () => {
    on('extract_frames_cmd', (a) => {
      const args = a as { jobId: string; projectId: string; args: Record<string, unknown> };
      expect(args.projectId).toBe('proj_test');
      expect(args.args).toMatchObject({ assetRelPath: `assets/${'b'.repeat(64)}.mp4`, fps: 16, maxFrames: 16, keepAspect: true, interpolation: 'none' });
      expect(Object.keys(args.args)).not.toContain('input'); // the UI never supplies a file path
      return buf(packWire({ count: 3, width: 2, height: 2 }, [png(10), png(20), png(30)]));
    });
    const { p, clipId } = project();
    const frames = await (await make()).frames.extract(p.clips[clipId]!, p);
    expect(frames).toHaveLength(3);
    expect(frames.map((f) => f.data[0])).toEqual([10, 20, 30]);
  });

  it('aborting asks the core to cancel the job', async () => {
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    on('extract_frames_cmd', async () => {
      started();
      await new Promise((r) => setTimeout(r, 30));
      throw { code: 'cancelled', message: 'Operation cancelled' };
    });
    on('cancel_job', () => true);
    const { p, clipId } = project();
    const ctl = new AbortController();
    const pending = (await make()).frames.extract(p.clips[clipId]!, p, { signal: ctl.signal });
    await running;
    ctl.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const cancel = fake.calls.find((c) => c.cmd === 'cancel_job');
    const extract = fake.calls.find((c) => c.cmd === 'extract_frames_cmd');
    expect((cancel!.args as { jobId: string }).jobId).toBe((extract!.args as { jobId: string }).jobId);
  });

  it('video without FFmpeg fails with an instruction instead of a decoder error', async () => {
    on('tool_status', () => toolStatus({ ffmpeg: false }));
    const { p, clipId } = project();
    await expect((await make()).frames.extract(p.clips[clipId]!, p)).rejects.toThrow(/needs FFmpeg/);
  });

  it('procedural clips never touch the native side', async () => {
    const p = createProject('t');
    const clip = createClip('gen', null);
    clip.generator = { kind: 'glow', palette: [[0, 0, 0], [1, 1, 1]], frames: 2, size: 16, seed: 1, intensity: 1 };
    const frames = await (await make()).frames.extract(clip, p);
    expect(frames).toHaveLength(2);
    expect(fake.calls.filter((c) => c.cmd !== 'tool_status')).toHaveLength(0);
  });
});

describe('converter', () => {
  it('packs XML + textures into one binary message and returns the verified .ypt', async () => {
    on('convert_ypt', (body) => {
      const { json, blobs } = unpackWire<{ xml: string; gen9: boolean; assetName: string; files: string[] }>(body as Uint8Array);
      expect(json).toMatchObject({ xml: '<x/>', gen9: true, assetName: 'fx', files: ['flames.dds'] });
      expect([...blobs[0]!]).toEqual([1, 2, 3]);
      return buf(packWire({ roundTripOk: true, mismatches: [], resourceVersion: 71, codewalkerCore: 'cw-1' }, [new Uint8Array([0x52, 0x53, 0x43, 0x37])]));
    });
    const r = await (await make()).converter!.convert({ xml: '<x/>', dds: { 'flames.dds': new Uint8Array([1, 2, 3]) }, gen9: true, assetName: 'fx' });
    expect(r.roundTripOk).toBe(true);
    expect(r.resourceVersion).toBe(71);
    expect(String.fromCharCode(...r.ypt)).toBe('RSC7');
  });

  it('reports a failed read-back as such (the exporter then blocks)', async () => {
    on('convert_ypt', () => buf(packWire({ roundTripOk: false, mismatches: ['effect count differs'], resourceVersion: 68, codewalkerCore: null }, [new Uint8Array([1])])));
    const r = await (await make()).converter!.convert({ xml: '<x/>', dds: {}, gen9: false, assetName: 'fx' });
    expect(r.roundTripOk).toBe(false);
    expect(r.mismatches).toEqual(['effect count differs']);
  });

  it('a reply without a file is an error, not an empty success', async () => {
    on('convert_ypt', () => buf(packWire({ roundTripOk: true, mismatches: [], resourceVersion: 68 }, [])));
    await expect((await make()).converter!.convert({ xml: '<x/>', dds: {}, gen9: false, assetName: 'fx' })).rejects.toThrow(/no file/);
  });
});

describe('projects and bundles', () => {
  it('refuses to save an invalid document', async () => {
    const p = await make();
    const bad = { ...createProject('x'), schemaVersion: 99 } as unknown as Project;
    await expect(p.projects.save(bad)).rejects.toThrow(/invalid project/);
    expect(fake.calls.some((c) => c.cmd === 'save_project')).toBe(false);
  });

  it('saves JSON through the core and reads it back through the schema', async () => {
    const store = new Map<string, string>();
    on('save_project', (a) => void store.set((a as { projectId: string }).projectId, (a as { json: string }).json));
    on('load_project', (a) => ({ json: store.get((a as { projectId: string }).projectId)!, recoveredFromBackup: false }));
    const platform = await make();
    const project = createProject('Saved');
    await platform.projects.save(project);
    expect((await platform.projects.open(project.id)).name).toBe('Saved');
    store.set(project.id, '{"schemaVersion":1}');
    await expect(platform.projects.open(project.id)).rejects.toThrow(/damaged/);
  });

  it('bundles round-trip and tampered bundles are refused before anything reaches disk', async () => {
    const png1 = png(7);
    const sha = await sha256Hex(png1);
    const project = createProject('Bundled');
    project.assets.a = { id: 'a', kind: 'image', name: 'a.png', file: `assets/${sha}.png`, sha256: sha, bytes: png1.length, mime: 'image/png', info: null, importedAt: '' };
    on('read_asset', () => buf(png1));
    const platform = await make(project.id);
    const bundle = await platform.projects.exportBundle(project);

    const written: Array<{ projectId: string; relPath: string }> = [];
    on('import_bundle_asset', (body) => void written.push(unpackWire<{ projectId: string; relPath: string }>(body as Uint8Array).json));
    const back = await platform.projects.importBundle(bundle);
    expect(back.name).toBe('Bundled');
    expect(written).toEqual([{ projectId: project.id, relPath: `assets/${sha}.png` }]);

    written.length = 0;
    const tampered = zipSync({ 'project.json': new TextEncoder().encode(JSON.stringify(project)), [`assets/${sha}.png`]: png(8) });
    await expect(platform.projects.importBundle(tampered)).rejects.toThrow(/checksum/);
    const notMedia = zipSync({ 'project.json': new TextEncoder().encode(JSON.stringify(project)), [`assets/${sha}.png`]: new TextEncoder().encode('not media at all, just text') });
    await expect(platform.projects.importBundle(notMedia)).rejects.toThrow(/not recognised media/);
    await expect(platform.projects.importBundle(new Uint8Array([1, 2, 3]))).rejects.toThrow(/not a valid ZIP/);
    expect(written).toEqual([]);
  });
});

describe('files', () => {
  it('writes saved files through the core only after the user picked a destination', async () => {
    on('write_user_file', (body) => {
      const { json, blobs } = unpackWire<{ path: string }>(body as Uint8Array);
      expect(json.path).toBe('/home/u/out.zip');
      expect([...blobs[0]!]).toEqual([9, 9]);
    });
    const p = await make();
    fake.dialogSave = null;
    expect(await p.saveFile('out.zip', new Uint8Array([9, 9]), 'application/zip')).toBe('cancelled');
    expect(fake.calls.some((c) => c.cmd === 'write_user_file')).toBe(false);
    fake.dialogSave = '/home/u/out.zip';
    expect(await p.saveFile('out.zip', new Uint8Array([9, 9]), 'application/zip')).toBe('saved');
  });

  it('file picker normalises single and multiple results', async () => {
    const p = await make();
    fake.dialogOpen = '/a.png';
    expect(await p.pickFiles({ accept: ['.png'] })).toEqual(['/a.png']);
    fake.dialogOpen = ['/a.png', '/b.png'];
    expect(await p.pickFiles({ accept: ['.png'], multiple: true })).toEqual(['/a.png', '/b.png']);
    fake.dialogOpen = null;
    expect(await p.pickFiles({ accept: ['.png'] })).toEqual([]);
  });

  it('without filters the dialog gets one "Supported files" entry from the accept list, as before', async () => {
    const p = await make();
    await p.pickFiles({ accept: ['.png', 'jpg', '../evil', '.ypt.xml', 'a b'], title: 'T', multiple: true });
    expect(fake.dialogOpenOptions).toEqual({ multiple: true, title: 'T', filters: [{ name: 'Supported files', extensions: ['png', 'jpg', 'ypt.xml'] }] });
    await p.pickFiles({ accept: [] });
    expect(fake.dialogOpenOptions!.filters).toBeUndefined();
  });

  it('the weapon-model picker shows three separate file types, everything first', async () => {
    const p = await make();
    const { accept, filters } = modelPicker(p.kind);
    await p.pickFiles({ accept, filters, title: 'Import a weapon model' });
    expect(fake.dialogOpenOptions).toEqual({
      multiple: false,
      title: 'Import a weapon model',
      filters: [
        { name: 'Supported files', extensions: ['glb', 'gltf', 'obj', 'fbx', 'ydr'] },
        { name: '3D models (glb, gltf, obj, fbx)', extensions: ['glb', 'gltf', 'obj', 'fbx'] },
        { name: 'GTA V drawable (ydr)', extensions: ['ydr'] },
      ],
    });
  });

  it('the generic Import picker lists media and models in the first entry, then the same two groups', async () => {
    const p = await make();
    const { accept, filters } = importPicker(p.kind);
    await p.pickFiles({ accept, filters, multiple: true });
    const shown = fake.dialogOpenOptions!.filters as Array<{ name: string; extensions: string[] }>;
    expect(shown.map((f) => f.name)).toEqual(['Supported files', '3D models (glb, gltf, obj, fbx)', 'GTA V drawable (ydr)']);
    expect(shown[0]!.extensions).toEqual(expect.arrayContaining(['mp4', 'webm', 'png', 'webp', 'glb', 'ydr']));
  });

  it('filter extensions are sanitised, entries left empty are dropped, and nothing usable falls back to accept', () => {
    expect(
      dialogFilters(['.glb'], [
        { name: ' Models ', extensions: ['.glb', 'gl b', '../x', 'obj'] },
        { name: 'x'.repeat(200), extensions: ['fbx'] },
        { name: 'Nothing usable', extensions: ['*', '', '.'] },
      ]),
    ).toEqual([
      { name: 'Models', extensions: ['glb', 'obj'] },
      { name: 'x'.repeat(80), extensions: ['fbx'] },
    ]);
    expect(dialogFilters(['.glb', '.ydr'], [{ name: 'Bad', extensions: ['*'] }])).toEqual([{ name: 'Supported files', extensions: ['glb', 'ydr'] }]);
    expect(dialogFilters([], [])).toBeUndefined();
    expect(dialogFilters([], undefined)).toBeUndefined();
    expect(dialogFilters([], [{ name: '', extensions: ['ydr'] }])).toEqual([{ name: 'Files', extensions: ['ydr'] }]);
  });
});
