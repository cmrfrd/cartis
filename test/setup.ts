import { beforeEach } from 'vitest';
import { setAppLayer, testAppLayer } from '@/app/runtime';
import { registerBuiltinThemes } from '@/cards';
import { __clearThemesForTests } from '@/cards/registry';

beforeEach(() => {
  // Fresh in-memory app runtime (memory StoreClient) + theme registry per test.
  setAppLayer(testAppLayer);
  __clearThemesForTests();
  registerBuiltinThemes();
});
