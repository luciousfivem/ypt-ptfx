import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The same bundle runs inside Tauri (desktop) and a plain browser (development, tests, web build).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: '127.0.0.1' },
  preview: { port: 1421, strictPort: true, host: '127.0.0.1' },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1500 },
  // `?raw` imports (the Lua templates) are supported natively by Vite.
});
