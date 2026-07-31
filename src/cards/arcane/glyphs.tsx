import type { CSSProperties } from 'react';
import type { EssenceId } from './palette';
import { paletteFor } from './palette';

/** Hand-drawn essence sigils — the kit's set-symbol language. Fill = currentColor. */
const GLYPH_PATHS: Record<EssenceId, string> = {
  ember:
    'M12 2c1.6 3.8-.8 5.6.2 8.1 2.2-1 2.9-3.3 2.9-3.3 1.9 2.4 2.9 4.8 2.9 7.2a6 6 0 1 1-12 0C6 9.4 10 6.8 12 2z',
  tide: 'M12 3c4 5.4 6 8.4 6 11.9a6 6 0 1 1-12 0C6 11.4 8 8.4 12 3z',
  verdant:
    'M20 4C9.5 4.8 4.6 10.4 4 20c9.6-.6 15.2-5.5 16-16zM6.8 17.2C9 11.6 12.6 8.4 17 6.4c-4.8 3.4-8 6.8-10.2 10.8z',
  radiant:
    'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm-1-7h2v4h-2V1zm0 18h2v4h-2v-4zM1 11h4v2H1v-2zm18 0h4v2h-4v-2zM4.5 3.1l2.9 2.9-1.4 1.4-2.9-2.9 1.4-1.4zm13.6 13.6 2.9 2.9-1.4 1.4-2.9-2.9 1.4-1.4zm2.9-15 1.4 1.4-2.9 2.9-1.4-1.4 2.9-2.9zM6 16.7l1.4 1.4-2.9 2.9-1.4-1.4L6 16.7z',
  umbral: 'M21 14.5A9 9 0 1 1 9.5 3a7.5 7.5 0 0 0 11.5 11.5z',
  relic: 'M12 2l7 10-7 10L5 12l7-10zm0 5.2L8.6 12l3.4 4.8 3.4-4.8L12 7.2z',
};

export function EssenceGlyph(props: {
  essence: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const id = paletteFor(props.essence).id;
  return (
    <svg
      data-testid={`glyph-${id}`}
      viewBox="0 0 24 24"
      width={props.size ?? 14}
      height={props.size ?? 14}
      className={props.className}
      style={props.style}
      aria-hidden="true"
    >
      <path d={GLYPH_PATHS[id]} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

/** Corner flourish; rotate per corner. Stroke = currentColor. */
export function CornerFiligree(props: { className?: string; style?: CSSProperties }) {
  return (
    <svg
      data-testid="filigree"
      viewBox="0 0 40 40"
      width={26}
      height={26}
      className={props.className}
      style={props.style}
      aria-hidden="true"
    >
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M3 37c0-14 6-24 16-30 5-3 12-4 18-3" />
        <path d="M3 37c8-2 13-6 15-12" />
        <circle cx="21" cy="22" r="1.4" fill="currentColor" stroke="none" />
      </g>
    </svg>
  );
}
