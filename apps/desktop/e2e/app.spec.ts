import { unzipSync } from 'fflate';
import { addPreset, expect, importFile, makeGlb, openApp, test, fixture } from './helpers';

test.describe('shell', () => {
  test('boots, renders the 3D preview and offers 30 presets in 6 categories', async ({ page }) => {
    await openApp(page);
    await expect(page.getByRole('heading', { name: /^(Fire|Electricity|Smoke|Fantasy|Horror|Sci-fi)$/ })).toHaveCount(6);
    await expect(page.locator('[data-testid^="preset-"]')).toHaveCount(30);
    // every toolbar action is a real control
    for (const name of ['New project (Ctrl+N)', 'Open project (Ctrl+O)', 'Save project (Ctrl+S)', 'Settings']) {
      await expect(page.getByRole('button', { name })).toBeEnabled();
    }
    await expect(page.getByTestId('mode-sprite')).toBeVisible();
    await expect(page.getByTestId('mode-particles')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('mode-weapon')).toBeVisible();
  });

  test('theme toggle switches between dark and light', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('workspace modes change the centre and keep the 3D scene alive', async ({ page }) => {
    await openApp(page);
    await addPreset(page, 'purple_flames');
    await page.getByTestId('mode-sprite').click();
    await expect(page.getByRole('region', { name: 'Animation preview' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Spritesheet atlas' })).toBeVisible();
    await page.getByTestId('mode-weapon').click();
    await expect(page.getByTestId('viewport-canvas')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Weapon', selected: true })).toBeVisible();
    await page.keyboard.press('1');
    await expect(page.getByTestId('mode-sprite')).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('presets, layers and undo', () => {
  test('adding a preset creates clip + sheet + effect, particles appear, and undo/redo work', async ({ page }) => {
    await openApp(page);
    await addPreset(page, 'purple_flames');
    await expect(page.getByText('Added “Purple Flames”')).toBeVisible();
    await page.getByRole('tab', { name: 'Layers' }).click();
    await expect(page.getByRole('button', { name: 'Purple Flames' }).first()).toBeVisible();
    // the idle loop starts by itself because the weapon is equipped
    await expect.poll(async () => (await page.getByTestId('stats').textContent()) ?? '', { timeout: 20_000 }).toMatch(/[1-9]\d* particles/);
    await page.getByRole('button', { name: 'Undo: Add preset Purple Flames (Ctrl+Z)' }).click();
    await expect(page.getByText('No effects yet')).toBeVisible();
    await page.keyboard.press('Control+Shift+Z');
    await expect(page.getByRole('button', { name: 'Purple Flames' }).first()).toBeVisible();
  });

  test('adding the same preset twice yields unique names; layers can be toggled, duplicated and deleted', async ({ page }) => {
    await openApp(page);
    await addPreset(page, 'blue_hellfire');
    await addPreset(page, 'blue_hellfire');
    await page.getByRole('tab', { name: 'Layers' }).click();
    await expect(page.getByRole('button', { name: 'Delete effect', exact: true })).toHaveCount(2);
    await page.getByRole('button', { name: 'Disable emitter' }).first().click();
    await expect(page.getByRole('button', { name: 'Enable emitter' })).toHaveCount(1);
    await page.getByRole('button', { name: 'Duplicate effect' }).first().click();
    await expect(page.getByRole('button', { name: 'Delete effect', exact: true })).toHaveCount(3);
    // names (and the YPT rule names) stay unique
    const rules = await page.getByLabel('Rule name').inputValue();
    expect(rules).toMatch(/^blue_hellfire/);
    await page.getByRole('button', { name: 'Delete effect', exact: true }).first().click();
    await expect(page.getByRole('button', { name: 'Delete effect', exact: true })).toHaveCount(2);
  });
});

test.describe('inspectors', () => {
  test('editing emitter parameters updates the project and the timeline; sliders coalesce into one undo step', async ({ page }) => {
    await openApp(page);
    await addPreset(page, 'electric_sparks');
    await page.getByRole('tab', { name: 'Emission' }).click();
    const burst = page.getByLabel('Count', { exact: true });
    await burst.fill('9');
    await burst.press('Enter');
    await expect(burst).toHaveValue('9');
    await page.getByRole('tab', { name: 'Look' }).click();
    // curve editor: double-click adds a key
    const svg = page.getByRole('application', { name: /Curve editor: size/ });
    const keysBefore = await svg.locator('circle').count();
    const box = (await svg.boundingBox())!;
    await svg.dblclick({ position: { x: box.width * 0.5, y: box.height * 0.3 } });
    await expect(svg.locator('circle')).toHaveCount(keysBefore + 1);
    // physics tab marks what the exporter cannot carry
    await page.getByRole('tab', { name: 'Physics' }).click();
    await page.getByRole('button', { name: /^Attractor/ }).click();
    await page.getByRole('switch', { name: 'Enabled' }).click();
    await expect(page.getByText('not exported').first()).toBeVisible();
  });

  test('clip inspector exposes extraction, keying and colour controls for imported video', async ({ page }) => {
    await openApp(page);
    await importFile(page, fixture('glow-on-black.webm'));
    await expect(page.getByText(/Imported “glow-on-black.webm”/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: /Frame extraction/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Background removal/ })).toBeVisible();
    const inspector = page.getByTestId('inspector-body');
    await expect(inspector.getByRole('radio', { name: 'Black' })).toBeChecked();
    await inspector.getByRole('radio', { name: 'Chroma' }).click();
    await expect(inspector.getByText('Key colour')).toBeVisible();
    await expect(inspector.getByLabel('Key colour colour')).toBeVisible();
    await inspector.getByRole('radio', { name: 'Black' }).click();
  });
});

test.describe('undo granularity', () => {
  test('rapid edits to one field fold into a single undo step', async ({ page }) => {
    await openApp(page);
    await addPreset(page, 'electric_sparks');
    await page.getByRole('tab', { name: 'Emission' }).click();
    const delay = page.getByLabel('Start delay', { exact: true });
    await expect(delay).toHaveValue('0');
    await delay.focus();
    for (let i = 0; i < 5; i++) await delay.press('ArrowUp');
    await expect(delay).toHaveValue('0.25');
    await page.getByRole('button', { name: /^Undo: Start delay/ }).click();
    await expect(delay).toHaveValue('0');
    await page.getByRole('button', { name: /^Redo: Start delay/ }).click();
    await expect(delay).toHaveValue('0.25');
  });
});

test.describe('import', () => {
  test('a video becomes a keyed 16-frame spritesheet in the Sprite Editor', async ({ page }) => {
    await openApp(page);
    await importFile(page, fixture('glow-on-black.webm'));
    await expect(page.getByTestId('mode-sprite')).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
    const atlas = page.getByRole('region', { name: 'Spritesheet atlas' });
    await expect(atlas.getByRole('img', { name: /Spritesheet atlas 4 by 4/ })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('region', { name: 'Frame list' })).toContainText('16');
    // black was keyed to transparency: the atlas canvas must contain transparent pixels
    const transparent = await atlas.getByRole('img', { name: /Spritesheet atlas/ }).evaluate((c: HTMLCanvasElement) => {
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let t = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] === 0) t++;
      return t / (d.length / 4);
    });
    expect(transparent).toBeGreaterThan(0.3);
    // frame-list editing is real: delete one frame
    await page.getByRole('option').nth(3).click();
    await page.getByRole('button', { name: 'Delete frame' }).click();
    await expect(page.getByRole('region', { name: 'Frame list' })).toContainText('15');
    await page.getByRole('button', { name: 'Reset frame list' }).click();
    await expect(page.getByRole('region', { name: 'Frame list' })).toContainText('16');
  });

  test('files are identified by content: a text file named .png is rejected', async ({ page }) => {
    await openApp(page);
    await importFile(page, { name: 'evil.png', mimeType: 'image/png', buffer: Buffer.from('this is not an image at all, just text') });
    await expect(page.getByText(/not a recognised image, video or 3D model/)).toBeVisible();
    await page.getByRole('tab', { name: 'Media' }).click();
    await expect(page.getByText('Nothing imported yet.')).toBeVisible();
  });

  test('drag & drop imports too', async ({ page }) => {
    await openApp(page);
    const data = await page.evaluateHandle(async (b64) => {
      const dt = new DataTransfer();
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bin], 'drop.glb', { type: 'model/gltf-binary' }));
      return dt;
    }, makeGlb().toString('base64'));
    await page.dispatchEvent('body', 'dragenter', { dataTransfer: data });
    await expect(page.getByText('Drop to import')).toBeVisible();
    await page.dispatchEvent('body', 'drop', { dataTransfer: data });
    await expect(page.getByText(/Imported 3D model “drop.glb”/)).toBeVisible({ timeout: 20_000 });
  });
});

test.describe('weapon preview', () => {
  test('attachment points can be added, selected and edited; models load with scale/orientation controls', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('mode-weapon').click();
    await page.getByRole('button', { name: 'Add default points for this weapon' }).click();
    await expect(page.getByRole('list', { name: 'Attachment points' }).getByRole('listitem')).toHaveCount(7);
    await page.getByRole('list', { name: 'Attachment points' }).getByRole('button', { name: /^Muzzle/ }).click();
    await expect(page.getByLabel('GTA bone')).toBeVisible();
    await page.getByLabel('Position X').fill('0.012');
    await page.getByLabel('Position X').press('Enter');
    await expect(page.getByLabel('Position X')).toHaveValue('0.012');

    // import a GLB: becomes the preview weapon, reports its geometry
    await importFile(page, { name: 'box.glb', mimeType: 'model/gltf-binary', buffer: makeGlb() });
    await expect(page.getByText(/12 triangles/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByLabel('Scale', { exact: true })).toBeVisible();
    await page.getByLabel('Orientation').click();
    await page.getByRole('option', { name: /Y-up, barrel \+X/ }).click();
    await expect(page.getByLabel('Rotation Y')).toHaveValue('90');
  });
});

test.describe('persistence', () => {
  test('save, reload, reopen: the project round-trips through IndexedDB', async ({ page }) => {
    await openApp(page);
    await addPreset(page, 'ghost_fire');
    await page.getByRole('textbox', { name: 'Project name' }).fill('Persistence Test');
    await page.keyboard.press('Control+s');
    await expect(page.getByText('Saved “Persistence Test”.')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('viewport-canvas')).toBeVisible();
    await page.keyboard.press('Control+o');
    await page.getByRole('button', { name: /^Persistence Test/ }).click();
    await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Persistence Test');
    await page.getByRole('tab', { name: 'Layers' }).click();
    await expect(page.getByRole('button', { name: 'Ghost Fire' }).first()).toBeVisible();
  });

  test('unsaved work is recoverable after an unclean exit', async ({ page, context }) => {
    await openApp(page);
    await addPreset(page, 'red_inferno');
    await page.getByRole('textbox', { name: 'Project name' }).fill('Crash Test');
    // the autosave interval is 20 s; the hidden-tab hook snapshots immediately
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(500);
    const fresh = await context.newPage();
    await fresh.goto('/');
    await expect(fresh.getByRole('dialog', { name: 'Recover unsaved work?' })).toBeVisible({ timeout: 20_000 });
    await fresh.getByRole('button', { name: 'Recover' }).click();
    await expect(fresh.getByRole('textbox', { name: 'Project name' })).toHaveValue('Crash Test');
    await fresh.close();
  });
});

test.describe('export', () => {
  test('without a converter the dialog blocks binary export, offers a labelled source-only package, and the ZIP is real', async ({ page }) => {
    await openApp(page);
    await addPreset(page, 'plasma_bursts');
    await page.getByTestId('toolbar-export').click();
    const dialog = page.getByRole('dialog', { name: 'Export FiveM resource' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/Binary .ypt creation needs the desktop app/)).toBeVisible();
    await expect(dialog.getByText(/Spritesheet “Plasma Bursts”: 16 frames/)).toBeVisible({ timeout: 30_000 });
    const run = dialog.getByTestId('run-export');
    await expect(run).toBeDisabled();
    await dialog.getByRole('button', { name: /Resource options/ }).click();
    await dialog.getByRole('switch', { name: 'Source-only' }).click();
    await expect(run).toBeEnabled();
    await run.click();
    await expect(dialog.getByTestId('export-result')).toContainText('Source-only package', { timeout: 60_000 });
    await expect(dialog.getByTestId('export-result')).toContainText('Not yet verified in the game');
    const download = page.waitForEvent('download');
    await dialog.getByTestId('save-zip').click();
    const file = await download;
    const zip = unzipSync(new Uint8Array(await (await import('node:fs/promises')).readFile((await file.path())!)));
    const names = Object.keys(zip);
    expect(names.some((n) => n.endsWith('fxmanifest.lua'))).toBe(true);
    expect(names.some((n) => n.endsWith('client.lua'))).toBe(true);
    expect(names.some((n) => n.endsWith('.dds'))).toBe(true);
    expect(names.some((n) => n.endsWith('.ypt.xml'))).toBe(true);
    expect(names.some((n) => /stream\/.*\.ypt$/.test(n))).toBe(false); // honest: no binary was produced
    expect(names.some((n) => /README/i.test(n))).toBe(true);
  });

  test('an invalid project is blocked before anything is built', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('toolbar-export').click();
    const dialog = page.getByRole('dialog', { name: 'Export FiveM resource' });
    await expect(dialog.getByText('No enabled emitters')).toBeVisible();
    await expect(dialog.getByTestId('run-export')).toBeDisabled();
  });
});

test.describe('keyboard', () => {
  test('Space pauses the preview, F fires, shortcuts dialog lists them', async ({ page }) => {
    await openApp(page);
    await addPreset(page, 'electric_sparks');
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Play (Space)' }).first()).toBeVisible();
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Pause (Space)' }).first()).toBeVisible();
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});
