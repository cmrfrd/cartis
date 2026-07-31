import type { CardTemplate } from './types';

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
