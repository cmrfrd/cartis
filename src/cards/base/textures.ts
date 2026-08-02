import { Effect } from 'effect';
import type { CSSProperties } from 'react';

/**
 * Procedural print textures. Authored as SVG feTurbulence data-URIs, then
 * pre-rasterized to PNG data-URIs at app startup (prepareTextures) because the
 * export pipeline (html-to-image) cannot rasterize SVG filters — it painted
 * them as solid black. With plain PNGs, the preview IS the print.
 */

function svgDataUrl(svg: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** Monochrome noise whose luminance becomes alpha — overlays tint the surface below. */
export function noiseTextureUrl(opts: {
  frequency: string;
  octaves: number;
  seed: number;
  alpha: number;
  tile?: number;
}): string {
  const tile = opts.tile ?? 240;
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${tile}' height='${tile}'>` +
    `<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='${opts.frequency}' ` +
    `numOctaves='${opts.octaves}' seed='${opts.seed}' stitchTiles='stitch'/>` +
    `<feColorMatrix type='matrix' values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ` +
    `${opts.alpha} ${opts.alpha} ${opts.alpha} 0 0'/></filter>` +
    `<rect width='100%' height='100%' filter='url(#n)'/></svg>`;
  return svgDataUrl(svg);
}

const TILE = 240;

/** Mutable registry: starts as SVG URIs, upgraded to PNG URIs by prepareTextures(). */
export const TEXTURES = {
  /** Soft large-scale mottling — aged parchment discoloration. */
  parchment: noiseTextureUrl({ frequency: '0.012 0.017', octaves: 5, seed: 7, alpha: 0.1 }),
  /** Fine paper grain. */
  grain: noiseTextureUrl({ frequency: '0.9', octaves: 2, seed: 11, alpha: 0.05 }),
  /** Directional weave for the frame — printed linen stock. */
  linen: noiseTextureUrl({ frequency: '0.09 0.55', octaves: 3, seed: 23, alpha: 0.16 }),
  /** Marbled stone mottling for the frame channel — the MTG-frame feel. */
  stone: noiseTextureUrl({ frequency: '0.018 0.026', octaves: 6, seed: 41, alpha: 0.34 }),
};

async function rasterizeToPng(cssUrl: string): Promise<string> {
  const src = cssUrl.slice('url("'.length, -'")'.length);
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('texture image failed to load'));
    image.src = src;
  });
  const canvas = document.createElement('canvas');
  canvas.width = TILE;
  canvas.height = TILE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d unavailable');
  ctx.drawImage(image, 0, 0, TILE, TILE);
  return `url("${canvas.toDataURL('image/png')}")`;
}

/**
 * Upgrade every texture to a plain PNG before first render (called from main.tsx).
 * Environments without canvas (tests) keep the SVG originals — fidelity there is
 * asserted visually, not in unit tests.
 */
export function prepareTextures(): Effect.Effect<void> {
  return Effect.all(
    (Object.keys(TEXTURES) as (keyof typeof TEXTURES)[]).map((key) =>
      Effect.tryPromise({
        try: () => rasterizeToPng(TEXTURES[key]),
        catch: (cause) => cause,
      }).pipe(
        Effect.tap((pngUrl) =>
          Effect.sync(() => {
            TEXTURES[key] = pngUrl;
          }),
        ),
        Effect.catchAll(() => Effect.void), // keep the SVG fallback silently
        Effect.asVoid,
      ),
    ),
    { concurrency: 'unbounded' },
  ).pipe(Effect.asVoid);
}

/** Plate material: parchment + grain, ink rim, bevel, drop shadow, and an
 *  optional essence-colored hairline tracing the plate edge. */
export function plateStyle(accent?: string, opts: { sheen?: boolean } = {}): CSSProperties {
  const sheen = opts.sheen
    ? 'linear-gradient(180deg, rgba(255, 255, 255, 0.28) 0%, rgba(255, 255, 255, 0) 45%, rgba(60, 40, 15, 0.14) 100%), '
    : '';
  return {
    backgroundImage: `${sheen}${TEXTURES.parchment}, ${TEXTURES.grain}`,
    boxShadow: [
      ...(accent ? [`0 0 0 1px ${accent}`] : []), // colored accent ring
      'inset 0 0 8px rgba(62, 38, 16, 0.28)', // ink pooling at the rim
      'inset 0 1px 1px rgba(255, 255, 255, 0.55)', // bevel light (top)
      'inset 0 -1px 2px rgba(62, 38, 16, 0.3)', // bevel shade (bottom)
      '0 2px 3px rgba(0, 0, 0, 0.45)', // drop shadow onto the frame
    ].join(', '),
  };
}

/** Frame-channel stone texture layer. */
export function frameStoneStyle(): CSSProperties {
  return { backgroundImage: TEXTURES.stone, opacity: 0.5 };
}

/** Frame stock: linen weave at plain alpha (no blend modes — they break in export). */
export function frameLinenStyle(): CSSProperties {
  return { backgroundImage: TEXTURES.linen, opacity: 0.55 };
}

/** Press-dot micro pattern; use at very low opacity over the whole card. */
export const halftoneSurface: CSSProperties = {
  backgroundImage: 'radial-gradient(circle, rgba(0, 0, 0, 0.65) 0.6px, transparent 1px)',
  backgroundSize: '4px 4px',
};
