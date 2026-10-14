import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createAsset, createAttachment, createClip, createEffect, createEmitter, createProject, createSheet, type Project } from '@vfxforge/core';
import { decodeDds, decodePng, validateDds } from '@vfxforge/media';
import { inspectYptXml, validateTextureFiles } from '@vfxforge/ypt';
import { unzipSync } from 'fflate';
import { afterAll, describe, expect, it } from 'vitest';
import { estimateProject, peakParticles, runExport, textureBytes, type FrameSource } from '../src';
import { BRIDGE, BridgeConvertService, CLI, CliFrameSource, bridgeAvailable, cliAvailable } from './node-adapters';

const HARNESS = resolve(__dirname, '../../fivem/test/harness.lua');
const tmp = mkdtempSync(join(tmpdir(), 'vfxforge-e2e-'));
afterAll(() => {
  if (!process.env.VFXFORGE_KEEP_ARTIFACTS) rmSync(tmp, { recursive: true, force: true });
});

const ready = cliAvailable && bridgeAvailable;
const why = `needs the Rust CLI (${CLI}) + ffmpeg and the CodeWalker bridge (${BRIDGE}); run \`cargo build -p vfxforge-native\` and build tools/ypt-bridge`;

/**
 * Generates a real H.264 MP4: 16 frames of a flickering purple flame on a pure black background.
 * (yuv420p, lossy — the format users actually have, not a convenient lossless fixture.)
 */
function makePurpleFlameMp4(path: string): void {
  const blob = (k: number) => `clip(${k}*255*(1-hypot(X-64+10*sin(N/2.5+Y/14),(Y-84)*0.8)/52),0,255)`;
  const r = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=128x128:r=16:d=1', '-vf', `format=rgb24,geq=r='${blob(0.75)}':g='${blob(0.12)}':b='${blob(1)}'`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '14', path],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`could not generate the fixture video: ${r.stderr}`);
}

function buildProject(videoPath: string): Project {
  const p = createProject('Purple Flame Muzzle');
  const asset = createAsset({
    kind: 'video',
    name: 'purple_flames.mp4',
    file: 'assets/' + 'c'.repeat(64) + '.mp4',
    sha256: 'c'.repeat(64),
    bytes: 1,
    mime: 'video/mp4',
    info: { width: 128, height: 128, durationSec: 1, fps: 16, frameCount: 16, hasAlpha: false, codec: 'h264' },
  });
  p.assets[asset.id] = asset;
  void videoPath;
  const clip = createClip('Purple Flames', asset.id);
  clip.extract.fps = 16;
  clip.extract.maxFrames = 16;
  clip.keying = { mode: 'black', color: [0, 1, 0], tolerance: 0.04, feather: 0.12, despill: false, keepSourceAlpha: true };
  p.clips[clip.id] = clip;
  const sheet = createSheet('purple_flames', clip.id);
  sheet.dds = { format: 'BC3', mipmaps: true };
  p.sheets[sheet.id] = sheet;

  const muzzle = createAttachment('muzzle', 'Muzzle');
  muzzle.position = [0.0, 0.03, -0.31]; // preview space: barrel toward -Z
  p.weapon.attachments.push(muzzle);

  const fx = createEffect('Purple Muzzle Flame');
  const em = createEmitter('Flame', sheet.id);
  em.attachmentId = muzzle.id;
  em.triggers = ['fired'];
  em.emission.mode = 'burst';
  em.emission.burstCount = 3;
  em.emission.lifetime = { min: 0.25, max: 0.4 };
  em.particle.size = { min: 0.12, max: 0.2 };
  em.blend = 'additive';
  fx.emitters.push(em);
  p.effects[fx.id] = fx;
  p.export.resourceName = 'purple_muzzle';
  p.export.assetName = 'vfx_purple_muzzle';
  p.export.weapons = ['WEAPON_PISTOL'];
  return p;
}

describe.skipIf(!ready)(`acceptance: MP4 → keyed 4x4 atlas → YPT → CodeWalker → FiveM ZIP (${ready ? 'real ffmpeg + real CodeWalker' : why})`, () => {
  const video = join(tmp, 'purple_flames.mp4');
  makePurpleFlameMp4(video);
  const project = buildProject(video);
  const frames = new CliFrameSource(() => video);
  const stages: string[] = [];
  let result: Awaited<ReturnType<typeof runExport>>;

  it('runs the whole export and ends in a COMPLETE, verified package', async () => {
    result = await runExport(project, frames, new BridgeConvertService(), { resource: {}, onStage: (s) => stages.push(s) });
    const errors = result.report.issues.filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
    expect(result.report.status).toBe('complete');
    expect(stages).toEqual(['frames', 'sheets', 'flipbook', 'model', 'xml', 'binary', 'resource']);
    expect(result.report.converter).toMatchObject({ used: true, roundTripOk: true, resourceVersion: 68 });
  }, 120_000);

  it('extracted 16 real frames, removed the black background and built a transparent 4x4 atlas', () => {
    expect(result.sheets).toHaveLength(1);
    const sheet = result.sheets[0]!;
    expect(sheet.frames).toBe(16);
    const png = decodePng(sheet.png);
    expect([png.width, png.height]).toEqual([1024, 1024]);
    const px = (x: number, y: number) => Array.from(png.data.slice((y * 1024 + x) * 4, (y * 1024 + x) * 4 + 4));
    // a cell's corner was pure black in the video -> now fully transparent
    expect(px(3, 3)[3]).toBe(0);
    expect(px(256 * 3 + 3, 256 * 3 + 3)[3]).toBe(0);
    // the flame core is opaque purple: blue strongest, then red, then little green
    const core = px(128, 190);
    expect(core[3]).toBeGreaterThan(200);
    expect(core[2]).toBeGreaterThan(core[0]);
    expect(core[0]).toBeGreaterThan(core[1]);
    // and every one of the 16 cells actually has content (no empty/duplicated-black frame)
    for (let i = 0; i < 16; i++) {
      const cx = (i % 4) * 256 + 128;
      const cy = Math.floor(i / 4) * 256 + 190;
      expect(px(cx, cy)[3], `frame ${i} centre alpha`).toBeGreaterThan(100);
    }
    expect(sheet.flipbook.status).toBe('structurally-valid');
    expect(sheet.flipbook.engineVerified).toBe(false);
  });

  it('the animation really moves: consecutive frames differ', () => {
    const png = decodePng(result.sheets[0]!.png);
    const cell = (i: number) => {
      const out: number[] = [];
      const x0 = (i % 4) * 256;
      const y0 = Math.floor(i / 4) * 256;
      for (let y = 0; y < 256; y += 8) for (let x = 0; x < 256; x += 8) out.push(png.data[((y0 + y) * 1024 + x0 + x) * 4 + 3]!);
      return out;
    };
    let differing = 0;
    for (let i = 1; i < 16; i++) {
      const a = cell(i - 1);
      const b = cell(i);
      const d = a.reduce((s, v, k) => s + Math.abs(v - b[k]!), 0);
      if (d > 50) differing++;
    }
    expect(differing).toBeGreaterThanOrEqual(12);
  });

  it('the DDS is a valid BC3 with a full mip chain and keeps the transparency', () => {
    const dds = result.sheets[0]!.dds;
    const v = validateDds(dds);
    expect(v.valid).toBe(true);
    expect(v.info).toMatchObject({ width: 1024, height: 1024, format: 'BC3', mipLevels: 11 });
    const top = decodeDds(dds).levels[0]!;
    expect(top.data[(3 * 1024 + 3) * 4 + 3]).toBe(0);
    expect(top.data[(190 * 1024 + 128) * 4 + 3]).toBeGreaterThan(150);
  });

  it('the YPT XML validates structurally and its DDS matches', () => {
    const r = inspectYptXml(result.xml!);
    expect(r.issues.filter((i) => i.severity !== 'info')).toEqual([]);
    expect(r.summary).toMatchObject({ name: 'vfx_purple_muzzle', effects: ['purple_muzzle_flame'], textures: [{ name: 'purple_flames', width: 1024, height: 1024, mips: 11 }] });
    const files = { 'purple_flames.dds': result.sheets[0]!.dds };
    expect(validateTextureFiles({ summary: r.summary!, files }).issues).toEqual([]);
  });

  it('the binary YPT is a real RSC7 resource', () => {
    const b = Buffer.from(result.ypt!);
    expect(b.readUInt32LE(0)).toBe(0x37435352);
    expect(b.readInt32LE(4)).toBe(68);
    expect(b.length).toBeGreaterThan(300_000); // contains the compressed 1024x1024 BC3 + mips
  });

  it('CodeWalker can export the produced binary back to XML + the same texture', () => {
    const dir = join(tmp, 'readback');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'in.ypt'), result.ypt!);
    const r = spawnSync('dotnet', [BRIDGE, 'ypt2xml', '--in', join(dir, 'in.ypt'), '--out', join(dir, 'out.ypt.xml')], { encoding: 'utf8' });
    const reply = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(reply.ok).toBe(true);
    const back = inspectYptXml(readFileSync(join(dir, 'out.ypt.xml'), 'utf8'));
    expect(back.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(back.summary!.effects).toEqual(['purple_muzzle_flame']);
    expect(back.summary!.textures[0]).toMatchObject({ name: 'purple_flames', width: 1024, height: 1024, mips: 11, format: 'D3DFMT_DXT5' });
  });

  it('packages a FiveM resource ZIP with the expected files and weapon/effect wiring', () => {
    const files = unzipSync(result.zip!);
    expect(Object.keys(files).sort()).toEqual([
      'purple_muzzle/README.md',
      'purple_muzzle/client.lua',
      'purple_muzzle/config.lua',
      'purple_muzzle/fxmanifest.lua',
      'purple_muzzle/source/purple_flames.dds',
      'purple_muzzle/source/vfx_purple_muzzle.ypt.xml',
      'purple_muzzle/stream/vfx_purple_muzzle.ypt',
    ]);
    const cfg = new TextDecoder().decode(files['purple_muzzle/config.lua']);
    expect(cfg).toContain("Config.Asset = 'vfx_purple_muzzle'");
    expect(cfg).toContain("'WEAPON_PISTOL'");
    expect(cfg).toContain("effect = 'purple_muzzle_flame'");
    // preview (0, 0.03, -0.31) -> GTA (x, -z, y) = (0, 0.31, 0.03)
    expect(cfg).toContain('offset = { x = 0, y = 0.31, z = 0.03 }');
    expect(Buffer.from(files['purple_muzzle/stream/vfx_purple_muzzle.ypt']!).equals(Buffer.from(result.ypt!))).toBe(true);
  });

  it('the Lua in the PRODUCED zip passes luac and the behavioural harness', () => {
    const files = unzipSync(result.zip!);
    const dir = join(tmp, 'zip-extracted');
    for (const [path, bytes] of Object.entries(files)) {
      const full = join(dir, path.replace(/^purple_muzzle\//, ''));
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, bytes);
    }
    for (const f of ['config.lua', 'client.lua', 'fxmanifest.lua']) {
      expect(spawnSync('luac5.4', ['-p', join(dir, f)]).status, f).toBe(0);
    }
    const list = spawnSync('lua5.4', [HARNESS, dir, '--list'], { encoding: 'utf8' }).stdout.trim().split('\n');
    const runnable = list.filter((s) => !s.startsWith('sync') && !s.startsWith('server'));
    // The harness scenarios override Config.Effects where they need a specific shape; the ones that
    // rely on the standard config run against the effect this project produced.
    const failures: string[] = [];
    for (const s of runnable) {
      const r = spawnSync('lua5.4', [HARNESS, dir, s], { encoding: 'utf8' });
      if (!r.stdout.startsWith('PASS')) failures.push(`${s}: ${r.stdout.split('\n')[0]}`);
    }
    expect(failures).toEqual([]);
  });

  it('reports mapping fidelity honestly, including what is only approximated', () => {
    const notes = result.report.mapping;
    expect(notes.find((n) => n.property === 'emission.burst')?.status).toBe('approximated');
    expect(notes.find((n) => n.property === 'animation')?.detail).toMatch(/ptxclipregions/);
    expect(notes.find((n) => n.property === 'shader')?.confidence).toBe('unverified');
    expect(result.report.estimate!.textureBytes).toBe(textureBytes(1024, 1024, 'BC3', 11));
  });
});

describe.skipIf(!ready)('export gates (nothing invalid is ever exported silently)', () => {
  const video = join(tmp, 'gate.mp4');
  makePurpleFlameMp4(video);
  const frames = new CliFrameSource(() => video);

  it('without a converter the export is BLOCKED with an actionable reason', async () => {
    const r = await runExport(buildProject(video), frames, null, { resource: {} });
    expect(r.report.status).toBe('blocked');
    expect(r.zip).toBeNull();
    expect(r.report.blockers.map((b) => b.code)).toContain('no-converter');
    expect(r.report.blockers.find((b) => b.code === 'no-converter')!.message).toMatch(/YPT_BRIDGE/);
  }, 60_000);

  it('…unless a source-only package is explicitly allowed, which is clearly labelled and has no .ypt', async () => {
    const r = await runExport(buildProject(video), frames, null, { resource: {}, allowSourceOnly: true });
    expect(r.report.status).toBe('source-only');
    expect(r.ypt).toBeNull();
    const files = unzipSync(r.zip!);
    expect(Object.keys(files).some((f) => f.endsWith('.ypt'))).toBe(false);
    expect(Object.keys(files)).toContain('purple_muzzle/source/vfx_purple_muzzle.ypt.xml');
    expect(new TextDecoder().decode(files['purple_muzzle/README.md'])).toMatch(/source-only package/);
    expect(r.report.issues.find((i) => i.code === 'source-only')!.severity).toBe('warning');
  }, 60_000);

  it('a converter whose read-back fails blocks the export (never "exported anyway")', async () => {
    const lying = { convert: async () => ({ ypt: new Uint8Array([1, 2, 3]), roundTripOk: false, mismatches: ['effectRules: XML had 1 but the re-loaded binary has 0'], resourceVersion: 68, codewalkerCore: null }) };
    const r = await runExport(buildProject(video), frames, lying, { resource: {} });
    expect(r.report.status).toBe('blocked');
    expect(r.zip).toBeNull();
    expect(r.report.blockers[0]!.message).toMatch(/NOT exported/);
  }, 60_000);

  it('a throwing converter is reported with its exact message', async () => {
    const boom = { convert: async () => { throw new Error('missing_texture: Texture file not found: x.dds'); } };
    const r = await runExport(buildProject(video), frames, boom, { resource: {} });
    expect(r.report.status).toBe('blocked');
    expect(r.report.blockers[0]!.message).toContain('Texture file not found');
  }, 60_000);

  it('invalid projects are blocked before any heavy work', async () => {
    const empty = createProject('Empty');
    const r = await runExport(empty, frames, null, { resource: {} });
    expect(r.report.blockers.map((b) => b.code)).toContain('no-sheets');

    const p = buildProject(video);
    Object.values(p.sheets)[0]!.grid = { cols: 2, rows: 2 }; // 16 frames cannot fit 2x2
    const r2 = await runExport(p, frames, new BridgeConvertService(), { resource: {} });
    expect(r2.report.status).toBe('blocked');
    expect(r2.report.blockers.some((b) => /do not fit/.test(b.message))).toBe(true);
    expect(r2.zip).toBeNull();
  }, 60_000);

  it('a frame source that fails is surfaced, not swallowed', async () => {
    const broken: FrameSource = { getFrames: async () => { throw new Error('ffmpeg exploded'); } };
    const r = await runExport(buildProject(video), broken, null, { resource: {} });
    expect(r.report.blockers[0]!.message).toBe('ffmpeg exploded');
  });

  it('can be cancelled', async () => {
    const ac = new AbortController();
    const slow: FrameSource = { getFrames: async (c, p, s) => { ac.abort(); return frames.getFrames(c, p, s); } };
    await expect(runExport(buildProject(video), slow, null, { resource: {}, signal: ac.signal })).rejects.toThrow(/cancelled/i);
  }, 60_000);
});

describe('cost estimates', () => {
  it('computes texture memory, particle counts and flags expensive setups', () => {
    expect(textureBytes(1024, 1024, 'BC3', 11)).toBe(Math.round(1024 * 1024 * (4 / 3)));
    expect(textureBytes(1024, 1024, 'BC1', 1)).toBe(512 * 1024);
    expect(textureBytes(512, 512, 'BGRA8', 1)).toBe(1024 * 1024);
    const p = createProject('x');
    const fx = createEffect('x');
    const em = createEmitter('e', null);
    em.emission.mode = 'continuous';
    em.emission.rate = 1000;
    em.emission.lifetime = { min: 1, max: 1 };
    em.emission.maxParticles = 5000;
    em.particle.size = { min: 2, max: 2 };
    fx.emitters.push(em);
    p.effects[fx.id] = fx;
    expect(peakParticles(em)).toBe(1000);
    const e = estimateProject(p, [{ sheetId: 's', textureName: 't', width: 4096, height: 4096, frames: 64, format: 'BGRA8', mips: 1, bytes: textureBytes(4096, 4096, 'BGRA8', 1) }]);
    const codes = e.issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['cost-huge-texture', 'cost-uncompressed', 'cost-memory-error', 'cost-particles', 'cost-overdraw']));
    em.emission.mode = 'burst';
    em.emission.burstCount = 10;
    em.emission.interval = 0.5;
    expect(peakParticles(em)).toBe(20); // 10 per burst, 2 overlapping bursts
    em.emission.mode = 'oneShot';
    expect(peakParticles(em)).toBe(10);
  });
});
