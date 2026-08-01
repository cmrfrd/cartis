import State from '@expressive/react';
import { storeClient } from './storeClient';

export interface StoredImage {
  id: string;
  name: string;
  kind: 'source' | 'generated';
  prompt?: string;
  styleId?: string;
  type: string;
  createdAt: number;
  fileName?: string;
}

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
    try {
      const rows = await storeClient().list<StoredImage>('images');
      if (this.get(null)) return; // destroyed while loading — drop the result
      rows.sort((a, b) => b.createdAt - a.createdAt);
      const urls: Record<string, string> = {};
      for (const row of rows) {
        const url = storeClient().fileUrl('images', row);
        if (url) urls[row.id] = url;
      }
      this.images = rows;
      this.urls = urls;
    } finally {
      if (!this.get(null)) this.ready = true;
    }
  }

  async add(input: NewImage): Promise<StoredImage> {
    const { bytes, ...meta } = input;
    const record: StoredImage = { ...meta, id: crypto.randomUUID(), createdAt: Date.now() };
    const stored = await storeClient().put('images', record, bytes);
    this.images = [stored, ...this.images];
    const url = storeClient().fileUrl('images', stored);
    if (url) this.urls = { ...this.urls, [stored.id]: url };
    return stored;
  }

  async remove(id: string): Promise<void> {
    await storeClient().remove('images', id);
    this.images = this.images.filter((image) => image.id !== id);
    const { [id]: _dropped, ...rest } = this.urls;
    this.urls = rest;
  }

  url(id: string): string | undefined {
    return this.urls[id];
  }
}
