import { Component, get, ref } from '@expressive/react';
import { Array as Arr, Effect, Exit, Match, Option, Schema } from 'effect';
// Value import of AppShell is a deliberate module cycle (AppShell renders BuilderView).
// Safe: neither module touches the other's binding during module evaluation — only
// inside method bodies at runtime, which ESM live bindings resolve correctly.
import { AppShell } from '@/app/AppShell';
import { runAppExit } from '@/app/runtime';
import { getLayout, getTheme, listThemes } from '@/cards/registry';
import { resolveImageFields } from '@/cards/resolve';
import type { CardData, FieldValue, Layout, Theme } from '@/cards/types';
import { ThreadPanel } from '@/chat/ThreadPanel';
import { type ChatContext, ThreadState } from '@/chat/ThreadState';
import {
  AspectRatio,
  type AspectRatioT,
  ConcreteAspectRatio,
  summarizeField,
} from '@/contracts/fields';
import { type CardIdT, LayoutId, type LayoutIdT, ThemeId, type ThemeIdT } from '@/contracts/ids';
import { ExportBar } from '@/export/ExportBar';
import {
  downloadBlob,
  exportFileName,
  renderCardBlob,
  renderPreviewSnapshot,
  renderSheetBlob,
} from '@/export/exportCard';
import { dataUrlToBytes } from '@/images/codec';
import { ImageProvider } from '@/images/ImageProvider';
import type { StoredCard } from '@/storage/CardArchive';
import { Button, Panel, PreviewStage, SelectInput, TextInput } from '@/ui';
import { FormRenderer } from './FormRenderer';
import { PortraitSection } from './PortraitSection';

/** A guarded destructive intent awaiting Save-first / Discard / Cancel. */
export type PendingIntent = { kind: 'new' } | { kind: 'open'; card: StoredCard };
export type GuardResolution = 'save-first' | 'discard' | 'cancel';

export class BuilderView extends Component {
  shell = get(AppShell, false);
  /** Transient empty sentinels until new() picks the first theme (nominal brands construct freely). */
  themeId: ThemeIdT = ThemeId.make('');
  layoutId: LayoutIdT = LayoutId.make('');
  data: CardData = {};
  holo = false;
  /** Per-card art aspect override; undefined = follow `layout.artAspect ?? 'auto'`. */
  artAspect?: AspectRatioT = undefined;
  savedId?: CardIdT = undefined;
  savedNote = '';
  /** Which image field's portrait tools are open (Task 8). */
  portraitKey?: string = undefined;
  /** Preview the shared card back instead of the front (both export). */
  showBack = false;
  previewEl = ref<HTMLDivElement>();
  /** The card's chat sidebar (adopted child; pi session per card). */
  thread = new ThreadState();
  /** Chat panel width in px — session-only, drag-resizable (340–600, dbl-click 400). */
  chatWidth = 400;
  /** Modified-flag: any edit sets it; save/load/new clear it. */
  dirty = false;
  /** A guarded destructive intent awaiting the user's choice (document guard). */
  pendingIntent?: PendingIntent = undefined;

  protected new() {
    this.thread.context = () => this.chatContext();
    const first = listThemes()[0];
    if (first) {
      this.pickTheme(first.id);
      this.dirty = false; // initialization is not an edit
    }
  }

  /** The card context + appliers the chat turn edits through (spec §Decision 3). */
  private chatContext(): ChatContext {
    const theme = this.theme;
    const layout = this.layout;
    return {
      themeContext: {
        lookAndFeel: theme.lookAndFeel,
        palette: theme.artFlavor?.(this.data) ?? '',
        argumentSummary: layout.fields.map((f) => f.key).join(', '),
      },
      fields: layout.fields.map(summarizeField),
      currentData: { ...this.data },
      // Option → undefined at the wire-request seam (spec: the Option boundary rule).
      currentArtFileName: Option.getOrUndefined(this.currentArtFileName()),
      applyPatch: (patch) => {
        this.data = { ...this.data, ...patch };
        this.dirty = true;
      },
      runArt: (action, sourceDataUrl) =>
        this.runArtAction(action.brief, action.editCurrentArt, sourceDataUrl),
      markDirty: () => {
        this.dirty = true;
      },
      save: () => this.saveCard(),
      saveAsCopy: () => this.saveAsCopy(),
      exportRender: (target) => this.exportRender(target),
      // Settings knobs (routing+awareness spec §2): the agent turns the SAME
      // knobs the UI does, validated against the registry.
      setLayout: (layoutId) => {
        if (!this.theme.layouts.some((l) => l.id === layoutId)) return false;
        this.pickLayout(LayoutId.make(layoutId));
        return true;
      },
      setTheme: (themeId) => {
        if (!listThemes().some((t) => t.id === themeId)) return false;
        this.pickTheme(ThemeId.make(themeId));
        return true;
      },
      setHolo: (value) => {
        this.holo = value;
        this.dirty = true;
        return true;
      },
      setArtAspect: (value) => {
        // The tool schema already pins the closed set; decode keeps it honest.
        const decoded = Schema.decodeUnknownOption(AspectRatio)(value);
        if (Option.isNone(decoded)) return false;
        this.setArtAspect(decoded.value);
        return true;
      },
      docContext: {
        themeId: this.themeId,
        themeOptions: listThemes().map((t) => t.id),
        layoutId: this.layoutId,
        layoutOptions: theme.layouts.map((l) => l.id),
        holo: this.holo,
        artAspect: this.resolvedArtAspect(),
        aspectOptions: ['auto', ...ConcreteAspectRatio.literals],
      },
      snapshotPreview: () => this.snapshotPreview(),
    };
  }

  /** Downscaled JPEG of the live preview for agent vision (literal what-you-see). */
  async snapshotPreview(): Promise<{ mime: string; dataUrl: string } | undefined> {
    const node = this.previewEl.current;
    if (!node) return undefined;
    const exit = await runAppExit(renderPreviewSnapshot(node));
    if (this.get(null) || Exit.isFailure(exit)) return undefined;
    return { mime: 'image/jpeg', dataUrl: exit.value };
  }

  /**
   * Agent-invoked export of the current preview (chat-doc-actions spec):
   * `png` = plain 300 DPI, `print` = 600 DPI + bleed/marks, `sheet` = 3×3 A4.
   * Same delivery as ExportBar: download + archive linked to the saved card.
   */
  async exportRender(target: 'png' | 'print' | 'sheet'): Promise<boolean> {
    const node = this.previewEl.current;
    const archive = this.shell?.archive;
    if (!node || !archive) return false;
    // Snapshot reactive fields before the effect (snapshot rule).
    const cardName = String(this.data.name ?? 'Untitled');
    const cardId = this.savedId;
    const render =
      target === 'sheet'
        ? renderSheetBlob(node)
        : renderCardBlob(node, 'png', {
            dpi: target === 'print' ? 600 : 300,
            bleed: target === 'print',
          });
    const exit = await runAppExit(render);
    if (this.get(null) || Exit.isFailure(exit)) return false;
    const blob = exit.value;
    const suffix = target === 'sheet' ? '-sheet' : target === 'print' ? '-600dpi-bleed' : '';
    const fileName = exportFileName(cardName + suffix, 'png');
    try {
      downloadBlob(blob, fileName);
      await archive.saveExport({
        name: fileName,
        format: 'png',
        bytes: await blob.arrayBuffer(),
        type: blob.type,
        cardId,
      });
      return true;
    } catch {
      return false;
    }
  }

  mount() {
    const { shell } = this;
    if (!shell) return;
    const consumePending = () => {
      const card = shell.pendingCard;
      if (card) {
        shell.pendingCard = undefined;
        this.requestOpen(card); // dirty documents get the guard, clean ones load
      }
    };
    consumePending(); // a card may already be waiting when the builder mounts
    return shell.set('pendingCard', consumePending);
  }

  get theme(): Theme {
    return getTheme(this.themeId);
  }

  get layout(): Layout {
    return getLayout(this.themeId, this.layoutId);
  }

  /** Card data with image-library references resolved to displayable URLs (tracks library.urls transitively). */
  get resolved(): CardData {
    // THE shared resolution (src/cards/resolve.ts) — identical to the gallery
    // tile by construction. Reads library.urls transitively (tracked).
    return resolveImageFields(this.data, this.layout, this.shell?.library.urls ?? {});
  }

  setField(key: string, value: FieldValue) {
    this.data = { ...this.data, [key]: value };
    this.dirty = true;
  }

  toggleHolo() {
    this.holo = !this.holo;
    this.dirty = true;
  }

  /**
   * The aspect art generation uses: card override → layout preference → auto.
   * A METHOD, not a `get` computed: expressive memoizes getters against the
   * deps of their first run, and `artAspect` starts undefined — the `??`
   * short-circuit makes the dep set unstable and the cache goes stale
   * (live-caught in tests, 2026-08-04).
   */
  resolvedArtAspect(): AspectRatioT {
    return this.artAspect ?? this.layout.artAspect ?? 'auto';
  }

  setArtAspect(value: AspectRatioT) {
    this.artAspect = value;
    this.dirty = true;
  }

  /** Switching theme EDITS the open document (lifecycle spec decision 4):
   *  identity kept, overlapping argument values preserved, dirty marked. */
  pickTheme(id: ThemeIdT) {
    // Non-emptiness is a type-level fact — no `first?` dance (spec §4).
    const first = Arr.headNonEmpty(getTheme(id).layouts);
    const keptKeys = new Set(first.fields.map((f) => f.key));
    const preserved: CardData = {};
    for (const [key, value] of Object.entries(this.data)) {
      if (keptKeys.has(key)) preserved[key] = value;
    }
    this.themeId = id;
    this.layoutId = first.id;
    this.data = { ...first.defaults, ...preserved };
    this.dirty = true;
    // The chat session belongs to the card, not the theme — it persists here.
  }

  /** Switching layouts is lossless for shared argument keys — user data wins over defaults. */
  pickLayout(id: LayoutIdT) {
    const next = getLayout(this.themeId, id);
    const keptKeys = new Set(next.fields.map((f) => f.key));
    const preserved: CardData = {};
    for (const [key, value] of Object.entries(this.data)) {
      if (keptKeys.has(key)) preserved[key] = value;
    }
    // Seed defaults only for keys the user has no value for (keeps user data).
    this.data = { ...next.defaults, ...preserved };
    this.layoutId = next.id;
    this.dirty = true;
  }

  loadCard(card: StoredCard) {
    this.themeId = card.themeId;
    this.layoutId = card.layoutId;
    this.data = { ...card.data };
    this.holo = card.holo;
    this.artAspect = card.artAspect;
    this.savedId = card.id;
    if (this.shell) this.shell.openCardId = card.id;
    this.savedNote = '';
    this.dirty = false;
    // Reset the previous card's thread state (messages/note/attachments),
    // then rehydrate this card's conversation, or start fresh.
    this.thread.clear();
    if (card.chatSessionId !== undefined) this.thread.bind(card.chatSessionId);
  }

  /** Unguarded executor: blank card in the CURRENT theme + layout. */
  newCard() {
    const layout = this.layout;
    this.data = { ...layout.defaults };
    this.holo = false;
    this.artAspect = undefined;
    this.savedId = undefined;
    if (this.shell) this.shell.openCardId = undefined;
    this.savedNote = '';
    this.dirty = false;
    this.portraitKey = undefined;
    this.thread.clear();
  }

  requestNew() {
    if (!this.dirty) {
      this.newCard();
      return;
    }
    this.pendingIntent = { kind: 'new' };
  }

  requestOpen(card: StoredCard) {
    if (!this.dirty) {
      this.loadCard(card);
      return;
    }
    this.pendingIntent = { kind: 'open', card };
  }

  private executeIntent(intent: PendingIntent) {
    // Match.exhaustive (spec §Match): a new intent kind fails tsc here.
    Match.value(intent).pipe(
      Match.discriminators('kind')({
        new: () => this.newCard(),
        open: (i) => this.loadCard(i.card),
      }),
      Match.exhaustive,
    );
  }

  async resolveIntent(resolution: GuardResolution) {
    const intent = this.pendingIntent;
    this.pendingIntent = undefined;
    if (!intent || resolution === 'cancel') return;
    if (resolution === 'save-first') {
      await this.saveCard();
      // A failed save cancels the intent and shows the error (spec: dirty guard).
      if (this.dirty || this.savedId === undefined) return;
    }
    this.executeIntent(intent);
  }

  /** Fork the open card into a fresh record and rebind the document to it. */
  async saveAsCopy(): Promise<boolean> {
    const { shell } = this;
    if (!shell) {
      this.savedNote = 'Storage unavailable.';
      return false;
    }
    const name = `${String(this.data.name ?? 'Untitled')} copy`;
    try {
      const saved = await shell.archive.saveCard({
        name,
        themeId: this.themeId,
        layoutId: this.layoutId,
        data: { ...this.data, name },
        holo: this.holo,
        artAspect: this.artAspect,
      });
      this.data = { ...this.data, name };
      this.savedId = saved.id;
      shell.openCardId = saved.id;
      this.savedNote = `Saved “${saved.name}” to the gallery.`;
      this.dirty = false;
      return true;
    } catch (cause) {
      this.savedNote = cause instanceof Error ? cause.message : String(cause);
      return false;
    }
  }

  /** The layout's single image argument (the art slot) — pure Option helper (spec §3). */
  private artKeyOption(): Option.Option<string> {
    return Option.fromNullable(this.layout.fields.find((f) => f.kind === 'image')?.key);
  }

  /** The stored fileName of the card's current art (for vision + edit sourcing). */
  private currentArtFileName(): Option.Option<string> {
    return this.artKeyOption().pipe(
      Option.flatMap((key) => {
        const artId = this.data[key];
        return typeof artId === 'string' && artId.length > 0 ? Option.some(artId) : Option.none();
      }),
      Option.flatMap((artId) =>
        Option.fromNullable(this.shell?.library.images.find((i) => i.id === artId)?.fileName),
      ),
    );
  }

  /**
   * Run the art pipeline for a chat turn's artAction (spec decision 7). Progress
   * streams into the chat as Art events; success updates the art slot. Called by
   * ThreadState via the injected chat context. `sourceDataUrl` = the turn's
   * attached photo — decoded into the generation's img2img source so the art
   * keeps the subject's identity (vision alone loses it, live-caught).
   */
  async runArtAction(brief: string, editCurrentArt: boolean, sourceDataUrl?: string) {
    const library = this.shell?.library;
    const artKey = Option.getOrUndefined(this.artKeyOption());
    if (!library || artKey === undefined) return; // no art slot or library — nothing to do
    // Snapshot before the effect.
    const theme = this.theme;
    const layout = this.layout;
    const data = this.data;
    const argumentValues: Record<string, string> = {};
    for (const field of layout.fields) {
      if (field.kind === 'image') continue;
      const v = data[field.key];
      if (v !== undefined && v !== '') argumentValues[field.key] = String(v);
    }
    const currentArtFileName = Option.getOrUndefined(this.currentArtFileName());
    // A malformed data URL must not kill the run — fall back to text-first.
    let source: { bytes: ArrayBuffer; type: string } | undefined;
    if (sourceDataUrl !== undefined) {
      try {
        source = dataUrlToBytes(sourceDataUrl);
      } catch {
        source = undefined;
      }
    }
    const exit = await runAppExit(
      Effect.flatMap(ImageProvider, (p) =>
        p.generate({
          sourceBytes: source?.bytes ?? new ArrayBuffer(0),
          sourceType: source?.type ?? 'application/octet-stream',
          prompt: theme.lookAndFeel,
          styleId: this.themeId,
          aspectRatio: this.resolvedArtAspect(),
          themeContext: {
            lookAndFeel: theme.lookAndFeel,
            palette: theme.artFlavor?.(data) ?? '',
            argumentSummary: layout.fields
              .filter((f) => f.kind !== 'image')
              .map((f) => f.key)
              .join(', '),
          },
          argumentValues,
          brief,
          editCurrentArt: editCurrentArt && currentArtFileName !== undefined,
          currentArtFileName,
        }),
      ),
    );
    if (Exit.isFailure(exit)) return; // the Art 'error' event surfaces it in chat
    const out = exit.value;
    const stored = await library.add({
      name: `${String(this.data.name ?? 'card')} art`,
      kind: 'generated',
      prompt: brief,
      styleId: this.themeId,
      bytes: out.bytes,
      type: out.type,
    });
    this.setField(artKey, stored.id);
  }

  /** Returns success — the agent's 'save' doc action needs the verdict. */
  async saveCard(): Promise<boolean> {
    const { shell } = this;
    if (!shell) {
      this.savedNote = 'Storage unavailable.';
      return false;
    }
    try {
      const saved = await shell.archive.saveCard({
        id: this.savedId,
        name: String(this.data.name ?? 'Untitled'),
        themeId: this.themeId,
        layoutId: this.layoutId,
        data: this.data,
        holo: this.holo,
        artAspect: this.artAspect,
        // Persist the card→session pointer once a conversation exists (lazy).
        chatSessionId: this.thread.sessionId,
      });
      this.savedId = saved.id;
      shell.openCardId = saved.id;
      this.savedNote = `Saved “${saved.name}” to the gallery.`;
      this.dirty = false;
      return true;
    } catch (cause) {
      this.savedNote = cause instanceof Error ? cause.message : String(cause);
      return false;
    }
  }

  render() {
    return (
      <div className="flex h-full">
        <BuilderForm />
        <BuilderPreview />
        <ThreadPanel />
      </div>
    );
  }
}

/** Implementation scoping per the skills: freestanding function components + .get(),
 *  NOT subcomponent methods (those are reserved for extension points like ArcaneCard's). */
function DocumentBar() {
  const { is: builder, data, savedId, dirty, savedNote, pendingIntent } = BuilderView.get();
  const title = String(data.name ?? '').trim() || 'Untitled card';
  return (
    <Panel title="Card">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <TextInput
              value={String(data.name ?? '')}
              onValue={(v) => builder.setField('name', v)}
              placeholder="Untitled card"
            />
          </div>
          <span className="shrink-0 text-[11px] text-ink-dim">
            {dirty ? '● Unsaved changes' : savedId ? 'Saved' : 'New card'}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button tone="ghost" onClick={() => builder.requestNew()}>
            New
          </Button>
          <Button onClick={() => void builder.saveCard()}>Save</Button>
          <Button tone="ghost" onClick={() => void builder.saveAsCopy()}>
            Save as copy
          </Button>
        </div>
        {savedNote && <p className="text-xs text-ink-dim">{savedNote}</p>}
        {pendingIntent && <GuardConfirm title={title} />}
      </div>
    </Panel>
  );
}

/** Inline Save-first / Discard / Cancel choice for a guarded destructive intent. */
function GuardConfirm(props: { title: string }) {
  const { is: builder } = BuilderView.get();
  return (
    <div className="flex flex-col gap-2 rounded-base border-2 border-border bg-secondary-background p-2">
      <p className="text-xs">Unsaved changes on “{props.title}”</p>
      <div className="flex gap-1.5">
        <Button onClick={() => void builder.resolveIntent('save-first')}>Save first</Button>
        <Button tone="ghost" onClick={() => void builder.resolveIntent('discard')}>
          Discard
        </Button>
        <Button tone="ghost" onClick={() => void builder.resolveIntent('cancel')}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function BuilderForm() {
  const { is: builder, theme, layout, themeId, layoutId, portraitKey } = BuilderView.get();
  return (
    <aside className="flex w-96 shrink-0 flex-col gap-4 overflow-y-auto border-r border-edge p-4">
      <DocumentBar />
      <Panel title="Theme">
        <SelectInput
          value={themeId}
          onValue={(id) => builder.pickTheme(ThemeId.make(id))}
          options={listThemes().map((t) => ({ value: t.id, label: t.name }))}
        />
        <p className="mt-2 text-xs text-ink-dim">{theme.description}</p>
      </Panel>
      <Panel title="Layout">
        <SelectInput
          value={layoutId}
          onValue={(id) => builder.pickLayout(LayoutId.make(id))}
          options={theme.layouts.map((l) => ({ value: l.id, label: l.name }))}
        />
        <p className="mt-2 text-xs text-ink-dim">{layout.description}</p>
      </Panel>
      <Panel title="Details">
        <FormRenderer />
      </Panel>
      {portraitKey && <PortraitSection fieldKey={portraitKey} />}
    </aside>
  );
}

export function PortraitSlot(props: { fieldKey: string }) {
  const { is: builder, data, portraitKey, shell } = BuilderView.get();
  const current = data[props.fieldKey];
  const url = shell?.library.urls?.[typeof current === 'string' ? current : ''];
  const open = portraitKey === props.fieldKey;
  return (
    <div className="flex items-center gap-3">
      {url ? (
        <img src={url} alt="portrait" className="h-14 w-14 rounded object-cover" />
      ) : (
        <div className="flex h-14 w-14 items-center justify-center rounded bg-surface text-ink-dim">
          ✶
        </div>
      )}
      <Button
        tone="ghost"
        onClick={() => {
          builder.portraitKey = open ? undefined : props.fieldKey;
        }}
      >
        {open ? 'Close portrait tools' : 'Portrait tools'}
      </Button>
    </div>
  );
}

function BuilderPreview() {
  const {
    is: builder,
    theme,
    layout,
    resolved,
    holo,
    data,
    previewEl,
    showBack,
    savedId,
  } = BuilderView.get();
  const Render = layout.Render;
  const CardBack = theme.CardBack;
  return (
    <section className="flex min-w-0 flex-1 items-center justify-center overflow-auto p-6">
      <div className="flex flex-col items-center gap-4">
        <PreviewStage>
          <div ref={previewEl}>
            {showBack ? <CardBack holo={holo} /> : <Render data={resolved} holo={holo} />}
          </div>
        </PreviewStage>
        <div className="flex items-center gap-3">
          <Button tone="ghost" onClick={() => builder.toggleHolo()}>
            {holo ? 'Holo: on' : 'Holo: off'}
          </Button>
          <Button
            tone="ghost"
            onClick={() => {
              builder.showBack = !builder.showBack;
            }}
          >
            {showBack ? 'Show front' : 'Show back'}
          </Button>
        </div>
        <ExportBar
          cardName={showBack ? 'cartis-card-back' : String(data.name ?? 'card')}
          cardId={showBack ? undefined : savedId}
          target={previewEl}
        />
      </div>
    </section>
  );
}
