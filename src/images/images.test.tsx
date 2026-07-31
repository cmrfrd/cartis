import { describe, expect, it, vi } from 'vitest';
import { mount, tick } from '../../test/util';
import { ImageLibrary } from '../storage/ImageLibrary';
import { CameraCapture } from './CameraCapture';
import { bytesToDataUrl, dataUrlToBytes } from './codec';
import { ImageLabView } from './ImageLabView';
import { buildPortraitPrompt } from './prompt';
import type { GenerationInput, ImageProvider } from './provider';
import { selectImageProvider } from './provider';
import { createStubProvider, stubStyleFor } from './stub';

const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

describe('codec', () => {
  it('round-trips bytes through a data url', () => {
    const original = bytesOf('hello cartis');
    const url = bytesToDataUrl(original, 'image/png');
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
    const back = dataUrlToBytes(url);
    expect(back.type).toBe('image/png');
    expect(new TextDecoder().decode(back.bytes)).toBe('hello cartis');
  });
});

describe('buildPortraitPrompt', () => {
  it('folds persona details into the style prompt, skipping blanks', () => {
    const prompt = buildPortraitPrompt('oil painting portrait', {
      age: '34',
      gender: '',
      detail: 'wears a silver pendant',
      hobby: 'baking sourdough',
    });
    expect(prompt).toContain('oil painting portrait');
    expect(prompt).toContain('34');
    expect(prompt).toContain('silver pendant');
    expect(prompt).toContain('baking sourdough');
    expect(prompt).not.toContain('undefined');
  });
});

describe('stub provider', () => {
  it('derives a deterministic style per styleId', () => {
    expect(stubStyleFor('arcane-hero')).toEqual(stubStyleFor('arcane-hero'));
    expect(stubStyleFor('a').hue).not.toBe(stubStyleFor('b').hue);
  });

  it('paints via the injected paint fn and falls back to the source on paint failure', async () => {
    const painted = { bytes: bytesOf('painted'), type: 'image/png' };
    const provider = createStubProvider(async () => painted);
    const input: GenerationInput = {
      sourceBytes: bytesOf('src'),
      sourceType: 'image/jpeg',
      prompt: 'p',
      styleId: 's',
    };
    expect(await provider.generate(input)).toBe(painted);

    const failing = createStubProvider(async () => {
      throw new Error('no canvas here');
    });
    const fallback = await failing.generate(input);
    expect(fallback.type).toBe('image/jpeg');
    expect(new TextDecoder().decode(fallback.bytes)).toBe('src');
  });
});

describe('selectImageProvider', () => {
  it('picks replicate when the bridge reports it', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ image: 'replicate' })),
    ) as unknown as typeof fetch;
    expect((await selectImageProvider(fetchImpl)).id).toBe('replicate');
  });

  it('falls back to stub when the bridge is absent', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('no server');
    }) as unknown as typeof fetch;
    expect((await selectImageProvider(fetchImpl)).id).toBe('stub');
  });
});

describe('CameraCapture', () => {
  it('reports camera unavailability when getUserMedia is missing', async () => {
    // happy-dom ships a working getUserMedia stub — inject a bare environment instead.
    const { container, unmount } = mount(<CameraCapture getMedia={() => undefined} />);
    await tick();
    expect(container.textContent).toContain('Camera unavailable');
    unmount();
  });
});

describe('ImageLabView (headless)', () => {
  it('requires a source photo before generating', async () => {
    const lab = ImageLabView.new();
    await lab.generate();
    expect(lab.note).toContain('photo first');
    lab.set(null);
  });

  it('generates via the injected provider and stores into the injected library', async () => {
    const lab = ImageLabView.new();
    const library = ImageLibrary.new();
    await vi.waitFor(() => {
      expect(library.ready).toBe(true);
    });
    lab.acceptSource(bytesOf('face'), 'image/jpeg');
    lab.prompt = 'as a noble knight';
    const provider: ImageProvider = {
      id: 'stub',
      generate: vi.fn(async () => ({ bytes: bytesOf('styled'), type: 'image/png' })),
    };
    await lab.generate(provider, library);
    expect(provider.generate).toHaveBeenCalledOnce();
    expect(library.images).toHaveLength(1);
    expect(library.images[0]?.kind).toBe('generated');
    expect(library.images[0]?.prompt).toContain('noble knight');
    expect(lab.note).toContain('stub');
    lab.set(null);
    library.set(null);
  });
});
