import type { ReactNode } from 'react';

/** Trading-card preview geometry: 2.5"×3.5" at 150 px/inch; exports double it to 300 DPI. */
export const CARD_WIDTH = 375;
export const CARD_HEIGHT = 525;

export function CardSurface(props: { holo?: boolean; frameClass?: string; children?: ReactNode }) {
  return (
    <div
      data-card-root="true"
      className={`relative overflow-hidden rounded-[18px] shadow-xl ${props.frameClass ?? 'bg-panel'}`}
      style={{ width: CARD_WIDTH, height: CARD_HEIGHT }}
    >
      {props.children}
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
