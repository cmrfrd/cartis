import { Component, get, ref } from '@expressive/react';
import { Effect, Exit } from 'effect';
// Value import of AppShell is a deliberate module cycle (AppShell renders BuilderView).
// Safe: neither module touches the other's binding during module evaluation — only
// inside method bodies at runtime, which ESM live bindings resolve correctly.
import { AppShell } from '../app/AppShell';
import { runAppExit } from '../app/runtime';
import { getLayout, getTheme, listThemes } from '../cards/registry';
import type { CardData, FieldValue, Layout, Theme } from '../cards/types';
import { noteFromCause } from '../contracts/errors';
import { ExportBar } from '../export/ExportBar';
import { ImageProvider } from '../images/ImageProvider';
import type { StoredCard } from '../storage/CardArchive';
import { Button, Panel, PreviewStage, SelectInput, TextAreaInput } from '../ui';
import { AgentFill } from './AgentFill';
import { FormRenderer } from './FormRenderer';
import { PortraitSection } from './PortraitSection';

export class BuilderView extends Component {
  shell = get(AppShell, false);
  themeId = '';
  layoutId = '';
  data: CardData = {};
  holo = false;
  savedId?: string = undefined;
  savedNote = '';
  /** Which image field's portrait tools are open (Task 8). */
  portraitKey?: string = undefined;
  /** Preview the shared card back instead of the front (both export). */
  showBack = false;
  previewEl = ref<HTMLDivElement>();
  /** Conversational fill: one opencode session per card-editing episode. */
  fillSessionId?: string = undefined;
  aiPrompt = '';
  aiBusy = false;
  aiNote = '';

  protected new() {
    const first = listThemes()[0];
    if (first) this.pickTheme(first.id);
  }

  mount() {
    const { shell } = this;
    if (!shell) return;
    const consumePending = () => {
      const card = shell.pendingCard;
      if (card) {
        this.loadCard(card);
        shell.pendingCard = undefined;
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
    const urls = this.shell?.library.urls ?? {};
    const out: CardData = { ...this.data };
    for (const field of this.layout.fields) {
      if (field.kind !== 'image') continue;
      const raw = out[field.key];
      const id = typeof raw === 'string' ? raw : '';
      out[field.key] =
        urls[id] ?? (id.startsWith('blob:') || id.startsWith('data:') ? id : undefined);
    }
    return out;
  }

  setField(key: string, value: FieldValue) {
    this.data = { ...this.data, [key]: value };
  }

  /** Selecting a theme starts a fresh card: first layout, its defaults. */
  pickTheme(id: string) {
    this.themeId = id;
    const first = getTheme(id).layouts[0];
    this.layoutId = first?.id ?? '';
    this.data = first ? { ...first.defaults } : {};
    this.savedId = undefined;
    this.savedNote = '';
    this.fillSessionId = undefined; // new episode (spec decision 6)
  }

  /** Switching layouts is lossless for shared argument keys — user data wins over defaults. */
  pickLayout(id: string) {
    const next = getLayout(this.themeId, id);
    const keptKeys = new Set(next.fields.map((f) => f.key));
    const preserved: CardData = {};
    for (const [key, value] of Object.entries(this.data)) {
      if (keptKeys.has(key)) preserved[key] = value;
    }
    // Seed defaults only for keys the user has no value for (keeps user data).
    this.data = { ...next.defaults, ...preserved };
    this.layoutId = id;
    this.fillSessionId = undefined; // new episode (spec decision 6)
  }

  loadCard(card: StoredCard) {
    this.themeId = card.themeId;
    this.layoutId = card.layoutId;
    this.data = { ...card.data };
    this.holo = card.holo;
    this.savedId = card.id;
    this.savedNote = '';
    this.fillSessionId = undefined; // new episode (spec decision 6)
  }

  /** The layout's single image argument (the art slot), if it has one. */
  get artKey(): string | undefined {
    return this.layout.fields.find((f) => f.kind === 'image')?.key;
  }

  /** The stored fileName of the card's current art (for vision + edit sourcing). */
  private currentArtFileName(): string | undefined {
    const artKey = this.artKey;
    if (!artKey) return undefined;
    const artId = this.data[artKey];
    if (typeof artId !== 'string' || artId.length === 0) return undefined;
    return this.shell?.library.images.find((i) => i.id === artId)?.fileName;
  }

  /** One conversational fill turn (spec decisions 6, 7, 10). */
  async fillWithAI() {
    if (this.aiBusy || this.aiPrompt.trim().length === 0) return;
    // Snapshot reactive fields before building the effect (snapshot rule).
    const userPrompt = this.aiPrompt.trim();
    const sessionId = this.fillSessionId;
    const currentData = { ...this.data };
    const theme = this.theme;
    const layout = this.layout;
    const currentArtFileName = this.currentArtFileName();
    const request = {
      sessionId,
      themeContext: {
        lookAndFeel: theme.lookAndFeel,
        palette: theme.artFlavor?.(currentData) ?? '',
        argumentSummary: layout.fields.map((f) => f.key).join(', '),
      },
      fields: layout.fields.map((f) => ({ kind: f.kind, key: f.key, label: f.label })),
      currentData,
      currentArtFileName,
      userPrompt,
    };
    this.aiBusy = true;
    this.aiNote = 'Asking the assistant…';
    try {
      const exit = await runAppExit(Effect.flatMap(AgentFill, (a) => a.fill(request)));
      if (Exit.isFailure(exit)) {
        this.aiNote = noteFromCause(exit.cause);
        return;
      }
      const out = exit.value;
      this.fillSessionId = out.sessionId;
      // Targeted merge — only the returned keys change (spec decision 10).
      this.data = { ...this.data, ...out.patch };
      this.aiPrompt = '';
      if (out.artAction) {
        this.aiNote = 'Applied — generating art…';
        await this.generateFromArtAction(out.artAction.brief, out.artAction.editCurrentArt);
      } else {
        this.aiNote = 'Applied.';
      }
    } finally {
      this.aiBusy = false;
    }
  }

  /** Auto-run of the art pipeline from a fill turn's artAction (spec decision 7). */
  private async generateFromArtAction(brief: string, editCurrentArt: boolean) {
    const library = this.shell?.library;
    const artKey = this.artKey;
    if (!library || !artKey) {
      this.aiNote = 'Applied (art skipped — no art slot or library).';
      return;
    }
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
    const currentArtFileName = this.currentArtFileName();
    const exit = await runAppExit(
      Effect.flatMap(ImageProvider, (p) =>
        p.generate({
          sourceBytes: new ArrayBuffer(0),
          sourceType: 'application/octet-stream',
          prompt: theme.lookAndFeel,
          styleId: this.themeId,
          aspectRatio: layout.artAspect ?? 'match_input_image',
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
    if (Exit.isFailure(exit)) {
      this.aiNote = noteFromCause(exit.cause);
      return;
    }
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
    this.aiNote = `Applied — art generated (via ${out.via}).`;
  }

  async saveCard() {
    const { shell } = this;
    if (!shell) {
      this.savedNote = 'Storage unavailable.';
      return;
    }
    const saved = await shell.archive.saveCard({
      id: this.savedId,
      name: String(this.data.name ?? 'Untitled'),
      themeId: this.themeId,
      layoutId: this.layoutId,
      data: this.data,
      holo: this.holo,
    });
    this.savedId = saved.id;
    this.savedNote = `Saved “${saved.name}” to the gallery.`;
  }

  render() {
    return (
      <div className="flex h-full">
        <BuilderForm />
        <BuilderPreview />
      </div>
    );
  }
}

/** Implementation scoping per the skills: freestanding function components + .get(),
 *  NOT subcomponent methods (those are reserved for extension points like ArcaneCard's). */
function BuilderForm() {
  const {
    is: builder,
    theme,
    layout,
    themeId,
    layoutId,
    savedNote,
    portraitKey,
    aiPrompt,
    aiBusy,
    aiNote,
  } = BuilderView.get();
  return (
    <aside className="flex w-96 shrink-0 flex-col gap-4 overflow-y-auto border-r border-edge p-4">
      <Panel title="Theme">
        <SelectInput
          value={themeId}
          onValue={(id) => builder.pickTheme(id)}
          options={listThemes().map((t) => ({ value: t.id, label: t.name }))}
        />
        <p className="mt-2 text-xs text-ink-dim">{theme.description}</p>
      </Panel>
      <Panel title="Layout">
        <SelectInput
          value={layoutId}
          onValue={(id) => builder.pickLayout(id)}
          options={theme.layouts.map((l) => ({ value: l.id, label: l.name }))}
        />
        <p className="mt-2 text-xs text-ink-dim">{layout.description}</p>
      </Panel>
      <Panel title="AI assistant">
        <div className="flex flex-col gap-2">
          <TextAreaInput
            value={aiPrompt}
            onValue={(v) => {
              builder.aiPrompt = v;
            }}
            rows={2}
            placeholder="a fire mage with a phoenix companion…"
          />
          <div className="flex items-center gap-3">
            <Button disabled={aiBusy} onClick={() => void builder.fillWithAI()}>
              {aiBusy ? 'Thinking…' : 'Fill with AI'}
            </Button>
            {aiNote && <span className="text-xs text-ink-dim">{aiNote}</span>}
          </div>
        </div>
      </Panel>
      <Panel title="Details">
        <FormRenderer />
      </Panel>
      {portraitKey && <PortraitSection fieldKey={portraitKey} />}
      <div className="flex items-center gap-3">
        <Button onClick={() => void builder.saveCard()}>Save to gallery</Button>
        {savedNote && <span className="text-xs text-ink-dim">{savedNote}</span>}
      </div>
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
          <Button
            tone="ghost"
            onClick={() => {
              builder.holo = !builder.holo;
            }}
          >
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
          target={previewEl}
        />
      </div>
    </section>
  );
}
