import { Component } from '@expressive/react';
import { BuilderView } from '../builder/BuilderView';
import { GalleryView } from '../gallery/GalleryView';
import { ImageLabView } from '../images/ImageLabView';
import { CardArchive, type StoredCard } from '../storage/CardArchive';
import { ImageLibrary } from '../storage/ImageLibrary';
import { TabBar } from '../ui';
import { ActivityFeed } from './ActivityFeed';

export type ViewId = 'builder' | 'images' | 'gallery';

const VIEW_TABS: readonly { id: ViewId; label: string }[] = [
  { id: 'builder', label: 'Builder' },
  { id: 'images', label: 'Image Lab' },
  { id: 'gallery', label: 'Gallery' },
];

export class AppShell extends Component {
  view: ViewId = 'builder';
  /** Adopted child models — AppShell owns their lifecycle (skills: child States attach as class fields). */
  library = new ImageLibrary();
  archive = new CardArchive();
  activity = new ActivityFeed();
  activityOpen = false;
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
            <BuilderView />
          </Pane>
          <Pane active={view === 'images'}>
            <ImageLabView />
          </Pane>
          <Pane active={view === 'gallery'}>
            <GalleryView />
          </Pane>
        </main>
        <ActivityBar />
      </div>
    );
  }
}

const TIME = (at: number) => new Date(at).toLocaleTimeString();

/** AI activity: latest action in a status strip, full log in a drawer. */
function ActivityBar() {
  const { is: shell, activity, activityOpen } = AppShell.get();
  const { events, latest } = activity;
  return (
    <footer className="relative border-border border-t-2 bg-secondary-background">
      {activityOpen && events.length > 0 && (
        <div
          data-testid="activity-drawer"
          className="absolute right-2 bottom-full mb-2 max-h-72 w-[520px] overflow-y-auto rounded-base border-2 border-border bg-secondary-background p-2 shadow-shadow"
        >
          <ul className="flex flex-col gap-1">
            {[...events].reverse().map((event) => (
              <li
                key={`${String(event.at)}-${event.message}`}
                className="flex gap-2 font-mono text-[11px]"
              >
                <span className="shrink-0 text-foreground/40">{TIME(event.at)}</span>
                <span
                  className={`shrink-0 rounded-sm border border-border px-1 uppercase ${
                    event.source === 'agent'
                      ? 'bg-main/60 text-main-foreground'
                      : 'bg-background text-foreground/80'
                  }`}
                >
                  {event.source}
                </span>
                <span className="text-foreground/90">{event.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex items-center gap-3 px-4 py-1.5">
        <span className="font-base text-[11px] text-foreground/50 uppercase tracking-wide">
          AI activity
        </span>
        <span
          data-testid="activity-latest"
          className="min-w-0 flex-1 truncate font-mono text-foreground/80 text-xs"
        >
          {latest ? `[${latest.source}] ${latest.message}` : 'idle — actions will appear here'}
        </span>
        <button
          type="button"
          className="rounded-base border-2 border-border bg-background px-2 py-0.5 font-base text-xs shadow-shadow hover:translate-x-boxShadowX hover:translate-y-boxShadowY hover:shadow-none"
          onClick={() => {
            shell.activityOpen = !shell.activityOpen;
          }}
        >
          {activityOpen ? 'Hide log' : `Log (${String(events.length)})`}
        </button>
      </div>
    </footer>
  );
}

/** Panes stay mounted and merely hide so view-local state survives tab switches. */
function Pane(props: { active: boolean; children?: Component.Node }) {
  return <div className={props.active ? 'h-full' : 'hidden'}>{props.children}</div>;
}
