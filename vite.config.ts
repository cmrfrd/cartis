import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { cartisBridge } from './src/server/agentBridge';

export default defineConfig({
  plugins: [react(), tailwindcss(), cartisBridge()],
});
