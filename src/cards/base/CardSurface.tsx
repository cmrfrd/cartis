import type { Component } from '@expressive/react';
// PointerEvent stays a host (DOM) type — expressive has no equivalent.
import type { PointerEvent } from 'react';
import { frameLinenStyle, frameStoneStyle, halftoneSurface } from './textures';

/** Trading-card preview geometry: 2.5"×3.5" at 150 px/inch; exports double it to 300 DPI. */
export const CARD_WIDTH = 375;
export const CARD_HEIGHT = 525;
/** Printed black border around the frame, like a real card. */
export const CARD_BORDER = 12;
/** Taller bottom band of the black border — hosts the collector line, like a real card. */
export const CARD_FOOTER = 26;

/** Interactive-only CSS vars; exports strip these so prints always use rest defaults. */
export const POINTER_VARS = ['--holo-x', '--holo-y', '--tilt-x', '--tilt-y'];

/** Imperative CSS-var writes: no state, no re-render, and the export always sees rest defaults. */
function trackPointer(e: PointerEvent<HTMLDivElement>) {
  const el = e.currentTarget;
  const rect = el.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  el.style.setProperty('--holo-x', `${(x * 100).toFixed(1)}%`);
  el.style.setProperty('--holo-y', `${(y * 100).toFixed(1)}%`);
  el.style.setProperty('--tilt-x', `${((0.5 - y) * 8).toFixed(2)}deg`);
  el.style.setProperty('--tilt-y', `${((x - 0.5) * 10).toFixed(2)}deg`);
}

function resetPointer(e: PointerEvent<HTMLDivElement>) {
  for (const name of POINTER_VARS) e.currentTarget.style.removeProperty(name);
}

export type FoilVariant = 'full' | 'etched';

export function CardSurface(props: {
  holo?: boolean;
  foilVariant?: FoilVariant;
  frameClass?: string;
  /** Essence pinstripe traced just inside the gold pinline. */
  accent?: string;
  /** Extra outer glow (e.g. mythic aura); replaces the default drop shadow. */
  aura?: string;
  /** Rendered on the bottom black-border band (collector line). */
  footer?: Component.Node;
  children?: Component.Node;
}) {
  return (
    <div
      data-card-root="true"
      // text-left: the card OWNS its typography — browsers' UA stylesheet
      // centers text inside <button> (the gallery tile wrapper), and
      // text-align inherits; without this the face renders differently
      // depending on what wraps it (live-caught: centered tiles).
      className={`relative overflow-hidden rounded-[18px] text-left bg-[#0d0b09] ${props.aura ? '' : 'shadow-xl'}`}
      style={{
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        boxShadow: props.aura,
        transform: 'perspective(1100px) rotateX(var(--tilt-x, 0deg)) rotateY(var(--tilt-y, 0deg))',
      }}
      onPointerMove={trackPointer}
      onPointerLeave={resetPointer}
    >
      {/* frame area inside the black border; gold pinline seats it */}
      <div
        data-card-frame="true"
        className={`absolute rounded-[9px] ${props.frameClass ?? 'bg-panel'}`}
        style={{
          inset: `${CARD_BORDER}px ${CARD_BORDER}px ${CARD_FOOTER}px`,
          boxShadow: [
            '0 0 0 1px rgba(212, 175, 55, 0.85)',
            '0 0 0 2.5px rgba(0, 0, 0, 0.7)',
            ...(props.accent ? [`inset 0 0 0 1px ${props.accent}66`] : []),
            'inset 0 1px 1px rgba(255, 255, 255, 0.22)',
            'inset 0 -2px 3px rgba(0, 0, 0, 0.35)',
          ].join(', '),
        }}
      >
        {/* stone channel + linen stock over the frame gradient */}
        <div
          className="pointer-events-none absolute inset-0 rounded-[9px]"
          style={frameStoneStyle()}
        />
        <div
          className="pointer-events-none absolute inset-0 rounded-[9px]"
          style={frameLinenStyle()}
        />
        <div className="relative h-full">{props.children}</div>
      </div>
      {props.footer && (
        <div
          data-card-footer="true"
          className="absolute inset-x-3 bottom-0 flex items-center"
          style={{ height: CARD_FOOTER }}
        >
          {props.footer}
        </div>
      )}
      {/* press-dot pattern over the whole card, incl. the black border */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ ...halftoneSurface, opacity: 0.045 }}
      />
      <HoloFoil active={props.holo === true} variant={props.foilVariant} />
    </div>
  );
}

/** Layered rainbow foil; `etched` renders fine striations instead of the full gloss. */
export function HoloFoil(props: { active: boolean; variant?: FoilVariant }) {
  if (!props.active) return null;
  const etched = props.variant === 'etched';
  return (
    <div
      data-holo="true"
      data-holo-variant={etched ? 'etched' : 'full'}
      className={`pointer-events-none absolute inset-0 ${etched ? 'holo-etched' : 'holo-foil'}`}
    />
  );
}
