import { describe, expect, it } from 'vitest';
import { mount, tick } from '../../test/util';
import { AppShell } from './AppShell';

describe('AppShell', () => {
  it('renders the app title', async () => {
    const { container, unmount } = mount(<AppShell />);
    await tick();
    expect(container.textContent).toContain('CARTIS');
    unmount();
  });
});
