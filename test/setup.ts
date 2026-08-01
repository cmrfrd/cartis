import { beforeEach } from 'vitest';
import { registerBuiltinTemplates } from '../src/cards';
import { __clearTemplatesForTests } from '../src/cards/registry';
import { __setStoreClientForTests, createMemoryStoreClient } from '../src/storage/storeClient';

beforeEach(() => {
  // Fresh in-memory file store + template registry per test.
  __setStoreClientForTests(createMemoryStoreClient());
  __clearTemplatesForTests();
  registerBuiltinTemplates();
});
