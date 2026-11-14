import { defineConfig } from 'vite';

// The host (`mrstudio dev`) serves the site, the API and the WebSocket.
const host = process.env.MRS_HOST ?? 'http://127.0.0.1:4170';

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    fs: { allow: ['../..'] },
    proxy: {
      '/ws': { target: host, ws: true },
      '/site': host,
      '/api': host,
    },
  },
  build: { target: 'es2022', sourcemap: true },
});
