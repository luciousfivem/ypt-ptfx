/**
 * Runs the REAL CodeWalker bridge (`ydr2glb`) on the committed fixture drawables and loads what it writes through the app's own
 * model loader. Gated like the other oracle tests: skipped, with the reason in the suite title, unless the bridge is built
 * (VFXFORGE_BRIDGE_DLL, or tools/ypt-bridge/out/vfxforge-ypt-bridge.dll) and `dotnet` runs.
 *
 * The fixtures are synthetic drawables written by CodeWalker from XML authored for this repository; no game file is involved.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { loadModel } from '../src/viewport/models';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const DLL = process.env.VFXFORGE_BRIDGE_DLL ?? resolve(root, 'tools/ypt-bridge/out/vfxforge-ypt-bridge.dll');
const YDR_DIR = resolve(root, 'tools/ypt-bridge/fixtures');
const COPIES = join(here, 'fixtures');

const hasDotnet = (() => {
  try {
    return spawnSync('dotnet', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();
const ready = existsSync(DLL) && hasDotnet && existsSync(join(YDR_DIR, 'cube_pnct.ydr'));
const why = ready ? DLL : `ydr2glb bridge not available (looked for ${DLL}${hasDotnet ? '' : '; dotnet did not run'}). Build tools/ypt-bridge (docs/YPT_BRIDGE.md) or set VFXFORGE_BRIDGE_DLL to run these tests.`;

interface Reply {
  ok: boolean;
  [k: string]: any;
}

/** One bridge call; arguments go straight to the process, never through a shell. */
function bridge(args: string[]): { reply: Reply; exit: number | null } {
  const r = spawnSync('dotnet', [DLL, ...args], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' } });
  const last = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).pop();
  if (!last) throw new Error(`the bridge printed no JSON (exit ${r.status}): ${r.stdout}\n${r.stderr}`);
  return { reply: JSON.parse(last) as Reply, exit: r.status };
}

const scratch = ready ? mkdtempSync(join(tmpdir(), 'vfxforge-ydr-ui-')) : '';
afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const extents = (b: { min: number[]; max: number[] }) => b.max.map((v, i) => v - b.min[i]!);
const near = (a: number[], b: number[], eps = 1e-4) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]!) <= eps);

const CASES: Array<{ name: string; ydr: string; golden: string; lod?: string; triangles: number; lodShown: string }> = [
  { name: 'legacy cube', ydr: 'cube_pnct.ydr', golden: 'cube_pnct.glb', triangles: 12, lodShown: 'high' },
  { name: 'gen9 cube', ydr: 'cube_pnct_gen9.ydr', golden: 'cube_pnct_gen9.glb', triangles: 12, lodShown: 'high' },
  { name: 'multi-LOD drawable (auto = high)', ydr: 'multi_lod.ydr', golden: 'multi_lod.glb', triangles: 22, lodShown: 'high' },
  { name: 'multi-LOD drawable (--lod med)', ydr: 'multi_lod.ydr', golden: 'multi_lod_med.glb', lod: 'med', triangles: 12, lodShown: 'med' },
  { name: 'bone-bound drawable', ydr: 'bone_bound.ydr', golden: 'bone_bound.glb', triangles: 48, lodShown: 'high' },
];

describe.skipIf(!ready)(`real ydr2glb bridge output through the app's model loader (${why})`, () => {
  for (const c of CASES) {
    it(`${c.name}: the bridge's GLB equals the golden copy and loads as an origin-ydr model of the same size`, async () => {
      const out = join(scratch, `${c.golden}`);
      const { reply, exit } = bridge(['ydr2glb', '--in', join(YDR_DIR, c.ydr), '--out', out, ...(c.lod ? ['--lod', c.lod] : [])]);
      expect(reply.ok, JSON.stringify(reply)).toBe(true);
      expect(exit).toBe(0);
      const bytes = readFileSync(out);
      expect(bytes.length).toBe(reply.bytes);
      // the copies under test/fixtures are what the other tests load: they must be what the bridge writes today
      expect(Buffer.compare(bytes, readFileSync(join(COPIES, c.golden)))).toBe(0);

      const model = await loadModel(new Uint8Array(bytes), 'glb');
      expect(model.origin).toBe('ydr');
      expect(model.triangles).toBe(reply.triangles);
      expect(model.triangles).toBe(c.triangles);
      expect(near(model.size, extents(reply.bounds))).toBe(true);
      expect(model.warnings[0]).toMatch(/geometry only/);
      expect(model.warnings).toContain(reply.lodsAvailable.length > 1 ? `Level of detail shown: ${c.lodShown} (the drawable also has ${reply.lodsAvailable.filter((l: string) => l !== c.lodShown).join(', ')}; other levels are not imported).` : `Level of detail shown: ${c.lodShown}.`);
      // every warning the converter reported reaches the user, and the counts the app shows are the converter's
      for (const w of reply.warnings as string[]) expect(model.warnings).toContain(`Converter: ${w}`);
      if (reply.windingFlippedGeometries > 0) expect(model.warnings.some((w) => /triangle order reversed so the faces point outward/.test(w))).toBe(true);
      expect(model.warnings.includes('No bone transforms were applied.')).toBe(!reply.boneTransformsApplied);
      model.dispose();
    });
  }

  it('the converter is deterministic: converting twice gives identical bytes', () => {
    const a = join(scratch, 'twice_a.glb');
    const b = join(scratch, 'twice_b.glb');
    expect(bridge(['ydr2glb', '--in', join(YDR_DIR, 'bone_bound.ydr'), '--out', a]).reply.ok).toBe(true);
    expect(bridge(['ydr2glb', '--in', join(YDR_DIR, 'bone_bound.ydr'), '--out', b]).reply.ok).toBe(true);
    expect(Buffer.compare(readFileSync(a), readFileSync(b))).toBe(0);
  });

  it('a text file named .ydr is refused by the bridge with a code the desktop core can map (not_ydr), and no GLB appears', () => {
    const fake = join(scratch, 'not_a_drawable.ydr');
    writeFileSync(fake, 'this is not a GTA V resource file');
    const out = join(scratch, 'nothing.glb');
    const { reply, exit } = bridge(['ydr2glb', '--in', fake, '--out', out]);
    expect(reply).toMatchObject({ ok: false, code: 'not_ydr' });
    expect(exit).toBe(1);
    expect(existsSync(out)).toBe(false);
  });

  it('a binary resource that is not a drawable is refused (unsupported_version), not converted', () => {
    // the bridge converts the repository's own YPT XML fixture into a real RSC7 .ypt, which is a resource but not a drawable
    const real = join(scratch, 'effect.ypt');
    const made = bridge(['xml2ypt', '--in', join(root, 'native/vfxforge-native/tests/fixtures/tiny_fx.ypt.xml'), '--out', real]);
    expect(made.reply.ok, JSON.stringify(made.reply)).toBe(true);
    const ypt = join(scratch, 'effect.ydr'); // same bytes, renamed: the extension is not what decides
    copyFileSync(real, ypt);
    const out = join(scratch, 'effect.glb');
    const { reply, exit } = bridge(['ydr2glb', '--in', ypt, '--out', out]);
    expect(reply).toMatchObject({ ok: false, code: 'unsupported_version' });
    expect(exit).toBe(1);
    expect(existsSync(out)).toBe(false);
  });
});
