import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // The daemon serves this directory directly when REY_SERVE_WEB=1.
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 5273,
    host: '127.0.0.1',
  },
});
