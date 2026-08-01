import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { deleteRecord, fileNameFor, listRecords, putRecord, readStoredFile } from './fileStore';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cartis-store-'));
});

const bytes = (text: string) => Buffer.from(text).toString('base64');

describe('fileNameFor', () => {
  it('slugs the name and keeps a short id suffix for uniqueness', () => {
    expect(fileNameFor({ id: 'abcdef123456', name: 'Ember Knight!', type: 'image/png' })).toBe(
      'ember-knight-abcdef.png',
    );
    expect(fileNameFor({ id: 'abcdef123456', name: '  ', type: 'image/jpeg' })).toBe(
      'untitled-abcdef.jpg',
    );
    expect(fileNameFor({ id: 'x'.repeat(12), name: 'a/b\\c..d', type: 'application/json' })).toBe(
      'a-b-c-d-xxxxxx.json',
    );
  });
});

describe('file store', () => {
  it('puts, lists, and deletes binary records with metadata sidecars', async () => {
    const record = {
      id: 'img-123456789',
      name: 'Storm Mage',
      kind: 'generated',
      prompt: 'a storm mage',
      type: 'image/png',
      createdAt: 111,
    };
    const stored = await putRecord(dir, 'images', record, bytes('fake-png'));
    expect(stored.fileName).toBe('storm-mage-img-12.png');

    const files = await readdir(join(dir, 'images'));
    expect(files.sort()).toEqual(['storm-mage-img-12.json', 'storm-mage-img-12.png']);
    expect((await readFile(join(dir, 'images', 'storm-mage-img-12.png'))).toString()).toBe(
      'fake-png',
    );

    const listed = await listRecords(dir, 'images');
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: 'img-123456789', name: 'Storm Mage', kind: 'generated' });

    const file = await readStoredFile(dir, 'images', 'storm-mage-img-12.png');
    expect(file?.type).toBe('image/png');

    await deleteRecord(dir, 'images', 'img-123456789');
    expect(await listRecords(dir, 'images')).toHaveLength(0);
    expect(await readdir(join(dir, 'images'))).toHaveLength(0);
  });

  it('stores pure-JSON records (cards) without a binary file', async () => {
    const card = {
      id: 'card-1234567',
      name: 'Nyra',
      templateId: 'arcane-hero',
      data: { name: 'Nyra' },
      holo: true,
      updatedAt: 5,
    };
    await putRecord(dir, 'cards', card);
    const files = await readdir(join(dir, 'cards'));
    expect(files).toEqual(['nyra-card-1.json']);
    const listed = await listRecords(dir, 'cards');
    expect(listed[0]).toMatchObject({ name: 'Nyra', holo: true });
  });

  it('upserts by id: re-putting replaces the old files even when renamed', async () => {
    const v1 = { id: 'card-1234567', name: 'Old Name', updatedAt: 1 };
    await putRecord(dir, 'cards', v1);
    await putRecord(dir, 'cards', { ...v1, name: 'New Name', updatedAt: 2 });
    const files = await readdir(join(dir, 'cards'));
    expect(files).toEqual(['new-name-card-1.json']);
    const listed = await listRecords(dir, 'cards');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe('New Name');
  });

  it('rejects traversal attempts in stored file reads', async () => {
    await expect(readStoredFile(dir, 'images', '../../etc/passwd')).resolves.toBeUndefined();
  });

  it('returns empty lists for missing stores', async () => {
    expect(await listRecords(dir, 'images')).toEqual([]);
  });
});
