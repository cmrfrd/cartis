import { Component } from '@expressive/react';
import { CardSurface } from '../base/CardSurface';
import type { CardData } from '../types';
import { EssenceGlyph } from './glyphs';
import { paletteFor } from './palette';
import {
  ArcaneCollectorStrip,
  ArcaneCostPips,
  ArcaneStatBadge,
  rarityFrom,
  rarityGemStyle,
} from './parts';
import { ENGRAVED_SHADOW, titleSizeFor } from './typography';

const MYTHIC_AURA =
  '0 0 0 1.5px rgba(255, 150, 60, 0.85), 0 0 16px 2px rgba(194, 37, 37, 0.55), 0 0 30px 8px rgba(255, 180, 94, 0.28), 0 10px 24px rgba(0, 0, 0, 0.5)';

const SMOKE_PLATE = 'rounded-md bg-black/50 px-2.5 py-1';

/**
 * Showcase frame: art fills the card, translucent plates float over it.
 * Deliberately NOT a render() subclass of ArcaneCard — expressive composes
 * subclass renders as children, so full layouts are separate Components
 * built from the same kit parts.
 */
export class ArcaneFullArtCard extends Component {
  data: CardData = {};
  holo = false;

  get palette() {
    return paletteFor(String(this.data.essence ?? 'relic'));
  }

  render() {
    const { data, holo, palette } = this;
    const art = typeof data.art === 'string' && data.art.length > 0 ? data.art : undefined;
    const name = String(data.name ?? 'Unnamed');
    return (
      <CardSurface
        holo={holo}
        foilVariant={data.foilStyle === 'etched' ? 'etched' : 'full'}
        frameClass={palette.frame}
        accent={palette.accent}
        aura={rarityFrom(data.rarity) === 'mythic' ? MYTHIC_AURA : undefined}
        footer={<ArcaneCollectorStrip text={String(data.collector ?? '001/001')} />}
      >
        <div data-testid="fullart-art" className="absolute inset-0 overflow-hidden rounded-[9px]">
          {art ? (
            <img src={art} alt={name} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full items-center justify-center bg-[radial-gradient(circle_at_50%_35%,rgba(255,255,255,0.14),transparent_65%)]">
              <EssenceGlyph
                essence={String(data.essence ?? 'relic')}
                size={90}
                className="text-white/15"
              />
            </div>
          )}
          <div className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/80 via-black/40 to-transparent" />
          <div className="absolute inset-x-0 top-0 h-14 bg-gradient-to-b from-black/70 to-transparent" />
        </div>
        <div className="relative flex h-full flex-col justify-between p-3 pb-1.5">
          <div className={`flex items-center justify-between gap-2 ${SMOKE_PLATE}`}>
            <span
              className="truncate font-display font-bold tracking-wide text-white"
              style={{ fontSize: titleSizeFor(name), textShadow: '0 1px 2px rgba(0,0,0,0.9)' }}
            >
              {name}
            </span>
            <ArcaneCostPips cost={Number(data.cost ?? 0)} palette={palette} />
          </div>
          <div className="space-y-1.5">
            {String(data.typeLine ?? '').trim().length > 0 && (
              <div className={`flex items-center justify-between ${SMOKE_PLATE}`}>
                <span
                  className="truncate font-card text-[12px] font-semibold text-white/90"
                  style={{ fontVariant: 'small-caps' }}
                >
                  {String(data.typeLine ?? '')}
                </span>
                <span
                  className="h-3 w-3 shrink-0 rotate-45 rounded-[2px]"
                  style={rarityGemStyle(rarityFrom(data.rarity))}
                />
              </div>
            )}
            {Boolean(data.ability) && (
              <p className={`font-card text-[13px] leading-snug text-white/95 ${SMOKE_PLATE}`}>
                {String(data.ability)}
              </p>
            )}
          </div>
        </div>
        <this.Stats />
      </CardSurface>
    );
  }

  Stats() {
    const { data, palette } = this;
    if (data.showStats === false) return null;
    return (
      <ArcaneStatBadge
        might={Number(data.might ?? 0)}
        ward={Number(data.ward ?? 0)}
        palette={palette}
      />
    );
  }
}
