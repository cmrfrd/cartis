import type { GenerationInput, GenerationOutput, ImageProvider } from './provider';

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
export const paintStylizedFrame: PaintFn = async (input, style) => {
  const bitmap = await createImageBitmap(new Blob([input.sourceBytes], { type: input.sourceType }));
  const size = 768;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d unavailable');
  // cover-crop the bitmap into a square
  const scale = Math.max(size / bitmap.width, size / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.filter = 'saturate(1.4) contrast(1.15)';
  ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h);
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'overlay';
  ctx.fillStyle = `hsla(${String(style.hue)}, 70%, 50%, 0.35)`;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over';
  const vignette = ctx.createRadialGradient(
    size / 2,
    size / 2,
    size * 0.35,
    size / 2,
    size / 2,
    size * 0.72,
  );
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, size, size);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
  });
  return { bytes: await blob.arrayBuffer(), type: 'image/png' };
};

export function createStubProvider(paint: PaintFn = paintStylizedFrame): ImageProvider {
  return {
    id: 'stub',
    async generate(input) {
      try {
        return await paint(input, stubStyleFor(input.styleId));
      } catch {
        // canvas unavailable (tests) or decode failure: pass the source through
        return { bytes: input.sourceBytes, type: input.sourceType };
      }
    },
  };
}

export const stubProvider: ImageProvider = createStubProvider();
