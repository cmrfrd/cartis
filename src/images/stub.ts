/**
 * Pure stub-painting helpers. The canvas stylizer + deterministic style seed
 * survive here (used by the ImageProvider stub path and by tests); the old
 * `ImageProvider` interface + `createStubProvider` wrapper moved to
 * ImageProvider.ts as the Effect service.
 */

import type { AspectRatioT } from '../contracts/fields';

/** Paint I/O shapes — the (optional) source photo in, the stylized frame out. */
export interface GenerationInput {
  /** Empty buffer = text-first generation with no source photo. */
  sourceBytes: ArrayBuffer;
  sourceType: string;
  prompt: string;
  styleId: string;
  /** Replicate aspect — the closed union (e.g. '3:2', 'match_input_image'). */
  aspectRatio?: AspectRatioT;
  themeContext?: { lookAndFeel: string; palette: string; argumentSummary: string };
  argumentValues?: Record<string, string>;
  brief?: string;
  editCurrentArt?: boolean;
  currentArtFileName?: string;
}

export interface GenerationOutput {
  bytes: ArrayBuffer;
  type: string;
}

export interface StubStyle {
  hue: number;
  label: string;
}

/** Deterministic pseudo-style from the styleId so repeated runs look consistent. */
export function stubStyleFor(styleId: string): StubStyle {
  let hash = 7;
  for (const ch of styleId) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return { hue: hash, label: `stubbed ${styleId}` };
}

export type PaintFn = (input: GenerationInput, style: StubStyle) => Promise<GenerationOutput>;

/** Browser-only: tint + vignette the source photo on a canvas as a fake "AI style". */
function dimensionsFor(aspectRatio: AspectRatioT | undefined): { width: number; height: number } {
  const match = /^(\d+):(\d+)$/.exec(aspectRatio ?? '');
  if (!match) return { width: 768, height: 768 };
  const w = Number(match[1]);
  const h = Number(match[2]);
  const scale = Math.sqrt((768 * 768) / (w * h));
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

export const paintStylizedFrame: PaintFn = async (input, style) => {
  const { width, height } = dimensionsFor(input.aspectRatio);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d unavailable');
  if (input.sourceBytes.byteLength > 0) {
    const bitmap = await createImageBitmap(
      new Blob([input.sourceBytes], { type: input.sourceType }),
    );
    // cover-crop the bitmap into the frame
    const scale = Math.max(width / bitmap.width, height / bitmap.height);
    const w = bitmap.width * scale;
    const h = bitmap.height * scale;
    ctx.filter = 'saturate(1.4) contrast(1.15)';
    ctx.drawImage(bitmap, (width - w) / 2, (height - h) / 2, w, h);
    ctx.filter = 'none';
  } else {
    // Text-first with no source photo: deterministic hue-gradient placeholder.
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, `hsl(${String(style.hue)}, 55%, 30%)`);
    gradient.addColorStop(1, `hsl(${String((style.hue + 60) % 360)}, 65%, 18%)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.globalCompositeOperation = 'overlay';
  ctx.fillStyle = `hsla(${String(style.hue)}, 70%, 50%, 0.35)`;
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'source-over';
  const vignette = ctx.createRadialGradient(
    width / 2,
    height / 2,
    Math.min(width, height) * 0.35,
    width / 2,
    height / 2,
    Math.max(width, height) * 0.72,
  );
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
  });
  return { bytes: await blob.arrayBuffer(), type: 'image/png' };
};
