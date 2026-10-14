import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { unzipSync } from 'fflate';
import { afterAll, describe, expect, it } from 'vitest';
import { joaat, type BindingPlan, type MappingNote } from '@vfxforge/ypt';
import {
  DEFAULT_RESOURCE_OPTIONS,
  buildConfigLua,
  buildManifest,
  buildResourceFiles,
  isWeaponName,
  lnum,
  lstr,
  packageResource,
  validateOptions,
  weaponHash,
  type ResourceInput,
  type ResourceOptions,
} from '../src';

const HARNESS = resolve(__dirname, 'harness.lua');
const LUA = 'lua5.4';
const LUAC = 'luac5.4';
const hasLua = spawnSync(LUA, ['-v']).status === 0;

const binding = (over: Partial<BindingPlan> = {}): BindingPlan => ({
  effectRule: 'fx_flash',
  effectName: 'Flash',
  attachmentId: null,
  attachmentName: 'Muzzle',
  offset: [0.01, 0.25, 0.03],
  rotation: [0, 0, 90],
  scale: 1.5,
  bone: null,
  triggers: ['fired'],
  loop: false,
  emitterNames: ['Core'],
  ...over,
});

const options = (over: Partial<ResourceOptions> = {}): ResourceOptions => ({
  ...DEFAULT_RESOURCE_OPTIONS,
  resourceName: 'test_resource',
  assetName: 'vfx_test',
  author: 'tester',
  weapons: ['WEAPON_PISTOL'],
  ...over,
});

const notes: MappingNote[] = [
  { effect: 'Flash', emitter: 'Core', property: 'physics.drag', status: 'approximated', confidence: 'inferred', detail: 'Drag | approximated' },
  { effect: 'Flash', emitter: 'Core', property: 'emission.maxParticles', status: 'preview-only', confidence: 'verified', detail: 'Not exported.' },
];

const input = (over: Partial<ResourceInput> = {}): ResourceInput => ({
  options: options(),
  bindings: [binding()],
  ypt: new Uint8Array([0x52, 0x53, 0x43, 0x37, 1, 2, 3]),
  notes,
  validationSummary: ['Structure validated', 'CodeWalker round-trip OK'],
  ...over,
});

const tmp = mkdtempSync(join(tmpdir(), 'vfxforge-fivem-'));
afterAll(() => {
  if (!process.env.VFXFORGE_KEEP_ARTIFACTS) rmSync(tmp, { recursive: true, force: true });
});

function writeResource(files: Record<string, Uint8Array>, name: string): string {
  const dir = join(tmp, name);
  for (const [path, bytes] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, bytes);
  }
  return dir;
}

describe('weapon hashes', () => {
  it('matches well-known GTA V weapon hash constants', () => {
    expect(weaponHash('WEAPON_PISTOL').hash).toBe(453432689);
    expect(weaponHash('WEAPON_UNARMED').hash).toBe(2725352035);
    expect(weaponHash('WEAPON_CARBINERIFLE').hash).toBe(2210333304);
    expect(weaponHash('WEAPON_MICROSMG').hash).toBe(324215364);
    expect(weaponHash('WEAPON_PUMPSHOTGUN').hash).toBe(487013001);
    expect(weaponHash('WEAPON_SNIPERRIFLE').hash).toBe(100416529);
    expect(weaponHash('WEAPON_PISTOL').signed).toBe(453432689);
    expect(weaponHash('WEAPON_UNARMED').signed).toBe(-1569615261);
    expect(weaponHash('weapon_pistol').hash).toBe(joaat('WEAPON_PISTOL'));
  });

  it('validates the shape of weapon names', () => {
    expect(isWeaponName('WEAPON_PISTOL')).toBe(true);
    for (const bad of ['weapon_pistol', 'WEAPON_', "WEAPON_X'; os.exit()", 'PISTOL', 'WEAPON_A B', '']) expect(isWeaponName(bad), bad).toBe(false);
  });
});

describe('lua literal helpers', () => {
  it('formats numbers safely and rejects non-finite values', () => {
    expect(lnum(1)).toBe('1');
    expect(lnum(0.1 + 0.2)).toBe('0.3');
    expect(lnum(-0.000001)).toBe('-0.000001');
    expect(() => lnum(Number.NaN)).toThrow();
    expect(() => lnum(Infinity)).toThrow();
  });
  it('escapes strings', () => {
    expect(lstr("a'b\\c\nd")).toBe("'a\\'b\\\\c\\nd'");
  });
});

describe('option validation', () => {
  it('accepts sane options and lists every problem otherwise', () => {
    expect(validateOptions(options())).toEqual([]);
    const errs = validateOptions(options({ resourceName: 'Bad Name', assetName: "x'y", testCommand: '1x', weapons: ['nope'], sync: { enabled: true, radius: -5, minIntervalMs: -1 }, assetTimeoutMs: 5, idlePollMs: 1 }));
    expect(errs.length).toBeGreaterThanOrEqual(7);
  });
});

describe('generated files', () => {
  it('produces the expected layout', () => {
    const { files } = buildResourceFiles(input());
    expect(Object.keys(files).sort()).toEqual(['README.md', 'client.lua', 'config.lua', 'fxmanifest.lua', 'stream/vfx_test.ypt']);
    const withSync = buildResourceFiles(input({ options: options({ sync: { enabled: true, radius: 60, minIntervalMs: 60 } }), source: { xml: '<x/>', dds: { 'a.dds': new Uint8Array([1]) } } }));
    expect(Object.keys(withSync.files).sort()).toEqual(['README.md', 'client.lua', 'config.lua', 'fxmanifest.lua', 'server.lua', 'source/a.dds', 'source/vfx_test.ypt.xml', 'stream/vfx_test.ypt']);
  });

  it('writes a Lua 5.4 manifest and only registers the server script when sync is on', () => {
    const m = buildManifest(options());
    expect(m).toContain("fx_version 'cerulean'");
    expect(m).toContain("lua54 'yes'");
    expect(m).toContain("client_scripts { 'config.lua', 'client.lua' }");
    expect(m).not.toContain('server_scripts');
    expect(buildManifest(options({ sync: { enabled: true, radius: 60, minIntervalMs: 60 } }))).toContain("server_scripts { 'config.lua', 'server.lua' }");
  });

  it('refuses to build a "loadable" resource without a YPT, but allows an explicit source-only package', () => {
    expect(() => buildResourceFiles(input({ ypt: null }))).toThrow(/without a binary YPT/);
    const r = buildResourceFiles(input({ ypt: null, sourceOnly: true, source: { xml: '<x/>', dds: {} } }));
    expect(r.files['stream/vfx_test.ypt']).toBeUndefined();
    expect(r.warnings.join(' ')).toMatch(/Source-only/);
    expect(new TextDecoder().decode(r.files['README.md'])).toMatch(/source-only package/);
  });

  it('rejects empty effects and invalid options', () => {
    expect(() => buildResourceFiles(input({ bindings: [] }))).toThrow(/no effects/);
    expect(() => buildResourceFiles(input({ options: options({ resourceName: '../evil' }) }))).toThrow(/lowercase identifier/);
  });

  it('README documents effects, hashes, sync state, fidelity and the in-game checklist', () => {
    const readme = new TextDecoder().decode(buildResourceFiles(input()).files['README.md']);
    expect(readme).toContain('ensure test_resource');
    expect(readme).toContain('| `WEAPON_PISTOL` | 453432689 | 453432689 | `0x1B06D571` |');
    expect(readme).toContain('Sync is **disabled**');
    expect(readme).toContain('| 1 | `fx_flash` | fired | no | 0.01, 0.25, 0.03 | 0, 0, 90 | weapon entity |');
    expect(readme).toContain('Drag \\| approximated'); // table cells are escaped
    expect(readme).toContain('approximated');
    expect(readme).not.toContain('emission.maxParticles'); // verified preview-only rows are not "problems"
    expect(readme).toMatch(/cannot launch GTA V/);
    expect(readme).toContain('/vfxtest');
  });

  it('README reflects enabled sync', () => {
    const readme = new TextDecoder().decode(buildResourceFiles(input({ options: options({ sync: { enabled: true, radius: 40, minIntervalMs: 80 } }) })).files['README.md']);
    expect(readme).toContain('Sync is **enabled**');
    expect(readme).toContain('80 ms');
  });
});

describe('Lua injection safety', () => {
  const hostile = [
    "'; os.execute('echo pwned') --",
    ']] os.exit() --[[',
    'line1\nline2\r\nline3',
    '\\',
    'a\u0000b',
    '"quotes" and \'apostrophes\'',
    '-- comment',
  ];
  it.each(hostile)('hostile effect/attachment names stay inert: %j', (evil) => {
    const lua = buildConfigLua(options(), [binding({ effectName: evil, attachmentName: evil, effectRule: 'fx_ok', bone: evil })]);
    const dir = join(tmp, 'inj');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'config.lua');
    writeFileSync(file, lua);
    if (!hasLua) return;
    expect(spawnSync(LUAC, ['-p', file]).status, lua).toBe(0);
    // load it and make sure the only table keys are the expected ones and no code ran
    const run = spawnSync(LUA, ['-e', `os.execute = function() error('INJECTED') end; os.exit = function() error('INJECTED') end; dofile('${file}'); assert(#Config.Effects == 1); assert(Config.Effects[1].effect == 'fx_ok')`]);
    expect(run.stderr.toString()).toBe('');
    expect(run.status).toBe(0);
  });

  it('rejects NaN/Infinity before they can reach Lua', () => {
    expect(() => buildConfigLua(options(), [binding({ offset: [Number.NaN, 0, 0] })])).toThrow(/non-finite/);
  });
});

describe('ZIP packaging', () => {
  it('zips everything under one top-level folder, byte-identically every time', () => {
    const a = packageResource(input());
    const b = packageResource(input());
    expect(Buffer.from(a.zip).equals(Buffer.from(b.zip))).toBe(true);
    const entries = unzipSync(a.zip);
    expect(Object.keys(entries).sort()).toEqual(['test_resource/README.md', 'test_resource/client.lua', 'test_resource/config.lua', 'test_resource/fxmanifest.lua', 'test_resource/stream/vfx_test.ypt']);
    expect(Buffer.from(entries['test_resource/stream/vfx_test.ypt']!).equals(Buffer.from(input().ypt!))).toBe(true);
    expect(a.totalBytes).toBeGreaterThan(5000);
  });

  it('never contains path-traversal entries', () => {
    const entries = Object.keys(unzipSync(packageResource(input({ source: { xml: '<x/>', dds: { 'a.dds': new Uint8Array([1]) } } })).zip));
    for (const e of entries) {
      expect(e.startsWith('/')).toBe(false);
      expect(e.split('/').includes('..')).toBe(false);
    }
  });

  it('refuses unsafe source file names', () => {
    expect(() => packageResource(input({ source: { xml: '<x/>', dds: { '../evil.dds': new Uint8Array([1]) } } }))).toThrow(/Unsafe relative path/);
  });
});

describe.skipIf(!hasLua)('generated Lua (lua 5.4)', () => {
  const standard = (sync = false) => {
    const files = buildResourceFiles(input({ options: options({ sync: { enabled: sync, radius: 60, minIntervalMs: 60 } }) })).files;
    return writeResource(files, sync ? 'res-sync' : 'res');
  };
  const dir = standard();
  const syncDir = standard(true);

  it('every generated script passes luac -p', () => {
    for (const d of [dir, syncDir]) {
      for (const f of ['config.lua', 'client.lua', ...(d === syncDir ? ['server.lua'] : [])]) {
        const r = spawnSync(LUAC, ['-p', join(d, f)]);
        expect(r.status, `${f}: ${r.stderr}`).toBe(0);
      }
    }
  });

  // vitest still runs this callback when the suite is skipped, so never shell out to a Lua that is not installed
  const list = hasLua ? spawnSync(LUA, [HARNESS, dir, '--list'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean) : [];
  it('the harness exposes its scenarios', () => {
    expect(list.length).toBeGreaterThanOrEqual(20);
  });

  it.each(list)('scenario: %s', (name) => {
    const target = name.startsWith('sync') || name.startsWith('server') ? syncDir : dir;
    const r = spawnSync(LUA, [HARNESS, target, name], { encoding: 'utf8', timeout: 30_000 });
    expect(r.stdout.trim().split('\n')[0] + '\n' + (r.status === 0 ? '' : r.stdout + r.stderr)).toMatch(/^PASS /);
  });
});
