import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  publicDir: process.env.HOSTING_TARGET === 'vercel' ? '.hosting/public' : 'public',
  server: { host: '0.0.0.0' },
  build: {
    sourcemap: false,
    rollupOptions: { output: { manualChunks(id) {
      if (id.includes('/shared/players')) return 'roster';
      if (id.includes('/node_modules/')) return 'vendor';
    } } },
  },
});
