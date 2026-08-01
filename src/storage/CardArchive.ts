import State from '@expressive/react';
import type { CardData } from '../cards/types';
import { storeClient } from './storeClient';

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
  type: string;
  createdAt: number;
  fileName?: string;
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
    try {
      const [cards, exports] = await Promise.all([
        storeClient().list<StoredCard>('cards'),
        storeClient().list<StoredExport>('exports'),
      ]);
      if (this.get(null)) return; // destroyed while loading — drop the result
      cards.sort((a, b) => b.updatedAt - a.updatedAt);
      exports.sort((a, b) => b.createdAt - a.createdAt);
      const exportUrls: Record<string, string> = {};
      for (const row of exports) {
        const url = storeClient().fileUrl('exports', row);
        if (url) exportUrls[row.id] = url;
      }
      this.cards = cards;
      this.exports = exports;
      this.exportUrls = exportUrls;
    } finally {
      if (!this.get(null)) this.ready = true;
    }
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
    await storeClient().put('cards', card);
    this.cards = [card, ...this.cards.filter((c) => c.id !== card.id)];
    return card;
  }

  async deleteCard(id: string): Promise<void> {
    await storeClient().remove('cards', id);
    this.cards = this.cards.filter((c) => c.id !== id);
  }

  async saveExport(input: {
    name: string;
    format: ExportFormat;
    bytes: ArrayBuffer;
    type: string;
  }): Promise<StoredExport> {
    const { bytes, ...meta } = input;
    const record: StoredExport = { ...meta, id: crypto.randomUUID(), createdAt: Date.now() };
    const stored = await storeClient().put('exports', record, bytes);
    this.exports = [stored, ...this.exports];
    const url = storeClient().fileUrl('exports', stored);
    if (url) this.exportUrls = { ...this.exportUrls, [stored.id]: url };
    return stored;
  }

  async deleteExport(id: string): Promise<void> {
    await storeClient().remove('exports', id);
    this.exports = this.exports.filter((e) => e.id !== id);
    const { [id]: _dropped, ...rest } = this.exportUrls;
    this.exportUrls = rest;
  }

  exportUrl(id: string): string | undefined {
    return this.exportUrls[id];
  }
}
