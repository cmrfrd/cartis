import { beforeEach } from 'vitest';
import { setAppLayer, testAppLayer } from '../src/app/runtime';
import { registerBuiltinTemplates } from '../src/cards';
import { __clearTemplatesForTests } from '../src/cards/registry';

beforeEach(() => {
  // Fresh in-memory app runtime (memory StoreClient) + template registry per test.
  setAppLayer(testAppLayer);
  __clearTemplatesForTests();
  registerBuiltinTemplates();
});
