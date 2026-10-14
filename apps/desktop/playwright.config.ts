import { defineConfig } from '@playwright/test';

/**
 * UI tests run against the Vite dev server in browser mode (the app's `browser` platform:
 * IndexedDB storage, <video> extraction, no FFmpeg, no binary-YPT converter). Chromium comes from
 * PLAYWRIGHT_BROWSERS_PATH; WebGL is served by SwiftShader (software) in headless environments.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:1420',
    viewport: { width: 1600, height: 900 },
    launchOptions: {
      executablePath: process.env.VFXFORGE_CHROMIUM ?? '/opt/pw-browsers/chromium',
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
    },
    trace: 'off',
  },
  webServer: {
    command: 'npx vite --host 127.0.0.1 --port 1420 --strictPort',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
