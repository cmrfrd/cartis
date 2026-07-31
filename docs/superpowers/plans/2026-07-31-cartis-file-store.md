# Cartis File Store + Generation Control Plan

> Executed inline (small steps, verify each, browser E2E at the end). Three user adjustments in one coherent change.

## Decisions

- **Storage moves from IndexedDB to real files** under `./cartis-data/` (gitignored), served by the bridge — the dev server is the app, so persistence lives beside it. Users can browse/copy/back up: `cartis-data/images/<name>.png` (+ `.json` metadata sidecar), `cartis-data/cards/<name>.json`, `cartis-data/exports/<name>.png`.
- Bridge endpoints: `GET /api/store/:store` (list metadata), `PUT /api/store/:store` (record + base64 bytes), `DELETE /api/store/:store/:id`, `GET /files/:store/:filename` (binary). Client gets `fileUrl`s — object-URL bookkeeping dies.
- Client storage goes through a `StoreClient` interface (fetch-based default, in-memory fake for tests via `__setStoreClientForTests`). `db.ts` + `fake-indexeddb` are deleted. Old IndexedDB data (test cards) is not migrated — clean break.
- **Dimensions**: `GenerationInput.aspectRatio` (replicate enum; verified live from the model schema). Templates declare `artAspect` (`arcane-hero`: `3:2`, fullart: `3:4`); Portrait generation uses it automatically; Image Lab gets a manual select (default `match_input_image`). The offline stub honors the ratio too (WYSIWYG parity).
- **Names**: images get a `name` — user-editable input, defaulting to `suggestImageName(prompt)` (significant-words slug — deterministic "AI-ish" naming, no model call). Names become the on-disk filenames (`<slug>-<id6>.<ext>`). Gallery's image tab becomes a full library browser: generated AND source images, kind chips, names, download links.

## Tasks

1. **fileStore (bridge)**: `src/server/fileStore.ts` — sanitized slugs, sidecar metadata, list/put/delete + static file serving; unit tests on a temp dir; wire routes into `cartisBridge`; `cartis-data/` in .gitignore.
2. **StoreClient (app)**: `src/storage/storeClient.ts` (fetch + memory implementations); rewrite `ImageLibrary`/`CardArchive` on top (records carry `fileUrl` not bytes); update setup.ts, storage tests, gallery download links; delete db.ts/fake-indexeddb.
3. **Aspect ratio**: provider/bridge plumbing, `artAspect` on templates, stub ratio support, Image Lab select, tests.
4. **Names + library browser**: `suggestImageName` util + tests, name inputs in Image Lab/Portrait, Gallery library tab upgrade.
5. **E2E**: browser walkthrough incl. one real generation at a non-default aspect; check files on disk; README + memory; merge.
