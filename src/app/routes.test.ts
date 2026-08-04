import { Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { formatRoute, parseRoute, type RouteT } from '@/app/routes';
import { CardId } from '@/contracts/ids';

const some = (route: RouteT) => Option.some(route);

describe('parseRoute', () => {
  it.each([
    ['/builder', some({ view: 'builder' as const })],
    ['/builder/', some({ view: 'builder' as const })],
    ['/builder/abc123', some({ view: 'builder' as const, cardId: CardId.make('abc123') })],
    ['/gallery', some({ view: 'gallery' as const })],
    ['/', Option.none()],
    ['', Option.none()],
    ['/nope', Option.none()],
    ['/builder/a/b', Option.none()],
    ['/gallery/x', Option.none()],
  ])('%s', (pathname, expected) => {
    expect(parseRoute(pathname)).toEqual(expected);
  });
});

describe('formatRoute', () => {
  it('round-trips all three route shapes', () => {
    const routes: RouteT[] = [
      { view: 'builder' },
      { view: 'builder', cardId: CardId.make('abc123') },
      { view: 'gallery' },
    ];
    for (const route of routes) {
      expect(parseRoute(formatRoute(route))).toEqual(Option.some(route));
    }
  });

  it('formats the exact paths', () => {
    expect(formatRoute({ view: 'builder' })).toBe('/builder');
    expect(formatRoute({ view: 'builder', cardId: CardId.make('x1') })).toBe('/builder/x1');
    expect(formatRoute({ view: 'gallery' })).toBe('/gallery');
  });
});
