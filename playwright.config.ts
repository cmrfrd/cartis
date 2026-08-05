import { defineConfig } from '@playwright/test';

/**
 * Scripted e2e (test-hardening spec §Track B): real Chromium + real dev
 * server + the CARTIS_FAKE_AGENT scripted faux model. Strict port 5198 +
 * scratch data root — a run can NEVER touch the user's live server (5173)
 * or real cartis-data. Model keys stripped: the faux model needs none.
 */
export default defineConfig({
  testDir: 'e2e/scripted',
  workers: 1, // shared scratch data root — keep runs serial
  use: { baseURL: 'http://localhost:5198' },
  webServer: {
    command: 'bun run dev -- --port 5198 --strictPort',
    url: 'http://localhost:5198/builder',
    reuseExistingServer: false,
    env: {
      CARTIS_DATA_ROOT: 'e2e/.scratch/scripted/data',
      CARTIS_FAKE_AGENT: '1',
      REPLICATE_API_TOKEN: '',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
    },
  },
});
