import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** SQLite API（server/index.mjs）的地址，由 `npm run api` 起在 5184。 */
const API_TARGET = 'http://127.0.0.1:5184';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5183,
    // 必须 strictPort：不设的话 5183 被占时 Vite 会顺延，而 5184 正好是 API 的端口。
    strictPort: true,
    proxy: {
      // 用正则键而不是 '/api'：proxy 的 context 匹配是 startsWith，
      // '/api' 会连 '/apiary' 一起代理走。
      '^/api/': { target: API_TARGET, changeOrigin: true },
    },
  },
});
