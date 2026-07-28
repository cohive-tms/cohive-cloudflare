import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_SAAS_MODE': JSON.stringify('true')
  },
  resolve: {
    alias: {
      'cohive-frontend': path.resolve(__dirname, './frontend/src'),
      'cohive-cloudflare': path.resolve(__dirname, './functions/api/_api')
    }
  },
  server: {
    port: 3001,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: true,
      },
    },
  },
});
