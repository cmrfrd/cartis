import { describe, expect, it } from 'vitest';
import { mount, tick } from '../../../test/util';
import { CARD_HEIGHT, CARD_WIDTH, CardSurface } from './CardSurface';

describe('CardSurface', () => {
  it('renders children on a fixed-size rooted surface', async () => {
    const { container, unmount } = mount(
      <CardSurface>
        <p>inner</p>
      </CardSurface>,
    );
    await tick();
    const root = container.querySelector('[data-card-root="true"]') as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.textContent).toContain('inner');
    expect(root.style.width).toBe(`${CARD_WIDTH}px`);
    expect(root.style.height).toBe(`${CARD_HEIGHT}px`);
    // the printed black border hosts an inset frame layer
    expect(root.querySelector('[data-card-frame="true"]')).not.toBeNull();
    expect(root.querySelector('[data-holo="true"]')).toBeNull();
    unmount();
  });

  it('shows the holo overlay only when enabled', async () => {
    const { container, unmount } = mount(<CardSurface holo>{null}</CardSurface>);
    await tick();
    expect(container.querySelector('[data-holo="true"]')).not.toBeNull();
    unmount();
  });

  it('owns its text alignment — identical inside a <button> (live-caught UA-style leak)', async () => {
    // The gallery wraps tiles in a <button>; browsers' UA stylesheet sets
    // text-align: center on buttons and it INHERITS into the whole card face.
    // The card root must declare its own alignment so the face renders the
    // same in ANY wrapper (builder preview, gallery tile, exports).
    const { container, unmount } = mount(
      <button type="button" style={{ textAlign: 'center' }}>
        <CardSurface>
          <p>rules text</p>
        </CardSurface>
      </button>,
    );
    await tick();
    const root = container.querySelector('[data-card-root="true"]') as HTMLElement;
    expect(root.className).toContain('text-left');
    unmount();
  });
});
