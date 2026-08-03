import { describe, expect, it } from 'vitest';
import { click, mountApp } from '../../test/util';

describe('AppShell', () => {
  it('shows two view tabs and switches the visible pane', async () => {
    const { container, shell, unmount } = await mountApp();
    expect(container.textContent).toContain('CARTIS');
    for (const label of ['Builder', 'Gallery']) {
      expect(container.textContent).toContain(label);
    }
    expect(shell.view).toBe('builder');
    const tabs = Array.from(container.querySelectorAll('header button'));
    await click(tabs.find((b) => b.textContent === 'Gallery') ?? null);
    expect(shell.view).toBe('gallery');
    const panes = Array.from(container.querySelectorAll('main > div'));
    expect(panes).toHaveLength(2);
    expect(panes.filter((p) => p.className.includes('hidden'))).toHaveLength(1);
    // the footer activity bar is gone — all AI activity now lives in the chat panel
    expect(container.textContent).not.toContain('AI activity');
    expect(container.querySelector('footer')).toBeNull();
    unmount();
  });
});
