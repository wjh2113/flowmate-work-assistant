import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { target: ['es2020', 'safari14'], sourcemap: true },
  server: { proxy: { '/api': 'http://localhost:8787' } },
});
