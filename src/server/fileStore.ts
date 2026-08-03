import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import { FileStoreError } from '../contracts/errors.ts';
import { Slug, type SlugT } from '../contracts/ids.ts';
import { StoredRecord as StoredRecordSchema } from '../contracts/records.ts';

/**
 * File-backed persistence under ./cartis-data — real files the user can
 * browse, copy, and back up. Binary records (images, exports) are stored as
 * <slug>-<id6>.<ext> with a .json metadata sidecar; cards are plain .json.
 *
 * Effect shape: pure name helpers stay plain functions; the async I/O lives
 * behind the `FileStore` service tag, so routes depend on the tag and tests
 * swap in a temp-dir layer. Every fs call is wrapped in `Effect.tryPromise`
 * mapping to `FileStoreError`; the list path decodes each sidecar through the
 * `StoredRecord` contract instead of a blind `JSON.parse` cast.
 */

export type StoreName = 'images' | 'cards' | 'exports';

/** Structural record type mirrored from the StoredRecord contract. */
export type StoredRecord = typeof StoredRecordSchema.Type;

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/json': 'json',
};

const TYPE_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  json: 'application/json',
};

/** Sanitized name slug — the Slug brand proves the character set (spec §1). */
function slugOf(name: string | undefined): SlugT {
  const slug = (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return Slug.make(slug.length > 0 ? slug : 'untitled');
}

/** Stable, human-readable, unique on-disk name. */
export function fileNameFor(record: { id: string; name?: string; type?: string }): string {
  const ext = EXT_BY_TYPE[record.type ?? 'application/json'] ?? 'bin';
  return `${slugOf(record.name)}-${record.id.slice(0, 6)}.${ext}`;
}

function sidecarName(record: { id: string; name?: string }): string {
  return `${slugOf(record.name)}-${record.id.slice(0, 6)}.json`;
}

// ---------------------------------------------------------------------------
// Service tag
// ---------------------------------------------------------------------------

export class FileStore extends Context.Tag('cartis/FileStore')<
  FileStore,
  {
    put(
      store: StoreName,
      record: StoredRecord,
      bytesBase64?: string,
    ): Effect.Effect<StoredRecord, FileStoreError>;
    list(store: StoreName): Effect.Effect<ReadonlyArray<StoredRecord>, FileStoreError>;
    remove(store: StoreName, id: string): Effect.Effect<void, FileStoreError>;
    readFile(
      store: StoreName,
      fileName: string,
    ): Effect.Effect<Option.Option<{ bytes: Buffer; type: string }>, FileStoreError>;
  }
>() {}

const decodeRecord = Schema.decodeUnknownEither(StoredRecordSchema);

/** Layer over node:fs/promises rooted at `root`. */
export function fileStoreLayer(root: string): Layer.Layer<FileStore> {
  const io = <A>(
    op: string,
    path: string,
    run: () => Promise<A>,
  ): Effect.Effect<A, FileStoreError> =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => new FileStoreError({ op, path, cause }),
    });

  const storeDir = (store: StoreName): Effect.Effect<string, FileStoreError> => {
    const dir = join(root, store);
    return io('mkdir', dir, () => mkdir(dir, { recursive: true }).then(() => dir));
  };

  const filesFor = (
    store: StoreName,
    id: string,
  ): Effect.Effect<ReadonlyArray<string>, FileStoreError> =>
    Effect.gen(function* () {
      const dir = yield* storeDir(store);
      const suffix = `-${id.slice(0, 6)}`;
      const names = yield* io('readdir', dir, () => readdir(dir));
      return names.filter((n) => n.replace(/\.[a-z0-9]+$/, '').endsWith(suffix));
    });

  const remove = (store: StoreName, id: string): Effect.Effect<void, FileStoreError> =>
    Effect.gen(function* () {
      const dir = yield* storeDir(store);
      const names = yield* filesFor(store, id);
      yield* Effect.forEach(
        names,
        (name) => io('rm', join(dir, name), () => rm(join(dir, name), { force: true })),
        { discard: true },
      );
    });

  const put = (
    store: StoreName,
    record: StoredRecord,
    bytesBase64?: string,
  ): Effect.Effect<StoredRecord, FileStoreError> =>
    Effect.gen(function* () {
      // upsert: clear any previous files for this id (name may have changed)
      yield* remove(store, record.id);
      const dir = yield* storeDir(store);
      const isBinary = typeof bytesBase64 === 'string' && record.type !== 'application/json';
      const fileName = isBinary ? fileNameFor(record) : undefined;
      const meta: StoredRecord = { ...record, ...(fileName ? { fileName } : {}) };
      if (isBinary && fileName) {
        const bytes = Buffer.from(bytesBase64, 'base64');
        yield* io('writeFile', join(dir, fileName), () => writeFile(join(dir, fileName), bytes));
      }
      const sidecar = join(dir, sidecarName(record));
      yield* io('writeFile', sidecar, () =>
        writeFile(sidecar, `${JSON.stringify(meta, null, 2)}\n`),
      );
      return meta;
    });

  const list = (store: StoreName): Effect.Effect<ReadonlyArray<StoredRecord>, FileStoreError> =>
    Effect.gen(function* () {
      const dir = yield* storeDir(store);
      const names = (yield* io('readdir', dir, () => readdir(dir))).filter((n) =>
        n.endsWith('.json'),
      );
      const records: StoredRecord[] = [];
      for (const name of names) {
        const raw = yield* io('readFile', join(dir, name), () => readFile(join(dir, name), 'utf8'));
        // lenient: a sidecar that fails JSON.parse OR the StoredRecord decode is
        // silently skipped rather than breaking the whole list.
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
        const decoded = decodeRecord(parsed);
        if (decoded._tag === 'Right') records.push(decoded.right);
      }
      return records;
    });

  const readStoredFile = (
    store: StoreName,
    fileName: string,
  ): Effect.Effect<Option.Option<{ bytes: Buffer; type: string }>, FileStoreError> => {
    if (fileName !== basename(fileName)) return Effect.succeed(Option.none()); // traversal guard
    return Effect.gen(function* () {
      const dir = yield* storeDir(store);
      const path = join(dir, fileName);
      const bytes = yield* io('readFile', path, () => readFile(path)).pipe(
        Effect.map(Option.some),
        // a missing file (ENOENT) is a 404, not an error — mirror today's catch → undefined
        Effect.catchTag('FileStoreError', () => Effect.succeed(Option.none<Buffer>())),
      );
      return Option.map(bytes, (b) => {
        const ext = fileName.split('.').pop() ?? '';
        return { bytes: b, type: TYPE_BY_EXT[ext] ?? 'application/octet-stream' };
      });
    });
  };

  return Layer.succeed(FileStore, {
    put,
    list,
    remove,
    readFile: readStoredFile,
  });
}
