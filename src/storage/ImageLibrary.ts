import State from '@expressive/react';
import { dbDelete, dbGetAll, dbPut } from './db';

export interface StoredImage {
  id: string;
  kind: 'source' | 'generated';
  prompt?: string;
  styleId?: string;
  bytes: ArrayBuffer;
  type: string;
  createdAt: number;
}

export type NewImage = Omit<StoredImage, 'id' | 'createdAt'>;

/** Object URLs are unavailable in some test environments; render code treats missing urls as "no art". */
export function safeObjectUrl(bytes: ArrayBuffer, type: string): string | undefined {
  try {
    return URL.createObjectURL(new Blob([bytes], { type }));
  } catch {
    return undefined;
  }
}

function withoutKey(map: Record<string, string>, id: string): Record<string, string> {
  const { [id]: dropped, ...rest } = map;
  if (dropped) {
    try {
      URL.revokeObjectURL(dropped);
    } catch {
      // happy-dom may not implement revoke; leaking in tests is fine
    }
  }
  return rest;
}

export class ImageLibrary extends State {
  images: StoredImage[] = [];
  urls: Record<string, string> = {};
  ready = false;

  protected new() {
    void this.load();
  }

  private async load(): Promise<void> {
    const rows = await dbGetAll<StoredImage>('images');
    if (this.get(null)) return; // destroyed while loading — drop the result
    rows.sort((a, b) => b.createdAt - a.createdAt);
    const urls: Record<string, string> = {};
    for (const row of rows) {
      const url = safeObjectUrl(row.bytes, row.type);
      if (url) urls[row.id] = url;
    }
    this.images = rows;
    this.urls = urls;
    this.ready = true;
  }

  async add(input: NewImage): Promise<StoredImage> {
    const image: StoredImage = { ...input, id: crypto.randomUUID(), createdAt: Date.now() };
    await dbPut('images', image);
    const url = safeObjectUrl(image.bytes, image.type);
    this.images = [image, ...this.images];
    if (url) this.urls = { ...this.urls, [image.id]: url };
    return image;
  }

  async remove(id: string): Promise<void> {
    await dbDelete('images', id);
    this.images = this.images.filter((image) => image.id !== id);
    this.urls = withoutKey(this.urls, id);
  }

  url(id: string): string | undefined {
    return this.urls[id];
  }
}
