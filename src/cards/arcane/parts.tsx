import { plateSurface } from '../base/textures';
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

const RARITY_GEM: Record<RarityId, string> = {
  common: 'bg-[#3a3a40]',
  uncommon: 'bg-gradient-to-br from-[#c0c8d0] to-[#707880]',
  rare: 'bg-gradient-to-br from-[#f0d060] to-[#a08020]',
  mythic: 'bg-gradient-to-br from-[#f08030] to-[#c02020]',
};

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
      style={plateSurface}
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

export function ArcaneTypeLine(props: { text: string; rarity: RarityId; palette: EssencePalette }) {
  return (
    <div
      className={`flex items-center justify-between rounded-md px-2.5 py-0.5 ${props.palette.plate}`}
      style={plateSurface}
    >
      <span
        className={`truncate font-card text-[12px] font-semibold ${props.palette.plateText}`}
        style={{ fontVariant: 'small-caps', textShadow: ENGRAVED_SHADOW }}
      >
        {props.text}
      </span>
      <span
        data-testid="rarity-gem"
        className={`h-3 w-3 shrink-0 rotate-45 rounded-[2px] shadow ${RARITY_GEM[props.rarity]}`}
      />
    </div>
  );
}

export function ArcaneRulesBox(props: {
  ability: string;
  flavor: string;
  palette: EssencePalette;
}) {
  return (
    <div
      className={`flex-1 space-y-1.5 overflow-hidden rounded-md px-2.5 py-2 ${props.palette.plate}`}
      style={plateSurface}
    >
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
  );
}

export function ArcaneStatBadge(props: { might: number; ward: number; palette: EssencePalette }) {
  return (
    <div
      data-testid="stat-badge"
      className={`absolute bottom-2.5 right-3.5 whitespace-nowrap rounded-full px-3 py-0.5 font-display text-[15px] font-bold shadow-lg ${props.palette.plate}`}
      style={plateSurface}
    >
      <span className={props.palette.plateText}>
        {props.might} / {props.ward}
      </span>
    </div>
  );
}
