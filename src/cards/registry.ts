import { Option, Schema } from 'effect';
import { FieldSpecList } from '../contracts/fields';
import type { LayoutIdT, ThemeIdT } from '../contracts/ids';
import { ThemeIdentity } from '../contracts/theme';
import type { Layout, Theme } from './types';

const themes = new Map<ThemeIdT, Theme>();
const decodeIdentity = Schema.decodeUnknownSync(ThemeIdentity);
const decodeFieldSpecs = Schema.decodeUnknownSync(FieldSpecList);

export function registerTheme(theme: Theme): void {
  decodeIdentity({
    id: theme.id,
    name: theme.name,
    description: theme.description,
    lookAndFeel: theme.lookAndFeel,
  });
  if (themes.has(theme.id)) {
    throw new Error(`Theme "${theme.id}" is already registered`);
  }
  const seen = new Set<string>();
  for (const layout of theme.layouts) {
    if (seen.has(layout.id)) {
      throw new Error(`Theme "${theme.id}" has a duplicate layout "${layout.id}"`);
    }
    seen.add(layout.id);
    // A malformed field definition is a caught registration error, not a
    // latent shape bug (spec §10) — decode throws with the layout named.
    try {
      decodeFieldSpecs(layout.fields);
    } catch (cause) {
      throw new Error(
        `Theme "${theme.id}" layout "${layout.id}" has invalid field specs: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  }
  themes.set(theme.id, theme);
}

export function getTheme(id: ThemeIdT): Theme {
  const found = themes.get(id);
  if (!found) throw new Error(`Unknown theme "${id}"`);
  return found;
}

/** Absence-typed lookups (spec §3): stored cards may reference unregistered themes. */
export function getThemeOption(id: ThemeIdT): Option.Option<Theme> {
  return Option.fromNullable(themes.get(id));
}

export function getLayoutOption(themeId: ThemeIdT, layoutId: LayoutIdT): Option.Option<Layout> {
  return getThemeOption(themeId).pipe(
    Option.flatMap((theme) => Option.fromNullable(theme.layouts.find((l) => l.id === layoutId))),
  );
}

export function listThemes(): Theme[] {
  return Array.from(themes.values());
}

export function getLayout(themeId: ThemeIdT, layoutId: LayoutIdT): Layout {
  const layout = getTheme(themeId).layouts.find((l) => l.id === layoutId);
  if (!layout) throw new Error(`Unknown layout "${layoutId}" in theme "${themeId}"`);
  return layout;
}

export function __clearThemesForTests(): void {
  themes.clear();
}
