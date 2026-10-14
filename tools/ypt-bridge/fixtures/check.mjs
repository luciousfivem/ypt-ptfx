#!/usr/bin/env node
// Checks (or regenerates) the ydr2glb fixtures against a built bridge. No dependencies.
//
//   node tools/ypt-bridge/fixtures/check.mjs              # verify
//   node tools/ypt-bridge/fixtures/check.mjs --regenerate  # rewrite the .ydr and golden .glb files from the XML sources
//
// The bridge is taken from VFXFORGE_BRIDGE_DLL, else tools/ypt-bridge/out/vfxforge-ypt-bridge.dll. When it is missing the
// check is skipped (exit 0) and says why, like the other bridge-gated tests. `dotnet` is taken from DOTNET or PATH.
//
// For every case in expected.json this runs
//   1. ydr2glb on the committed .ydr  -> reply fields match expected.json and the bytes equal the committed golden .glb
//   2. xml2ydr on the XML source, then ydr2glb on that new .ydr -> the same golden bytes (so XML, .ydr and golden agree;
//      the .ydr bytes themselves are not compared because deflate output may differ between runtimes)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dll = process.env.VFXFORGE_BRIDGE_DLL || path.resolve(here, '../out/vfxforge-ypt-bridge.dll');
const dotnet = process.env.DOTNET || 'dotnet';
const regenerate = process.argv.includes('--regenerate');

if (!fs.existsSync(dll)) {
  console.log(`SKIPPED: bridge DLL not found at ${dll}. Build tools/ypt-bridge (docs/YPT_BRIDGE.md) or set VFXFORGE_BRIDGE_DLL.`);
  process.exit(0);
}

function bridge(...args) {
  const r = spawnSync(dotnet, [dll, ...args], { encoding: 'utf8', timeout: 120000 });
  if (r.error) throw new Error(`could not run ${dotnet}: ${r.error.message}`);
  const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  let reply;
  try { reply = JSON.parse(last); } catch { throw new Error(`no JSON reply from ${args[0]}: ${r.stdout}\n${r.stderr}`); }
  return reply;
}
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const near = (a, b) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= 1e-6);

const cases = JSON.parse(fs.readFileSync(path.join(here, 'expected.json'), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vfxforge-ydr-'));
let failures = 0;
const fail = (name, msg) => { failures++; console.log(`FAIL  ${name}: ${msg}`); };

try {
  if (regenerate) {
    const done = new Set();
    for (const [name, c] of Object.entries(cases)) {
      const ydr = path.join(here, c.ydr);
      if (!done.has(c.ydr)) {
        const r = bridge('xml2ydr', '--in', path.join(here, c.xml), '--out', ydr, '--gen', c.gen);
        if (!r.ok) { fail(name, `xml2ydr: ${r.code} ${r.error}`); continue; }
        done.add(c.ydr);
      }
      const r = bridge('ydr2glb', '--in', ydr, '--out', path.join(here, c.glb), '--lod', c.lod ?? 'auto');
      console.log(r.ok ? `regenerated ${c.ydr} and ${c.glb} (${r.bytes} bytes)` : `FAIL  ${name}: ydr2glb: ${r.code} ${r.error}`);
      if (!r.ok) failures++;
    }
  } else {
    for (const [name, c] of Object.entries(cases)) {
      const golden = path.join(here, c.glb);
      const lod = c.lod ?? 'auto';
      // 1. committed .ydr
      const out1 = path.join(tmp, `${name}.1.glb`);
      const r1 = bridge('ydr2glb', '--in', path.join(here, c.ydr), '--out', out1, '--lod', lod);
      if (!r1.ok) { fail(name, `ydr2glb: ${r1.code} ${r1.error}`); continue; }
      const e = c.expect;
      for (const key of Object.keys(e)) {
        if (key === 'bounds') {
          if (!near(r1.bounds.min, e.bounds.min) || !near(r1.bounds.max, e.bounds.max)) fail(name, `bounds ${JSON.stringify(r1.bounds)} != ${JSON.stringify(e.bounds)}`);
        } else if (!same(r1[key], e[key])) fail(name, `${key} ${JSON.stringify(r1[key])} != ${JSON.stringify(e[key])}`);
      }
      if (sha(out1) !== sha(golden)) fail(name, `output differs from golden ${c.glb}`);
      // 2. fresh .ydr from the XML source
      const ydr2 = path.join(tmp, `${name}.ydr`);
      const x = bridge('xml2ydr', '--in', path.join(here, c.xml), '--out', ydr2, '--gen', c.gen);
      if (!x.ok) { fail(name, `xml2ydr: ${x.code} ${x.error}`); continue; }
      const out2 = path.join(tmp, `${name}.2.glb`);
      const r2 = bridge('ydr2glb', '--in', ydr2, '--out', out2, '--lod', lod);
      if (!r2.ok) { fail(name, `ydr2glb (fresh): ${r2.code} ${r2.error}`); continue; }
      if (sha(out2) !== sha(golden)) fail(name, `fresh conversion of ${c.xml} differs from golden ${c.glb}`);
      console.log(`ok    ${name}`);
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failures === 0 ? 'PASS' : `FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
