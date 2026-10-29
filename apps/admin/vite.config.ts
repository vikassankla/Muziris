/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The API runs on 127.0.0.1:4000 (apps/api). Proxying /admin/v1 keeps the admin app and the
// API on one origin in development, so the __Host- session cookie is first-party and every
// request is same-origin. Add this dev server's origin to CORS_ORIGINS: the API checks Origin
// on every state-changing request, proxied or not.
const API_TARGET = 'http://127.0.0.1:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
    proxy: {
      '/admin/v1': { target: API_TARGET, changeOrigin: false },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
