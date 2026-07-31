import { Component } from '@expressive/react';
import { CardSurface } from '../base/CardSurface';
import { CornerFiligree, EssenceGlyph } from './glyphs';

const BACK_FRAME =
  'bg-[radial-gradient(ellipse_at_50%_38%,#2c2340_0%,#1a1528_55%,#100c1a_100%)] border-2 border-[#3a3050]';

/** The shared Cartis card back — print it on the reverse side of any deck. */
export class ArcaneCardBack extends Component {
  holo = false;

  render() {
    const { holo } = this;
    return (
      <CardSurface holo={holo} frameClass={BACK_FRAME}>
        <div
          data-testid="card-back"
          className="relative flex h-full flex-col items-center justify-center gap-5 p-6 text-[#d4af37]"
        >
          <CornerFiligree className="absolute top-1.5 left-1.5 text-[#d4af37]/50" />
          <CornerFiligree
            className="absolute top-1.5 right-1.5 text-[#d4af37]/50"
            style={{ transform: 'scaleX(-1)' }}
          />
          <CornerFiligree
            className="absolute bottom-1.5 left-1.5 text-[#d4af37]/50"
            style={{ transform: 'scaleY(-1)' }}
          />
          <CornerFiligree
            className="absolute right-1.5 bottom-1.5 text-[#d4af37]/50"
            style={{ transform: 'scale(-1)' }}
          />
          <div className="rounded-full border border-[#d4af37]/60 p-7 shadow-[0_0_30px_rgba(212,175,55,0.15),inset_0_0_20px_rgba(212,175,55,0.12)]">
            <EssenceGlyph essence="relic" size={72} className="text-[#d4af37]/80" />
          </div>
          <span className="font-display text-[26px] font-bold tracking-[0.32em] pl-[0.32em]">
            CARTIS
          </span>
          <span className="font-card text-[11px] italic tracking-wide text-[#d4af37]/60">
            every soul a card
          </span>
        </div>
      </CardSurface>
    );
  }
}
