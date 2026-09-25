// Vite build of the jobleft UI. No React plugin: esbuild compiles TSX with the automatic JSX runtime.
// Output: apps/ui/dist (served by the local server at "/"). Everything is bundled: no remote font, icon or script.
// `vite` (dev) proxies /api to the local API mock on 127.0.0.1:47821.

import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  esbuild: { jsx: 'automatic' },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2500,
    assetsInlineLimit: 0,
    rollupOptions: {
      // Ant Design marks its files "use client" (a server-components hint that does not apply to this app)
      onwarn(w, warn) { if (w.code === 'MODULE_LEVEL_DIRECTIVE') return; warn(w); },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:47821', changeOrigin: true } },
  },
});
