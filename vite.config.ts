import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** 与 src/server/serve.ts 的默认端口保持一致，否则开发模式下所有 API 都反代到空气里。 */
const API_PORT = process.env.PORT ?? '8686';

export default defineConfig({
  plugins: [react()],
  root: '.',
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    // 开发时前端跑在 vite，API 与 SSE 反代到 Hono
    proxy: {
      '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: false },
    },
  },
});
