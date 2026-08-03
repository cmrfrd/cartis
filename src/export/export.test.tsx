import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { CardId } from '../contracts/ids';
import { CardArchive } from '../storage/CardArchive';
import { ExportBar } from './ExportBar';
import {
  bleedLayout,
  CARD_EXPORT_WIDTH,
  composeBleed,
  composeSheet,
  exportFileName,
  exportPixelRatio,
  FORMAT_MIME,
  renderCardBlob,
  sheetLayout,
} from './exportCard';

vi.mock('html-to-image', () => ({
  toCanvas: vi.fn(async () => {
    const fake = {
      width: 750,
      height: 1050,
      toBlob(cb: (b: Blob | null) => void, type?: string) {
        cb(new Blob(['fake-image'], { type: type ?? 'image/png' }));
      },
    };
    return fake as unknown as HTMLCanvasElement;
  }),
}));

/** Fake canvas recording draw calls; happy-dom has no real 2d context. */
function fakeCanvasFactory() {
  const calls: string[] = [];
  const factory = (width: number, height: number) => {
    const ctx = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'canvas') return canvas;
          return (...args: unknown[]) => {
            calls.push(`${String(prop)}(${args.map((a) => String(a)).join(',')})`);
          };
        },
        set() {
          return true;
        },
      },
    );
    const canvas = {
      width,
      height,
      getContext: () => ctx,
      toBlob(cb: (b: Blob | null) => void, type?: string) {
        cb(new Blob(['composed'], { type: type ?? 'image/png' }));
      },
    } as unknown as HTMLCanvasElement;
    return canvas;
  };
  return { factory, calls };
}

describe('export math and naming', () => {
  it('doubles the 375px preview to 750px (300 DPI) and quadruples at 600', () => {
    expect(CARD_EXPORT_WIDTH).toBe(750);
    expect(exportPixelRatio(375)).toBe(2);
    expect(exportPixelRatio(375, 600)).toBe(4);
    expect(exportPixelRatio(0)).toBe(2); // guards divide-by-zero via CARD_WIDTH fallback
  });

  it('slugifies file names per format', () => {
    expect(exportFileName('Nyra, Ember Sage!', 'png')).toBe('nyra-ember-sage.png');
    expect(exportFileName('  ', 'webp')).toBe('card.webp');
    expect(FORMAT_MIME.jpeg).toBe('image/jpeg');
  });
});

describe('print layout math', () => {
  it('computes standard 1/8" bleed with a crop-mark margin', () => {
    const layout = bleedLayout(750, 1050, 300);
    expect(layout.bleed).toBe(38);
    expect(layout.markSpace).toBe(36);
    expect(layout.pad).toBe(74);
    expect(layout.width).toBe(750 + 148);
    expect(layout.height).toBe(1050 + 148);
  });

  it('centers a 3×3 grid on A4 with cut lines at every trim edge', () => {
    const layout = sheetLayout(750, 1050);
    expect(layout.page).toEqual({ width: 2480, height: 3508 });
    expect(layout.cells).toHaveLength(9);
    expect(layout.cells[0]).toEqual({ x: 115, y: 179 });
    expect(layout.cutsX).toEqual([115, 865, 1615, 2365]);
    expect(layout.cutsY).toEqual([179, 1229, 2279, 3329]);
  });
});

describe('bleed and sheet composition', () => {
  const card = { width: 750, height: 1050 } as HTMLCanvasElement;

  it('paints margin, bleed, card, and four corner marks', () => {
    const { factory, calls } = fakeCanvasFactory();
    const out = composeBleed(card, 300, factory);
    expect(out.width).toBe(898);
    expect(calls.filter((c) => c.startsWith('fillRect'))).toHaveLength(2);
    expect(calls.filter((c) => c.startsWith('drawImage'))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith('stroke('))).toHaveLength(4);
  });

  it('tiles nine cards over full-length cut lines', () => {
    const { factory, calls } = fakeCanvasFactory();
    const out = composeSheet(card, factory);
    expect(out.width).toBe(2480);
    expect(calls.filter((c) => c.startsWith('drawImage'))).toHaveLength(9);
    expect(calls.filter((c) => c.startsWith('stroke('))).toHaveLength(8); // 4 vertical + 4 horizontal
  });
});

describe('renderCardBlob', () => {
  it('renders through html-to-image and converts to the requested mime', async () => {
    const node = document.createElement('div');
    const blob = await Effect.runPromise(renderCardBlob(node, 'webp'));
    expect(blob.type).toBe('image/webp');
    const { toCanvas } = await import('html-to-image');
    expect(vi.mocked(toCanvas)).toHaveBeenCalledWith(
      node,
      expect.objectContaining({ pixelRatio: 2 }),
    );
  });

  it('composes bleed when requested', async () => {
    const { factory, calls } = fakeCanvasFactory();
    const node = document.createElement('div');
    const blob = await Effect.runPromise(
      renderCardBlob(node, 'png', { bleed: true, createCanvas: factory }),
    );
    expect(blob.type).toBe('image/png');
    expect(calls.some((c) => c.startsWith('drawImage'))).toBe(true);
  });
});

describe('ExportBar', () => {
  it('exports the target node and records it in the injected archive', async () => {
    const archive = CardArchive.new();
    await vi.waitFor(() => {
      expect(archive.ready).toBe(true);
    });
    const node = document.createElement('div');
    const bar = ExportBar.new({ cardName: 'Nyra', target: { current: node } });
    await bar.exportAs('png', archive);
    expect(archive.exports).toHaveLength(1);
    expect(archive.exports[0]?.name).toBe('nyra.png');
    expect(archive.exports[0]?.format).toBe('png');
    expect(bar.note).toContain('nyra.png');
    bar.set(null);
    archive.set(null);
  });

  it('links the render to its card when a cardId prop is set', async () => {
    const archive = CardArchive.new();
    await vi.waitFor(() => {
      expect(archive.ready).toBe(true);
    });
    const node = document.createElement('div');
    const bar = ExportBar.new({
      cardName: 'Nyra',
      cardId: CardId.make('card-7'),
      target: { current: node },
    });
    await bar.exportAs('png', archive);
    expect(archive.exports[0]?.cardId).toBe('card-7');
    bar.set(null);
    archive.set(null);
  });

  it('suffixes file names with print options', async () => {
    const archive = CardArchive.new();
    await vi.waitFor(() => {
      expect(archive.ready).toBe(true);
    });
    const node = document.createElement('div');
    const bar = ExportBar.new({ cardName: 'Nyra', target: { current: node } });
    bar.dpi = 600;
    // bleed composition needs a canvas; keep bleed off in this happy-dom test
    await bar.exportAs('png', archive);
    expect(archive.exports[0]?.name).toBe('nyra-600dpi.png');
    bar.set(null);
    archive.set(null);
  });
});
