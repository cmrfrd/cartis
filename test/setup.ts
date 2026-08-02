import { beforeEach } from 'vitest';
import { setAppLayer, testAppLayer } from '../src/app/runtime';
import { registerBuiltinTemplates, registerBuiltinThemes } from '../src/cards';
import { __clearTemplatesForTests, __clearThemesForTests } from '../src/cards/registry';

beforeEach(() => {
  // Fresh in-memory app runtime (memory StoreClient) + registries per test.
  setAppLayer(testAppLayer);
  __clearTemplatesForTests();
  __clearThemesForTests();
  registerBuiltinTemplates();
  registerBuiltinThemes();
});
