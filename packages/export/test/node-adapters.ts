/**
 * Node-side implementations of the export services, built on the real Rust CLI (FFmpeg) and the
 * real .NET bridge. The desktop app provides the same interfaces through Tauri commands.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Clip, Project } from '@vfxforge/core';
import { decodePng, type RgbaImage } from '@vfxforge/media';
import type { ConvertResult, ConvertService, FrameSource } from '../src';

const root = resolve(__dirname, '../../..');
export const CLI = process.env.VFXFORGE_CLI ?? resolve(root, 'target/debug/vfxforge-cli');
export const BRIDGE = process.env.VFXFORGE_BRIDGE_DLL ?? resolve(root, 'tools/ypt-bridge/out/vfxforge-ypt-bridge.dll');

export const cliAvailable = existsSync(CLI) && spawnSync('ffmpeg', ['-version']).status === 0;
export const bridgeAvailable = existsSync(BRIDGE) && spawnSync('dotnet', ['--version']).status === 0;

/** Extracts frames with the Rust CLI exactly as the desktop app does, then decodes the PNGs. */
export class CliFrameSource implements FrameSource {
  constructor(private readonly resolveAsset: (project: Project, assetId: string) => string) {}

  async getFrames(clip: Clip, project: Project): Promise<RgbaImage[]> {
    if (!clip.assetId) throw new Error(`Clip "${clip.name}" has no source asset.`);
    const input = this.resolveAsset(project, clip.assetId);
    const asset = project.assets[clip.assetId]!;
    const out = mkdtempSync(join(tmpdir(), 'vfxforge-frames-'));
    try {
      if (asset.kind === 'image') return [decodePng(new Uint8Array(readFileSync(input)))];
      const req = {
        input,
        outDir: out,
        startSec: clip.extract.startSec,
        endSec: clip.extract.endSec,
        fps: clip.extract.fps,
        frameSkip: clip.extract.frameSkip,
        maxFrames: clip.extract.maxFrames,
        width: clip.extract.width,
        height: clip.extract.height,
        keepAspect: clip.extract.keepAspect,
        interpolation: clip.extract.interpolation,
      };
      const stdout = execFileSync(CLI, ['extract'], { input: JSON.stringify(req), encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      const reply = JSON.parse(stdout.trim().split('\n').pop()!);
      if (reply.error) throw new Error(`${reply.error.message}`);
      return readdirSync(out)
        .filter((f) => /^frame_\d{5}\.png$/.test(f))
        .sort()
        .map((f) => decodePng(new Uint8Array(readFileSync(join(out, f)))));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }
}

function bridge(args: string[]): Record<string, unknown> {
  const r = spawnSync('dotnet', [BRIDGE, ...args], { encoding: 'utf8', env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' } });
  const line = r.stdout.split('\n').reverse().find((l) => l.trim().startsWith('{'));
  if (!line) throw new Error(`bridge printed no JSON: ${r.stdout}${r.stderr}`);
  return JSON.parse(line) as Record<string, unknown>;
}

export class BridgeConvertService implements ConvertService {
  async convert({ xml, dds, gen9, assetName }: { xml: string; dds: Record<string, Uint8Array>; gen9: boolean; assetName: string }): Promise<ConvertResult> {
    const dir = mkdtempSync(join(tmpdir(), 'vfxforge-convert-'));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${assetName}.ypt.xml`), xml);
      for (const [name, bytes] of Object.entries(dds)) writeFileSync(join(dir, name), bytes);
      const out = join(dir, `${assetName}.ypt`);
      const r = bridge(['xml2ypt', '--in', join(dir, `${assetName}.ypt.xml`), '--out', out, '--gen', gen9 ? 'gen9' : 'legacy']);
      if (r.ok !== true) throw new Error(`${r.code}: ${r.error}`);
      const rt = r.roundTrip as { ok: boolean; mismatches: string[] };
      const v = bridge(['version']);
      return {
        ypt: new Uint8Array(readFileSync(out)),
        roundTripOk: rt.ok,
        mismatches: rt.mismatches,
        resourceVersion: r.resourceVersion as number,
        codewalkerCore: (v.codewalkerCore as string) ?? null,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
