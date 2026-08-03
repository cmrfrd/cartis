import { Array as Arr } from 'effect';
import { beforeEach, describe, expect, it } from 'vitest';
import { LayoutId, ThemeId } from '../contracts/ids';
import { __clearThemesForTests, getLayout, getTheme, listThemes, registerTheme } from './registry';
import type { Layout, Theme } from './types';

function fakeLayout(lid: string): Layout {
  return {
    id: LayoutId.make(lid),
    name: lid,
    description: 'l',
    fields: [{ kind: 'text', key: 'name', label: 'Name' }],
    defaults: { name: 'Test' },
    Render: () => null,
  };
}

function fakeTheme(id: string, layoutIds: readonly string[] = ['classic']): Theme {
  const [head = 'classic', ...tail] = layoutIds;
  return {
    id: ThemeId.make(id),
    name: `Theme ${id}`,
    description: 'test theme',
    lookAndFeel: 'painterly',
    CardBack: () => null,
    layouts: Arr.prepend(tail.map(fakeLayout), fakeLayout(head)),
  };
}

describe('theme registry', () => {
  beforeEach(() => {
    __clearThemesForTests();
  });

  it('registers, gets, lists', () => {
    registerTheme(fakeTheme('t1'));
    expect(getTheme(ThemeId.make('t1')).name).toBe('Theme t1');
    expect(listThemes().map((t) => t.id)).toEqual(['t1']);
  });

  it('gets a layout by theme + layout id', () => {
    registerTheme(fakeTheme('t1', ['classic', 'fullart']));
    expect(getLayout(ThemeId.make('t1'), LayoutId.make('fullart')).id).toBe('fullart');
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

  it('rejects a layout whose field specs fail the FieldSpec schema', () => {
    const theme = fakeTheme('t4');
    const broken = {
      ...theme,
      layouts: [
        {
          ...theme.layouts[0],
          // number field missing its required min/max
          fields: [{ kind: 'number', key: 'cost', label: 'Cost' }],
        },
      ],
    } as unknown as Theme;
    expect(() => registerTheme(broken)).toThrow(/invalid field specs/i);
  });

  it('throws on unknown theme / layout', () => {
    expect(() => getTheme(ThemeId.make('nope'))).toThrow(/unknown theme/i);
    registerTheme(fakeTheme('t1'));
    expect(() => getLayout(ThemeId.make('t1'), LayoutId.make('nope'))).toThrow(/unknown layout/i);
  });
});
