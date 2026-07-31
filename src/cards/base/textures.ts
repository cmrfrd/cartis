import type { CSSProperties } from 'react';

/**
 * Procedural print textures: SVG feTurbulence encoded as data-URIs.
 * Zero binary assets, deterministic (fixed seeds), fully offline, and they
 * rasterize through html-to-image — the preview IS the print.
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

/** Soft large-scale mottling — aged parchment discoloration. */
export const PARCHMENT_MOTTLE = noiseTextureUrl({
  frequency: '0.012 0.017',
  octaves: 5,
  seed: 7,
  alpha: 0.1,
});

/** Fine paper grain. */
export const PAPER_GRAIN = noiseTextureUrl({
  frequency: '0.9',
  octaves: 2,
  seed: 11,
  alpha: 0.05,
});

/** Directional weave for the frame — printed linen stock. */
export const LINEN_TEXTURE = noiseTextureUrl({
  frequency: '0.09 0.55',
  octaves: 3,
  seed: 23,
  alpha: 0.16,
});

/** Plate material: parchment mottle + grain, ink-darkened rim, raised bevel. */
export const plateSurface: CSSProperties = {
  backgroundImage: `${PARCHMENT_MOTTLE}, ${PAPER_GRAIN}`,
  boxShadow: [
    'inset 0 0 8px rgba(62, 38, 16, 0.28)', // ink pooling at the rim
    'inset 0 1px 1px rgba(255, 255, 255, 0.55)', // bevel light (top)
    'inset 0 -1px 2px rgba(62, 38, 16, 0.3)', // bevel shade (bottom)
    '0 1px 2px rgba(0, 0, 0, 0.4)', // lift off the frame
  ].join(', '),
};

/** Press-dot micro pattern; use at very low opacity over the whole card. */
export const halftoneSurface: CSSProperties = {
  backgroundImage: 'radial-gradient(circle, rgba(0, 0, 0, 0.65) 0.6px, transparent 1px)',
  backgroundSize: '4px 4px',
};
