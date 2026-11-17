import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function forwardHost(proxy) {
  const setHost = (proxyReq, req) => {
    if (req.headers.host) proxyReq.setHeader('X-Forwarded-Host', req.headers.host);
  };
  proxy.on('proxyReq', setHost);
  proxy.on('proxyReqWs', setHost);
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: false,
        configure: forwardHost
      },
      '/ws': {
        target: 'ws://127.0.0.1:3001',
        ws: true,
        changeOrigin: false,
        configure: forwardHost
      }
    }
  }
});
