import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const buildVersion=Date.now().toString();

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'admin-page',
      configureServer(server) {
        server.middlewares.use((req: { url?: string }, _res, next) => {
          const url = req.url || '';
          if (url === '/admin' || url.startsWith('/admin?')) req.url = '/admin.html';
          next();
        });
      }
    },
    {name:'flowmate-version',generateBundle(){this.emitFile({type:'asset',fileName:'version.json',source:JSON.stringify({version:buildVersion})})}}
  ],
  define:{__APP_BUILD_VERSION__:JSON.stringify(buildVersion)},
  build: {
    target: ['es2020', 'safari14'],
    sourcemap: true,
    rollupOptions: {
      input: {
        main: 'index.html',
        admin: 'admin.html'
      }
    }
  },
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:8790',
        changeOrigin: true,
        configure(proxy) {
          (proxy as any).on('proxyRes', (proxyRes: { headers: Record<string, string | string[] | undefined> }) => {
            const raw = proxyRes.headers['set-cookie'];
            if (!raw) return;
            const list = Array.isArray(raw) ? raw : [raw];
            // Keep session cookies scoped to the Vite origin (not the API host).
            proxyRes.headers['set-cookie'] = list.map(cookie => cookie.replace(/;\s*Domain=[^;]+/i, ''));
          });
          (proxy as any).on('error', (_err: unknown, _req: unknown, res: any) => {
            if (res && typeof res.writeHead === 'function' && !res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ message: '后端服务暂时不可用，请稍后重试' }));
            }
          });
        },
      },
    },
  },
});
