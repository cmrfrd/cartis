import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

/**
 * File-backed persistence under ./cartis-data — real files the user can
 * browse, copy, and back up. Binary records (images, exports) are stored as
 * <slug>-<id6>.<ext> with a .json metadata sidecar; cards are plain .json.
 */

export type StoreName = 'images' | 'cards' | 'exports';

export interface StoredRecord {
  id: string;
  name?: string;
  type?: string;
  [key: string]: unknown;
}

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

function slugOf(name: string | undefined): string {
  const slug = (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug.length > 0 ? slug : 'untitled';
}

/** Stable, human-readable, unique on-disk name. */
export function fileNameFor(record: { id: string; name?: string; type?: string }): string {
  const ext = EXT_BY_TYPE[record.type ?? 'application/json'] ?? 'bin';
  return `${slugOf(record.name)}-${record.id.slice(0, 6)}.${ext}`;
}

function sidecarName(record: { id: string; name?: string }): string {
  return `${slugOf(record.name)}-${record.id.slice(0, 6)}.json`;
}

async function storeDir(root: string, store: StoreName): Promise<string> {
  const dir = join(root, store);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function filesFor(root: string, store: StoreName, id: string): Promise<string[]> {
  const dir = await storeDir(root, store);
  const suffix = `-${id.slice(0, 6)}`;
  const names = await readdir(dir);
  return names.filter((n) => {
    const stem = n.replace(/\.[a-z0-9]+$/, '');
    return stem.endsWith(suffix);
  });
}

export async function putRecord(
  root: string,
  store: StoreName,
  record: StoredRecord,
  bytesBase64?: string,
): Promise<StoredRecord & { fileName?: string }> {
  // upsert: clear any previous files for this id (name may have changed)
  await deleteRecord(root, store, record.id);
  const dir = await storeDir(root, store);
  const isBinary = typeof bytesBase64 === 'string' && record.type !== 'application/json';
  const fileName = isBinary ? fileNameFor(record) : undefined;
  const meta = { ...record, ...(fileName ? { fileName } : {}) };
  if (isBinary && fileName) {
    await writeFile(join(dir, fileName), Buffer.from(bytesBase64, 'base64'));
  }
  await writeFile(join(dir, sidecarName(record)), `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

export async function listRecords(root: string, store: StoreName): Promise<StoredRecord[]> {
  const dir = await storeDir(root, store);
  const names = (await readdir(dir)).filter((n) => n.endsWith('.json'));
  const records: StoredRecord[] = [];
  for (const name of names) {
    try {
      records.push(JSON.parse(await readFile(join(dir, name), 'utf8')) as StoredRecord);
    } catch {
      // unreadable sidecar (hand-edited?) — skip rather than break the app
    }
  }
  return records;
}

export async function deleteRecord(root: string, store: StoreName, id: string): Promise<void> {
  const dir = await storeDir(root, store);
  for (const name of await filesFor(root, store, id)) {
    await rm(join(dir, name), { force: true });
  }
}

export async function readStoredFile(
  root: string,
  store: StoreName,
  fileName: string,
): Promise<{ bytes: Buffer; type: string } | undefined> {
  if (fileName !== basename(fileName)) return undefined; // traversal guard
  try {
    const bytes = await readFile(join(await storeDir(root, store), fileName));
    const ext = fileName.split('.').pop() ?? '';
    return { bytes, type: TYPE_BY_EXT[ext] ?? 'application/octet-stream' };
  } catch {
    return undefined;
  }
}
