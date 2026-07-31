import { arcaneFullArtTemplate, arcaneTemplate } from './arcane/template';
import { listTemplates, registerTemplate } from './registry';

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
export { arcaneFullArtTemplate, arcaneTemplate } from './arcane/template';
export { ENGRAVED_SHADOW, titleSizeFor } from './arcane/typography';
export { CARD_HEIGHT, CARD_WIDTH, CardSurface, HoloFoil } from './base/CardSurface';
export { getTemplate, listTemplates, registerTemplate } from './registry';
export type {
  CardData,
  CardRenderer,
  CardRenderProps,
  CardTemplate,
  FieldSpec,
  FieldValue,
} from './types';

/** Idempotent: safe to call from main.tsx and from every test's setup. */
export function registerBuiltinTemplates(): void {
  for (const template of [arcaneTemplate, arcaneFullArtTemplate]) {
    if (!listTemplates().some((t) => t.id === template.id)) {
      registerTemplate(template);
    }
  }
}
