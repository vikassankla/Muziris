/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The API runs on 127.0.0.1:4000 (apps/api). Proxying /storefront/v1 keeps the storefront and
// the API on one origin in development, so the buyer's __Host- session cookie is first-party
// (ADR 0015). Add this dev server's origin to CORS_ORIGINS, and point the API's
// STOREFRONT_PERSISTED_QUERIES at this app's persisted-queries.json.
const API_TARGET = 'http://127.0.0.1:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // VITE_STOREFRONT_WEBSITE comes from the repository's .env, like the API's settings.
  envDir: '../..',
  server: {
    host: 'localhost',
    port: 5174,
    strictPort: true,
    proxy: {
      '/storefront/v1': { target: API_TARGET, changeOrigin: false },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
  },
});
