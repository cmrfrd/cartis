import State from '@expressive/react';
import { Effect, Exit } from 'effect';
import { runAppExit } from '@/app/runtime';
import type { CardData } from '@/cards/types';
import { noteFromCause } from '@/contracts/errors';
import {
  CardId,
  type CardIdT,
  ExportId,
  type LayoutIdT,
  type SessionIdT,
  type ThemeIdT,
  Timestamp,
} from '@/contracts/ids';
import {
  CardRecord,
  type CardRecordT,
  type ExportFormatT,
  ExportRecord,
  type ExportRecordT,
} from '@/contracts/records';
import { StoreClient } from './StoreClient';

/**
 * Type continuity: views (BuilderView, GalleryView, ExportBar, AppShell) import
 * these names. They now alias the contract types so no view file changes.
 */
export type ExportFormat = ExportFormatT;
export type StoredCard = CardRecordT;
export type StoredExport = ExportRecordT;

export interface SaveCardInput {
  id?: CardIdT;
  name: string;
  themeId: ThemeIdT;
  layoutId: LayoutIdT;
  data: CardData;
  holo: boolean;
  /** The opencode chat session backing this card (card chat panel). */
  chatSessionId?: SessionIdT;
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
    const exit = await runAppExit(
      Effect.gen(function* () {
        const store = yield* StoreClient;
        const [cards, exports] = yield* Effect.all(
          [store.list('cards', CardRecord), store.list('exports', ExportRecord)],
          { concurrency: 'unbounded' },
        );
        const exportUrls: Record<string, string> = {};
        for (const row of exports) {
          const url = store.fileUrl('exports', row);
          if (url !== undefined) exportUrls[row.id] = url;
        }
        return { cards, exports, exportUrls };
      }),
    );
    if (this.get(null)) return; // destroyed while loading — drop the result
    if (Exit.isSuccess(exit)) {
      // load() had no note today (failures were swallowed by try/finally);
      // preserve that — no new UI messaging on failure.
      this.cards = [...exit.value.cards].sort((a, b) => b.updatedAt - a.updatedAt);
      this.exports = [...exit.value.exports].sort((a, b) => b.createdAt - a.createdAt);
      this.exportUrls = exit.value.exportUrls;
    }
    this.ready = true;
  }

  async saveCard(input: SaveCardInput): Promise<StoredCard> {
    const card: StoredCard = {
      id: input.id ?? CardId.make(crypto.randomUUID()),
      name: input.name,
      themeId: input.themeId,
      layoutId: input.layoutId,
      data: { ...input.data },
      holo: input.holo,
      updatedAt: Timestamp.make(Date.now()),
      // Omit the key entirely when absent (copies/pre-chat cards start fresh).
      ...(input.chatSessionId !== undefined ? { chatSessionId: input.chatSessionId } : {}),
    };
    const exit = await runAppExit(
      Effect.gen(function* () {
        const store = yield* StoreClient;
        yield* store.put('cards', CardRecord, card);
      }),
    );
    if (Exit.isFailure(exit)) throw new Error(noteFromCause(exit.cause));
    this.cards = [card, ...this.cards.filter((c) => c.id !== card.id)];
    return card;
  }

  async deleteCard(id: string): Promise<void> {
    const exit = await runAppExit(
      Effect.gen(function* () {
        const store = yield* StoreClient;
        yield* store.remove('cards', id);
      }),
    );
    if (Exit.isFailure(exit)) throw new Error(noteFromCause(exit.cause));
    this.cards = this.cards.filter((c) => c.id !== id);
  }

  async saveExport(input: {
    name: string;
    format: ExportFormat;
    bytes: ArrayBuffer;
    type: string;
    cardId?: CardIdT;
  }): Promise<StoredExport> {
    const { bytes, ...meta } = input;
    const record: StoredExport = {
      ...meta,
      id: ExportId.make(crypto.randomUUID()),
      createdAt: Timestamp.make(Date.now()),
    };
    const exit = await runAppExit(
      Effect.gen(function* () {
        const store = yield* StoreClient;
        const stored = yield* store.put('exports', ExportRecord, record, bytes);
        const url = store.fileUrl('exports', stored);
        return { stored, url };
      }),
    );
    if (Exit.isFailure(exit)) throw new Error(noteFromCause(exit.cause));
    const { stored, url } = exit.value;
    this.exports = [stored, ...this.exports];
    if (url !== undefined) this.exportUrls = { ...this.exportUrls, [stored.id]: url };
    return stored;
  }

  async deleteExport(id: string): Promise<void> {
    const exit = await runAppExit(
      Effect.gen(function* () {
        const store = yield* StoreClient;
        yield* store.remove('exports', id);
      }),
    );
    if (Exit.isFailure(exit)) throw new Error(noteFromCause(exit.cause));
    this.exports = this.exports.filter((e) => e.id !== id);
    const { [id]: _dropped, ...rest } = this.exportUrls;
    this.exportUrls = rest;
  }

  exportUrl(id: string): string | undefined {
    return this.exportUrls[id];
  }
}
