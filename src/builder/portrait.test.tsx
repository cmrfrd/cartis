import { describe, expect, it, vi } from 'vitest';
import { click, mountApp, tick } from '../../test/util';
import type { ImageProvider } from '../images/provider';
import { ImageLibrary } from '../storage/ImageLibrary';
import { BuilderView } from './BuilderView';
import { PortraitSection } from './PortraitSection';

const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

describe('PortraitSection (headless)', () => {
  it('generates with the template style + persona prompt and assigns the image id to the card', async () => {
    const library = ImageLibrary.new();
    await vi.waitFor(() => {
      expect(library.ready).toBe(true);
    });
    const builder = BuilderView.new();
    const section = PortraitSection.new({ fieldKey: 'art' });

    section.acceptSource(bytesOf('face'), 'image/png');
    section.setPersona('age', '29');
    section.setPersona('hobby', 'chess');

    const provider: ImageProvider = {
      id: 'stub',
      generate: vi.fn(async (input) => {
        expect(input.prompt).toContain('oil painting'); // template style
        expect(input.prompt).toContain('29'); // persona
        expect(input.prompt).toContain('chess');
        expect(input.styleId).toBe('arcane-hero');
        return { bytes: bytesOf('styled'), type: 'image/png' };
      }),
    };
    await section.generate(provider, { builder, library });

    expect(library.images).toHaveLength(1);
    const stored = library.images[0];
    expect(builder.data.art).toBe(stored?.id);
    expect(builder.resolved.art).toBeUndefined(); // headless builder has no shell → no url mapping — fine

    section.set(null);
    builder.set(null);
    library.set(null);
  });

  it('refuses to generate without a source image', async () => {
    const section = PortraitSection.new({ fieldKey: 'art' });
    await section.generate();
    expect(section.note).toContain('photo first');
    section.set(null);
  });
});

describe('Builder portrait slot (mounted)', () => {
  it('opens portrait tools from the image field', async () => {
    const { container, unmount } = await mountApp();
    const openButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Portrait tools',
    );
    expect(openButton).toBeDefined();
    await click(openButton ?? null);
    await tick();
    const text = container.textContent ?? '';
    for (const label of ['Age', 'Gender', 'Small detail', 'Hobby']) {
      expect(text).toContain(label);
    }
    expect(text).toContain('Generate portrait');
    unmount();
  });
});
