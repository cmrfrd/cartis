const DB_NAME = 'cartis';
const DB_VERSION = 1;
const STORES = ['images', 'cards', 'exports'] as const;

export type StoreName = (typeof STORES)[number];

let connection: Promise<IDBDatabase> | undefined;

// Migration rule (permanent): never rename or repurpose a stored field — bump
// DB_VERSION and convert existing rows in the onupgradeneeded handler below.
export function openDatabase(): Promise<IDBDatabase> {
  connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      for (const store of STORES) {
        if (!request.result.objectStoreNames.contains(store)) {
          request.result.createObjectStore(store, { keyPath: 'id' });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'));
  });
  return connection;
}

function inTransaction<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  run: (objectStore: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const request = run(tx.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error(`indexedDB ${mode} failed`));
      }),
  );
}

export async function dbPut<T extends { id: string }>(store: StoreName, value: T): Promise<void> {
  await inTransaction(store, 'readwrite', (s) => s.put(value));
}

export function dbGetAll<T>(store: StoreName): Promise<T[]> {
  return inTransaction(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
}

export async function dbDelete(store: StoreName, id: string): Promise<void> {
  await inTransaction(store, 'readwrite', (s) => s.delete(id));
}

export function __resetDbForTests(): void {
  connection = undefined;
}
