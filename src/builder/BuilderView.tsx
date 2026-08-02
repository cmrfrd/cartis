import { Component, get, ref } from '@expressive/react';
// Value import of AppShell is a deliberate module cycle (AppShell renders BuilderView).
// Safe: neither module touches the other's binding during module evaluation — only
// inside method bodies at runtime, which ESM live bindings resolve correctly.
import { AppShell } from '../app/AppShell';
import { getLayout, getTheme, listThemes } from '../cards/registry';
import type { CardData, FieldValue, Layout, Theme } from '../cards/types';
import { ExportBar } from '../export/ExportBar';
import type { StoredCard } from '../storage/CardArchive';
import { Button, Panel, PreviewStage, SelectInput } from '../ui';
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
  }

  loadCard(card: StoredCard) {
    this.themeId = card.themeId;
    this.layoutId = card.layoutId;
    this.data = { ...card.data };
    this.holo = card.holo;
    this.savedId = card.id;
    this.savedNote = '';
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
