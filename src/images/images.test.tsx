import { Effect, Layer, Schema } from 'effect';
import { describe, expect, vi, it as vit } from 'vitest';
import { it } from '../../test/effect';
import { mount } from '../../test/util';
import { ImageGenerateRequest } from '../contracts/api';
import { httpClientFromHandler } from '../lib/http';
import { CameraCapture } from './CameraCapture';
import { bytesToDataUrl, dataUrlToBytes } from './codec';
import {
  type GenerationInput,
  ImageProvider,
  imageProviderLive,
  imageProviderStubLayer,
} from './ImageProvider';
import { stubStyleFor } from './stub';

const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

describe('codec', () => {
  vit('round-trips bytes through a data url', () => {
    const original = bytesOf('hello cartis');
    const url = bytesToDataUrl(original, 'image/png');
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
    const back = dataUrlToBytes(url);
    expect(back.type).toBe('image/png');
    expect(new TextDecoder().decode(back.bytes)).toBe('hello cartis');
  });
});

describe('stub painting', () => {
  vit('derives a deterministic style per styleId', () => {
    expect(stubStyleFor('arcane-hero')).toEqual(stubStyleFor('arcane-hero'));
    expect(stubStyleFor('a').hue).not.toBe(stubStyleFor('b').hue);
  });
});

const genInput: GenerationInput = {
  sourceBytes: bytesOf('src'),
  sourceType: 'image/jpeg',
  prompt: 'p',
  styleId: 's',
};

describe('ImageProvider (Live)', () => {
  it.effect('posts to /api/image/generate when /api/status reports replicate', () => {
    const posted: string[] = [];
    const handler = (req: { method: string; url: string }): Response => {
      posted.push(`${req.method} ${req.url}`);
      if (req.method === 'GET' && req.url.endsWith('/api/status')) {
        return new Response(JSON.stringify({ image: 'replicate' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (req.method === 'POST' && req.url.endsWith('/api/image/generate')) {
        return new Response(
          JSON.stringify({ dataUrl: bytesToDataUrl(bytesOf('styled'), 'image/png') }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('nope', { status: 404 });
    };
    const layer = imageProviderLive.pipe(Layer.provide(httpClientFromHandler(handler)));
    return Effect.gen(function* () {
      const provider = yield* ImageProvider;
      const result = yield* provider.generate(genInput);
      expect(result.via).toBe('replicate');
      expect(new TextDecoder().decode(result.bytes)).toBe('styled');
      expect(posted.some((p) => p.includes('POST') && p.includes('/api/image/generate'))).toBe(
        true,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect('forwards themeContext + argumentValues + brief on the generate wire', () =>
    Effect.gen(function* () {
      const wire = yield* Schema.encode(ImageGenerateRequest)({
        prompt: 'p',
        imageDataUrl: 'data:image/png;base64,QQ==',
        aspectRatio: '3:4',
        themeContext: { lookAndFeel: 'oil', palette: 'ember', argumentSummary: 'name' },
        argumentValues: { name: 'Nyra' },
        brief: 'angrier',
        editCurrentArt: true,
        currentArtFileName: 'nyra-abc123.png',
      });
      expect(wire.themeContext?.lookAndFeel).toBe('oil');
      expect(wire.argumentValues?.name).toBe('Nyra');
      expect(wire.brief).toBe('angrier');
      expect(wire.editCurrentArt).toBe(true);
      expect(wire.currentArtFileName).toBe('nyra-abc123.png');
    }),
  );

  it.effect('falls back to stub (no generate POST) when /api/status fails', () => {
    const posted: string[] = [];
    const handler = (req: { method: string; url: string }): Response => {
      posted.push(`${req.method} ${req.url}`);
      if (req.url.endsWith('/api/status')) return new Response('down', { status: 500 });
      return new Response('nope', { status: 404 });
    };
    const layer = imageProviderLive.pipe(Layer.provide(httpClientFromHandler(handler)));
    return Effect.gen(function* () {
      const provider = yield* ImageProvider;
      const result = yield* provider.generate(genInput);
      expect(result.via).toBe('stub');
      expect(posted.some((p) => p.includes('/api/image/generate'))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect('falls back to stub when the bridge transport errors', () => {
    let generatePosts = 0;
    const handler = (req: { method: string; url: string }): Response => {
      if (req.url.endsWith('/api/image/generate')) generatePosts++;
      throw new Error('no server');
    };
    const layer = imageProviderLive.pipe(Layer.provide(httpClientFromHandler(handler)));
    return Effect.gen(function* () {
      const provider = yield* ImageProvider;
      const result = yield* provider.generate(genInput);
      expect(result.via).toBe('stub');
      expect(generatePosts).toBe(0);
    }).pipe(Effect.provide(layer));
  });
});

describe('imageProviderStubLayer', () => {
  it.effect('returns the source unchanged when paint fails (headless: no canvas)', () => {
    const failing = () => {
      throw new Error('no canvas here');
    };
    const layer = imageProviderStubLayer(failing);
    return Effect.gen(function* () {
      const provider = yield* ImageProvider;
      const result = yield* provider.generate(genInput);
      expect(result.via).toBe('stub');
      expect(result.type).toBe('image/jpeg');
      expect(new TextDecoder().decode(result.bytes)).toBe('src');
    }).pipe(Effect.provide(layer));
  });

  it.effect('paints via the injected paint fn', () => {
    const painted = { bytes: bytesOf('painted'), type: 'image/png' };
    const layer = imageProviderStubLayer(async () => painted);
    return Effect.gen(function* () {
      const provider = yield* ImageProvider;
      const result = yield* provider.generate(genInput);
      expect(result.via).toBe('stub');
      expect(new TextDecoder().decode(result.bytes)).toBe('painted');
    }).pipe(Effect.provide(layer));
  });
});

describe('CameraCapture', () => {
  vit('reports camera unavailability when getUserMedia is missing', async () => {
    // happy-dom ships a working getUserMedia stub — inject a bare environment instead.
    const { container, unmount } = mount(<CameraCapture getMedia={() => undefined} />);
    // The error is set in mount() and rendered on the NEXT flush — poll, don't fixed-sleep.
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Camera unavailable');
    });
    unmount();
  });
});
