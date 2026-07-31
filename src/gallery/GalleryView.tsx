import { Component, get } from '@expressive/react';
import { AppShell } from '../app/AppShell';
import { downloadBlob } from '../export/exportCard';
import type { StoredCard } from '../storage/CardArchive';
import { Button, EmptyState, TabBar } from '../ui';

const SECTIONS = [
  { id: 'exports', label: 'Renders' },
  { id: 'images', label: 'Generations' },
  { id: 'cards', label: 'Saved cards' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

export class GalleryView extends Component {
  shell = get(AppShell, false);
  section: SectionId = 'exports';

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
        {section === 'exports' && <GalleryExports />}
        {section === 'images' && <GalleryImages />}
        {section === 'cards' && <GalleryCards />}
      </div>
    );
  }
}

function GalleryExports() {
  const { shell } = GalleryView.get();
  const exports = shell?.archive.exports ?? [];
  const urls = shell?.archive.exportUrls ?? {};
  if (exports.length === 0) {
    return (
      <EmptyState message="No exported renders yet." hint="Export from the Builder or Code Lab." />
    );
  }
  return (
    <div className="grid grid-cols-3 gap-4 xl:grid-cols-5">
      {exports.map((item) => (
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
              onClick={() => downloadBlob(new Blob([item.bytes], { type: item.type }), item.name)}
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
  const generated = (shell?.library.images ?? []).filter((i) => i.kind === 'generated');
  const urls = shell?.library.urls ?? {};
  if (generated.length === 0) {
    return <EmptyState message="No image generations yet." hint="Create some in the Image Lab." />;
  }
  return (
    <div className="grid grid-cols-3 gap-4 xl:grid-cols-5">
      {generated.map((image) => (
        <figure key={image.id} className="flex flex-col gap-1.5">
          <img
            src={urls[image.id]}
            alt={image.prompt ?? 'generated'}
            className="aspect-square w-full rounded-lg border border-edge object-cover"
          />
          <figcaption className="truncate text-[11px] text-ink-dim">{image.prompt}</figcaption>
          <div className="flex gap-1.5">
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
  const { is: gallery, shell } = GalleryView.get();
  const cards = shell?.archive.cards ?? [];
  if (cards.length === 0) {
    return <EmptyState message="No saved cards yet." hint="Save from the Builder's form panel." />;
  }
  return (
    <ul className="flex flex-col gap-2">
      {cards.map((card) => (
        <li
          key={card.id}
          className="flex items-center justify-between rounded-lg border border-edge bg-panel px-4 py-2.5"
        >
          <div className="min-w-0">
            <p className="truncate font-display text-sm">{card.name}</p>
            <p className="text-[11px] text-ink-dim">
              {card.templateId} · {new Date(card.updatedAt).toLocaleString()}
            </p>
          </div>
          <div className="flex shrink-0 gap-1.5">
            <Button tone="ghost" onClick={() => gallery.openCard(card)}>
              Open in builder
            </Button>
            <Button tone="danger" onClick={() => void shell?.archive.deleteCard(card.id)}>
              Delete
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
