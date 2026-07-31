import { arcaneTemplate } from './arcane/template';
import { listTemplates, registerTemplate } from './registry';

export { ArcaneCard } from './arcane/ArcaneCard';
export { ESSENCES, type EssenceId, type EssencePalette, paletteFor } from './arcane/palette';
export {
  ArcaneArtWindow,
  ArcaneCostPips,
  ArcaneRulesBox,
  ArcaneStatBadge,
  ArcaneTitleBar,
  ArcaneTypeLine,
  RARITIES,
  type RarityId,
} from './arcane/parts';
export { arcaneTemplate } from './arcane/template';
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
  if (!listTemplates().some((t) => t.id === arcaneTemplate.id)) {
    registerTemplate(arcaneTemplate);
  }
}
