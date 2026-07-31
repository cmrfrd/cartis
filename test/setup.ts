import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach } from 'vitest';
import { __resetDbForTests } from '../src/storage/db';

beforeEach(() => {
  // Fresh database per test: new factory + drop the cached connection.
  globalThis.indexedDB = new IDBFactory();
  __resetDbForTests();
});
