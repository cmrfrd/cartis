import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Option } from 'effect';
import { describe, expect } from 'vitest';
import { it } from '../../test/effect.ts';
import { FileStore, fileNameFor, fileStoreLayer } from './fileStore.ts';

/**
 * `fileNameFor` stays a plain pure test; the I/O tests run under a per-test
 * temp-dir layer (real FS — this is a local tool). Every assertion's intent is
 * carried over from the pre-Effect spec: slugging, sidecar format + names,
 * upsert-on-rename, traversal guard, corrupt-sidecar skip, empty-store list.
 */

const bytes = (text: string) => Buffer.from(text).toString('base64');

/** A fresh temp-dir FileStore layer per test. */
const withTempStore = () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'cartis-store-')));
    return dir;
  });

describe('fileNameFor', () => {
  it('slugs the name and keeps a short id suffix for uniqueness', () => {
    expect(fileNameFor({ id: 'abcdef123456', name: 'Ember Knight!', type: 'image/png' })).toBe(
      'ember-knight-abcdef.png',
    );
    expect(fileNameFor({ id: 'abcdef123456', name: '  ', type: 'image/jpeg' })).toBe(
      'untitled-abcdef.jpg',
    );
    expect(fileNameFor({ id: 'x'.repeat(12), name: 'a/b\\c..d', type: 'application/json' })).toBe(
      'a-b-c-d-xxxxxx.json',
    );
  });
});

describe('file store', () => {
  it.effect('puts, lists, and deletes binary records with metadata sidecars', () =>
    Effect.gen(function* () {
      const dir = yield* withTempStore();
      yield* Effect.gen(function* () {
        const store = yield* FileStore;
        const record = {
          id: 'img-123456789',
          name: 'Storm Mage',
          kind: 'generated',
          prompt: 'a storm mage',
          type: 'image/png',
          createdAt: 111,
        };
        const stored = yield* store.put('images', record, bytes('fake-png'));
        expect(stored.fileName).toBe('storm-mage-img-12.png');

        const files = yield* Effect.promise(() => readdir(join(dir, 'images')));
        expect(files.sort()).toEqual(['storm-mage-img-12.json', 'storm-mage-img-12.png']);
        const png = yield* Effect.promise(() =>
          readFile(join(dir, 'images', 'storm-mage-img-12.png')),
        );
        expect(png.toString()).toBe('fake-png');

        const listed = yield* store.list('images');
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({
          id: 'img-123456789',
          name: 'Storm Mage',
          kind: 'generated',
        });

        const file = yield* store.readFile('images', 'storm-mage-img-12.png');
        expect(Option.isSome(file)).toBe(true);
        expect(Option.getOrThrow(file).type).toBe('image/png');

        yield* store.remove('images', 'img-123456789');
        expect(yield* store.list('images')).toHaveLength(0);
        expect(yield* Effect.promise(() => readdir(join(dir, 'images')))).toHaveLength(0);
      }).pipe(Effect.provide(fileStoreLayer(dir)));
    }),
  );

  it.effect('stores pure-JSON records (cards) without a binary file', () =>
    Effect.gen(function* () {
      const dir = yield* withTempStore();
      yield* Effect.gen(function* () {
        const store = yield* FileStore;
        const card = {
          id: 'card-1234567',
          name: 'Nyra',
          templateId: 'arcane-hero',
          data: { name: 'Nyra' },
          holo: true,
          updatedAt: 5,
        };
        yield* store.put('cards', card);
        const files = yield* Effect.promise(() => readdir(join(dir, 'cards')));
        expect(files).toEqual(['nyra-card-1.json']);
        const listed = yield* store.list('cards');
        expect(listed[0]).toMatchObject({ name: 'Nyra', holo: true });
      }).pipe(Effect.provide(fileStoreLayer(dir)));
    }),
  );

  it.effect('upserts by id: re-putting replaces the old files even when renamed', () =>
    Effect.gen(function* () {
      const dir = yield* withTempStore();
      yield* Effect.gen(function* () {
        const store = yield* FileStore;
        const v1 = { id: 'card-1234567', name: 'Old Name', updatedAt: 1 };
        yield* store.put('cards', v1);
        yield* store.put('cards', { ...v1, name: 'New Name', updatedAt: 2 });
        const files = yield* Effect.promise(() => readdir(join(dir, 'cards')));
        expect(files).toEqual(['new-name-card-1.json']);
        const listed = yield* store.list('cards');
        expect(listed).toHaveLength(1);
        expect(listed[0]?.name).toBe('New Name');
      }).pipe(Effect.provide(fileStoreLayer(dir)));
    }),
  );

  it.effect('rejects traversal attempts in stored file reads', () =>
    Effect.gen(function* () {
      const dir = yield* withTempStore();
      yield* Effect.gen(function* () {
        const store = yield* FileStore;
        const file = yield* store.readFile('images', '../../etc/passwd');
        expect(Option.isNone(file)).toBe(true);
      }).pipe(Effect.provide(fileStoreLayer(dir)));
    }),
  );

  it.effect('returns empty lists for missing stores', () =>
    Effect.gen(function* () {
      const dir = yield* withTempStore();
      yield* Effect.gen(function* () {
        const store = yield* FileStore;
        expect(yield* store.list('images')).toEqual([]);
      }).pipe(Effect.provide(fileStoreLayer(dir)));
    }),
  );

  it.effect('skips a corrupt sidecar rather than failing the whole list', () =>
    Effect.gen(function* () {
      const dir = yield* withTempStore();
      yield* Effect.gen(function* () {
        const store = yield* FileStore;
        // one valid record + one hand-broken sidecar in the same store dir
        yield* store.put('cards', { id: 'card-good1', name: 'Good' });
        yield* Effect.promise(() =>
          writeFile(join(dir, 'cards', 'broken-xxxxxx.json'), '{ not valid json'),
        );
        const listed = yield* store.list('cards');
        expect(listed).toHaveLength(1);
        expect(listed[0]?.name).toBe('Good');
      }).pipe(Effect.provide(fileStoreLayer(dir)));
    }),
  );
});
