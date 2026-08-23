import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: '.',
  build: {
    outDir: '../../../dist/web/public',
    emptyOutDir: true,
    // This app ships as a single inlined bundle (no code-splitting / manualChunks),
    // so the 500 kB default threshold is noisy rather than actionable. Raise it
    // so the build output stays focused on real errors.
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3780',
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
