/**
 * Browser-side client for the bridge's file store (./cartis-data).
 *
 * All persistence flows through this Effect service. The Live layer talks to
 * the dev-server bridge over `@effect/platform` HttpClient exactly as the old
 * plain-fetch HttpStoreClient did (same routes, same wire body, same error
 * strings). The Memory layer mirrors the old createMemoryStoreClient for tests
 * and headless use.
 *
 * Migrated from the old src/storage/storeClient.ts.
 */

import { HttpClient, HttpClientRequest, type HttpClientResponse } from '@effect/platform';
import { Context, Effect, Layer, Option, Ref, Schema } from 'effect';
import { ErrorBody, StorePutRequest } from '@/contracts/api';
import { NetworkError, StoreError } from '@/contracts/errors';
import { StoredRecord, type StoreNameT } from '@/contracts/records';
import { bytesToDataUrl } from '@/images/codec';

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/**
 * A stored row plus the server-added `fileName` (present only for binary-backed
 * records). Modeled as an explicit intersection so callers see `fileName` on a
 * `put` result without the row schema having to declare it (CardRecord doesn't).
 */
export type StoredWithFile<A> = A & { readonly fileName?: string };

export interface StoreClientShape {
  readonly list: <A extends { id: string }, I>(
    store: StoreNameT,
    schema: Schema.Schema<A, I>,
  ) => Effect.Effect<ReadonlyArray<A>, StoreError | NetworkError>;
  readonly put: <A extends { id: string }, I>(
    store: StoreNameT,
    schema: Schema.Schema<A, I>,
    record: A,
    bytes?: ArrayBuffer,
  ) => Effect.Effect<StoredWithFile<A>, StoreError | NetworkError>;
  readonly remove: (
    store: StoreNameT,
    id: string,
  ) => Effect.Effect<void, StoreError | NetworkError>;
  /** Displayable URL for a stored binary record. Pure. */
  readonly fileUrl: (store: StoreNameT, record: { fileName?: string }) => string | undefined;
}

export class StoreClient extends Context.Tag('cartis/StoreClient')<
  StoreClient,
  StoreClientShape
>() {}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Same base64 payload the old `toBase64` produced (data-url minus the prefix). */
function toBase64(bytes: ArrayBuffer): string {
  const dataUrl = bytesToDataUrl(bytes, 'application/octet-stream');
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

/** Pure file URL for the Live client — `/files/${store}/${fileName}` as today. */
function liveFileUrl(store: StoreNameT, record: { fileName?: string }): string | undefined {
  return record.fileName ? `/files/${store}/${encodeURIComponent(record.fileName)}` : undefined;
}

/** Decode the server-added `fileName` off a raw JSON body (absent → undefined). */
const FileNameOnly = Schema.Struct({ fileName: Schema.optional(Schema.String) });
function fileNameOf(raw: unknown): string | undefined {
  const decoded = Schema.decodeUnknownOption(FileNameOnly)(raw);
  return Option.isSome(decoded) ? decoded.value.fileName : undefined;
}

/**
 * Decode each row of a JSON array through `schema`, dropping invalid rows
 * (user-approved refinement — one bad sidecar must not blank the whole list).
 */
function decodeRows<A, I>(rows: ReadonlyArray<unknown>, schema: Schema.Schema<A, I>): A[] {
  const decode = Schema.decodeUnknownEither(schema);
  const out: A[] = [];
  for (const row of rows) {
    const decoded = decode(row);
    if (decoded._tag === 'Right') out.push(decoded.right);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Live layer — over @effect/platform HttpClient
// ---------------------------------------------------------------------------

const isOk = (status: number): boolean => status >= 200 && status < 300;

/** Read the raw JSON body of a response; transport/parse failure → NetworkError. */
function readJson(
  url: string,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<unknown, NetworkError> {
  return response.json.pipe(Effect.mapError((cause) => new NetworkError({ url, cause })));
}

/** Best-effort ErrorBody detail off a non-ok response (missing → undefined). */
function detailOf(
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<string | undefined> {
  return response.json.pipe(
    Effect.map((body) => {
      const decoded = Schema.decodeUnknownOption(ErrorBody)(body);
      return Option.isSome(decoded) ? decoded.value.error : undefined;
    }),
    Effect.orElseSucceed(() => undefined),
  );
}

export const storeClientLive: Layer.Layer<StoreClient, never, HttpClient.HttpClient> = Layer.effect(
  StoreClient,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;

    const list = <A extends { id: string }, I>(
      store: StoreNameT,
      schema: Schema.Schema<A, I>,
    ): Effect.Effect<ReadonlyArray<A>, StoreError | NetworkError> =>
      Effect.gen(function* () {
        const url = `/api/store/${store}`;
        const response = yield* http
          .get(url)
          .pipe(Effect.mapError((cause) => new NetworkError({ url, cause })));
        if (!isOk(response.status)) {
          return yield* Effect.fail(new StoreError({ op: 'list', status: response.status }));
        }
        const body = yield* readJson(url, response);
        const rows = Array.isArray(body) ? body : [];
        return decodeRows(rows, schema);
      });

    const put = <A extends { id: string }, I>(
      store: StoreNameT,
      schema: Schema.Schema<A, I>,
      record: A,
      bytes?: ArrayBuffer,
    ): Effect.Effect<StoredWithFile<A>, StoreError | NetworkError> =>
      Effect.gen(function* () {
        const url = `/api/store/${store}`;
        // Encode the row through its own schema, re-decode into the wire's
        // StoredRecord (typed knowns + index signature), then encode the whole
        // StorePutRequest — no casts on the boundary body.
        const encodedRow = yield* Schema.encode(schema)(record).pipe(
          Effect.mapError((cause) => new NetworkError({ url, cause })),
        );
        const wireRecord = yield* Schema.decodeUnknown(StoredRecord)(encodedRow).pipe(
          Effect.mapError((cause) => new NetworkError({ url, cause })),
        );
        const wire = yield* Schema.encode(StorePutRequest)({
          record: wireRecord,
          bytesBase64: bytes ? toBase64(bytes) : undefined,
        }).pipe(Effect.mapError((cause) => new NetworkError({ url, cause })));
        const request = HttpClientRequest.put(url).pipe(HttpClientRequest.bodyUnsafeJson(wire));
        const response = yield* http
          .execute(request)
          .pipe(Effect.mapError((cause) => new NetworkError({ url, cause })));
        if (!isOk(response.status)) {
          const detail = yield* detailOf(response);
          return yield* Effect.fail(new StoreError({ op: 'put', status: response.status, detail }));
        }
        const body = yield* readJson(url, response);
        const decoded = yield* Schema.decodeUnknown(schema)(body).pipe(
          Effect.mapError((cause) => new NetworkError({ url, cause })),
        );
        const fileName = fileNameOf(body);
        return (fileName === undefined ? decoded : { ...decoded, fileName }) as StoredWithFile<A>;
      });

    const remove = (
      store: StoreNameT,
      id: string,
    ): Effect.Effect<void, StoreError | NetworkError> =>
      Effect.gen(function* () {
        const url = `/api/store/${store}/${encodeURIComponent(id)}`;
        const response = yield* http
          .del(url)
          .pipe(Effect.mapError((cause) => new NetworkError({ url, cause })));
        if (!isOk(response.status)) {
          return yield* Effect.fail(new StoreError({ op: 'delete', status: response.status }));
        }
      });

    return StoreClient.of({ list, put, remove, fileUrl: liveFileUrl });
  }),
);

// ---------------------------------------------------------------------------
// Memory layer — in-process, no bridge (tests + headless)
// ---------------------------------------------------------------------------

export const storeClientMemory: Layer.Layer<StoreClient> = Layer.effect(
  StoreClient,
  Effect.gen(function* () {
    const stores = yield* Ref.make(new Map<string, Map<string, unknown>>());

    const bucket = (store: StoreNameT): Effect.Effect<Map<string, unknown>> =>
      Ref.modify(stores, (map) => {
        const existing = map.get(store);
        if (existing) return [existing, map];
        const created = new Map<string, unknown>();
        map.set(store, created);
        return [created, map];
      });

    const list = <A extends { id: string }, I>(
      store: StoreNameT,
      schema: Schema.Schema<A, I>,
    ): Effect.Effect<ReadonlyArray<A>, StoreError | NetworkError> =>
      bucket(store).pipe(Effect.map((b) => decodeRows([...b.values()], schema)));

    const put = <A extends { id: string }, I>(
      store: StoreNameT,
      schema: Schema.Schema<A, I>,
      record: A,
      bytes?: ArrayBuffer,
    ): Effect.Effect<StoredWithFile<A>, StoreError | NetworkError> =>
      Effect.gen(function* () {
        const fileName = bytes ? `${record.id}.bin` : undefined;
        // Store the encoded form (parity with the Live wire body) so list()
        // decodes it back through the row schema, exercising the same path.
        const encoded = yield* Schema.encode(schema)(record).pipe(
          Effect.mapError((cause) => new NetworkError({ url: `memory://${store}`, cause })),
        );
        const stored: Record<string, unknown> = { ...(encoded as Record<string, unknown>) };
        if (fileName !== undefined) stored.fileName = fileName;
        const b = yield* bucket(store);
        b.set(record.id, stored);
        return (fileName === undefined ? record : { ...record, fileName }) as StoredWithFile<A>;
      });

    const remove = (
      store: StoreNameT,
      id: string,
    ): Effect.Effect<void, StoreError | NetworkError> =>
      Effect.gen(function* () {
        const b = yield* bucket(store);
        b.delete(id);
      });

    const fileUrl = (_store: StoreNameT, record: { fileName?: string }): string | undefined =>
      record.fileName ? `memory://${record.fileName}` : undefined;

    return StoreClient.of({ list, put, remove, fileUrl });
  }),
);
