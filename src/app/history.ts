/**
 * URL ⇄ AppShell projection (routing spec §1). Expressive state is canonical;
 * this module is the ONLY writer/reader of the History API.
 *
 * State → URL: listeners on `view`/`openCardId` schedule ONE microtask
 * reconcile (one user action = one history entry). Tab switches and card
 * opens push; the FIRST save of a new card replaces (saving is not a
 * navigation); popstate reconciliation and boot normalization replace.
 *
 * URL → state: popstate applies the parsed route through the same seams the
 * UI uses (`view`, `pendingCard` → requestOpen dirty-guard). If state does
 * not follow (guard cancel, unknown id), the reconcile snaps the URL back to
 * reality. Boot deep-links wait for the archive and hand the card through
 * `pendingCard` (which also rehydrates its chat).
 */

import { Option } from 'effect';
import type { CardIdT } from '@/contracts/ids';
import type { AppShell } from './AppShell';
import { formatRoute, parseRoute, type RouteT } from './routes';

const BASE_TITLE = 'Cartis — Card Studio';

export function syncHistory(shell: AppShell): () => void {
  let applying = false; // URL→state application in progress: don't re-project
  let scheduled = false;
  let disposed = false;

  const routeOf = (): RouteT =>
    shell.view === 'gallery'
      ? { view: 'gallery' }
      : {
          view: 'builder',
          ...(shell.openCardId !== undefined ? { cardId: shell.openCardId } : {}),
        };

  const titleOf = (route: RouteT): string => {
    if (route.view !== 'builder' || route.cardId === undefined) return BASE_TITLE;
    const name = shell.archive.cards.find((c) => c.id === route.cardId)?.name;
    return name !== undefined ? `Cartis — ${name}` : BASE_TITLE;
  };

  let prev = routeOf();

  const write = (mode: 'push' | 'replace') => {
    if (disposed) return;
    const route = routeOf();
    const path = formatRoute(route);
    if (window.location.pathname !== path) {
      // First save of a new card: /builder → /builder/<id> with the view
      // unchanged — an identity change of the SAME document, not a navigation.
      const firstSave =
        prev.view === 'builder' &&
        prev.cardId === undefined &&
        route.view === 'builder' &&
        route.cardId !== undefined;
      if (mode === 'replace' || firstSave) window.history.replaceState(null, '', path);
      else window.history.pushState(null, '', path);
    }
    prev = route;
    document.title = titleOf(route);
  };

  /** Coalesce state-change projections: one user action = one history entry. */
  const schedule = () => {
    if (applying || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      write('push');
    });
  };

  const offView = shell.set('view', schedule);
  const offCard = shell.set('openCardId', schedule);

  /** Hand a card to the builder via the guard-integrated pending seam. */
  const openCard = (cardId: CardIdT): boolean => {
    const card = shell.archive.cards.find((c) => c.id === cardId);
    if (!card) return false;
    shell.pendingCard = card;
    return true;
  };

  const applyRoute = (route: RouteT) => {
    applying = true;
    shell.view = route.view;
    if (
      route.view === 'builder' &&
      route.cardId !== undefined &&
      route.cardId !== shell.openCardId
    ) {
      openCard(route.cardId);
    }
    applying = false;
  };

  const onPopstate = () => {
    Option.match(parseRoute(window.location.pathname), {
      onNone: () => undefined,
      onSome: applyRoute,
    });
    // If state followed, the URL already matches (no write); if the dirty
    // guard held or the id was unknown, snap the URL back to actual state.
    queueMicrotask(() => write('replace'));
  };
  window.addEventListener('popstate', onPopstate);

  // ----- boot: apply the initial URL -----
  const whenArchiveReady = (fn: () => void): void => {
    if (shell.archive.ready) {
      fn();
      return;
    }
    const off = shell.archive.set('ready', () => {
      off();
      fn();
    });
  };

  Option.match(parseRoute(window.location.pathname), {
    onNone: () => write('replace'), // '/', unknown → normalize
    onSome: (route) => {
      applying = true;
      shell.view = route.view;
      applying = false;
      if (route.view === 'builder' && route.cardId !== undefined) {
        const cardId = route.cardId;
        whenArchiveReady(() => {
          if (disposed) return;
          if (!openCard(cardId)) write('replace'); // deleted/unknown → /builder
        });
      } else {
        write('replace'); // normalize formatting (e.g. trailing slash)
      }
    },
  });

  return () => {
    disposed = true;
    offView();
    offCard();
    window.removeEventListener('popstate', onPopstate);
  };
}
