import { toCanvas } from 'html-to-image';
import { CARD_WIDTH } from '../cards/base/CardSurface';
import type { ExportFormat } from '../storage/CardArchive';

/** 2.5" × 300 DPI. Height follows the node's aspect (525 → 1050). */
export const CARD_EXPORT_WIDTH = 750;

export const FORMAT_MIME: Record<ExportFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export function exportPixelRatio(nodeWidth: number): number {
  const width = nodeWidth > 0 ? nodeWidth : CARD_WIDTH;
  return CARD_EXPORT_WIDTH / width;
}

export function exportFileName(name: string, format: ExportFormat): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug.length > 0 ? slug : 'card'}.${format}`;
}

/** Rasterize a card DOM node at print resolution and encode to the requested format. */
export async function renderCardBlob(
  node: HTMLElement,
  format: ExportFormat,
  quality = 0.95,
): Promise<Blob> {
  const canvas = await toCanvas(node, { pixelRatio: exportPixelRatio(node.offsetWidth) });
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(`could not encode ${format}`))),
      FORMAT_MIME[format],
      quality,
    );
  });
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
