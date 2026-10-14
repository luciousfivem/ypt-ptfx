import { addPreset, fixture, importFile, openApp, test } from './helpers';

const S = '/tmp/claude-0/-home-user-ypt-ptfx/d54e4ee8-105a-5c6d-a05c-e68e9545c720/scratchpad';

test('qa', async ({ page }) => {
  test.setTimeout(200_000);
  await page.setViewportSize({ width: 1180, height: 720 });
  await openApp(page);
  await page.getByTestId('toolbar-settings').click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${S}/q1-settings.png` });
  await page.keyboard.press('Escape');
  await addPreset(page, 'blue_electricity');
  await importFile(page, fixture('glow-on-black.webm'));
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${S}/q2-sprite-small.png` });
  await page.getByRole('button', { name: 'Sheet settings' }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${S}/q3-sheet-inspector.png` });
  await page.getByTestId('toolbar-export').click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${S}/q4-export-small.png` });
});
