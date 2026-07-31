import { describe, expect, it, vi } from 'vitest';
import { CardArchive } from '../storage/CardArchive';
import { ExportBar } from './ExportBar';
import {
  CARD_EXPORT_WIDTH,
  exportFileName,
  exportPixelRatio,
  FORMAT_MIME,
  renderCardBlob,
} from './exportCard';

vi.mock('html-to-image', () => ({
  toCanvas: vi.fn(async () => {
    const fake = {
      toBlob(cb: (b: Blob | null) => void, type?: string) {
        cb(new Blob(['fake-image'], { type: type ?? 'image/png' }));
      },
    };
    return fake as unknown as HTMLCanvasElement;
  }),
}));

describe('export math and naming', () => {
  it('doubles the 375px preview to 750px (300 DPI at 2.5 inches)', () => {
    expect(CARD_EXPORT_WIDTH).toBe(750);
    expect(exportPixelRatio(375)).toBe(2);
    expect(exportPixelRatio(0)).toBe(2); // guards divide-by-zero via CARD_WIDTH fallback
  });

  it('slugifies file names per format', () => {
    expect(exportFileName('Nyra, Ember Sage!', 'png')).toBe('nyra-ember-sage.png');
    expect(exportFileName('  ', 'webp')).toBe('card.webp');
    expect(FORMAT_MIME.jpeg).toBe('image/jpeg');
  });
});

describe('renderCardBlob', () => {
  it('renders the node through html-to-image and converts to the requested mime', async () => {
    const node = document.createElement('div');
    const blob = await renderCardBlob(node, 'webp');
    expect(blob.type).toBe('image/webp');
    const { toCanvas } = await import('html-to-image');
    expect(vi.mocked(toCanvas)).toHaveBeenCalledWith(
      node,
      expect.objectContaining({ pixelRatio: 2 }),
    );
  });
});

describe('ExportBar', () => {
  it('exports the target node and records it in the injected archive', async () => {
    const archive = CardArchive.new();
    await vi.waitFor(() => {
      expect(archive.ready).toBe(true);
    });
    const node = document.createElement('div');
    const bar = ExportBar.new({ cardName: 'Nyra', target: () => node });
    await bar.exportAs('png', archive);
    expect(archive.exports).toHaveLength(1);
    expect(archive.exports[0]?.name).toBe('nyra.png');
    expect(archive.exports[0]?.format).toBe('png');
    expect(bar.note).toContain('nyra.png');
    bar.set(null);
    archive.set(null);
  });
});
