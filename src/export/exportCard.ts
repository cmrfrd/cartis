import { Effect } from 'effect';
import { toCanvas } from 'html-to-image';
import { CARD_WIDTH, POINTER_VARS } from '@/cards/base/CardSurface';
import { ExportError } from '@/contracts/errors';
import type { ExportFormat } from '@/storage/CardArchive';

/** Prints must not depend on where the pointer happens to be — force rest state. */
function clearInteractiveVars(node: HTMLElement): void {
  const targets = [node, ...Array.from(node.querySelectorAll<HTMLElement>('[data-card-root]'))];
  for (const el of targets) {
    for (const name of POINTER_VARS) el.style.removeProperty(name);
  }
}

/** 2.5" × 300 DPI. Height follows the node's aspect (525 → 1050). */
export const CARD_EXPORT_WIDTH = 750;

export type ExportDpi = 300 | 600;

export const FORMAT_MIME: Record<ExportFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export function exportPixelRatio(nodeWidth: number, dpi: ExportDpi = 300): number {
  const width = nodeWidth > 0 ? nodeWidth : CARD_WIDTH;
  return (CARD_EXPORT_WIDTH / width) * (dpi / 300);
}

export function exportFileName(name: string, format: ExportFormat): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug.length > 0 ? slug : 'card'}.${format}`;
}

// ---------- print layout math (pure, unit-tested) ----------

/** Standard 1/8" bleed plus a margin band that carries the crop marks. */
export function bleedLayout(cardW: number, cardH: number, dpi: ExportDpi) {
  const bleed = Math.round(0.125 * dpi);
  const markSpace = Math.round(0.12 * dpi);
  const pad = bleed + markSpace;
  return { bleed, markSpace, pad, width: cardW + 2 * pad, height: cardH + 2 * pad };
}

/** 3×3 cards centered on A4 at 300 DPI, with full-length cut lines at every trim edge. */
export function sheetLayout(cardW: number, cardH: number, columns = 3, rows = 3) {
  const page = { width: 2480, height: 3508 }; // A4 @ 300 DPI
  const originX = Math.floor((page.width - cardW * columns) / 2);
  const originY = Math.floor((page.height - cardH * rows) / 2);
  const cells: { x: number; y: number }[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      cells.push({ x: originX + col * cardW, y: originY + row * cardH });
    }
  }
  const cutsX = Array.from({ length: columns + 1 }, (_, i) => originX + i * cardW);
  const cutsY = Array.from({ length: rows + 1 }, (_, i) => originY + i * cardH);
  return { page, cells, cutsX, cutsY };
}

// ---------- canvas composition (factory-injected for tests) ----------

export type CanvasFactory = (width: number, height: number) => HTMLCanvasElement;

const domCanvas: CanvasFactory = (width, height) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d unavailable');
  return ctx;
}

/** White margin with crop marks, black bleed extending the card border, card centered. */
export function composeBleed(
  card: HTMLCanvasElement,
  dpi: ExportDpi,
  createCanvas: CanvasFactory = domCanvas,
): HTMLCanvasElement {
  const { bleed, markSpace, pad, width, height } = bleedLayout(card.width, card.height, dpi);
  const out = createCanvas(width, height);
  const ctx = context2d(out);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#0d0b09'; // bleed continues the printed black border
  ctx.fillRect(markSpace, markSpace, card.width + 2 * bleed, card.height + 2 * bleed);
  ctx.drawImage(card, pad, pad);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = Math.max(1, Math.round(dpi / 300));
  const gap = 6;
  const trims = [
    { x: pad, y: pad },
    { x: pad + card.width, y: pad },
    { x: pad, y: pad + card.height },
    { x: pad + card.width, y: pad + card.height },
  ];
  for (const t of trims) {
    const beforeY = t.y < height / 2;
    const beforeX = t.x < width / 2;
    ctx.beginPath();
    // vertical mark outside the bleed, aligned with the trim x
    ctx.moveTo(t.x, beforeY ? gap : height - markSpace + gap);
    ctx.lineTo(t.x, beforeY ? markSpace - gap : height - gap);
    // horizontal mark outside the bleed, aligned with the trim y
    ctx.moveTo(beforeX ? gap : width - markSpace + gap, t.y);
    ctx.lineTo(beforeX ? markSpace - gap : width - gap, t.y);
    ctx.stroke();
  }
  return out;
}

/** Tile the card 3×3 on an A4 print sheet with cut lines under the cards. */
export function composeSheet(
  card: HTMLCanvasElement,
  createCanvas: CanvasFactory = domCanvas,
): HTMLCanvasElement {
  const { page, cells, cutsX, cutsY } = sheetLayout(card.width, card.height);
  const out = createCanvas(page.width, page.height);
  const ctx = context2d(out);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, page.width, page.height);
  ctx.strokeStyle = '#8a8a8a';
  ctx.lineWidth = 1;
  for (const x of cutsX) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, page.height);
    ctx.stroke();
  }
  for (const y of cutsY) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(page.width, y);
    ctx.stroke();
  }
  for (const cell of cells) {
    ctx.drawImage(card, cell.x, cell.y);
  }
  return out;
}

// ---------- rasterize + encode ----------

export interface RenderOptions {
  quality?: number;
  dpi?: ExportDpi;
  bleed?: boolean;
  createCanvas?: CanvasFactory;
}

function encode(
  canvas: HTMLCanvasElement,
  format: ExportFormat,
  quality: number,
): Effect.Effect<Blob, ExportError> {
  return Effect.tryPromise({
    try: () =>
      new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error(`could not encode ${format}`))),
          FORMAT_MIME[format],
          quality,
        );
      }),
    catch: (cause) =>
      new ExportError({
        detail: cause instanceof Error ? cause.message : `could not encode ${format}`,
      }),
  });
}

/** Rasterize a card DOM node at print resolution and encode to the requested format. */
export function renderCardBlob(
  node: HTMLElement,
  format: ExportFormat,
  options: RenderOptions = {},
): Effect.Effect<Blob, ExportError> {
  const { quality = 0.95, dpi = 300, bleed = false, createCanvas } = options;
  return Effect.gen(function* () {
    clearInteractiveVars(node);
    const canvas = yield* Effect.tryPromise({
      try: () => toCanvas(node, { pixelRatio: exportPixelRatio(node.offsetWidth, dpi) }),
      catch: (cause) =>
        new ExportError({
          detail: cause instanceof Error ? cause.message : 'could not rasterize card',
        }),
    });
    const composed = bleed ? composeBleed(canvas, dpi, createCanvas) : canvas;
    return yield* encode(composed, format, quality);
  });
}

/** Rasterize the card once and tile it onto an A4 3×3 cut sheet (PNG-quality use case). */
export function renderSheetBlob(
  node: HTMLElement,
  options: Pick<RenderOptions, 'createCanvas'> = {},
): Effect.Effect<Blob, ExportError> {
  return Effect.gen(function* () {
    clearInteractiveVars(node);
    const canvas = yield* Effect.tryPromise({
      try: () => toCanvas(node, { pixelRatio: exportPixelRatio(node.offsetWidth, 300) }),
      catch: (cause) =>
        new ExportError({
          detail: cause instanceof Error ? cause.message : 'could not rasterize card',
        }),
    });
    return yield* encode(composeSheet(canvas, options.createCanvas), 'png', 0.95);
  });
}

export function downloadUrl(url: string, fileName: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
