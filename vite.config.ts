import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { cartisBridge } from './src/server/agentBridge.ts';

export default defineConfig(({ mode }) => {
  // The bridge reads process.env at request time; Vite only loads .env files
  // into import.meta.env. Bridge keys are copied over here — shell env wins.
  const fileEnv = loadEnv(mode, process.cwd(), '');
  for (const key of ['REPLICATE_API_TOKEN', 'OPENCODE_MODEL']) {
    if (!process.env[key] && fileEnv[key]) process.env[key] = fileEnv[key];
  }
  return {
    plugins: [react(), tailwindcss(), cartisBridge()],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
      },
    },
  };
});
