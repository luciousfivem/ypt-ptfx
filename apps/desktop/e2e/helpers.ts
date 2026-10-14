import { expect, test as base, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const fixture = (name: string) => join(FIXTURES, name);

/** Fails any test that logs a console error or throws in the page: silent UI errors are bugs. */
export const test = base.extend<{ errors: string[] }>({
  errors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const t = m.text();
        // headless software GL prints driver notices that are not application errors
        if (/GPU stall|GL Driver Message|swiftshader|WebGL: INVALID_|Failed to load resource.*favicon/i.test(t)) return;
        errors.push(`console.error: ${t}`);
      });
      await use(errors);
      expect(errors, 'the page must not log errors').toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

export async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('viewport-canvas')).toBeVisible();
  await expect(page.getByTestId('stats')).toContainText('fps', { timeout: 20_000 });
}

export async function addPreset(page: Page, id: string): Promise<void> {
  await page.getByRole('tab', { name: 'Presets' }).click();
  await page.getByTestId(`preset-${id}`).click();
}

/** Opens the app's own file picker and hands it a file. */
export async function importFile(page: Page, path: string | { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('toolbar-import').click();
  await (await chooser).setFiles(path);
}

/** A tiny but valid binary glTF: a 0.1 x 0.1 x 0.6 m box, long axis along Z. */
export function makeGlb(): Buffer {
  const hx = 0.05;
  const hy = 0.05;
  const hz = 0.3;
  const pos = new Float32Array([-hx, -hy, -hz, hx, -hy, -hz, hx, hy, -hz, -hx, hy, -hz, -hx, -hy, hz, hx, -hy, hz, hx, hy, hz, -hx, hy, hz]);
  const idx = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2]);
  const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(idx.buffer)]);
  const binPadded = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: binPadded.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-hx, -hy, -hz], max: [hx, hy, hz] },
      { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
  };
  let jsonBuf = Buffer.from(JSON.stringify(json));
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const total = 12 + 8 + jsonBuf.length + 8 + binPadded.length;
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(total, 8);
  const c0 = Buffer.alloc(8);
  c0.writeUInt32LE(jsonBuf.length, 0);
  c0.writeUInt32LE(0x4e4f534a, 4);
  const c1 = Buffer.alloc(8);
  c1.writeUInt32LE(binPadded.length, 0);
  c1.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, c0, jsonBuf, c1, binPadded]);
}

export const readFixture = (name: string) => readFileSync(fixture(name));
