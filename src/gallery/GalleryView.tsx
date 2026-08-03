import { Component, get } from '@expressive/react';
import { AppShell } from '../app/AppShell';
import { downloadUrl } from '../export/exportCard';
import type { StoredCard, StoredExport } from '../storage/CardArchive';
import { Button, EmptyState, TabBar, TextInput } from '../ui';
import { exportMatchesQuery, groupExports, matchesQuery } from './gallery-helpers';

const SECTIONS = [
  { id: 'cards', label: 'Saved cards' },
  { id: 'images', label: 'Library' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

export class GalleryView extends Component {
  shell = get(AppShell, false);
  section: SectionId = 'cards';
  /** Search over the unified Saved cards view. */
  query = '';

  openCard(card: StoredCard) {
    const { shell } = this;
    if (!shell) return;
    shell.pendingCard = card;
    shell.view = 'builder';
  }

  render() {
    const { section } = this;
    return (
      <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
        <TabBar
          tabs={SECTIONS}
          active={section}
          onSelect={(id) => {
            this.section = id;
          }}
        />
        {section === 'cards' && <GalleryCards />}
        {section === 'images' && <GalleryImages />}
      </div>
    );
  }
}

/** A grid of render thumbnails with the standard download/delete actions. */
function RenderStrip(props: { items: readonly StoredExport[] }) {
  const { shell } = GalleryView.get();
  const urls = shell?.archive.exportUrls ?? {};
  return (
    <div className="grid grid-cols-3 gap-4 xl:grid-cols-5">
      {props.items.map((item) => (
        <figure key={item.id} className="flex flex-col gap-1.5">
          <img
            src={urls[item.id]}
            alt={item.name}
            className="w-full rounded-lg border border-edge"
          />
          <figcaption className="truncate text-[11px] text-ink-dim">{item.name}</figcaption>
          <div className="flex gap-1.5">
            <Button
              tone="ghost"
              onClick={() => {
                const url = shell?.archive.exportUrl(item.id);
                if (url) downloadUrl(url, item.name);
              }}
            >
              Download
            </Button>
            <Button tone="danger" onClick={() => void shell?.archive.deleteExport(item.id)}>
              Delete
            </Button>
          </div>
        </figure>
      ))}
    </div>
  );
}

function GalleryImages() {
  const { shell } = GalleryView.get();
  const images = shell?.library.images ?? [];
  const urls = shell?.library.urls ?? {};
  if (images.length === 0) {
    return (
      <EmptyState message="No library images yet." hint="Generate in the Builder's art tools." />
    );
  }
  return (
    <div className="grid grid-cols-3 gap-4 xl:grid-cols-5">
      {images.map((image) => (
        <figure key={image.id} className="flex flex-col gap-1.5">
          <img
            src={urls[image.id]}
            alt={image.name}
            className="aspect-square w-full rounded-base border-2 border-border object-cover shadow-shadow"
          />
          <figcaption className="flex items-center gap-1.5 text-[11px]">
            <span
              className={`shrink-0 rounded-sm border border-border px-1 uppercase ${
                image.kind === 'generated'
                  ? 'bg-main/70 text-main-foreground'
                  : 'bg-background text-foreground/70'
              }`}
            >
              {image.kind}
            </span>
            <span className="truncate text-foreground/80" title={image.prompt}>
              {image.name}
            </span>
          </figcaption>
          <div className="flex gap-1.5">
            <Button
              tone="ghost"
              onClick={() => {
                const url = urls[image.id];
                if (url) downloadUrl(url, image.fileName ?? image.name);
              }}
            >
              Download
            </Button>
            <Button tone="danger" onClick={() => void shell?.library.remove(image.id)}>
              Delete
            </Button>
          </div>
        </figure>
      ))}
    </div>
  );
}

function GalleryCards() {
  const { is: gallery, shell, query } = GalleryView.get();
  const cards = shell?.archive.cards ?? [];
  const exports = shell?.archive.exports ?? [];
  const { byCard, other } = groupExports(cards, exports);
  const visibleCards = cards.filter((card) => matchesQuery(card, query));
  const visibleOther = other.filter((item) => exportMatchesQuery(item, query));
  if (cards.length === 0 && exports.length === 0) {
    return <EmptyState message="No saved cards yet." hint="Save from the Builder's form panel." />;
  }
  return (
    <div className="flex flex-col gap-4">
      <TextInput
        value={query}
        onValue={(v) => {
          gallery.query = v;
        }}
        placeholder="Search cards and renders…"
      />
      {visibleCards.length === 0 && visibleOther.length === 0 && (
        <EmptyState message="Nothing matches your search." hint="Try a different query." />
      )}
      <ul className="flex flex-col gap-3">
        {visibleCards.map((card) => (
          <li
            key={card.id}
            className="flex flex-col gap-2.5 rounded-lg border border-edge bg-panel px-4 py-2.5"
          >
            <div className="flex items-center justify-between">
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => gallery.openCard(card)}
              >
                <p className="truncate font-display text-sm">{card.name}</p>
                <p className="text-[11px] text-ink-dim">
                  {card.themeId} · {card.layoutId} · {new Date(card.updatedAt).toLocaleString()}
                </p>
              </button>
              <div className="flex shrink-0 gap-1.5">
                <Button tone="ghost" onClick={() => gallery.openCard(card)}>
                  Open in builder
                </Button>
                <Button
                  tone="ghost"
                  onClick={() =>
                    void shell?.archive.saveCard({
                      name: `${card.name} copy`,
                      themeId: card.themeId,
                      layoutId: card.layoutId,
                      data: { ...card.data, name: `${card.name} copy` },
                      holo: card.holo,
                    })
                  }
                >
                  Duplicate
                </Button>
                <Button tone="danger" onClick={() => void shell?.archive.deleteCard(card.id)}>
                  Delete
                </Button>
              </div>
            </div>
            {(byCard.get(card.id)?.length ?? 0) > 0 && (
              <RenderStrip items={byCard.get(card.id) ?? []} />
            )}
          </li>
        ))}
      </ul>
      {visibleOther.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="font-base text-[11px] text-ink-dim uppercase tracking-wide">
            Other renders
          </h3>
          <RenderStrip items={visibleOther} />
        </section>
      )}
    </div>
  );
}
