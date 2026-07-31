import type { ReactNode } from 'react';
import { halftoneSurface, LINEN_TEXTURE } from './textures';

/** Trading-card preview geometry: 2.5"×3.5" at 150 px/inch; exports double it to 300 DPI. */
export const CARD_WIDTH = 375;
export const CARD_HEIGHT = 525;
/** Printed black border around the frame, like a real card. */
export const CARD_BORDER = 12;

export function CardSurface(props: { holo?: boolean; frameClass?: string; children?: ReactNode }) {
  return (
    <div
      data-card-root="true"
      className="relative overflow-hidden rounded-[18px] bg-[#0d0b09] shadow-xl"
      style={{ width: CARD_WIDTH, height: CARD_HEIGHT }}
    >
      {/* frame area inside the black border; gold pinline seats it */}
      <div
        data-card-frame="true"
        className={`absolute rounded-[9px] ${props.frameClass ?? 'bg-panel'}`}
        style={{
          inset: CARD_BORDER,
          boxShadow: '0 0 0 1px rgba(212, 175, 55, 0.85), 0 0 0 2.5px rgba(0, 0, 0, 0.7)',
        }}
      >
        {/* linen stock texture over the frame gradient */}
        <div
          className="pointer-events-none absolute inset-0 rounded-[9px] opacity-70 mix-blend-overlay"
          style={{ backgroundImage: LINEN_TEXTURE }}
        />
        <div className="relative h-full">{props.children}</div>
      </div>
      {/* press-dot pattern over the whole card, incl. the black border */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ ...halftoneSurface, opacity: 0.045 }}
      />
      <HoloFoil active={props.holo === true} />
    </div>
  );
}

/** Rainbow-sheen overlay approximating holographic foil; also prints nicely as a keepsake. */
export function HoloFoil(props: { active: boolean }) {
  if (!props.active) return null;
  return (
    <div
      data-holo="true"
      className="holo-sheen pointer-events-none absolute inset-0 opacity-60 mix-blend-screen"
    />
  );
}
