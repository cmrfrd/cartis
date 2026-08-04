/**
 * Pure route codec (routing spec §1). The URL is a PROJECTION of AppShell
 * state — this module is the only place path shapes are known. Paths:
 * `/builder`, `/builder/<cardId>`, `/gallery`. `/` and unknown paths parse to
 * none (the history sync normalizes them at boot).
 */

import { Option } from 'effect';
import { CardId, type CardIdT } from '@/contracts/ids';

export type RouteT = { view: 'builder'; cardId?: CardIdT } | { view: 'gallery' };

export function parseRoute(pathname: string): Option.Option<RouteT> {
  const segments = pathname.split('/').filter((s) => s.length > 0);
  if (segments.length === 1 && segments[0] === 'builder') return Option.some({ view: 'builder' });
  if (segments.length === 2 && segments[0] === 'builder' && segments[1] !== undefined) {
    return Option.some({ view: 'builder', cardId: CardId.make(decodeURIComponent(segments[1])) });
  }
  if (segments.length === 1 && segments[0] === 'gallery') return Option.some({ view: 'gallery' });
  return Option.none();
}

export function formatRoute(route: RouteT): string {
  if (route.view === 'gallery') return '/gallery';
  return route.cardId !== undefined ? `/builder/${encodeURIComponent(route.cardId)}` : '/builder';
}
