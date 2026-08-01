import State from '@expressive/react';
import { Effect, Exit } from 'effect';
import { runAppExit } from '../app/runtime';
import { noteFromCause } from '../contracts/errors';
import { ImageRecord, type ImageRecordT } from '../contracts/records';
import { StoreClient } from './StoreClient';

/** Type continuity: views import `StoredImage`; alias the contract type. */
export type StoredImage = ImageRecordT;

export interface NewImage {
  name: string;
  kind: 'source' | 'generated';
  prompt?: string;
  styleId?: string;
  bytes: ArrayBuffer;
  type: string;
}

export class ImageLibrary extends State {
  images: StoredImage[] = [];
  urls: Record<string, string> = {};
  ready = false;

  protected new() {
    void this.load();
  }

  private async load(): Promise<void> {
    const exit = await runAppExit(
      Effect.gen(function* () {
        const store = yield* StoreClient;
        const rows = yield* store.list('images', ImageRecord);
        const urls: Record<string, string> = {};
        for (const row of rows) {
          const url = store.fileUrl('images', row);
          if (url !== undefined) urls[row.id] = url;
        }
        return { rows, urls };
      }),
    );
    if (this.get(null)) return; // destroyed while loading — drop the result
    if (Exit.isSuccess(exit)) {
      // Parity with today: load() surfaced no note on failure.
      this.images = [...exit.value.rows].sort((a, b) => b.createdAt - a.createdAt);
      this.urls = exit.value.urls;
    }
    this.ready = true;
  }

  async add(input: NewImage): Promise<StoredImage> {
    const { bytes, ...meta } = input;
    const record: StoredImage = { ...meta, id: crypto.randomUUID(), createdAt: Date.now() };
    const exit = await runAppExit(
      Effect.gen(function* () {
        const store = yield* StoreClient;
        const stored = yield* store.put('images', ImageRecord, record, bytes);
        const url = store.fileUrl('images', stored);
        return { stored, url };
      }),
    );
    if (Exit.isFailure(exit)) throw new Error(noteFromCause(exit.cause));
    const { stored, url } = exit.value;
    this.images = [stored, ...this.images];
    if (url !== undefined) this.urls = { ...this.urls, [stored.id]: url };
    return stored;
  }

  async remove(id: string): Promise<void> {
    const exit = await runAppExit(
      Effect.gen(function* () {
        const store = yield* StoreClient;
        yield* store.remove('images', id);
      }),
    );
    if (Exit.isFailure(exit)) throw new Error(noteFromCause(exit.cause));
    this.images = this.images.filter((image) => image.id !== id);
    const { [id]: _dropped, ...rest } = this.urls;
    this.urls = rest;
  }

  url(id: string): string | undefined {
    return this.urls[id];
  }
}
