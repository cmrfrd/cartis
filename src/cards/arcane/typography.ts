/** Title auto-fit: Cinzel at 17px fits ~16 chars in the arcane title bar. */
const MAX_SIZE = 17;
const MIN_SIZE = 11;
const FITS_AT = 16;

export function titleSizeFor(name: string): number {
  if (name.length <= FITS_AT) return MAX_SIZE;
  const size = Math.floor(MAX_SIZE - (name.length - FITS_AT) * 0.45);
  return Math.max(MIN_SIZE, size);
}

/** Letterpress: dark text pressed into a light plate. */
export const ENGRAVED_SHADOW = '0 1px 0 rgba(255, 255, 255, 0.45)';
