import { beforeEach } from 'vitest';
import { setAppLayer, testAppLayer } from '../src/app/runtime';
import { registerBuiltinThemes } from '../src/cards';
import { __clearThemesForTests } from '../src/cards/registry';

beforeEach(() => {
  // Fresh in-memory app runtime (memory StoreClient) + theme registry per test.
  setAppLayer(testAppLayer);
  __clearThemesForTests();
  registerBuiltinThemes();
});
