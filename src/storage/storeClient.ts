import { bytesToDataUrl } from '../images/codec';

/**
 * Client for the bridge's file store (./cartis-data). All persistence flows
 * through this seam; tests install an in-memory client via
 * __setStoreClientForTests.
 */

export type StoreName = 'images' | 'cards' | 'exports';

export interface StoreRecord {
  id: string;
  name?: string;
  type?: string;
  fileName?: string;
  [key: string]: unknown;
}

export interface StoreClient {
  list<T extends { id: string }>(store: StoreName): Promise<T[]>;
  put<T extends { id: string }>(
    store: StoreName,
    record: T,
    bytes?: ArrayBuffer,
  ): Promise<T & { fileName?: string }>;
  remove(store: StoreName, id: string): Promise<void>;
  /** Displayable URL for a stored binary record. */
  fileUrl(store: StoreName, record: { fileName?: string }): string | undefined;
}

function toBase64(bytes: ArrayBuffer): string {
  const dataUrl = bytesToDataUrl(bytes, 'application/octet-stream');
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

class HttpStoreClient implements StoreClient {
  async list<T extends { id: string }>(store: StoreName): Promise<T[]> {
    const res = await fetch(`/api/store/${store}`);
    if (!res.ok) throw new Error(`store list failed (${String(res.status)})`);
    return (await res.json()) as T[];
  }

  async put<T extends { id: string }>(
    store: StoreName,
    record: T,
    bytes?: ArrayBuffer,
  ): Promise<T & { fileName?: string }> {
    const res = await fetch(`/api/store/${store}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record, bytesBase64: bytes ? toBase64(bytes) : undefined }),
    });
    const body = (await res.json()) as (T & { fileName?: string }) & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `store put failed (${String(res.status)})`);
    return body;
  }

  async remove(store: StoreName, id: string): Promise<void> {
    const res = await fetch(`/api/store/${store}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`store delete failed (${String(res.status)})`);
  }

  fileUrl(store: StoreName, record: StoreRecord): string | undefined {
    return record.fileName ? `/files/${store}/${encodeURIComponent(record.fileName)}` : undefined;
  }
}

/** In-memory client for tests and headless use — same contract, no bridge. */
export function createMemoryStoreClient(): StoreClient {
  const stores = new Map<string, Map<string, unknown>>();
  const bucket = (store: StoreName) => {
    let b = stores.get(store);
    if (!b) {
      b = new Map();
      stores.set(store, b);
    }
    return b;
  };
  return {
    async list<T extends { id: string }>(store: StoreName) {
      return [...bucket(store).values()] as T[];
    },
    async put(store, record, bytes) {
      const fileName = bytes ? `${record.id}.bin` : undefined;
      const stored = { ...record, ...(fileName ? { fileName } : {}) };
      bucket(store).set(record.id, stored);
      return stored;
    },
    async remove(store, id) {
      bucket(store).delete(id);
    },
    fileUrl(_store, record) {
      return record.fileName ? `memory://${record.fileName}` : undefined;
    },
  };
}

let client: StoreClient = new HttpStoreClient();

export function storeClient(): StoreClient {
  return client;
}

export function __setStoreClientForTests(next: StoreClient): void {
  client = next;
}
