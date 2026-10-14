/**
 * Importing GTA V drawables (.ydr) as weapon models.
 *
 * Part 1 runs the real browser build: it never offers .ydr, refuses one with an actionable message, and shows the
 * YDR-specific note and warnings for a GLB that the converter wrote (the golden files from tools/ypt-bridge/fixtures).
 *
 * Part 2 runs the desktop UI (platform "tauri") in the browser against a SCRIPTED core: `window.__TAURI_INTERNALS__` is
 * replaced by a stub that answers the few commands the import needs. That exercises the real desktop platform code, the picker
 * filters it hands to the native dialog, and the whole UI path. It does NOT run the Rust core, the CodeWalker bridge or a real
 * native dialog; the replies it scripts are the shape contract between the two sides, so they are the thing to keep in sync.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, importFile, makeGlb, openApp, test, ydrGlb } from './helpers';
import type { Page } from '@playwright/test';

const RSC7 = Buffer.from([0x52, 0x53, 0x43, 0x37, 0xa5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]);

async function goWeapon(page: Page) {
  await page.getByTestId('mode-weapon').click();
  await expect(page.getByRole('button', { name: 'Import model…' })).toBeVisible();
}

test.describe('browser build', () => {
  test('the pickers never offer .ydr, and the empty state says a .ydr needs the desktop app', async ({ page }) => {
    await openApp(page);
    await goWeapon(page);
    await expect(page.getByText(/A GTA V drawable \(\.ydr\) needs the desktop app with the CodeWalker converter bridge/)).toBeVisible();

    // weapon-model picker
    let chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import model…' }).click();
    let fc = await chooser;
    expect(await fc.element().getAttribute('accept')).toBe('.glb,.gltf,.obj,.fbx');
    expect(fc.isMultiple()).toBe(false);
    await fc.setFiles([]);

    // generic Import picker
    chooser = page.waitForEvent('filechooser');
    await page.getByTestId('toolbar-import').click();
    fc = await chooser;
    const accept = (await fc.element().getAttribute('accept')) ?? '';
    expect(accept.split(',')).toEqual(expect.arrayContaining(['.glb', '.gltf', '.obj', '.fbx', '.webm', '.png']));
    expect(accept).not.toMatch(/ydr/i);
    await fc.setFiles([]);

    // the library text does not advertise it either
    await page.getByRole('tab', { name: 'Media' }).click();
    await expect(page.getByText(/MP4, MOV, WebM, GIF, WebP, PNG, JPG · GLB, glTF, OBJ, FBX\. You can also drop files/)).toBeVisible();
    await expect(page.getByText(/\.ydr \(converted/)).toHaveCount(0);
  });

  test('a .ydr that is chosen anyway is refused with an actionable message, nothing is imported, and the app keeps working', async ({ page }) => {
    await openApp(page);
    await importFile(page, { name: 'w_ar_k2light.ydr', mimeType: 'application/octet-stream', buffer: RSC7 });
    const alert = page.getByRole('alert').filter({ hasText: 'w_ar_k2light.ydr' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('A GTA V .ydr drawable has to be converted to a GLB first');
    await expect(alert).toContainText('desktop app with the CodeWalker converter bridge');
    await expect(alert).toContainText('docs/YPT_BRIDGE.md');
    await expect(alert).toContainText('Exporting the model as .glb works in both');
    await page.getByRole('tab', { name: 'Media' }).click();
    await expect(page.getByText('Nothing imported yet.')).toBeVisible();
    // no weapon was set and the importer is not stuck
    await goWeapon(page);
    await importFile(page, { name: 'box.glb', mimeType: 'model/gltf-binary', buffer: makeGlb() });
    await expect(page.getByText(/12 triangles/)).toBeVisible({ timeout: 20_000 });
  });

  test('a .ydr dropped on the window gets the same message', async ({ page }) => {
    await openApp(page);
    const data = await page.evaluateHandle((b64) => {
      const dt = new DataTransfer();
      dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'dropped.YDR'));
      return dt;
    }, RSC7.toString('base64'));
    await page.dispatchEvent('body', 'dragenter', { dataTransfer: data });
    await page.dispatchEvent('body', 'drop', { dataTransfer: data });
    await expect(page.getByRole('alert').filter({ hasText: 'dropped.YDR' })).toContainText('has to be converted to a GLB first');
  });

  test('a converted drawable shows the YDR note and the converter\'s honest warnings instead of the generic GLB note', async ({ page }) => {
    await openApp(page);
    await goWeapon(page);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import model…' }).click();
    await (await chooser).setFiles(ydrGlb('multi_lod'));

    const inspector = page.getByTestId('inspector-body');
    await expect(inspector.getByText('22 triangles · 3.00 × 0.50 × 1.25 (model units)')).toBeVisible({ timeout: 20_000 });
    await expect(inspector.getByText(/Converted from a GTA V \.ydr drawable when it was imported/)).toBeVisible();
    await expect(inspector.getByText(/the \.ydr itself is not stored in the project/)).toBeVisible();
    await expect(inspector.getByText(/GLB \(binary glTF\): fully supported/)).toHaveCount(0);

    await expect(inspector.getByText(/Converted from a GTA V \.ydr: geometry only\. GTA textures and shaders are not converted/)).toBeVisible();
    await expect(inspector.getByText('Level of detail shown: high (the drawable also has med; other levels are not imported).')).toBeVisible();
    await expect(inspector.getByText(/^Converter: model_1 geometry 0 has no normals/)).toBeVisible();
    await expect(inspector.getByText('1 geometry had its triangle order reversed so the faces point outward (decided from the vertex normals, or from the rest of the drawable where a geometry has none).')).toBeVisible();
    await expect(inspector.getByText('No bone transforms were applied.')).toBeVisible();

    // it is an ordinary model afterwards: scale and orientation controls work
    await page.getByLabel('Orientation').click();
    await page.getByRole('option', { name: /Z-up, barrel \+Y/ }).click();
    await expect(page.getByLabel('Rotation X')).toHaveValue('-90');
  });

  test('the bone-bound and med-LOD goldens report their own status', async ({ page }) => {
    await openApp(page);
    await goWeapon(page);
    const inspector = page.getByTestId('inspector-body');

    let chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import model…' }).click();
    await (await chooser).setFiles(ydrGlb('bone_bound'));
    await expect(inspector.getByText(/^48 triangles · 2\.00 × 1\.25 × 1\.75/)).toBeVisible({ timeout: 20_000 });
    await expect(inspector.getByText('Parts bound to skeleton bones were placed with the drawable\'s bone transforms; skinned parts are shown unposed.')).toBeVisible();
    await expect(inspector.getByText(/^Converter: 1 skinned model\(s\) \(model_2\) exported in bind pose/)).toBeVisible();
    await expect(inspector.getByText('No bone transforms were applied.')).toHaveCount(0);

    await inspector.getByRole('button', { name: 'Remove model' }).click();
    chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import model…' }).click();
    await (await chooser).setFiles(ydrGlb('multi_lod_med'));
    await expect(inspector.getByText(/^12 triangles · 1\.00 × 0\.50 × 1\.00/)).toBeVisible({ timeout: 20_000 });
    await expect(inspector.getByText('Level of detail shown: med (the drawable also has high; other levels are not imported).')).toBeVisible();
  });

  test('an ordinary GLB keeps the generic note and gets no YDR text', async ({ page }) => {
    await openApp(page);
    await goWeapon(page);
    await importFile(page, { name: 'box.glb', mimeType: 'model/gltf-binary', buffer: makeGlb() });
    const inspector = page.getByTestId('inspector-body');
    await expect(inspector.getByText(/12 triangles/)).toBeVisible({ timeout: 20_000 });
    await expect(inspector.getByText('GLB (binary glTF): fully supported, textures embedded.')).toBeVisible();
    await expect(inspector.getByText(/\.ydr/)).toHaveCount(0);
  });
});

/* ---------------------------------------------------------------- desktop UI, scripted core */

const GOLDEN = readFileSync(ydrGlb('multi_lod'));
const PLAIN = makeGlb();
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const SCRIPT = {
  ydrGlbB64: GOLDEN.toString('base64'),
  ydrSha: sha(GOLDEN),
  plainB64: PLAIN.toString('base64'),
  plainSha: sha(PLAIN),
  conversion: {
    lod: 'high',
    models: 2,
    geometries: 3,
    vertices: 44,
    triangles: 22,
    warnings: ['model_1 geometry 0 has no normals to judge its winding by; it follows the other geometries (12 triangles stored counter-clockwise, 6 clockwise relative to their normals), so the stored order was kept.'],
  },
};

/** Replaces the Tauri bridge with a scripted core before the app starts. */
async function installScriptedCore(page: Page) {
  await page.addInitScript((script) => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const w = window as any;
    const callbacks = new Map<number, (d: unknown) => void>();
    let nextId = 1;
    const listeners = new Map<string, number[]>();
    const calls: Array<{ cmd: string; args: any }> = [];
    const dialogs: any[] = [];
    const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;
    const files = new Map<string, ArrayBuffer>([
      [`assets/${script.ydrSha}.glb`, b64(script.ydrGlbB64)],
      [`assets/${script.plainSha}.glb`, b64(script.plainB64)],
    ]);
    const state = { nextPick: null as any, bridge: 'ready' as 'ready' | 'missing' | 'old' };
    const tool = (available: boolean) => ({ available, path: null, version: null, detail: 'scripted core' });

    const core: Record<string, (a: any) => unknown> = {
      tool_status: () => ({ ffmpeg: tool(false), ffprobe: tool(false), bridge: { available: state.bridge === 'ready', detail: 'scripted core', version: '0.2.0', codewalkerCore: '1.0.0.0' }, paths: { ffmpeg: null, ffprobe: null, dotnet: null, dll: null } }),
      latest_autosave: () => null,
      autosave_project: () => null,
      recovery_for: () => null,
      clear_autosave: () => null,
      read_asset: (a) => {
        const f = files.get(a.relPath);
        if (!f) throw { code: 'not_found', message: `no such asset ${a.relPath}` };
        return f.slice(0);
      },
      import_asset: (a) => {
        const src = String(a.source);
        if (/\.ydr$/i.test(src)) {
          if (state.bridge === 'missing') throw { code: 'tool_missing', message: 'The CodeWalker bridge is not configured. Set it up under Settings > Tools (see docs/YPT_BRIDGE.md); exporting the model as .glb works without it.' };
          if (state.bridge === 'old') throw { code: 'convert_error', message: 'The CodeWalker bridge is too old to read drawables. Rebuild tools/ypt-bridge.' };
          return { relPath: `assets/${script.ydrSha}.glb`, sha256: script.ydrSha, bytes: files.get(`assets/${script.ydrSha}.glb`)!.byteLength, kind: 'glb', category: 'model', mime: 'model/gltf-binary', deduplicated: false, info: null, convertedFrom: 'ydr', conversion: script.conversion };
        }
        return { relPath: `assets/${script.plainSha}.glb`, sha256: script.plainSha, bytes: files.get(`assets/${script.plainSha}.glb`)!.byteLength, kind: 'glb', category: 'model', mime: 'model/gltf-binary', deduplicated: false, info: null };
      },
      'plugin:dialog|open': (a) => {
        dialogs.push(a.options);
        const pick = state.nextPick;
        state.nextPick = null;
        return pick;
      },
    };

    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
      transformCallback: (cb: (d: unknown) => void) => {
        const id = nextId++;
        callbacks.set(id, cb);
        return id;
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
      convertFileSrc: (p: string) => p,
      invoke: async (cmd: string, args: any) => {
        if (cmd === 'plugin:event|listen') {
          listeners.set(args.event, [...(listeners.get(args.event) ?? []), args.handler]);
          return args.handler;
        }
        if (cmd === 'plugin:event|unlisten') {
          listeners.set(args.event, (listeners.get(args.event) ?? []).filter((id) => id !== args.eventId));
          callbacks.delete(args.eventId);
          return null;
        }
        calls.push({ cmd, args });
        const h = core[cmd];
        if (!h) throw { code: 'invalid_param', message: `scripted core: no handler for ${cmd}` };
        return h(args);
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
    w.__scripted = {
      calls,
      dialogs,
      pickNext: (v: unknown) => (state.nextPick = v),
      setBridge: (v: 'ready' | 'missing' | 'old') => (state.bridge = v),
      emit: (event: string, payload: unknown) => {
        for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, id, payload });
      },
    };
  }, SCRIPT);
}

const dialogsOf = (page: Page) => page.evaluate(() => (window as any).__scripted.dialogs as any[]);
const callsOf = (page: Page, cmd: string) => page.evaluate((c) => ((window as any).__scripted.calls as Array<{ cmd: string; args: any }>).filter((x) => x.cmd === c).map((x) => x.args), cmd);

test.describe('desktop UI against a scripted core', () => {
  test.beforeEach(async ({ page }) => {
    await installScriptedCore(page);
  });

  test('the weapon-model dialog lists everything, 3D models and the GTA V drawable; a picked .ydr is converted and shown honestly', async ({ page }) => {
    await openApp(page);
    await goWeapon(page);
    await expect(page.getByText(/A GTA V drawable \(\.ydr\) can be imported too: the desktop app converts it to a GLB with your CodeWalker converter bridge \(Settings > Tools\)\. Geometry only/)).toBeVisible();

    await page.evaluate(() => (window as any).__scripted.pickNext('C:\\mods\\w_ar_k2light.ydr'));
    await page.getByRole('button', { name: 'Import model…' }).click();

    await expect.poll(async () => (await dialogsOf(page)).length).toBe(1);
    expect((await dialogsOf(page))[0]).toEqual({
      multiple: false,
      title: 'Import a weapon model',
      filters: [
        { name: 'Supported files', extensions: ['glb', 'gltf', 'obj', 'fbx', 'ydr'] },
        { name: '3D models (glb, gltf, obj, fbx)', extensions: ['glb', 'gltf', 'obj', 'fbx'] },
        { name: 'GTA V drawable (ydr)', extensions: ['ydr'] },
      ],
    });

    // the core is asked by path, and only that
    expect(await callsOf(page, 'import_asset')).toEqual([{ projectId: expect.any(String), source: 'C:\\mods\\w_ar_k2light.ydr' }]);

    const inspector = page.getByTestId('inspector-body');
    await expect(inspector.getByText('22 triangles · 3.00 × 0.50 × 1.25 (model units)')).toBeVisible({ timeout: 20_000 });
    await expect(inspector.getByText('w_ar_k2light.ydr', { exact: true })).toBeVisible(); // named like the source, not like the stored GLB
    await expect(page.getByText(/Imported 3D model “w_ar_k2light\.ydr” and set it as the preview weapon\. Converted from \.ydr \(high level of detail, 2 models, 22 triangles\): geometry only\. 1 converter warning in the 3D model panel\./)).toBeVisible();
    await expect(inspector.getByText(/Converted from a GTA V \.ydr drawable when it was imported/)).toBeVisible();
    await expect(inspector.getByText(/GLB \(binary glTF\): fully supported/)).toHaveCount(0);
    await expect(inspector.getByText('Level of detail shown: high (the drawable also has med; other levels are not imported).')).toBeVisible();
    await expect(inspector.getByText(/^Converter: model_1 geometry 0 has no normals/)).toBeVisible();

    // the media list names it like the source too
    await page.getByRole('tab', { name: 'Media' }).click();
    await expect(page.getByRole('button', { name: 'w_ar_k2light.ydr model' })).toBeVisible();
    await expect(page.getByText(/GTA V \.ydr \(converted to GLB by the converter bridge; geometry only\)/)).toBeVisible();
  });

  test('the generic Import dialog has the same three entries, with media in the first', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('toolbar-import').click();
    await expect.poll(async () => (await dialogsOf(page)).length).toBe(1);
    const d = (await dialogsOf(page))[0];
    expect(d.multiple).toBe(true);
    expect(d.filters.map((f: { name: string }) => f.name)).toEqual(['Supported files', '3D models (glb, gltf, obj, fbx)', 'GTA V drawable (ydr)']);
    expect(d.filters[0].extensions).toEqual(expect.arrayContaining(['mp4', 'webm', 'png', 'glb', 'ydr']));
    expect(d.filters[2].extensions).toEqual(['ydr']);
  });

  test('a .ydr dropped on the native window is imported by path; an ordinary GLB shows no conversion text', async ({ page }) => {
    await openApp(page);
    await expect(page.getByText('Drop to import')).toHaveCount(0);
    await page.evaluate(() => (window as any).__scripted.emit('tauri://drag-enter', { paths: ['D:\\x\\w_pi_combat.ydr'], position: { x: 1, y: 1 } }));
    await expect(page.getByText('Video, GIF, image, 3D model or GTA V .ydr')).toBeVisible();
    await page.evaluate(() => (window as any).__scripted.emit('tauri://drag-drop', { paths: ['D:\\x\\w_pi_combat.ydr'], position: { x: 1, y: 1 } }));
    await expect(page.getByText(/Imported 3D model “w_pi_combat\.ydr”/)).toBeVisible({ timeout: 20_000 });
    expect(await callsOf(page, 'import_asset')).toEqual([{ projectId: expect.any(String), source: 'D:\\x\\w_pi_combat.ydr' }]);
    await expect(page.getByTestId('inspector-body').getByText(/22 triangles/)).toBeVisible({ timeout: 20_000 });

    // a plain GLB on the same platform: no conversion sentence, generic note
    await page.getByRole('button', { name: 'Remove model' }).click();
    await page.evaluate(() => (window as any).__scripted.emit('tauri://drag-drop', { paths: ['D:\\x\\box.glb'], position: { x: 1, y: 1 } }));
    const ok = page.getByText(/Imported 3D model “box\.glb” and set it as the preview weapon\./);
    await expect(ok).toBeVisible({ timeout: 20_000 });
    await expect(ok).not.toContainText('Converted');
    await expect(page.getByTestId('inspector-body').getByText('GLB (binary glTF): fully supported, textures embedded.')).toBeVisible();
  });

  test('a converted .ydr starts from rotation 0 and scale 1, and its asset says the .ydr itself is not stored', async ({ page }) => {
    await openApp(page);
    // a previous model left a rotation and a scale behind
    await page.evaluate(() => (window as any).__scripted.emit('tauri://drag-drop', { paths: ['D:\\x\\box.glb'], position: { x: 1, y: 1 } }));
    await expect(page.getByText(/Imported 3D model “box\.glb”/)).toBeVisible({ timeout: 20_000 });
    await page.getByLabel('Rotation X').fill('-90');
    await page.getByLabel('Rotation X').press('Enter');
    await page.getByLabel('Scale', { exact: true }).fill('2.5');
    await page.getByLabel('Scale', { exact: true }).press('Enter');
    await expect(page.getByLabel('Rotation X')).toHaveValue('-90');

    await page.evaluate(() => (window as any).__scripted.emit('tauri://drag-drop', { paths: ['D:\\x\\w_pi_combat.ydr'], position: { x: 1, y: 1 } }));
    await expect(page.getByText(/Imported 3D model “w_pi_combat\.ydr”/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('inspector-body').getByText(/22 triangles/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByLabel('Rotation X')).toHaveValue('0');
    await expect(page.getByLabel('Scale', { exact: true })).toHaveValue('1');

    // the asset inspector does not claim the original file was stored
    await page.getByRole('tab', { name: 'Media' }).click();
    await page.getByRole('button', { name: 'w_pi_combat.ydr model' }).click();
    const inspector = page.getByTestId('inspector-body');
    await expect(inspector.getByText(/Converted to a GLB when it was imported; the GLB is stored, addressed by its hash, and the \.ydr itself is not\./)).toBeVisible();
    await expect(inspector.getByText(/The original file is stored unchanged/)).toHaveCount(0);
    // while an ordinary model keeps the original wording
    await page.getByRole('button', { name: 'box.glb model' }).click();
    await expect(inspector.getByText(/The original file is stored unchanged, addressed by its hash\./)).toBeVisible();
  });

  test('a core error for a .ydr reaches the user unchanged (bridge missing, bridge too old) and nothing is imported', async ({ page }) => {
    await openApp(page);
    for (const [mode, text] of [
      ['missing', /The CodeWalker bridge is not configured\. Set it up under Settings > Tools \(see docs\/YPT_BRIDGE\.md\); exporting the model as \.glb works without it\./],
      ['old', /The CodeWalker bridge is too old to read drawables\. Rebuild tools\/ypt-bridge\./],
    ] as const) {
      await page.evaluate((m) => (window as any).__scripted.setBridge(m), mode);
      await page.evaluate(() => (window as any).__scripted.emit('tauri://drag-drop', { paths: ['E:\\a\\thing.ydr'], position: { x: 0, y: 0 } }));
      await expect(page.getByRole('alert').filter({ hasText: 'thing.ydr:' }).filter({ hasText: text })).toBeVisible();
    }
    await page.getByRole('tab', { name: 'Media' }).click();
    await expect(page.getByText('Nothing imported yet.')).toBeVisible();
  });
});
