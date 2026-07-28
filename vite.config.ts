import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';

// Use local submodule if exists, fallback to node_modules for automated deploy environments
const frontendSrcDir = path.resolve(__dirname, './frontend/src');
const frontendSrc = fs.existsSync(frontendSrcDir) && fs.readdirSync(frontendSrcDir).length > 0
  ? frontendSrcDir
  : path.resolve(__dirname, './node_modules/cohive-frontend/src');

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, './package.json'), 'utf-8'));

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_SAAS_MODE': JSON.stringify('true'),
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version)
  },
  resolve: {
    alias: {
      'cohive-frontend': frontendSrc,
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
