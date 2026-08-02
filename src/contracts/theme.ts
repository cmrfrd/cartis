/**
 * Theme identity + shared theme-context schemas.
 *
 * ThemeIdentity is the data-shaped slice of a Theme (src/cards/types.ts),
 * validated by registerTheme (src/cards/registry.ts). ThemeContext is the
 * prose/JSON block the AI pipelines (fill + image-generate) receive instead
 * of component code — see the spec "AI pipelines" section.
 */

import { Schema } from 'effect';

export const ThemeIdentity = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  lookAndFeel: Schema.String,
});
export type ThemeIdentityT = typeof ThemeIdentity.Type;

export const ThemeContext = Schema.Struct({
  lookAndFeel: Schema.String,
  palette: Schema.String,
  argumentSummary: Schema.String,
});
export type ThemeContextT = typeof ThemeContext.Type;
