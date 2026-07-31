import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    server: {
      deps: {
        // @expressive ships extensionless relative ESM imports; Node's loader rejects
        // them when externalized, so let Vite process these packages in tests.
        inline: [/@expressive\//],
      },
    },
  },
});
