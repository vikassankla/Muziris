/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { CONTENT_SECURITY_POLICY } from './src/lib/content-security-policy.js';

// The API runs on 127.0.0.1:4000 (apps/api). Proxying /storefront/v1 keeps the storefront and
// the API on one origin in development, so the buyer's __Host- session cookie is first-party
// (ADR 0015). Add this dev server's origin to CORS_ORIGINS, and point the API's
// STOREFRONT_PERSISTED_QUERIES at this app's persisted-queries.json.
// The end-to-end journeys (e2e/) run their own API elsewhere and set MUZIRIS_API_TARGET.
const API_TARGET = process.env['MUZIRIS_API_TARGET'] ?? 'http://127.0.0.1:4000';

/** Writes the content security policy into the built index.html (ADR 0019). */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'muziris-content-security-policy',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY },
        injectTo: 'head-prepend',
      },
    ],
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), contentSecurityPolicy()],
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
    // Typing with user-event takes about 200 ms here but passed 5 seconds on a busy CI runner,
    // where every package tests at once.
    testTimeout: 15_000,
    env: { VITE_STOREFRONT_WEBSITE: 'main' },
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
  },
});
