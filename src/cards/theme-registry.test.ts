import { beforeEach, describe, expect, it } from 'vitest';
import { __clearThemesForTests, getLayout, getTheme, listThemes, registerTheme } from './registry';
import type { Theme } from './types';

function fakeTheme(id: string, layoutIds: readonly string[] = ['classic']): Theme {
  return {
    id,
    name: `Theme ${id}`,
    description: 'test theme',
    lookAndFeel: 'painterly',
    CardBack: () => null,
    layouts: layoutIds.map((lid) => ({
      id: lid,
      name: lid,
      description: 'l',
      fields: [{ kind: 'text', key: 'name', label: 'Name' }],
      defaults: { name: 'Test' },
      Render: () => null,
    })),
  };
}

describe('theme registry', () => {
  beforeEach(() => {
    __clearThemesForTests();
  });

  it('registers, gets, lists', () => {
    registerTheme(fakeTheme('t1'));
    expect(getTheme('t1').name).toBe('Theme t1');
    expect(listThemes().map((t) => t.id)).toEqual(['t1']);
  });

  it('gets a layout by theme + layout id', () => {
    registerTheme(fakeTheme('t1', ['classic', 'fullart']));
    expect(getLayout('t1', 'fullart').id).toBe('fullart');
  });

  it('throws on duplicate theme id', () => {
    registerTheme(fakeTheme('t1'));
    expect(() => registerTheme(fakeTheme('t1'))).toThrow(/already registered/);
  });

  it('throws on duplicate layout id within a theme', () => {
    expect(() => registerTheme(fakeTheme('t2', ['dup', 'dup']))).toThrow(/duplicate layout/i);
  });

  it('rejects an identity that fails the schema', () => {
    const bad = { ...fakeTheme('t3'), lookAndFeel: 42 } as unknown as Theme;
    expect(() => registerTheme(bad)).toThrow();
  });

  it('throws on unknown theme / layout', () => {
    expect(() => getTheme('nope')).toThrow(/unknown theme/i);
    registerTheme(fakeTheme('t1'));
    expect(() => getLayout('t1', 'nope')).toThrow(/unknown layout/i);
  });
});
