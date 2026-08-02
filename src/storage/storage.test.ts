import type { HttpClientRequest } from '@effect/platform';
import { Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { setAppLayer, testAppLayerWith } from '../app/runtime';
import { httpClientFromHandler } from '../lib/http';
import { CardArchive } from './CardArchive';
import { ImageLibrary } from './ImageLibrary';
import { storeClientLive } from './StoreClient';

const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

async function ready(model: { ready: boolean }): Promise<void> {
  await vi.waitFor(() => {
    expect(model.ready).toBe(true);
  });
}

describe('ImageLibrary', () => {
  it('adds named images, lists newest-first, persists, and removes', async () => {
    const lib = ImageLibrary.new();
    await ready(lib);
    const a = await lib.add({
      name: 'Ember Test',
      kind: 'generated',
      prompt: 'a',
      styleId: 's',
      bytes: bytesOf('a'),
      type: 'image/png',
    });
    const b = await lib.add({
      name: 'Source Photo',
      kind: 'source',
      bytes: bytesOf('b'),
      type: 'image/jpeg',
    });
    expect(lib.images.map((i) => i.id)).toEqual([b.id, a.id]);
    expect(lib.images[1]?.name).toBe('Ember Test');
    expect(typeof lib.url(a.id)).toBe('string');

    const reloaded = ImageLibrary.new();
    await ready(reloaded);
    expect(reloaded.images.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());
    reloaded.set(null);

    await lib.remove(a.id);
    expect(lib.images.map((i) => i.id)).toEqual([b.id]);
    expect(lib.url(a.id)).toBeUndefined();
    lib.set(null);
  });
});

describe('CardArchive', () => {
  it('upserts cards by id and orders by recency', async () => {
    const archive = CardArchive.new();
    await ready(archive);
    const first = await archive.saveCard({
      name: 'One',
      templateId: 't',
      data: { name: 'One' },
      holo: false,
    });
    await archive.saveCard({ name: 'Two', templateId: 't', data: { name: 'Two' }, holo: true });
    const updated = await archive.saveCard({
      id: first.id,
      name: 'One v2',
      templateId: 't',
      data: { name: 'One v2' },
      holo: false,
    });
    expect(updated.id).toBe(first.id);
    expect(archive.cards).toHaveLength(2);
    expect(archive.cards[0]?.name).toBe('One v2');
    await archive.deleteCard(first.id);
    expect(archive.cards.map((c) => c.name)).toEqual(['Two']);
    archive.set(null);
  });

  it('saves and deletes exports with file urls', async () => {
    const archive = CardArchive.new();
    await ready(archive);
    const exp = await archive.saveExport({
      name: 'hero',
      format: 'png',
      bytes: bytesOf('img'),
      type: 'image/png',
    });
    expect(archive.exports[0]?.format).toBe('png');
    expect(typeof archive.exportUrl(exp.id)).toBe('string');
    await archive.deleteExport(exp.id);
    expect(archive.exports).toHaveLength(0);
    archive.set(null);
  });

  it('drops schema-invalid rows from a list, keeps valid ones', async () => {
    // A live StoreClient over a canned handler: the cards list returns one
    // valid card and one invalid card (missing `updatedAt`). The invalid row
    // must be dropped; the valid row survives.
    const good = {
      id: 'good',
      name: 'Good',
      templateId: 't',
      holo: false,
      updatedAt: 100,
      data: {},
    };
    const bad = { id: 'bad', name: 'Bad', templateId: 't', holo: false, data: {} }; // no updatedAt
    const handler = (req: HttpClientRequest.HttpClientRequest): Response => {
      if (req.method === 'GET' && req.url.endsWith('/api/store/cards')) {
        return new Response(JSON.stringify([good, bad]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // exports (and anything else) → empty list
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    setAppLayer(
      testAppLayerWith({
        store: storeClientLive.pipe(Layer.provide(httpClientFromHandler(handler))),
      }),
    );

    const archive = CardArchive.new();
    await ready(archive);
    expect(archive.cards.map((c) => c.id)).toEqual(['good']);
    archive.set(null);
  });
});
