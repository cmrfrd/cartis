import { Component } from '@expressive/react';
import { CardSurface } from '../base/CardSurface';
import type { CardData } from '../types';
import { paletteFor } from './palette';
import {
  ArcaneArtWindow,
  ArcaneRulesBox,
  ArcaneStatBadge,
  ArcaneTitleBar,
  ArcaneTypeLine,
  rarityFrom,
} from './parts';

/**
 * The Arcane kit's card. The PascalCase methods here PASS the skills' extension test
 * (react/component.md): each is a renderer a subclass would genuinely replace — that is
 * the whole "build your own card style" story, in the Builder and the Code Lab alike:
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
      />
    );
  }

  StatBadge() {
    const { data, palette } = this;
    return (
      <ArcaneStatBadge
        might={Number(data.might ?? 0)}
        ward={Number(data.ward ?? 0)}
        palette={palette}
      />
    );
  }

  render() {
    const { holo, palette } = this;
    return (
      <CardSurface holo={holo} frameClass={palette.frame}>
        <div className="flex h-full flex-col gap-1.5 p-3.5">
          <this.TitleBar />
          <this.ArtWindow />
          <this.TypeLine />
          <this.RulesBox />
        </div>
        <this.StatBadge />
      </CardSurface>
    );
  }
}
