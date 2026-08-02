import { Effect, Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { click, mountApp, tick } from '../../test/util';
import { setAppLayer, testAppLayerWith } from '../app/runtime';
import { type GenerationInput, ImageProvider } from '../images/ImageProvider';
import { ImageLibrary } from '../storage/ImageLibrary';
import { BuilderView } from './BuilderView';
import { PortraitSection } from './PortraitSection';

const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

describe('PortraitSection (headless, text-first)', () => {
  it('composes art from the layout arguments (no photo) and stores the image', async () => {
    const generate = vi.fn((input: GenerationInput) => {
      expect(input.themeContext?.lookAndFeel.toLowerCase()).toContain('oil');
      expect(input.themeContext?.palette.length).toBeGreaterThan(0); // essence artFlavor
      expect(input.argumentValues?.name).toBeDefined();
      expect(input.styleId).toBe('arcane');
      expect(input.sourceBytes.byteLength).toBe(0); // text-first: no photo attached
      return Effect.succeed({ bytes: bytesOf('art'), type: 'image/png', via: 'stub' as const });
    });
    setAppLayer(
      testAppLayerWith({ image: Layer.succeed(ImageProvider, ImageProvider.of({ generate })) }),
    );

    const library = ImageLibrary.new();
    await vi.waitFor(() => {
      expect(library.ready).toBe(true);
    });
    const builder = BuilderView.new();
    const section = PortraitSection.new({ fieldKey: 'art' });

    await section.generateArt({ builder, library });
    expect(generate).toHaveBeenCalledOnce();

    expect(library.images).toHaveLength(1);
    expect(builder.data.art).toBe(library.images[0]?.id);
    expect(section.note).toContain('stub');

    section.set(null);
    builder.set(null);
    library.set(null);
  });

  it('forwards an attached photo and the brief as steering input', async () => {
    const generate = vi.fn((input: GenerationInput) => {
      expect(new TextDecoder().decode(input.sourceBytes)).toBe('face');
      expect(input.brief).toBe('a phoenix behind her');
      return Effect.succeed({ bytes: bytesOf('art'), type: 'image/png', via: 'stub' as const });
    });
    setAppLayer(
      testAppLayerWith({ image: Layer.succeed(ImageProvider, ImageProvider.of({ generate })) }),
    );

    const library = ImageLibrary.new();
    await vi.waitFor(() => {
      expect(library.ready).toBe(true);
    });
    const builder = BuilderView.new();
    const section = PortraitSection.new({ fieldKey: 'art' });

    section.attachPhoto(bytesOf('face'), 'image/png');
    section.brief = 'a phoenix behind her';
    await section.generateArt({ builder, library });
    expect(generate).toHaveBeenCalledOnce();

    section.set(null);
    builder.set(null);
    library.set(null);
  });

  it('applies a library image directly to the card field', async () => {
    const builder = BuilderView.new();
    const section = PortraitSection.new({ fieldKey: 'art' });
    // headless: builder ref comes from context in the app; inject via the field
    section.builder = builder;
    section.applyLibraryImage('img-123');
    expect(builder.data.art).toBe('img-123');
    expect(section.note).toContain('library');
    section.set(null);
    builder.set(null);
  });
});

describe('Builder art tools (mounted)', () => {
  it('opens the art tools from the image field', async () => {
    const { container, unmount } = await mountApp();
    const openButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Portrait tools',
    );
    expect(openButton).toBeDefined();
    await click(openButton ?? null);
    await tick();
    const text = container.textContent ?? '';
    expect(text).toContain('Art brief');
    expect(text).toContain('Generate art');
    expect(text).toContain('Attach photo (optional)');
    unmount();
  });
});
