import State from '@expressive/react';
import type { CardData } from '../cards/types';
import { dbDelete, dbGetAll, dbPut } from './db';
import { safeObjectUrl } from './ImageLibrary';

export type ExportFormat = 'png' | 'jpeg' | 'webp';

export interface StoredCard {
  id: string;
  name: string;
  templateId: string;
  data: CardData;
  holo: boolean;
  updatedAt: number;
}

export interface StoredExport {
  id: string;
  name: string;
  format: ExportFormat;
  bytes: ArrayBuffer;
  type: string;
  createdAt: number;
}

export interface SaveCardInput {
  id?: string;
  name: string;
  templateId: string;
  data: CardData;
  holo: boolean;
}

export class CardArchive extends State {
  cards: StoredCard[] = [];
  exports: StoredExport[] = [];
  exportUrls: Record<string, string> = {};
  ready = false;

  protected new() {
    void this.load();
  }

  private async load(): Promise<void> {
    const [cards, exports] = await Promise.all([
      dbGetAll<StoredCard>('cards'),
      dbGetAll<StoredExport>('exports'),
    ]);
    if (this.get(null)) return; // destroyed while loading — drop the result
    cards.sort((a, b) => b.updatedAt - a.updatedAt);
    exports.sort((a, b) => b.createdAt - a.createdAt);
    const exportUrls: Record<string, string> = {};
    for (const row of exports) {
      const url = safeObjectUrl(row.bytes, row.type);
      if (url) exportUrls[row.id] = url;
    }
    this.cards = cards;
    this.exports = exports;
    this.exportUrls = exportUrls;
    this.ready = true;
  }

  async saveCard(input: SaveCardInput): Promise<StoredCard> {
    const card: StoredCard = {
      id: input.id ?? crypto.randomUUID(),
      name: input.name,
      templateId: input.templateId,
      data: { ...input.data },
      holo: input.holo,
      updatedAt: Date.now(),
    };
    await dbPut('cards', card);
    this.cards = [card, ...this.cards.filter((c) => c.id !== card.id)];
    return card;
  }

  async deleteCard(id: string): Promise<void> {
    await dbDelete('cards', id);
    this.cards = this.cards.filter((c) => c.id !== id);
  }

  async saveExport(input: {
    name: string;
    format: ExportFormat;
    bytes: ArrayBuffer;
    type: string;
  }): Promise<StoredExport> {
    const record: StoredExport = { ...input, id: crypto.randomUUID(), createdAt: Date.now() };
    await dbPut('exports', record);
    this.exports = [record, ...this.exports];
    const url = safeObjectUrl(record.bytes, record.type);
    if (url) this.exportUrls = { ...this.exportUrls, [record.id]: url };
    return record;
  }

  async deleteExport(id: string): Promise<void> {
    await dbDelete('exports', id);
    this.exports = this.exports.filter((e) => e.id !== id);
    const { [id]: _dropped, ...rest } = this.exportUrls;
    this.exportUrls = rest;
  }

  exportUrl(id: string): string | undefined {
    return this.exportUrls[id];
  }
}
