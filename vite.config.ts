import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const buildVersion=Date.now().toString();

export default defineConfig({
  plugins: [react(),{name:'flowmate-version',generateBundle(){this.emitFile({type:'asset',fileName:'version.json',source:JSON.stringify({version:buildVersion})})}}],
  define:{__APP_BUILD_VERSION__:JSON.stringify(buildVersion)},
  build: { target: ['es2020', 'safari14'], sourcemap: true },
  server: { proxy: { '/api': 'http://localhost:8787' } },
});
