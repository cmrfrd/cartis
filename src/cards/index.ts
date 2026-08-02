import { arcaneTheme } from './arcane/theme';
import { listThemes, registerTheme } from './registry';

export { ArcaneCard } from './arcane/ArcaneCard';
export { ArcaneCardBack } from './arcane/ArcaneCardBack';
export { ArcaneFullArtCard } from './arcane/ArcaneFullArtCard';
export { CornerFiligree, EssenceGlyph } from './arcane/glyphs';
export { ESSENCES, type EssenceId, type EssencePalette, paletteFor } from './arcane/palette';
export {
  ArcaneArtWindow,
  ArcaneCollectorStrip,
  ArcaneCostPips,
  ArcaneRulesBox,
  ArcaneStatBadge,
  ArcaneTitleBar,
  ArcaneTypeLine,
  RARITIES,
  type RarityId,
  rarityFrom,
  rarityGemStyle,
} from './arcane/parts';
export { arcaneFields, arcaneTheme } from './arcane/theme';
export { ENGRAVED_SHADOW, titleSizeFor } from './arcane/typography';
export { CARD_HEIGHT, CARD_WIDTH, CardSurface, HoloFoil } from './base/CardSurface';
export { getLayout, getTheme, listThemes, registerTheme } from './registry';
export type {
  CardData,
  CardRenderer,
  CardRenderProps,
  FieldSpec,
  FieldValue,
  Layout,
  Theme,
} from './types';

/** Idempotent: safe from main.tsx and every test setup. */
export function registerBuiltinThemes(): void {
  for (const theme of [arcaneTheme]) {
    if (!listThemes().some((t) => t.id === theme.id)) {
      registerTheme(theme);
    }
  }
}
