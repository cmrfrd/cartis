import { beforeEach, describe, expect, it, vi } from 'vitest';
import { click, mountApp, tick } from '../../test/util';

/**
 * The URL is a projection of AppShell state (routing spec §1): mounted tests
 * drive the app and assert History API writes — including the coalescing rule
 * (one user action = ONE history entry) — and popstate/boot application.
 */

const pathname = () => window.location.pathname;

/** Spy on History writes without breaking them. */
function spyHistory() {
  const pushes: string[] = [];
  const replaces: string[] = [];
  const push = History.prototype.pushState;
  const replace = History.prototype.replaceState;
  vi.spyOn(History.prototype, 'pushState').mockImplementation(function (
    this: History,
    ...args: Parameters<History['pushState']>
  ) {
    pushes.push(String(args[2]));
    return push.apply(this, args);
  });
  vi.spyOn(History.prototype, 'replaceState').mockImplementation(function (
    this: History,
    ...args: Parameters<History['replaceState']>
  ) {
    replaces.push(String(args[2]));
    return replace.apply(this, args);
  });
  return { pushes, replaces };
}

const galleryTab = () =>
  Array.from(document.querySelectorAll('button, [role="tab"]')).find(
    (el) => el.textContent === 'Gallery',
  ) ?? null;

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

describe('history sync', () => {
  it('boot normalizes unknown paths to /builder (replace, no push)', async () => {
    window.history.replaceState(null, '', '/nope');
    const spies = spyHistory();
    const { unmount } = await mountApp();
    expect(pathname()).toBe('/builder');
    expect(spies.pushes).toEqual([]);
    unmount();
  });

  it('tab switch pushes exactly one /gallery entry; popstate flips back', async () => {
    const { shell, unmount } = await mountApp();
    const spies = spyHistory();
    await click(galleryTab());
    await tick();
    expect(pathname()).toBe('/gallery');
    expect(spies.pushes).toEqual(['/gallery']);
    // back → popstate applies the URL to state
    window.history.replaceState(null, '', '/builder');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await tick();
    expect(shell.view).toBe('builder');
    unmount();
  });

  it('opening a card from the gallery produces exactly ONE push at /builder/<id>', async () => {
    const { container, shell, unmount } = await mountApp();
    await vi.waitFor(() => expect(shell.archive.ready).toBe(true));
    // save a card first (replace per first-save rule — not a push)
    const spies = spyHistory();
    const save = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save',
    );
    await click(save ?? null);
    await vi.waitFor(() => expect(shell.archive.cards).toHaveLength(1));
    await tick();
    const id = shell.archive.cards[0]?.id ?? '';
    expect(spies.pushes).toEqual([]); // first save replaced, never pushed
    expect(pathname()).toBe(`/builder/${id}`);
    // go to gallery, then open the card — ONE push for the open
    await click(galleryTab());
    await tick();
    spies.pushes.length = 0;
    const open = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Open',
    );
    await click(open ?? null);
    await tick();
    await vi.waitFor(() => expect(pathname()).toBe(`/builder/${id}`));
    expect(spies.pushes).toEqual([`/builder/${id}`]); // coalesced: one action, one entry
    expect(document.title).toContain('Nyra');
    unmount();
  });

  it('boot at /builder/<id> reopens the card (and keeps the URL)', async () => {
    // First mount: create a card, capture its id.
    const first = await mountApp();
    await vi.waitFor(() => expect(first.shell.archive.ready).toBe(true));
    const save = Array.from(first.container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save',
    );
    await click(save ?? null);
    await vi.waitFor(() => expect(first.shell.archive.cards).toHaveLength(1));
    const id = first.shell.archive.cards[0]?.id ?? '';
    first.unmount();
    // Second mount at the deep link (same memory store within this test).
    window.history.replaceState(null, '', `/builder/${id}`);
    const second = await mountApp();
    await vi.waitFor(() => {
      expect(second.shell.openCardId).toBe(id);
    });
    expect(pathname()).toBe(`/builder/${id}`);
    second.unmount();
  });

  it('boot at /builder/<unknown-id> normalizes to /builder', async () => {
    window.history.replaceState(null, '', '/builder/does-not-exist');
    const { shell, unmount } = await mountApp();
    await vi.waitFor(() => expect(shell.archive.ready).toBe(true));
    await vi.waitFor(() => expect(pathname()).toBe('/builder'));
    expect(shell.openCardId).toBeUndefined();
    unmount();
  });
});
