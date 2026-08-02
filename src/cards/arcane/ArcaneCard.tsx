import { Component } from '@expressive/react';
import { CardSurface } from '../base/CardSurface';
import type { CardData } from '../types';
import { CornerFiligree } from './glyphs';
import { paletteFor } from './palette';
import {
  ArcaneArtWindow,
  ArcaneCollectorStrip,
  ArcaneRulesBox,
  ArcaneStatBadge,
  ArcaneTitleBar,
  ArcaneTypeLine,
  rarityFrom,
} from './parts';

/** Prismatic outer glow reserved for mythics; the 1.5px ring survives print crops. */
const MYTHIC_AURA =
  '0 0 0 1.5px rgba(255, 150, 60, 0.85), 0 0 16px 2px rgba(194, 37, 37, 0.55), 0 0 30px 8px rgba(255, 180, 94, 0.28), 0 10px 24px rgba(0, 0, 0, 0.5)';

/**
 * The Arcane kit's card. The PascalCase methods here PASS the skills' extension test
 * (react/component.md): each is a renderer a subclass would genuinely replace — that is
 * the whole "build your own card style" story in the Builder:
 *   class MyCard extends ArcaneCard { TitleBar = () => <div>custom</div> }
 * (Views elsewhere must NOT copy this pattern for mere implementation scoping.)
 */
export class ArcaneCard extends Component {
  data: CardData = {};
  holo = false;

  get palette() {
    return paletteFor(String(this.data.essence ?? 'relic'));
  }

  TitleBar() {
    const { data, palette } = this;
    return (
      <ArcaneTitleBar
        name={String(data.name ?? 'Unnamed')}
        cost={Number(data.cost ?? 0)}
        palette={palette}
      />
    );
  }

  ArtWindow() {
    const { data, palette } = this;
    const art = data.art;
    return (
      <ArcaneArtWindow
        art={typeof art === 'string' && art.length > 0 ? art : undefined}
        alt={String(data.name ?? 'card art')}
        palette={palette}
      />
    );
  }

  TypeLine() {
    const { data, palette } = this;
    return (
      <ArcaneTypeLine
        text={String(data.typeLine ?? '')}
        rarity={rarityFrom(data.rarity)}
        palette={palette}
        essenceId={String(data.essence ?? 'relic')}
      />
    );
  }

  RulesBox() {
    const { data, palette } = this;
    return (
      <ArcaneRulesBox
        ability={String(data.ability ?? '')}
        flavor={String(data.flavor ?? '')}
        palette={palette}
        essenceId={String(data.essence ?? 'relic')}
      />
    );
  }

  StatBadge() {
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

  CollectorStrip() {
    const { data } = this;
    return <ArcaneCollectorStrip text={String(data.collector ?? '001/001')} />;
  }

  render() {
    const { data, holo, palette } = this;
    const mythic = rarityFrom(data.rarity) === 'mythic';
    return (
      <CardSurface
        holo={holo}
        foilVariant={data.foilStyle === 'etched' ? 'etched' : 'full'}
        frameClass={palette.frame}
        accent={palette.accent}
        aura={mythic ? MYTHIC_AURA : undefined}
        footer={<this.CollectorStrip />}
      >
        <div className="flex h-full flex-col gap-[3px] p-[7px] pb-2">
          <this.TitleBar />
          <this.ArtWindow />
          <this.TypeLine />
          <this.RulesBox />
        </div>
        <this.StatBadge />
        <CornerFiligree className="pointer-events-none absolute top-0.5 left-0.5 text-[#d4af37]/40" />
        <CornerFiligree
          className="pointer-events-none absolute top-0.5 right-0.5 text-[#d4af37]/40"
          style={{ transform: 'scaleX(-1)' }}
        />
      </CardSurface>
    );
  }
}
