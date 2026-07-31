import type { CSSProperties } from 'react';
import { plateStyle } from '../base/textures';
import { EssenceGlyph } from './glyphs';
import type { EssencePalette } from './palette';
import { ENGRAVED_SHADOW, titleSizeFor } from './typography';

export type RarityId = 'common' | 'uncommon' | 'rare' | 'mythic';

export const RARITIES: readonly { value: RarityId; label: string }[] = [
  { value: 'common', label: 'Common' },
  { value: 'uncommon', label: 'Uncommon' },
  { value: 'rare', label: 'Rare' },
  { value: 'mythic', label: 'Mythic' },
];

/** Card data is user-authored JSON — never trust a rarity string without checking. */
export function rarityFrom(value: unknown): RarityId {
  return RARITIES.some((r) => r.value === value) ? (value as RarityId) : 'common';
}

const GEM_COLORS: Record<RarityId, [string, string, string]> = {
  common: ['#5a5a64', '#2e2e34', '#7a7a84'],
  uncommon: ['#e8eef4', '#8a94a0', '#c6ced8'],
  rare: ['#f6df8a', '#a5821f', '#ffd75e'],
  mythic: ['#ffb45e', '#c22525', '#ff7a2f'],
};

/** Faceted gem: conic facets + a specular highlight dot. */
export function rarityGemStyle(rarity: RarityId): CSSProperties {
  const [a, b, c] = GEM_COLORS[rarity];
  return {
    backgroundImage: `radial-gradient(circle at 30% 28%, rgba(255, 255, 255, 0.95) 0%, transparent 28%), conic-gradient(from 45deg, ${a}, ${b} 25%, ${c} 50%, ${b} 75%, ${a})`,
    boxShadow: 'inset 0 0 2px rgba(0, 0, 0, 0.6), 0 1px 2px rgba(0, 0, 0, 0.5)',
  };
}

export function ArcaneCostPips(props: { cost: number; palette: EssencePalette }) {
  const pips = Math.max(0, Math.min(9, Math.round(props.cost)));
  return (
    <span className="flex items-center gap-0.5" data-testid="cost-pips">
      {Array.from({ length: pips }, (_, i) => (
        <span
          key={`pip-${String(i)}`}
          className={`inline-block h-3.5 w-3.5 rounded-full shadow-inner ${props.palette.pip}`}
        />
      ))}
    </span>
  );
}

export function ArcaneTitleBar(props: { name: string; cost: number; palette: EssencePalette }) {
  return (
    <div
      className={`flex items-center justify-between gap-2 rounded-md px-2.5 py-1 ${props.palette.plate}`}
      style={plateStyle()}
    >
      <span
        className={`truncate font-display font-bold tracking-wide ${props.palette.plateText}`}
        style={{ fontSize: titleSizeFor(props.name), textShadow: ENGRAVED_SHADOW }}
      >
        {props.name}
      </span>
      <ArcaneCostPips cost={props.cost} palette={props.palette} />
    </div>
  );
}

export function ArcaneArtWindow(props: { art?: string; alt: string; palette: EssencePalette }) {
  return (
    <div className={`h-[210px] overflow-hidden rounded-sm bg-black/40 ${props.palette.artEdge}`}>
      {props.art ? (
        <img src={props.art} alt={props.alt} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full items-center justify-center bg-[radial-gradient(circle_at_50%_35%,rgba(255,255,255,0.12),transparent_60%)]">
          <span className="font-display text-4xl opacity-30">✶</span>
        </div>
      )}
    </div>
  );
}

export function ArcaneTypeLine(props: {
  text: string;
  rarity: RarityId;
  palette: EssencePalette;
  essenceId?: string;
}) {
  return (
    <div
      className={`flex items-center justify-between rounded-md px-2.5 py-0.5 ${props.palette.plate}`}
      style={plateStyle()}
    >
      <span
        className={`truncate font-card text-[12px] font-semibold ${props.palette.plateText}`}
        style={{ fontVariant: 'small-caps', textShadow: ENGRAVED_SHADOW }}
      >
        {props.text}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <span
          data-testid="set-symbol"
          className={`flex h-4 w-4 items-center justify-center rounded-full ${props.palette.pip}`}
        >
          <EssenceGlyph essence={props.essenceId ?? 'relic'} size={10} />
        </span>
        <span
          data-testid="rarity-gem"
          className="h-3 w-3 shrink-0 rotate-45 rounded-[2px]"
          style={rarityGemStyle(props.rarity)}
        />
      </span>
    </div>
  );
}

export function ArcaneRulesBox(props: {
  ability: string;
  flavor: string;
  palette: EssencePalette;
  essenceId?: string;
}) {
  return (
    <div
      className={`relative flex-1 overflow-hidden rounded-md px-2.5 py-2 ${props.palette.plate}`}
      style={plateStyle()}
    >
      {props.essenceId && (
        <div
          data-testid="watermark"
          className={`pointer-events-none absolute inset-0 flex items-center justify-center ${props.palette.plateText}`}
          style={{ opacity: 0.08 }}
        >
          <EssenceGlyph essence={props.essenceId} size={120} />
        </div>
      )}
      <div className="relative space-y-1.5">
        <p
          className={`whitespace-pre-wrap font-card text-[13.5px] leading-snug ${props.palette.plateText}`}
        >
          {props.ability}
        </p>
        {props.flavor && (
          <p
            className={`font-card text-[12.5px] italic leading-snug opacity-80 ${props.palette.plateText}`}
          >
            {props.flavor}
          </p>
        )}
      </div>
    </div>
  );
}

export function ArcaneStatBadge(props: { might: number; ward: number; palette: EssencePalette }) {
  return (
    <div
      data-testid="stat-badge"
      className="absolute right-3 bottom-[22px] rounded-full p-[2px] shadow-lg"
      style={{
        backgroundImage:
          'conic-gradient(from 210deg, #f0e0a0, #8a6a2f 25%, #f6df8a 50%, #6a4f1f 75%, #f0e0a0)',
      }}
    >
      <div
        className={`whitespace-nowrap rounded-full px-3 py-0.5 font-display text-[15px] font-bold ${props.palette.plate}`}
        style={plateStyle()}
      >
        <span className={props.palette.plateText} style={{ textShadow: ENGRAVED_SHADOW }}>
          {props.might} / {props.ward}
        </span>
      </div>
    </div>
  );
}

/** Tiny print line at the card foot — collector number, dedication, year. */
export function ArcaneCollectorStrip(props: { text: string }) {
  return (
    <div
      data-testid="collector-strip"
      className="flex items-center justify-between px-1 pt-1 font-card text-[8px] tracking-[0.14em] text-white/70 uppercase"
    >
      <span className="truncate">{props.text}</span>
      <span className="shrink-0 pl-2">Cartis</span>
    </div>
  );
}
