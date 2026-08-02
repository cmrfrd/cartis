import { describe, expect, it } from 'vitest';
import { click, mountApp, tick } from '../../test/util';

describe('AppShell', () => {
  it('shows three view tabs and switches the visible pane', async () => {
    const { container, shell, unmount } = await mountApp();
    expect(container.textContent).toContain('CARTIS');
    for (const label of ['Builder', 'Image Lab', 'Gallery']) {
      expect(container.textContent).toContain(label);
    }
    expect(shell.view).toBe('builder');
    const tabs = Array.from(container.querySelectorAll('header button'));
    await click(tabs.find((b) => b.textContent === 'Gallery') ?? null);
    expect(shell.view).toBe('gallery');
    const panes = Array.from(container.querySelectorAll('main > div'));
    expect(panes).toHaveLength(3);
    expect(panes.filter((p) => p.className.includes('hidden'))).toHaveLength(2);
    // activity bar: idle by default, drawer opens with pushed events
    expect(container.textContent).toContain('AI activity');
    shell.activity.push({ at: Date.now(), source: 'image', message: 'prediction created' });
    await tick();
    expect(container.querySelector('[data-testid="activity-latest"]')?.textContent).toContain(
      'prediction created',
    );
    const logButton = Array.from(container.querySelectorAll('footer button')).find((b) =>
      b.textContent?.startsWith('Log'),
    );
    await click(logButton ?? null);
    expect(container.querySelector('[data-testid="activity-drawer"]')).not.toBeNull();
    unmount();
  });
});
