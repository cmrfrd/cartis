import { Component } from '@expressive/react';
import type { ReactNode } from 'react';
import { CardArchive, type StoredCard } from '../storage/CardArchive';
import { ImageLibrary } from '../storage/ImageLibrary';
import { EmptyState, TabBar } from '../ui';

export type ViewId = 'builder' | 'editor' | 'images' | 'gallery';

const VIEW_TABS: readonly { id: ViewId; label: string }[] = [
  { id: 'builder', label: 'Builder' },
  { id: 'editor', label: 'Code Lab' },
  { id: 'images', label: 'Image Lab' },
  { id: 'gallery', label: 'Gallery' },
];

export class AppShell extends Component {
  view: ViewId = 'builder';
  /** Adopted child models — AppShell owns their lifecycle (skills: child States attach as class fields). */
  library = new ImageLibrary();
  archive = new CardArchive();
  /** Set by the Gallery to hand a saved card to the Builder (consumed in BuilderView.mount, Task 10). */
  pendingCard?: StoredCard = undefined;

  render() {
    const { view } = this;
    return (
      <div className="flex h-screen flex-col bg-surface font-body text-ink">
        <header className="flex items-center gap-6 border-b border-edge px-6 py-3">
          <h1 className="font-display text-xl tracking-widest text-accent">CARTIS</h1>
          <TabBar
            tabs={VIEW_TABS}
            active={view}
            onSelect={(id) => {
              this.view = id;
            }}
          />
        </header>
        <main className="min-h-0 flex-1">
          <Pane active={view === 'builder'}>
            <EmptyState message="Builder arrives in Task 6." />
          </Pane>
          <Pane active={view === 'editor'}>
            <EmptyState message="Code Lab arrives in Task 12." />
          </Pane>
          <Pane active={view === 'images'}>
            <EmptyState message="Image Lab arrives in Task 7." />
          </Pane>
          <Pane active={view === 'gallery'}>
            <EmptyState message="Gallery arrives in Task 10." />
          </Pane>
        </main>
      </div>
    );
  }
}

/** Panes stay mounted and merely hide so view-local state survives tab switches. */
function Pane(props: { active: boolean; children?: ReactNode }) {
  return <div className={props.active ? 'h-full' : 'hidden'}>{props.children}</div>;
}
