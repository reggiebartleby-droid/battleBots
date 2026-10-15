import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // allow importing ../src/core and ../data from the repo root
    fs: { allow: ['..'] },
  },
  build: { chunkSizeWarningLimit: 8000 },
  optimizeDeps: {
    // Havok ships a WASM module; keep it out of the dep pre-bundler
    exclude: ['@babylonjs/havok'],
  },
});
