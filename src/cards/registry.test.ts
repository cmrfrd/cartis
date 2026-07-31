import { beforeEach, describe, expect, it } from 'vitest';
import { __clearTemplatesForTests, getTemplate, listTemplates, registerTemplate } from './registry';
import type { CardTemplate } from './types';

function fakeTemplate(id: string): CardTemplate {
  return {
    id,
    kitId: 'test',
    name: `Template ${id}`,
    description: 'test template',
    fields: [{ kind: 'text', key: 'name', label: 'Name' }],
    defaults: { name: 'Test' },
    artStylePrompt: () => 'test style',
    Render: () => null,
  };
}

describe('template registry', () => {
  beforeEach(() => {
    __clearTemplatesForTests();
  });

  it('registers and retrieves a template', () => {
    registerTemplate(fakeTemplate('t1'));
    expect(getTemplate('t1').name).toBe('Template t1');
    expect(listTemplates().map((t) => t.id)).toEqual(['t1']);
  });

  it('throws on duplicate registration', () => {
    registerTemplate(fakeTemplate('t1'));
    expect(() => registerTemplate(fakeTemplate('t1'))).toThrow(/already registered/);
  });

  it('throws on unknown template id', () => {
    expect(() => getTemplate('nope')).toThrow(/unknown template/i);
  });
});
