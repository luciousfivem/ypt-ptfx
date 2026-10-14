/**
 * Documentation screenshots. Skipped unless VFXFORGE_SCREENSHOTS is set, e.g.
 *   VFXFORGE_SCREENSHOTS=docs/screenshots npx playwright test e2e/screens.spec.ts
 */
import { join } from 'node:path';
import { addPreset, fixture, importFile, makeGlb, openApp, test } from './helpers';

const OUT = process.env.VFXFORGE_SCREENSHOTS;
test.skip(!OUT, 'set VFXFORGE_SCREENSHOTS=<dir> to (re)generate documentation screenshots');
const shot = (name: string) => join(OUT!, `${name}.png`);

test('capture', async ({ page }) => {
  test.setTimeout(240_000);
  await openApp(page);
  await addPreset(page, 'purple_flames');
  await addPreset(page, 'lightning_arcs');
  await addPreset(page, 'dark_smoke');
  await page.waitForTimeout(5000);
  await page.screenshot({ path: shot('particle-editor') });

  await page.getByRole('tab', { name: 'Look' }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: shot('particle-editor-look') });

  await importFile(page, fixture('glow-on-black.webm'));
  await page.waitForTimeout(4000);
  await page.screenshot({ path: shot('sprite-editor') });

  await page.getByTestId('mode-weapon').click();
  await importFile(page, { name: 'box.glb', mimeType: 'model/gltf-binary', buffer: makeGlb() });
  await page.waitForTimeout(3000);
  await page.getByRole('button', { name: 'Add default points for this weapon' }).click();
  await page.getByRole('list', { name: 'Attachment points' }).getByRole('button', { name: /^Muzzle/ }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: shot('weapon-preview') });

  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: shot('light-theme') });
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();

  await page.getByTestId('toolbar-export').click();
  const dialog = page.getByRole('dialog', { name: 'Export FiveM resource' });
  await dialog.getByRole('button', { name: /Resource options/ }).click();
  await dialog.getByRole('switch', { name: 'Source-only' }).click();
  await page.waitForTimeout(1500);
  await dialog.getByTestId('run-export').click();
  await dialog.getByTestId('export-result').waitFor({ timeout: 90_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: shot('export-dialog') });
});
