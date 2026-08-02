import { Schema } from 'effect';
import { ThemeIdentity } from '../contracts/theme';
import type { CardTemplate, Layout, Theme } from './types';

const templates = new Map<string, CardTemplate>();

export function registerTemplate(template: CardTemplate): void {
  if (templates.has(template.id)) {
    throw new Error(`Template "${template.id}" is already registered`);
  }
  templates.set(template.id, template);
}

export function getTemplate(id: string): CardTemplate {
  const found = templates.get(id);
  if (!found) throw new Error(`Unknown template "${id}"`);
  return found;
}

export function listTemplates(): CardTemplate[] {
  return Array.from(templates.values());
}

export function __clearTemplatesForTests(): void {
  templates.clear();
}

const themes = new Map<string, Theme>();
const decodeIdentity = Schema.decodeUnknownSync(ThemeIdentity);

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
  }
  themes.set(theme.id, theme);
}

export function getTheme(id: string): Theme {
  const found = themes.get(id);
  if (!found) throw new Error(`Unknown theme "${id}"`);
  return found;
}

export function listThemes(): Theme[] {
  return Array.from(themes.values());
}

export function getLayout(themeId: string, layoutId: string): Layout {
  const layout = getTheme(themeId).layouts.find((l) => l.id === layoutId);
  if (!layout) throw new Error(`Unknown layout "${layoutId}" in theme "${themeId}"`);
  return layout;
}

export function __clearThemesForTests(): void {
  themes.clear();
}
