# Themes & Layouts — implementation plan

**Date:** 2026-08-02 · **Spec:** `docs/superpowers/specs/2026-08-01-themes-layouts-design.md` · **Status:** ready to execute

## For agentic workers

**REQUIRED SUB-SKILL:** invoke `superpowers:subagent-driven-development` (recommended, tasks are largely independent within their ordering) or `superpowers:executing-plans` before starting. Each task below is written so its worker sees ONLY its own task text — every type/function a task consumes is either defined in an earlier task's **Produces** or cited to a source `file:line`. Follow TDD: write the failing test, run it, confirm the failure, implement, run, confirm green, commit.

## Goal

Replace the flat `CardTemplate` with first-class **Theme** and **Layout** concepts, collapse the app to two tabs (Builder / Gallery), and repurpose the opencode agent for conversational AI form-fill and LLM-composed, text-first art generation.

## Architecture

Themes are code-defined objects carrying Schema-validated identity (`id`/`name`/`description`/`lookAndFeel`) plus code (`CardBack`, ordered `layouts[]`, optional `artFlavor(data)`); each Layout owns its `fields`/`defaults`/`artAspect`/`Render`. A new registry (`registerTheme`/`getTheme`/`listThemes`/`getLayout`) sits beside the old template registry until consumers flip, then the template half is deleted. AI features run through the existing dev-server bridge (`AgentClient` for opencode sessions, `ReplicateClient` for image gen); a new `POST /api/agent/fill` returns a targeted `Partial<CardData>` patch (Schema-decoded from a spec-derived Schema) plus an optional `artAction`, and `POST /api/image/generate` gains an LLM composition step ahead of replicate.

## Tech Stack

- **Runtime:** Bun; Vite 8 dev server hosts both the app and the `/api/*` bridge (`src/server/agentBridge.ts` `cartisBridge()` vite plugin).
- **UI:** `@expressive/react` 0.83 (`Component`/`State` classes, `.get()` contextual reads), React 19, Tailwind 4.
- **Effect:** `effect` 3.22, `@effect/platform` 0.97 (`HttpClient`). Services are `Context.Tag` classes; errors are `Data.TaggedError` (`src/contracts/errors.ts`); all external data decoded through `Schema`.
- **Agent:** `@opencode-ai/sdk` 1.18 (dynamic-imported in `agentClientLive`); `replicate` 1.4 (`flux-kontext-pro`).
- **Tests:** vitest 4 + happy-dom; `it.effect`/`it.scoped` from `test/effect.ts`; `mount`/`mountApp`/`click`/`setInput`/`tick` from `test/util.tsx`; service fakes via `setAppLayer`/`testAppLayerWith` (`src/app/runtime.ts`).

## Global Constraints (verbatim — every task obeys these)

- **Gate after EVERY task:** `bun run verify` must be green. It runs `biome ci . && tsc --noEmit && vitest run` (`package.json:14`).
- **Effect v3 idioms as established here:** `Context.Tag` service classes; `Data.TaggedError` for failures (`src/contracts/errors.ts`); `Schema` decode of ALL external data; **no `as` on external data**, **no `any`**, **no non-null `!`**.
- **Expressive↔Effect boundary pattern** (copy from `src/storage/CardArchive.ts:68-86` and `src/builder/PortraitSection.tsx:52-104`): snapshot reactive fields into locals BEFORE building the effect (never read `this.*` inside `Effect.gen`); build effect → `runAppExit` → `Exit.isFailure`/`isSuccess` match → assign result / set note via `noteFromCause(exit.cause)`; toggle `busy` in `finally`; guard destroyed instances with `if (this.get(null)) return;` in async loaders; event-handler-style writes to `this` (e.g. `ActivityFeed.push`) are the sanctioned exception.
- **Tests:** `it.effect`/`it.scoped` (from `test/effect.ts`) for Effect code; plain `vitest` + happy-dom + `mount()`/`mountApp()` (`test/util.tsx`) for components; `setAppLayer`/`testAppLayerWith` seam for service fakes; a `__clearThemesForTests()` analog of `__clearTemplatesForTests` (`src/cards/registry.ts:22`) resets the registry per test.
- **Card TSX renders are UNTOUCHED — pixel output identical.** Do not edit `ArcaneCard`, `ArcaneFullArtCard`, `ArcaneCardBack`, `parts.tsx`, `glyphs.tsx`, `CardSurface`, `textures.ts`, `typography.ts`, `palette.ts` (except reading exports).
- **Local-only repo, never push.** Conventional commits, each ending with exactly:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

---

## Task A — Theme/Layout model beside the old one (non-breaking)

Introduce `Theme`/`Layout` types, `src/contracts/theme.ts` (`ThemeIdentity` + `ThemeContext`), a theme registry ALONGSIDE the template registry, `arcaneTheme`, and `registerBuiltinThemes`. Nothing is deleted here; consumers still use templates until Task B.

### Files

- **Create** `src/contracts/theme.ts` — `ThemeIdentity`, `ThemeContext` schemas.
- **Create** `src/cards/arcane/theme.ts` — `arcaneTheme`, `arcaneFields`.
- **Modify** `src/cards/types.ts` — add `Theme`, `Layout` interfaces (keep `CardTemplate`).
- **Modify** `src/cards/registry.ts` — add theme registry functions beside the template ones.
- **Modify** `src/cards/index.ts` — export new names; add `registerBuiltinThemes`.
- **Modify** `src/main.tsx:9` — call `registerBuiltinThemes()` alongside `registerBuiltinTemplates()`.
- **Modify** `test/setup.ts` — clear + register themes each test.
- **Test** `src/contracts/theme.test.ts` — `ThemeIdentity` decode success/failure; `ThemeContext` shape.
- **Test** `src/cards/theme-registry.test.ts` — register/get/list/getLayout/duplicate-theme/duplicate-layout/identity-schema-failure.
- **Test** `src/cards/arcane/arcane-theme.test.ts` — arcane theme shape.

### Interfaces

**Produces** (later tasks consume):
- `src/contracts/theme.ts`: `ThemeIdentity` (Schema.Struct `{ id, name, description, lookAndFeel: string }`), `ThemeIdentityT`; `ThemeContext` (Schema.Struct `{ lookAndFeel: string, palette: string, argumentSummary: string }`), `ThemeContextT`.
- `src/cards/types.ts`: `interface Theme { id; name; description; lookAndFeel; CardBack: CardRenderer; layouts: readonly Layout[]; artFlavor?: (data: CardData) => string }`; `interface Layout { id; name; description; fields: readonly FieldSpec[]; defaults: CardData; artAspect?: string; Render: CardRenderer }`.
- `src/cards/registry.ts`: `registerTheme(theme: Theme): void`; `getTheme(id: string): Theme`; `listThemes(): Theme[]`; `getLayout(themeId: string, layoutId: string): Layout`; `__clearThemesForTests(): void`.
- `src/cards/index.ts`: `registerBuiltinThemes(): void`; re-exports `Theme`, `Layout`, `arcaneTheme`, registry fns.
- `src/cards/arcane/theme.ts`: `arcaneTheme: Theme`; `arcaneFields: readonly FieldSpec[]`.

**Consumes** (already in codebase): `FieldSpec`, `CardData`, `CardRenderer` (`src/cards/types.ts:15,7,34`); `paletteFor`, `ESSENCES` (`src/cards/arcane/palette.ts:90,21`); `RARITIES` (`src/cards/arcane/parts.tsx`); `ArcaneCard`, `ArcaneFullArtCard`, `ArcaneCardBack`.

### Steps

- [ ] Write `src/contracts/theme.test.ts` asserting a valid identity decodes and a missing `lookAndFeel` throws:
  ```ts
  import { Schema } from 'effect';
  import { describe, expect, it } from 'vitest';
  import { ThemeContext, ThemeIdentity } from './theme';

  describe('ThemeIdentity', () => {
    it('decodes a full identity', () => {
      const decoded = Schema.decodeUnknownSync(ThemeIdentity)({
        id: 'arcane',
        name: 'Arcane',
        description: 'a world',
        lookAndFeel: 'painterly oil brushwork',
      });
      expect(decoded.id).toBe('arcane');
    });

    it('rejects a missing lookAndFeel', () => {
      expect(() =>
        Schema.decodeUnknownSync(ThemeIdentity)({ id: 'x', name: 'X', description: 'd' }),
      ).toThrow();
    });
  });

  describe('ThemeContext', () => {
    it('decodes the shared context block', () => {
      const decoded = Schema.decodeUnknownSync(ThemeContext)({
        lookAndFeel: 'oil',
        palette: 'ember warm',
        argumentSummary: 'name, essence',
      });
      expect(decoded.palette).toBe('ember warm');
    });
  });
  ```
- [ ] Run `bunx vitest run src/contracts/theme.test.ts` — expect failure (module missing).
- [ ] Create `src/contracts/theme.ts`:
  ```ts
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
  ```
- [ ] Run `bunx vitest run src/contracts/theme.test.ts` — expect pass.
- [ ] Add `Theme` and `Layout` interfaces to `src/cards/types.ts` after `CardTemplate` (leave `CardTemplate` intact):
  ```ts
  /** A card face: how theme components organize into a layout, parameterized by arguments. */
  export interface Layout {
    id: string;
    name: string;
    description: string;
    fields: readonly FieldSpec[];
    defaults: CardData;
    /** Preferred replicate aspect for this layout's art slot (e.g. '3:2'). */
    artAspect?: string;
    Render: CardRenderer;
  }

  /** A collection/world: identity + shared code parts + ordered layouts. */
  export interface Theme {
    id: string;
    name: string;
    description: string;
    /** Prose visual identity consumed by the AI art + fill pipelines. */
    lookAndFeel: string;
    CardBack: CardRenderer;
    /** Ordered; layouts[0] is the default. */
    layouts: readonly Layout[];
    /** Optional per-card flavor derived from data (e.g. palette artFlavor). */
    artFlavor?: (data: CardData) => string;
  }
  ```
- [ ] Write `src/cards/theme-registry.test.ts`:
  ```ts
  import { beforeEach, describe, expect, it } from 'vitest';
  import {
    __clearThemesForTests,
    getLayout,
    getTheme,
    listThemes,
    registerTheme,
  } from './registry';
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
  ```
- [ ] Run `bunx vitest run src/cards/theme-registry.test.ts` — expect failure.
- [ ] Add the theme registry to `src/cards/registry.ts` (below the existing template map; keep the template functions):
  ```ts
  import { Schema } from 'effect';
  import { ThemeIdentity } from '../contracts/theme';
  import type { CardTemplate, Layout, Theme } from './types';

  // ... existing template map + registerTemplate/getTemplate/listTemplates/__clearTemplatesForTests ...

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
  ```
  Note: keep the existing `import type { CardTemplate } from './types';` merged into the combined import shown above.
- [ ] Run `bunx vitest run src/cards/theme-registry.test.ts` — expect pass.
- [ ] Write `src/cards/arcane/arcane-theme.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest';
  import { paletteFor } from './palette';
  import { arcaneFields, arcaneTheme } from './theme';

  describe('arcaneTheme', () => {
    it('has arcane identity and two layouts sharing one field list', () => {
      expect(arcaneTheme.id).toBe('arcane');
      expect(arcaneTheme.name).toBe('Arcane');
      expect(arcaneTheme.lookAndFeel.toLowerCase()).toContain('oil');
      expect(arcaneTheme.layouts.map((l) => l.id)).toEqual(['classic', 'fullart']);
      expect(arcaneTheme.layouts[0]?.fields).toBe(arcaneFields);
      expect(arcaneTheme.layouts[1]?.fields).toBe(arcaneFields);
    });

    it('classic + fullart carry the right aspects and fullart defaults override', () => {
      expect(arcaneTheme.layouts[0]?.artAspect).toBe('3:2');
      expect(arcaneTheme.layouts[1]?.artAspect).toBe('3:4');
      expect(arcaneTheme.layouts[1]?.defaults.name).toBe('Nyra, Unbound');
      expect(arcaneTheme.layouts[1]?.defaults.flavor).toBe('');
    });

    it('artFlavor pulls per-essence flavor from the palette', () => {
      expect(arcaneTheme.artFlavor?.({ essence: 'tide' })).toBe(paletteFor('tide').artFlavor);
    });
  });
  ```
- [ ] Run `bunx vitest run src/cards/arcane/arcane-theme.test.ts` — expect failure.
- [ ] Create `src/cards/arcane/theme.ts` (fields/defaults copied verbatim from `template.ts:13-68`; `lookAndFeel` distilled from `template.ts:69-75` art prose minus per-essence bits):
  ```ts
  import type { FieldSpec, Theme } from '../types';
  import { ArcaneCard } from './ArcaneCard';
  import { ArcaneCardBack } from './ArcaneCardBack';
  import { ArcaneFullArtCard } from './ArcaneFullArtCard';
  import { ESSENCES, paletteFor } from './palette';
  import { RARITIES } from './parts';

  /** Shared argument list for every Arcane layout (code reuse per spec §Layouts). */
  export const arcaneFields: readonly FieldSpec[] = [
    { kind: 'text', key: 'name', label: 'Name', placeholder: 'Nyra, Ember Sage', maxLength: 28 },
    {
      kind: 'select',
      key: 'essence',
      label: 'Essence',
      options: ESSENCES.map((e) => ({ value: e.id, label: e.label })),
    },
    { kind: 'number', key: 'cost', label: 'Cost', min: 0, max: 9 },
    { kind: 'image', key: 'art', label: 'Portrait' },
    { kind: 'text', key: 'typeLine', label: 'Type line', placeholder: 'Hero — Baker' },
    { kind: 'textarea', key: 'ability', label: 'Ability', rows: 3 },
    { kind: 'textarea', key: 'flavor', label: 'Flavor text', rows: 2 },
    { kind: 'toggle', key: 'showStats', label: 'Might / Ward' },
    {
      kind: 'number',
      key: 'might',
      label: 'Might',
      min: 0,
      max: 20,
      showIf: { key: 'showStats', equals: true },
    },
    {
      kind: 'number',
      key: 'ward',
      label: 'Ward',
      min: 0,
      max: 20,
      showIf: { key: 'showStats', equals: true },
    },
    { kind: 'select', key: 'rarity', label: 'Rarity', options: RARITIES },
    {
      kind: 'select',
      key: 'foilStyle',
      label: 'Foil style',
      options: [
        { value: 'full', label: 'Full gloss' },
        { value: 'etched', label: 'Etched' },
      ],
    },
    { kind: 'text', key: 'collector', label: 'Collector line', maxLength: 40 },
  ];

  const arcaneDefaults = {
    name: 'Nyra, Ember Sage',
    essence: 'ember',
    cost: 3,
    typeLine: 'Hero — Pyromancer',
    ability: 'When Nyra enters play, deal 2 damage to any target.',
    flavor: '“The spark was always hers to keep.”',
    showStats: true,
    might: 2,
    ward: 3,
    rarity: 'rare',
    foilStyle: 'full',
    collector: '001/001 · Cartis Original',
  } as const;

  export const arcaneTheme: Theme = {
    id: 'arcane',
    name: 'Arcane',
    description:
      'Cartis take on a classic fantasy trading card: essence frame, ability box, might/ward.',
    lookAndFeel:
      'Fantasy oil painting, head-and-shoulders portrait subjects, dramatic lighting, ' +
      'visible canvas texture, painterly oil brushwork, ornate trading card illustration.',
    CardBack: ArcaneCardBack,
    artFlavor: (data) => paletteFor(String(data.essence ?? 'relic')).artFlavor,
    layouts: [
      {
        id: 'classic',
        name: 'Arcane Hero',
        description:
          'Cartis take on a classic fantasy trading card: essence frame, ability box, might/ward.',
        fields: arcaneFields,
        defaults: { ...arcaneDefaults },
        artAspect: '3:2',
        Render: ArcaneCard,
      },
      {
        id: 'fullart',
        name: 'Arcane Hero — Full Art',
        description:
          'Showcase frame: the portrait fills the card, plates float translucent above it.',
        fields: arcaneFields,
        defaults: { ...arcaneDefaults, name: 'Nyra, Unbound', flavor: '' },
        artAspect: '3:4',
        Render: ArcaneFullArtCard,
      },
    ],
  };
  ```
- [ ] Run `bunx vitest run src/cards/arcane/arcane-theme.test.ts` — expect pass.
- [ ] In `src/cards/index.ts`: add exports and `registerBuiltinThemes` (keep the template exports/`registerBuiltinTemplates` for now):
  ```ts
  import { arcaneTheme } from './arcane/theme';
  import { listThemes, registerTheme } from './registry';
  // ...existing exports...
  export { arcaneFields, arcaneTheme } from './arcane/theme';
  export { getLayout, getTheme, listThemes, registerTheme } from './registry';
  export type { Layout, Theme } from './types';

  /** Idempotent: safe from main.tsx and every test setup. */
  export function registerBuiltinThemes(): void {
    for (const theme of [arcaneTheme]) {
      if (!listThemes().some((t) => t.id === theme.id)) {
        registerTheme(theme);
      }
    }
  }
  ```
- [ ] Edit `src/main.tsx`: import and call `registerBuiltinThemes()` right after `registerBuiltinTemplates()` (line 9); update the import on line 5 to `import { registerBuiltinTemplates, registerBuiltinThemes } from './cards';`.
- [ ] Edit `test/setup.ts` to register/clear themes each test:
  ```ts
  import { beforeEach } from 'vitest';
  import { setAppLayer, testAppLayer } from '../src/app/runtime';
  import { registerBuiltinTemplates, registerBuiltinThemes } from '../src/cards';
  import { __clearTemplatesForTests, __clearThemesForTests } from '../src/cards/registry';

  beforeEach(() => {
    setAppLayer(testAppLayer);
    __clearTemplatesForTests();
    __clearThemesForTests();
    registerBuiltinTemplates();
    registerBuiltinThemes();
  });
  ```
- [ ] Run `bun run verify` — expect green.
- [ ] Commit:
  ```
  feat: add Theme/Layout model + registry beside the template registry

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

---

## Task B — Builder/Gallery/persistence flip to themeId+layoutId

Flip every consumer (`CardRecord`, `CardArchive`, `BuilderView`, `GalleryView`, `PortraitSection` plumbing) from `templateId` to required `themeId` + `layoutId`, then delete the template half of the registry, `template.ts`, and `registerBuiltinTemplates`.

### Files

- **Modify** `src/contracts/records.ts:51-59` — `CardRecord`: drop `templateId`, add required `themeId` + `layoutId`.
- **Modify** `src/storage/CardArchive.ts:23-29,68-86` — `SaveCardInput`/`saveCard` use `themeId`+`layoutId`.
- **Modify** `src/builder/BuilderView.tsx` — `themeId`+`layoutId` state, THEME + LAYOUT selects, fields/render from layout, layout-switch preserves overlapping keys, `pendingCard` carries both.
- **Modify** `src/builder/FormRenderer.tsx:13,17,20` — read `layout.fields` instead of `template.fields`.
- **Modify** `src/builder/PortraitSection.tsx:72-74` — build prompt from theme/layout (minimal id plumbing; full rework in Task E).
- **Modify** `src/gallery/GalleryView.tsx:19-24,152` — show `themeId/layoutId`; primary click opens builder.
- **Delete from** `src/cards/registry.ts` — `registerTemplate`/`getTemplate`/`listTemplates`/`__clearTemplatesForTests` + the `templates` map + `CardTemplate` import.
- **Delete** `src/cards/arcane/template.ts`.
- **Modify** `src/cards/index.ts` — remove template exports, `registerBuiltinTemplates`, `CardTemplate` type export.
- **Modify** `src/cards/types.ts` — delete `CardTemplate`.
- **Modify** `src/main.tsx` / `test/setup.ts` — drop `registerBuiltinTemplates`.
- **Delete** `src/cards/registry.test.ts`, `src/cards/arcane/arcane.test.tsx`'s template-only cases (rewrite to theme), and update `src/contracts/contracts.test.ts` CardRecord cases.
- **Test** `src/contracts/contracts.test.ts` — CardRecord requires themeId+layoutId; an old templateId row fails decode (clean break).
- **Test** `src/builder/builder.test.tsx` — theme/layout selects; lossless layout switch; defaults seed only new cards.
- **Test** `src/gallery/gallery.test.tsx` — roundtrip re-save updates same id.

### Interfaces

**Consumes** (from Task A): `getTheme`, `getLayout`, `listThemes` (`src/cards/registry.ts`); `Theme`, `Layout` (`src/cards/types.ts`); `registerBuiltinThemes` (`src/cards/index.ts`).

**Produces**:
- `src/contracts/records.ts`: `CardRecord` fields `{ id, name, themeId, layoutId, holo, updatedAt, data }`; `CardRecordT`.
- `src/storage/CardArchive.ts`: `SaveCardInput { id?; name; themeId; layoutId; data; holo }`; `StoredCard = CardRecordT`.
- `src/builder/BuilderView.tsx`: `BuilderView` with `themeId: string`, `layoutId: string`, getters `theme: Theme`, `layout: Layout`, `resolved: CardData`, methods `pickTheme(id)`, `pickLayout(id)`, `loadCard(card)`, `savedId?: string`.

### Steps

- [ ] Update `src/contracts/contracts.test.ts` `CardRecord` describe block: change valid-card fixtures to use `themeId`/`layoutId`, and add a clean-break case:
  ```ts
  it('decodes a valid card with themeId + layoutId', () => {
    const raw = {
      id: 'card-1',
      name: 'Ember Sprite',
      themeId: 'arcane',
      layoutId: 'classic',
      holo: false,
      updatedAt: 1700000000,
      data: { name: 'Ember Sprite', cost: 3 },
    };
    const decoded = Schema.decodeUnknownSync(CardRecord)(raw);
    expect(decoded.themeId).toBe('arcane');
    expect(decoded.layoutId).toBe('classic');
  });

  it('rejects an old templateId-only row (clean break, decision 2)', () => {
    const legacy = {
      id: 'old-1',
      name: 'Legacy',
      templateId: 'arcane-hero',
      holo: false,
      updatedAt: 1700000000,
      data: {},
    };
    expect(() => Schema.decodeUnknownSync(CardRecord)(legacy)).toThrow();
  });
  ```
  (Update the existing `holo: 'yes'` wrong-type case to also carry `themeId`/`layoutId`.)
- [ ] Run `bunx vitest run src/contracts/contracts.test.ts` — expect failure.
- [ ] Edit `src/contracts/records.ts:51-59` `CardRecord`:
  ```ts
  export const CardRecord = Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    themeId: Schema.String,
    layoutId: Schema.String,
    holo: Schema.Boolean,
    updatedAt: Schema.Number,
    data: Schema.Record({ key: Schema.String, value: FieldValue }),
  });
  ```
  Update the doc comment at `records.ts:42-47` to reference `themeId`/`layoutId`.
- [ ] Run `bunx vitest run src/contracts/contracts.test.ts` — expect pass.
- [ ] Edit `src/storage/CardArchive.ts`: `SaveCardInput` (23-29) → `{ id?; name; themeId: string; layoutId: string; data; holo }`; in `saveCard` (68-76) replace `templateId: input.templateId` with `themeId: input.themeId, layoutId: input.layoutId`.
- [ ] Rewrite `src/cards/registry.ts` to keep ONLY the theme registry (delete `templates` map, `registerTemplate`, `getTemplate`, `listTemplates`, `__clearTemplatesForTests`, and the `import type { CardTemplate }`). Keep `registerTheme`/`getTheme`/`listThemes`/`getLayout`/`__clearThemesForTests`.
- [ ] Delete `src/cards/arcane/template.ts` (`rm`).
- [ ] Edit `src/cards/index.ts`: remove lines 1-2 template imports, line 22 (`export … template`), line 25 template registry export, `CardTemplate` from the type export (26-33), and the whole `registerBuiltinTemplates` block (35-42).
- [ ] Delete the `CardTemplate` interface from `src/cards/types.ts:40-51` (and its doc comment 36-39).
- [ ] Edit `src/main.tsx`: drop `registerBuiltinTemplates` import + call (keep `registerBuiltinThemes`).
- [ ] Edit `test/setup.ts`: drop `registerBuiltinTemplates`/`__clearTemplatesForTests` (keep the themes lines).
- [ ] Delete `src/cards/registry.test.ts` (`rm` — superseded by `theme-registry.test.ts`).
- [ ] Rewrite the template-dependent cases in `src/cards/arcane/arcane.test.tsx`: the `arcane template` describe (17-34) and the `registers the showcase template` case (102-105) — replace `getTemplate('arcane-hero')`/`arcaneTemplate` with `getLayout('arcane','classic')`/`arcaneTheme` and `arcaneTheme.layouts` fields; keep all render cases untouched. Example:
  ```ts
  import { getLayout, getTheme } from '../registry';
  import { arcaneFields, arcaneTheme } from './theme';
  // ...
  describe('arcane theme', () => {
    it('is registered by test setup', () => {
      expect(getTheme('arcane').name).toBe('Arcane');
    });
    it('provides defaults for every non-image field', () => {
      const classic = getLayout('arcane', 'classic');
      for (const field of classic.fields) {
        if (field.kind === 'image') continue;
        expect(classic.defaults[field.key], `default for ${field.key}`).toBeDefined();
      }
    });
    it('shares one field list across layouts', () => {
      expect(getLayout('arcane', 'fullart').fields).toBe(arcaneFields);
    });
  });
  ```
  Delete the two `artStylePrompt`-based cases (arcane.test.tsx:29-33, 129-131) — art prompting is verified in Task E.
- [ ] Rewrite `src/builder/BuilderView.tsx` to theme/layout. Key changes (keep the boundary/`get()` patterns intact):
  - Import `getLayout, getTheme, listThemes` from `../cards/registry`; `type { Layout, Theme }` from `../cards/types`; `ArcaneCardBack` stays for `BuilderPreview` (but read the CardBack from `theme.CardBack` — see below).
  - State: replace `templateId = ''` with `themeId = ''` and `layoutId = ''`.
  - `new()`:
    ```ts
    protected new() {
      const first = listThemes()[0];
      if (first) this.pickTheme(first.id);
    }
    ```
  - Getters:
    ```ts
    get theme(): Theme {
      return getTheme(this.themeId);
    }
    get layout(): Layout {
      return getLayout(this.themeId, this.layoutId);
    }
    ```
  - `resolved` getter: iterate `this.layout.fields` instead of `this.template.fields` (line 55).
  - `pickTheme` + `pickLayout` (defaults seed only fresh cards; layout switch preserves overlapping keys):
    ```ts
    pickTheme(id: string) {
      this.themeId = id;
      const first = getTheme(id).layouts[0];
      this.layoutId = first?.id ?? '';
      this.data = first ? { ...first.defaults } : {};
      this.savedId = undefined;
      this.savedNote = '';
    }

    pickLayout(id: string) {
      const next = getLayout(this.themeId, id);
      const keptKeys = new Set(next.fields.map((f) => f.key));
      const preserved: CardData = {};
      for (const [key, value] of Object.entries(this.data)) {
        if (keptKeys.has(key)) preserved[key] = value;
      }
      // seed defaults only for keys the user has no value for (keeps user data)
      this.data = { ...next.defaults, ...preserved };
      this.layoutId = id;
    }
    ```
  - `loadCard`:
    ```ts
    loadCard(card: StoredCard) {
      this.themeId = card.themeId;
      this.layoutId = card.layoutId;
      this.data = { ...card.data };
      this.holo = card.holo;
      this.savedId = card.id;
      this.savedNote = '';
    }
    ```
  - `saveCard` (89-98): pass `themeId: this.themeId, layoutId: this.layoutId` instead of `templateId`.
  - `BuilderForm` (113-135): replace the single Template panel with THEME + LAYOUT selects:
    ```ts
    const { is: builder, theme, layout, themeId, layoutId, savedNote, portraitKey } =
      BuilderView.get();
    // ...
    <Panel title="Theme">
      <SelectInput
        value={themeId}
        onValue={(id) => builder.pickTheme(id)}
        options={listThemes().map((t) => ({ value: t.id, label: t.name }))}
      />
      <p className="mt-2 text-xs text-ink-dim">{theme.description}</p>
    </Panel>
    <Panel title="Layout">
      <SelectInput
        value={layoutId}
        onValue={(id) => builder.pickLayout(id)}
        options={theme.layouts.map((l) => ({ value: l.id, label: l.name }))}
      />
      <p className="mt-2 text-xs text-ink-dim">{layout.description}</p>
    </Panel>
    ```
  - `PortraitSlot` (137-161): unchanged logic; it already reads `data`/`portraitKey`/`shell`.
  - `BuilderPreview` (163-199): `const Render = layout.Render;` and use `const CardBack = builder.theme.CardBack;` for the back (`showBack ? <CardBack holo={holo} /> : <Render data={resolved} holo={holo} />`). Read `layout` from `.get()`.
- [ ] Edit `src/builder/FormRenderer.tsx`: change `const { template, data } = BuilderView.get();` (13) to `const { layout, data } = BuilderView.get();` and replace all three `template.fields` reads (17, 20, and the `dependentsOf` at 17) with `layout.fields`.
- [ ] Edit `src/builder/PortraitSection.tsx:72-74`: minimal id plumbing so it still compiles — replace `builder.template.artStylePrompt(builder.data)` / `builder.templateId` / `builder.template.artAspect` with the layout/theme equivalents:
  ```ts
  const themeArt = [
    builder.theme.lookAndFeel,
    builder.theme.artFlavor?.(builder.data) ?? '',
  ]
    .filter((s) => s.length > 0)
    .join(', ');
  const prompt = buildPortraitPrompt(themeArt, this.persona);
  const styleId = builder.themeId;
  const aspectRatio = builder.layout.artAspect ?? 'match_input_image';
  ```
  (Full text-first rework lands in Task E; this keeps the current photo→art path alive and green.)
- [ ] Edit `src/gallery/GalleryView.tsx`: `openCard` (19-24) unchanged. In `GalleryCards` (152) replace `{card.templateId}` with `{card.themeId} · {card.layoutId}`. Make the whole card row clickable to open the builder (primary action) while keeping the explicit buttons:
  ```ts
  <li
    key={card.id}
    className="flex items-center justify-between rounded-lg border border-edge bg-panel px-4 py-2.5"
  >
    <button
      type="button"
      className="min-w-0 flex-1 text-left"
      onClick={() => gallery.openCard(card)}
    >
      <p className="truncate font-display text-sm">{card.name}</p>
      <p className="text-[11px] text-ink-dim">
        {card.themeId} · {card.layoutId} · {new Date(card.updatedAt).toLocaleString()}
      </p>
    </button>
    <div className="flex shrink-0 gap-1.5">
      <Button tone="ghost" onClick={() => gallery.openCard(card)}>Open in builder</Button>
      <Button tone="danger" onClick={() => void shell?.archive.deleteCard(card.id)}>Delete</Button>
    </div>
  </li>
  ```
- [ ] Update `src/builder/builder.test.tsx`: change the save assertion `templateId).toBe('arcane-hero')` (line 95) to `themeId).toBe('arcane')` + a `layoutId).toBe('classic')` assertion. Add a lossless-layout-switch case (headless):
  ```ts
  import { BuilderView } from './BuilderView';
  // ...
  it('preserves overlapping field values and user data across a layout switch', () => {
    const builder = BuilderView.new();
    builder.setField('name', 'Custom Hero');
    builder.setField('ability', 'Draw two cards.');
    builder.pickLayout('fullart');
    expect(builder.layoutId).toBe('fullart');
    expect(builder.data.name).toBe('Custom Hero'); // shared key preserved
    expect(builder.data.ability).toBe('Draw two cards.');
    builder.set(null);
  });

  it('seeds defaults only for a fresh card, not when switching layouts with edits', () => {
    const builder = BuilderView.new();
    builder.setField('name', 'Edited');
    builder.pickLayout('fullart');
    expect(builder.data.name).toBe('Edited'); // NOT reset to the fullart default
    builder.set(null);
  });
  ```
- [ ] Update `src/gallery/gallery.test.tsx`: change every `templateId: 'arcane-hero'` in `saveCard(...)` calls (lines 15, 58) to `themeId: 'arcane', layoutId: 'classic'`. Add a re-save-updates-in-place case:
  ```ts
  it('re-saving an opened card updates the same record', async () => {
    const { shell, unmount } = await mountApp();
    await vi.waitFor(() => expect(shell.archive.ready).toBe(true));
    const first = await shell.archive.saveCard({
      name: 'Once', themeId: 'arcane', layoutId: 'classic', data: { name: 'Once' }, holo: false,
    });
    const again = await shell.archive.saveCard({
      id: first.id, name: 'Twice', themeId: 'arcane', layoutId: 'classic', data: { name: 'Twice' }, holo: false,
    });
    expect(again.id).toBe(first.id);
    expect(shell.archive.cards).toHaveLength(1);
    expect(shell.archive.cards[0]?.name).toBe('Twice');
    unmount();
  });
  ```
- [ ] Update `src/builder/portrait.test.tsx`: the headless generate case (13-47) asserts `input.styleId).toBe('arcane-hero')` and `input.prompt).toContain('oil painting')` — change `styleId` expectation to `'arcane'` and `prompt` expectation to `toContain('oil')` (matches `arcaneTheme.lookAndFeel`). Keep the persona assertions.
- [ ] Run `bun run verify` — expect green. (If `AppShell.test.tsx` fails on the four-tab assertion, that is expected and fixed in Task C.)
- [ ] Commit:
  ```
  feat: flip builder/gallery/persistence to themeId+layoutId; delete template registry

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

---

## Task C — Remove Code Lab

Delete `src/editor/`, drop the editor tab, remove codemirror/sucrase deps, delete the `/api/agent/card` route + `buildAgentPrompt`/`extractCode`/`runCardAgent`, delete the `AgentCardRequest`/`Response` contracts, and drop `AgentApi` from the runtime. `AgentClient` (opencode session machinery) STAYS.

### Files

- **Delete** `src/editor/` (all: `EditorView.tsx`, `CodePane.tsx`, `compile.ts`, `compile.test.tsx`, `Sandbox.tsx`, `starter.ts`, `editor.test.tsx`, `AgentApi.ts`).
- **Modify** `src/app/AppShell.tsx:3,10-18,45-56` — drop the editor import, tab, and pane.
- **Modify** `src/app/AppShell.test.tsx:8,16-17` — three tabs (Task D drops to two; here keep Image Lab so this stays green mid-flight — assert Builder/Image Lab/Gallery and 3 panes).
- **Modify** `package.json:17,26,32` — remove `@codemirror/lang-javascript`, `codemirror`, `sucrase`.
- **Modify** `src/server/agentBridge.ts:27-53,84-107,169-212,436,553-570` — delete `CARD_API_GUIDE`, `buildAgentPrompt`, `extractCode`, `runCardAgent`, `decodeAgentCard`, the `/api/agent/card` middleware, and the `AgentCardRequest` import (keep `AgentClient`, `agentClientFromSdk`, `agentClientLive`, `PromptResult`/`SessionCreated` imports — still used by Tasks E/F).
- **Modify** `src/contracts/api.ts:49-66` — delete `AgentCardRequest`/`AgentCardResponse`.
- **Modify** `src/contracts/opencode.ts` — keep (still used by `agentClientFromSdk` session decode); note `PromptResult` remains for Task F extraction.
- **Modify** `src/app/runtime.ts:15-16,27,30-35,42-48,52-56,63-70` — drop `AgentApi` from `AppServices`, `appLive`, `TestAppOverrides`, `testAppLayerWith`, and delete `testAgentApiLayer` + the `AgentRequestError` import.
- **Modify** `src/server/agentBridge.test.ts` — delete `buildAgentPrompt`/`extractCode`/`runCardAgent` describes; keep the `ReplicateClient` describes.
- **Modify** `src/contracts/contracts.test.ts:24,436-451` — delete the `AgentCardRequest / AgentCardResponse` describe + import.
- **Delete** `AgentError.reason` `'no-code'` member if no longer referenced — verify; `runCardAgent` was its only producer.

### Interfaces

**Consumes**: `AgentClient`, `agentClientLive`, `agentClientFromSdk` (`src/server/agentBridge.ts:109-167` — remain); `respond`, `readBody`, `sendJson` (`src/server/BridgeRuntime.ts`).

**Produces**: `AppServices = StoreClient | ImageProvider | ActivityClient` (`src/app/runtime.ts`); `TestAppOverrides` without `agent`.

### Steps

- [ ] `rm -rf src/editor`.
- [ ] Edit `src/app/AppShell.tsx`: delete the `EditorView` import (line 3); remove `'editor'` from `ViewId` (11) and the `{ id: 'editor', label: 'Code Lab' }` tab (14-15); remove the editor `<Pane>` (48-50).
- [ ] Edit `src/app/AppShell.test.tsx`: change the tab-label loop (8) to `['Builder', 'Image Lab', 'Gallery']`, the pane count (16) to `toHaveLength(3)`, and the hidden count (17) to `toHaveLength(2)`.
- [ ] Edit `package.json`: remove the three dependency lines. Run `bun install` to update the lockfile.
- [ ] Edit `src/contracts/api.ts`: delete the `POST /api/agent/card` section (49-66: `AgentCardRequest`, `AgentCardRequestT`, `AgentCardResponse`, `AgentCardResponseT`).
- [ ] Edit `src/contracts/contracts.test.ts`: remove `AgentCardRequest, AgentCardResponse` from the import (24) and delete the `AgentCardRequest / AgentCardResponse` describe (436-451).
- [ ] Edit `src/server/agentBridge.ts`: delete `CARD_API_GUIDE` (29-41), `buildAgentPrompt` (43-53), `extractCode` (85-107), `runCardAgent` (169-212), `decodeAgentCard` (436), the `/api/agent/card` middleware (553-570), and `AgentCardRequest` from the `contracts/api.ts` import (18). Keep `ImageGenerateRequest`, `StorePutRequest`. Keep `AgentClient`/`agentClientFromSdk`/`agentClientLive`, and `decodeSessionOption`/`decodePromptOption` are used by `agentClientFromSdk` — but `decodePromptOption` was only used by `extractCode`; if now unused, delete it too (verify by grep before deleting).
- [ ] Edit `src/server/agentBridge.test.ts`: delete the `buildAgentPrompt`, `extractCode`, and `runCardAgent` describes (21-182) and the imports of those symbols (9-15 keep only `ReplicateClient`, `ReplicateSdk`, `replicateClientLive`). Keep the `ReplicateClient.generate` describes.
- [ ] Edit `src/app/runtime.ts`: remove the `AgentApi, agentApiLive` import (16) and `AgentRequestError` import (15); drop `AgentApi` from `AppServices` (27), from `appLive` (30-35), from `TestAppOverrides` (51-56), and from `testAppLayerWith` (63-70); delete `testAgentApiLayer` (42-48). Result:
  ```ts
  export type AppServices = StoreClient | ImageProvider | ActivityClient;

  export const appLive: Layer.Layer<AppServices> = Layer.mergeAll(
    storeClientLive,
    imageProviderLive,
    activityClientLive,
  ).pipe(Layer.provide(AppHttpLive));

  export interface TestAppOverrides {
    readonly store?: Layer.Layer<StoreClient>;
    readonly image?: Layer.Layer<ImageProvider>;
    readonly activity?: Layer.Layer<ActivityClient>;
  }

  export function testAppLayerWith(overrides: TestAppOverrides = {}): Layer.Layer<AppServices> {
    return Layer.mergeAll(
      overrides.store ?? storeClientMemory,
      overrides.image ?? imageProviderStubLayer(),
      overrides.activity ?? activityClientEmpty,
    );
  }
  ```
- [ ] Verify `AgentError` `'no-code'` reason and `AgentRequestError` class: grep `src` for both. `AgentRequestError` (`errors.ts:73-80`) was used by `EditorView`/`AgentApi`/`runtime` only — remove the class if grep is clean. `AgentError` `'no-code'` (`errors.ts:60-70`) loses its only producer (`runCardAgent`); leave the class (`'no-session-id'` still used by `agentClientFromSdk`) but drop the `'no-code'` union member + its `byReason` entry if grep confirms no reference remains.
- [ ] `grep -rn "editor/\|EditorView\|Code Lab\|AgentApi\|buildAgentPrompt\|extractCode\|runCardAgent\|AgentCardRequest\|agentApiLive" src` — expect zero matches.
- [ ] Run `bun run verify` — expect green.
- [ ] Commit:
  ```
  feat: remove the Code Lab (editor, /api/agent/card, AgentApi); AgentClient stays

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

---

## Task D — Remove Image Lab

Delete `ImageLabView` + tests, drop the app to two tabs (Builder / Gallery), retire the freestyle path, and confirm the Gallery Library tab is the image manager (it already lists + deletes library images: `GalleryView.tsx:84-134`). `stubStyleFor` and `suggestImageName` stay.

### Files

- **Delete** `src/images/ImageLabView.tsx`.
- **Modify** `src/images/images.test.tsx:10,165-218` — delete the `ImageLabView` import + its three describes; keep codec/prompt/stub/ImageProvider/CameraCapture.
- **Modify** `src/app/AppShell.tsx` — drop `ImageLabView` import, `'images'` ViewId + tab + pane → two tabs.
- **Modify** `src/app/AppShell.test.tsx` — two tabs (Builder / Gallery), 2 panes, 1 hidden.
- **Modify** `src/gallery/GalleryView.tsx:90` — the Library empty-state hint mentions "Image Lab"; reword to "the Builder's art tools".
- **Keep** `src/images/prompt.ts` (`suggestImageName`), `src/images/stub.ts` (`stubStyleFor`), `PhotoPicker`, `CameraCapture`, `codec`, `ImageProvider`.

### Interfaces

**Produces**: `ViewId = 'builder' | 'gallery'` (`src/app/AppShell.tsx`); `VIEW_TABS` of length 2.

**Consumes**: `GalleryView` Library tab (`src/gallery/GalleryView.tsx:84-134`, unchanged: it already renders `shell.library.images` with Download + Delete).

### Steps

- [ ] `rm src/images/ImageLabView.tsx`.
- [ ] Edit `src/images/images.test.tsx`: remove the `ImageLabView` import (10) and delete the three `ImageLabView`-related describes (165-218: the name-input regression, the headless `requires a source photo`, and the `generates via the app ImageProvider` cases). Keep everything else.
- [ ] Edit `src/app/AppShell.tsx`: delete the `ImageLabView` import (5); `ViewId = 'builder' | 'gallery'` (11); `VIEW_TABS` = `[{ id: 'builder', label: 'Builder' }, { id: 'gallery', label: 'Gallery' }]`; remove the images `<Pane>` (51-53).
- [ ] Edit `src/app/AppShell.test.tsx`: tab loop → `['Builder', 'Gallery']`; `panes` → `toHaveLength(2)`; hidden → `toHaveLength(1)`.
- [ ] Edit `src/gallery/GalleryView.tsx:90` empty-state hint: `hint="Generate in the Builder's art tools."`.
- [ ] `grep -rn "ImageLabView\|Image Lab\|freestyle" src` — expect zero matches (spec §Persistence keeps legacy `'freestyle'` `styleId` VALUES decoding harmlessly via the optional `ImageRecord.styleId`; no code references the string).
- [ ] Run `bun run verify` — expect green.
- [ ] Commit:
  ```
  feat: remove the Image Lab; app is two tabs (Builder / Gallery)

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

---

## Task E — Art pipeline rework (text-first, LLM-composed)

Add an LLM composition step to `POST /api/image/generate`, extend `ImageGenerateRequest` with theme context + argument values + brief + editCurrentArt, reshape `ImageProvider` accordingly, and rework `PortraitSection` to be text-first (empty placeholder, Generate-art action, optional photo attach, library pick).

### Files

- **Modify** `src/contracts/api.ts:77-87` — `ImageGenerateRequest` gains `themeContext?`, `argumentValues?`, `brief?`, `editCurrentArt?`, `currentArtFileName?` (all optional so the stub path + old tests still decode).
- **Modify** `src/server/agentBridge.ts` — add `composeArtPrompt` (AgentClient one-shot) + wire it into `/api/image/generate` when a live token AND `themeContext` are present; source image handling (attached photo OR `currentArtFileName` via `FileStore`); activity events for compose + generate.
- **Modify** `src/images/ImageProvider.ts:36-46,127-167` — `GenerationInput` (from `stub.ts`) gains the new fields; `replicateGenerate` forwards them; stub path unchanged (deterministic).
- **Modify** `src/images/stub.ts:9-16` — `GenerationInput` gains `themeContext?`, `argumentValues?`, `brief?`, `editCurrentArt?`, `currentArtFileName?` (optional; stub ignores them).
- **Modify** `src/builder/PortraitSection.tsx` — text-first rework: empty placeholder default, Generate-art action (boundary pattern) composing from arguments + optional photo attach + library pick.
- **Test** `src/server/agentBridge.test.ts` — `composeArtPrompt` with a stub `AgentClient` layer asserts composed inputs; `editCurrentArt` sources current art via a stub `FileStore`; activity events.
- **Test** `src/images/images.test.tsx` — `ImageProvider` forwards the new fields in the POST body.
- **Test** `src/builder/portrait.test.tsx` — Generate-art from arguments (no photo); optional photo attach; library pick.

### Interfaces

**Consumes** (from Task A): `ThemeContext`, `ThemeContextT` (`src/contracts/theme.ts`); `Theme`, `Layout` (`src/cards/types.ts`); `getLayout`/`getTheme`. From bridge: `AgentClient` (`src/server/agentBridge.ts:109`), `FileStore` (`src/server/fileStore.ts:64`, method `readFile(store, fileName): Effect<Option<{bytes: Buffer; type: string}>, FileStoreError>`), `ActivityBus.emit` (`src/server/activity.ts:20`), `ReplicateClient.generate(token, { prompt, imageDataUrl, aspectRatio })` (`src/server/agentBridge.ts:301`), `bytesToDataUrl` (`src/images/codec.ts:3`).

**Produces**:
- `ImageGenerateRequest` with the extra optional fields; `ImageGenerateRequestT`.
- `src/server/agentBridge.ts`: `composeArtPrompt(themeContext: ThemeContextT, argumentValues, brief?): Effect<string, AgentError, AgentClient | ActivityBus>`.
- `GenerationInput` (in `stub.ts`, re-exported by `ImageProvider.ts`) with the new optional fields.
- `PortraitSection` methods: `attachPhoto(bytes, type)`, `generateArt(deps?)`, `applyLibraryImage(id)`.

### Steps

- [ ] Extend `src/contracts/api.ts` `ImageGenerateRequest`. Import `ThemeContext` from `./theme.ts`:
  ```ts
  import { ThemeContext } from './theme.ts';
  // ...
  export const ImageGenerateRequest = Schema.Struct({
    prompt: Schema.String,
    imageDataUrl: Schema.String,
    aspectRatio: Schema.optional(Schema.String),
    themeContext: Schema.optional(ThemeContext),
    argumentValues: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
    brief: Schema.optional(Schema.String),
    editCurrentArt: Schema.optional(Schema.Boolean),
    currentArtFileName: Schema.optional(Schema.String),
  });
  ```
  (Existing `contracts.test.ts` `ImageGenerateRequest` cases still pass — all new fields are optional.)
- [ ] Extend `GenerationInput` in `src/images/stub.ts:9-16`:
  ```ts
  export interface GenerationInput {
    sourceBytes: ArrayBuffer;
    sourceType: string;
    prompt: string;
    styleId: string;
    aspectRatio?: string;
    themeContext?: { lookAndFeel: string; palette: string; argumentSummary: string };
    argumentValues?: Record<string, string>;
    brief?: string;
    editCurrentArt?: boolean;
    currentArtFileName?: string;
  }
  ```
- [ ] Write the `composeArtPrompt` test in `src/server/agentBridge.test.ts` (stub `AgentClient` returns a canned prompt; assert the compose input embeds lookAndFeel + argument values + brief):
  ```ts
  import { ThemeContext } from '../contracts/theme.ts';
  import { composeArtPrompt } from './agentBridge.ts';
  // stub AgentClient whose prompt() records the text and returns a text part
  const composeStub = (record: (text: string) => void): Layer.Layer<AgentClient> =>
    Layer.succeed(AgentClient, {
      createSession: () => Effect.succeed('sess-c'),
      prompt: (_id, text) => {
        record(text);
        return Effect.succeed({
          data: { parts: [{ type: 'text', text: 'a mythic ember mage, oil painting' }] },
        });
      },
    });

  describe('composeArtPrompt', () => {
    it.effect('feeds lookAndFeel, argument values, and brief to the model', () =>
      Effect.gen(function* () {
        let seen = '';
        const prompt = yield* composeArtPrompt(
          { lookAndFeel: 'painterly oil', palette: 'ember warm', argumentSummary: 'name, essence' },
          { name: 'Nyra', essence: 'ember' },
          'make him angrier',
        );
        expect(prompt).toContain('oil painting');
        // the composed instruction we sent embedded the inputs
        expect(seen).toContain('painterly oil');
        expect(seen).toContain('Nyra');
        expect(seen).toContain('make him angrier');
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            composeStub((t) => {
              // capture via closure — replace `seen` above by binding into the layer
            }),
            activityBusTestLayer,
          ),
        ),
      ),
    );
  });
  ```
  (Bind `seen` through the layer closure: build `composeStub` with a mutable ref captured in the test scope; the pattern mirrors the `agentStub` capture in the existing `runCardAgent` test, agentBridge.test.ts:100-127.)
- [ ] Run `bunx vitest run src/server/agentBridge.test.ts` — expect failure (`composeArtPrompt` missing).
- [ ] Add `composeArtPrompt` to `src/server/agentBridge.ts` (reuse `extractText`-style fence-free text join; a one-shot session, no heartbeat needed). Import `ThemeContextT` from `../contracts/theme.ts`:
  ```ts
  import type { ThemeContextT } from '../contracts/theme.ts';

  const decodePromptText = Schema.decodeUnknownOption(PromptResult);

  /** Concatenate the text parts of a prompt result (no fence extraction — plain prose). */
  function promptText(result: unknown): string {
    const decoded = decodePromptText(result);
    if (Option.isNone(decoded)) return '';
    const value = decoded.value;
    const data = value.data ?? value;
    const parts = data.parts ?? value.parts ?? [];
    let text = '';
    for (const part of parts) {
      if (part.type === 'text' && typeof part.text === 'string') text += `\n${part.text}`;
    }
    return text.trim();
  }

  const ART_COMPOSER_GUIDE =
    'You are writing a single image-generation prompt for a trading-card art slot. ' +
    'Return ONLY the prompt text — no preamble, no markdown, one paragraph.';

  export function composeArtPrompt(
    themeContext: ThemeContextT,
    argumentValues: Record<string, string>,
    brief?: string,
  ): Effect.Effect<string, AgentError, AgentClient | ActivityBus> {
    return Effect.gen(function* () {
      const agent = yield* AgentClient;
      const bus = yield* ActivityBus;
      yield* bus.emit('agent', 'composing art prompt from theme + arguments');
      const id = yield* agent.createSession('cartis art compose');
      const argLines = Object.entries(argumentValues)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join('\n');
      const instruction = [
        ART_COMPOSER_GUIDE,
        `Look and feel: ${themeContext.lookAndFeel}`,
        `Palette: ${themeContext.palette}`,
        `Card arguments:\n${argLines}`,
        brief ? `Requested emphasis: ${brief}` : '',
      ]
        .filter((s) => s.length > 0)
        .join('\n\n');
      const result = yield* agent.prompt(id, instruction);
      const composed = promptText(result);
      const final = composed.length > 0 ? composed : themeContext.lookAndFeel;
      yield* bus.emit('agent', `art prompt composed (${String(final.length)} chars)`);
      return final;
    });
  }
  ```
  (`agent.prompt` returns `Effect<unknown, AgentError>`; `createSession` returns `Effect<string, AgentError>` — both from `AgentClient`, agentBridge.ts:109-115. No `!`/`as` on external data: `promptText` decodes via `PromptResult`.)
- [ ] Run `bunx vitest run src/server/agentBridge.test.ts` — expect pass for the compose describe.
- [ ] Wire composition into the `/api/image/generate` middleware in `src/server/agentBridge.ts:573-603`. When a token exists AND `body.themeContext` is present, compose first; when `editCurrentArt` + `currentArtFileName`, read the file via `FileStore.readFile('images', fileName)` and use it as the replicate source; else use `imageDataUrl` (attached photo) or an empty source. Import `Option` (already imported) and reuse `bytesToDataUrl` (already imported). Sketch:
  ```ts
  respond(
    runtime,
    sres,
    Effect.gen(function* () {
      const body = yield* readBody(req);
      const req0 = yield* decodeImageGenerate(body);
      const bus = yield* ActivityBus;
      // 1) compose (only when theme context is present)
      const prompt = req0.themeContext
        ? yield* composeArtPrompt(req0.themeContext, req0.argumentValues ?? {}, req0.brief)
        : req0.prompt;
      // 2) resolve the source image
      let imageDataUrl = req0.imageDataUrl;
      if (req0.editCurrentArt && req0.currentArtFileName) {
        const fs = yield* FileStore;
        const file = yield* fs.readFile('images', req0.currentArtFileName);
        if (Option.isSome(file)) {
          imageDataUrl = bytesToDataUrl(
            file.value.bytes.buffer.slice(
              file.value.bytes.byteOffset,
              file.value.bytes.byteOffset + file.value.bytes.byteLength,
            ),
            file.value.type,
          );
        }
      }
      yield* bus.emit('image', 'generating art from composed prompt');
      const client = yield* ReplicateClient;
      const dataUrl = yield* client.generate(token, {
        prompt,
        imageDataUrl,
        aspectRatio: req0.aspectRatio,
      });
      return { dataUrl };
    }),
  );
  ```
  Add `ActivityBus`, `FileStore`, `composeArtPrompt`, `bytesToDataUrl` to the effect's requirements (all in `bridgeLive`'s layer, BridgeRuntime.ts:23-39 — note `AgentClient` is already in `bridgeLive` leaves). `FileStore.readFile` signature: fileStore.ts:74-78.
- [ ] Forward the new fields from `ImageProvider.replicateGenerate` (`src/images/ImageProvider.ts:128-154`) into the encoded `ImageGenerateRequest`:
  ```ts
  const wire = yield* Schema.encode(ImageGenerateRequest)({
    prompt: input.prompt,
    imageDataUrl: bytesToDataUrl(input.sourceBytes, input.sourceType),
    aspectRatio: input.aspectRatio,
    themeContext: input.themeContext,
    argumentValues: input.argumentValues,
    brief: input.brief,
    editCurrentArt: input.editCurrentArt,
    currentArtFileName: input.currentArtFileName,
  }).pipe(Effect.mapError((cause) => new NetworkError({ url, cause })));
  ```
- [ ] Write the `ImageProvider` forwarding test in `src/images/images.test.tsx` (assert the POST body carries `themeContext`):
  ```ts
  it.effect('forwards themeContext + argumentValues in the generate POST', () => {
    let posted: unknown;
    const handler = (req: HttpClientRequest.HttpClientRequest): Response => {
      // record the JSON body on the generate POST
      if (req.url.endsWith('/api/status')) {
        return new Response(JSON.stringify({ image: 'replicate' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      // body inspection: use req.body / re-encode as needed for the seam
      return new Response(
        JSON.stringify({ dataUrl: bytesToDataUrl(bytesOf('styled'), 'image/png') }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    // ... assert result.via === 'replicate' and (if the seam exposes body) themeContext present
  });
  ```
  (The `httpClientFromHandler` seam passes the full `HttpClientRequest`; read `req` fields as the existing images.test.tsx handlers do at 66-81. If body capture is awkward through the seam, assert instead at the `Schema.encode(ImageGenerateRequest)` boundary in a focused unit test: encode a `GenerationInput` with `themeContext` and assert the wire has it.)
- [ ] Run `bunx vitest run src/images/images.test.tsx` — expect pass.
- [ ] Rework `src/builder/PortraitSection.tsx` text-first. Replace the persona-centric flow: default source is none (empty art placeholder in the preview comes from `resolved.art === undefined`, already handled by the renders). Compose art from the builder's argument values + theme context; photo attach is a secondary affordance. New shape (boundary pattern preserved):
  ```ts
  export class PortraitSection extends Component {
    builder = get(BuilderView, false);
    shell = get(AppShell, false);
    fieldKey = '';
    source: 'none' | 'upload' | 'camera' | 'library' = 'none';
    brief = '';
    pendingBytes?: ArrayBuffer = undefined;
    pendingType = '';
    pendingPreview = '';
    busy = false;
    note = '';

    attachPhoto(bytes: ArrayBuffer, type: string) {
      this.pendingBytes = bytes;
      this.pendingType = type;
      this.pendingPreview = bytesToDataUrl(bytes, type);
      this.note = '';
    }

    applyLibraryImage(id: string) {
      this.builder?.setField(this.fieldKey, id);
      this.note = 'Applied from library.';
    }

    async generateArt(deps: { builder?: BuilderView; library?: ImageLibrary } = {}) {
      if (this.busy) return;
      const builder = deps.builder ?? this.builder;
      if (!builder) { this.note = 'Builder unavailable.'; return; }
      const library = deps.library ?? this.shell?.library;
      if (!library) { this.note = 'Image library unavailable.'; return; }
      // snapshot reactive fields BEFORE the effect (snapshot rule)
      const fieldKey = this.fieldKey;
      const brief = this.brief.trim();
      const bytes = this.pendingBytes;
      const sourceType = this.pendingType;
      const theme = builder.theme;
      const layout = builder.layout;
      const argumentValues: Record<string, string> = {};
      for (const field of layout.fields) {
        if (field.kind === 'image') continue;
        const v = builder.data[field.key];
        if (v !== undefined && v !== '') argumentValues[field.key] = String(v);
      }
      const themeContext = {
        lookAndFeel: theme.lookAndFeel,
        palette: theme.artFlavor?.(builder.data) ?? '',
        argumentSummary: layout.fields.filter((f) => f.kind !== 'image').map((f) => f.key).join(', '),
      };
      const styleId = builder.themeId;
      const aspectRatio = layout.artAspect ?? 'match_input_image';
      const name = `${String(builder.data.name ?? 'card')} art`;
      this.busy = true;
      this.note = 'Generating art…';
      try {
        const exit = await runAppExit(
          Effect.flatMap(ImageProvider, (p) =>
            p.generate({
              sourceBytes: bytes ?? new ArrayBuffer(0),
              sourceType: bytes ? sourceType : 'application/octet-stream',
              prompt: theme.lookAndFeel,
              styleId,
              aspectRatio,
              themeContext,
              argumentValues,
              brief: brief.length > 0 ? brief : undefined,
            }),
          ),
        );
        if (Exit.isFailure(exit)) { this.note = noteFromCause(exit.cause); return; }
        const out = exit.value;
        const stored = await library.add({
          name, kind: 'generated', prompt: brief || theme.lookAndFeel,
          styleId, bytes: out.bytes, type: out.type,
        });
        builder.setField(fieldKey, stored.id);
        this.note = `Art applied (via ${out.via}).`;
      } catch (cause) {
        this.note = cause instanceof Error ? cause.message : String(cause);
      } finally {
        this.busy = false;
      }
    }
    // render(): brief TextInput + "Generate art" Button + secondary photo/camera/library pickers
  }
  ```
  Render: a `brief` `TextInput`, a `Generate art` `Button` (`onClick={() => void this.generateArt()}`), and a collapsible "Attach photo (optional)" group reusing `PhotoPicker`/`CameraCapture` (calling `attachPhoto`) plus the library grid (calling `applyLibraryImage`) copied from the existing 143-168 markup. Delete `PortraitPersonaForm`/`Persona`/`buildPortraitPrompt` usage from this file (`buildPortraitPrompt` stays in `prompt.ts` unused-by-builder; leave it — `suggestImageName` in the same module is still used).
- [ ] Update `src/builder/portrait.test.tsx`:
  ```ts
  it('composes art from the layout arguments (no photo) and stores the image', async () => {
    const generate = vi.fn((input: GenerationInput) => {
      expect(input.themeContext?.lookAndFeel.toLowerCase()).toContain('oil');
      expect(input.argumentValues?.name).toBeDefined();
      expect(input.styleId).toBe('arcane');
      return Effect.succeed({ bytes: bytesOf('art'), type: 'image/png', via: 'stub' as const });
    });
    setAppLayer(testAppLayerWith({ image: Layer.succeed(ImageProvider, ImageProvider.of({ generate })) }));
    const library = ImageLibrary.new();
    await vi.waitFor(() => expect(library.ready).toBe(true));
    const builder = BuilderView.new();
    const section = PortraitSection.new({ fieldKey: 'art' });
    await section.generateArt({ builder, library });
    expect(generate).toHaveBeenCalledOnce();
    expect(library.images).toHaveLength(1);
    expect(builder.data.art).toBe(library.images[0]?.id);
    section.set(null); builder.set(null); library.set(null);
  });
  ```
  Update the mounted "opens portrait tools" case (57-72): assert the button label is now "Generate art" and the brief field / "Attach photo" affordance appear.
- [ ] Run `bun run verify` — expect green.
- [ ] Commit:
  ```
  feat: text-first LLM-composed art pipeline (compose step + PortraitSection rework)

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

---

## Task F — Conversational AI fill

Add `AgentFillRequest`/`AgentFillResponse` contracts + a Schema-from-FieldSpec derivation, a `POST /api/agent/fill` bridge route (session-per-episode, per-turn `currentData` snapshot, vision attach of current art, Schema-decoded targeted patch), a browser `AgentFill` service + runtime wiring, and a BuilderView AI-prompt field (Fill-with-AI, targeted merge, artAction auto-run through Task E, session discard on switch).

### Vision mechanism (verified)

**SDK image parts ARE supported.** `@opencode-ai/sdk` 1.18.10 `SessionPromptData.body.parts` is `Array<TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput>` (`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:2257`), and `FilePartInput = { id?; type: "file"; mime: string; filename?; url: string; source? }` (types.gen.d.ts:1245-1252). The bridge's `agentClientFromSdk.prompt` already calls `client.session.prompt({ path: { id }, body: { parts: [{ type: 'text', text }] } })` (agentBridge.ts:132-139) — we extend it to append a `FilePartInput` whose `url` is a base64 data URL of the current art (`mime` from the file type). **Mechanism chosen: SDK image parts (FilePartInput with a data-URL `url`).** No file-path-in-prompt fallback needed.

### Files

- **Modify** `src/contracts/api.ts` — add `AgentFillRequest`, `AgentFillResponse`; add `schemaFromFields(fields)` deriving a `Partial<CardData>` Schema for the patch.
- **Modify** `src/server/agentBridge.ts` — extend `AgentClient` shape with an optional image part on `prompt`; add `runFillAgent` + the `/api/agent/fill` middleware (session reuse via `sessionId`, per-turn `currentData` snapshot, vision attach, Schema-decoded patch).
- **Create** `src/builder/AgentFill.ts` — browser `AgentFill` Effect service (Live over HttpClient + a test fake).
- **Modify** `src/app/runtime.ts` — add `AgentFill` to `AppServices`/`appLive`/`TestAppOverrides`/`testAppLayerWith`.
- **Modify** `src/builder/BuilderView.tsx` — AI prompt field above the form, `fillWithAI` (boundary pattern), targeted merge, `artAction` auto-run, session discard on card/theme/layout switch/new.
- **Test** `src/server/agentBridge.test.ts` — fill happy path + session reuse + targeted patch + vision attach + Schema-reject.
- **Test** `src/contracts/contracts.test.ts` — `AgentFillRequest`/`Response` decode; `schemaFromFields` accepts a matching patch + rejects a wrong-typed field.
- **Test** `src/builder/builder.test.tsx` — fill merges targeted patch; hand edits survive a later turn; session discard on switch; artAction path.

### Interfaces

**Consumes**: `ThemeContext` (`src/contracts/theme.ts`); `FieldSpec`, `CardData`, `Layout`, `Theme` (`src/cards/types.ts`); `AgentClient` (`src/server/agentBridge.ts:109`), `ActivityBus`, `FileStore` (bridge); `composeArtPrompt` + Task E's `/api/image/generate` (for `artAction` auto-run via `ImageProvider.generate` with `editCurrentArt`).

**Produces**:
- `src/contracts/api.ts`: `AgentFillRequest` (`{ sessionId?; themeContext; fields; currentData; currentArtFileName?; userPrompt }`), `AgentFillResponse` (`{ sessionId; patch; artAction? { brief; editCurrentArt } }`), `schemaFromFields(fields: readonly { kind: string; key: string }[])` — accepts full `FieldSpec[]` and request summaries alike.
- `src/builder/AgentFill.ts`: `AgentFill` tag with `fill(req): Effect<AgentFillResponseT, AgentFillError | NetworkError>`; `agentFillLive`; `agentFillEmpty` (test default failing with a typed error).
- `src/builder/BuilderView.tsx`: `fillSessionId?: string`, `aiPrompt: string`, `aiBusy: boolean`, `aiNote: string`, method `fillWithAI()`.

### Steps

- [ ] Add contracts to `src/contracts/api.ts`. The patch is a permissive `Record<string, FieldValue>` (the model returns only changed keys); `schemaFromFields` narrows per-field for the reject test:
  ```ts
  import type { FieldSpec } from '../cards/types.ts';
  import { ThemeContext } from './theme.ts';

  const FieldValue = Schema.Union(Schema.String, Schema.Number, Schema.Boolean, Schema.Undefined);
  const CardDataSchema = Schema.Record({ key: Schema.String, value: FieldValue });

  /** FieldSpec-shaped summary the LLM sees (kind + key + label). */
  const FieldSummary = Schema.Struct({
    kind: Schema.String,
    key: Schema.String,
    label: Schema.String,
  });

  export const AgentFillRequest = Schema.Struct({
    sessionId: Schema.optional(Schema.String),
    themeContext: ThemeContext,
    fields: Schema.Array(FieldSummary),
    currentData: CardDataSchema,
    currentArtFileName: Schema.optional(Schema.String),
    userPrompt: Schema.String,
  });
  export type AgentFillRequestT = typeof AgentFillRequest.Type;

  export const ArtAction = Schema.Struct({
    brief: Schema.String,
    editCurrentArt: Schema.Boolean,
  });

  export const AgentFillResponse = Schema.Struct({
    sessionId: Schema.String,
    patch: CardDataSchema,
    artAction: Schema.optional(ArtAction),
  });
  export type AgentFillResponseT = typeof AgentFillResponse.Type;

  /**
   * Derive a Schema for a targeted patch from field specs: every key optional,
   * each typed per its kind (text/select/image/textarea → string, number →
   * number, toggle → boolean). Unknown keys are dropped. The parameter is
   * deliberately minimal ({ kind, key }) so BOTH a layout's full FieldSpec[]
   * and the fill request's { kind, key, label } summaries feed it directly.
   */
  export function schemaFromFields(fields: readonly { kind: string; key: string }[]) {
    const shape: Record<string, Schema.Schema<string | number | boolean | undefined>> = {};
    for (const f of fields) {
      const value =
        f.kind === 'number'
          ? Schema.Number
          : f.kind === 'toggle'
            ? Schema.Boolean
            : Schema.String;
      shape[f.key] = Schema.optional(value);
    }
    return Schema.Struct(shape);
  }
  ```
- [ ] Add `contracts.test.ts` cases:
  ```ts
  import { AgentFillRequest, AgentFillResponse, schemaFromFields } from './api';
  import type { FieldSpec } from '../cards/types';

  describe('AgentFillRequest / Response', () => {
    it('decodes a request and a response with an artAction', () => {
      const req = Schema.decodeUnknownSync(AgentFillRequest)({
        themeContext: { lookAndFeel: 'oil', palette: 'ember', argumentSummary: 'name' },
        fields: [{ kind: 'text', key: 'name', label: 'Name' }],
        currentData: { name: 'Nyra' },
        userPrompt: 'make him angrier',
      });
      expect(req.userPrompt).toBe('make him angrier');
      const res = Schema.decodeUnknownSync(AgentFillResponse)({
        sessionId: 's1',
        patch: { name: 'Vorak' },
        artAction: { brief: 'angrier face', editCurrentArt: true },
      });
      expect(res.patch.name).toBe('Vorak');
      expect(res.artAction?.editCurrentArt).toBe(true);
    });
  });

  describe('schemaFromFields', () => {
    const fields: FieldSpec[] = [
      { kind: 'text', key: 'name', label: 'Name' },
      { kind: 'number', key: 'cost', label: 'Cost', min: 0, max: 9 },
    ];
    it('accepts a matching partial patch', () => {
      const decoded = Schema.decodeUnknownSync(schemaFromFields(fields))({ name: 'X' });
      expect(decoded.name).toBe('X');
    });
    it('rejects a wrong-typed field', () => {
      expect(() => Schema.decodeUnknownSync(schemaFromFields(fields))({ cost: 'high' })).toThrow();
    });
  });
  ```
- [ ] Run `bunx vitest run src/contracts/contracts.test.ts` — expect failure then, after the api.ts edit above, pass.
- [ ] Extend `AgentClient` in `src/server/agentBridge.ts` so `prompt` accepts an optional image part (SDK `FilePartInput`). Change the tag shape (109-115) and `agentClientFromSdk` (132-139):
  ```ts
  export class AgentClient extends Context.Tag('cartis/AgentClient')<
    AgentClient,
    {
      createSession(title: string): Effect.Effect<string, AgentError>;
      prompt(
        sessionId: string,
        text: string,
        image?: { mime: string; dataUrl: string },
      ): Effect.Effect<unknown, AgentError>;
    }
  >() {}
  ```
  In `agentClientFromSdk`:
  ```ts
  prompt: (sessionId, text, image) =>
    Effect.promise(() =>
      client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: image
            ? [
                { type: 'text', text },
                { type: 'file', mime: image.mime, url: image.dataUrl },
              ]
            : [{ type: 'text', text }],
        },
      }),
    ),
  ```
  Update `OpencodeClient.session.prompt` typing (agentBridge.ts:58-63) is already `prompt(input: unknown): Promise<unknown>` — unchanged. Update `agentClientLive` delegate (161-165) to forward the third arg: `prompt: (sessionId, text, image) => cached.pipe(Effect.flatMap((c) => agentClientFromSdk(c).prompt(sessionId, text, image)))`. The existing `runFillAgent`-free `composeArtPrompt` call (Task E) passes two args — still valid.
- [ ] Write the `runFillAgent` bridge tests in `src/server/agentBridge.test.ts` (stub AgentClient records text + image; assert session reuse, targeted patch decode, vision attach, malformed → typed failure). Use a stub `FileStore` layer returning a canned image for `currentArtFileName`:
  ```ts
  import { runFillAgent } from './agentBridge.ts';
  import { FileStore } from './fileStore.ts';
  import { Option } from 'effect';

  const fileStoreStub = (bytes: Buffer, type: string): Layer.Layer<FileStore> =>
    Layer.succeed(FileStore, {
      put: () => Effect.succeed({ id: 'x' }),
      list: () => Effect.succeed([]),
      remove: () => Effect.void,
      readFile: () => Effect.succeed(Option.some({ bytes, type })),
    });
  // ...assert: prompt text contains currentData JSON + userPrompt;
  //           image part present when currentArtFileName given;
  //           reuses the passed sessionId (createSession NOT called);
  //           patch decodes to only { name } when the model returns extra keys;
  //           a non-JSON model reply fails with a typed AgentError.
  ```
- [ ] Run `bunx vitest run src/server/agentBridge.test.ts` — expect failure (`runFillAgent` missing).
- [ ] Add `runFillAgent` + the `/api/agent/fill` middleware to `src/server/agentBridge.ts`. The agent must return JSON `{ patch, artAction? }`; decode `patch` through `schemaFromFields(fields)` — the request's `{kind,key,label}` summaries satisfy its minimal `{ kind, key }` parameter directly. Sketch:
  ```ts
  import { AgentFillRequest, AgentFillResponse, schemaFromFields } from '../contracts/api.ts';

  const FILL_GUIDE =
    'You are editing a trading-card record. Reply with ONLY a JSON object ' +
    '{ "patch": { ...only changed fields... }, "artAction"?: { "brief": string, "editCurrentArt": boolean } }. ' +
    'patch must contain only the fields you intend to change.';

  export function runFillAgent(
    req: AgentFillRequestT,
    readArt: (fileName: string) => Effect.Effect<Option.Option<{ mime: string; dataUrl: string }>, FileStoreError>,
  ): Effect.Effect<AgentFillResponseT, AgentError | FileStoreError> {
    return Effect.gen(function* () {
      const agent = yield* AgentClient;
      const bus = yield* ActivityBus;
      const sessionId = req.sessionId ?? (yield* agent.createSession('cartis card fill'));
      const image =
        req.currentArtFileName !== undefined
          ? Option.getOrUndefined(yield* readArt(req.currentArtFileName))
          : undefined;
      const text = [
        FILL_GUIDE,
        `Look and feel: ${req.themeContext.lookAndFeel}`,
        `Fields: ${req.fields.map((f) => `${f.key} (${f.kind})`).join(', ')}`,
        `Current values (respect these; the user may have hand-edited): ${JSON.stringify(req.currentData)}`,
        `User request: ${req.userPrompt}`,
      ].join('\n\n');
      yield* bus.emit('agent', `fill: “${req.userPrompt.slice(0, 60)}”`);
      const result = yield* agent.prompt(sessionId, text, image);
      const raw = promptText(result); // reuse Task E's promptText
      const json = extractJson(raw);  // parse the first {...} block; malformed → AgentError('no-fill')
      if (Option.isNone(json)) return yield* Effect.fail(new AgentError({ reason: 'no-fill' }));
      const patch = yield* Schema.decodeUnknown(schemaFromFields(fieldsFromSummaries(req.fields)))(
        (json.value as { patch?: unknown }).patch ?? {},
      ).pipe(Effect.mapError(() => new AgentError({ reason: 'no-fill' })));
      const artAction = /* decode optional artAction via ArtAction schema, leniently */;
      yield* bus.emit('agent', 'fill patch ready');
      return { sessionId, patch, artAction };
    });
  }
  ```
  Add `AgentError` reason `'no-fill'` → message `'agent returned no fill patch'` in `src/contracts/errors.ts:60-70` (union member + `byReason` entry). Provide `readArt` from the middleware by reading `FileStore.readFile('images', fileName)` and mapping the `Buffer` → data URL (same slice pattern as Task E). Add the middleware after the existing routes:
  ```ts
  server.middlewares.use('/api/agent/fill', (req, res) => {
    const sres = res as ServerResponse;
    if (req.method !== 'POST') { sendJson(sres, 405, { error: 'POST only' }); return; }
    respond(runtime, sres, Effect.gen(function* () {
      const body = yield* readBody(req);
      const parsed = yield* Schema.decodeUnknown(AgentFillRequest)(body);
      const fs = yield* FileStore;
      const readArt = (fileName: string) =>
        fs.readFile('images', fileName).pipe(Effect.map(Option.map((f) => ({
          mime: f.type,
          dataUrl: bytesToDataUrl(/* f.bytes → ArrayBuffer */, f.type),
        }))));
      return yield* runFillAgent(parsed, readArt);
    }));
  });
  ```
  (`decodeImageGenerate`-style: add `const decodeFill = Schema.decodeUnknown(AgentFillRequest)` near line 435-437. `schemaFromFields` is declared in api.ts as `schemaFromFields(fields: readonly { kind: string; key: string }[])` — deliberately minimal so both the layout's full `FieldSpec[]` and the request's `{kind,key,label}` summaries feed it directly, no mapping shim.)
- [ ] Run `bunx vitest run src/server/agentBridge.test.ts` — expect pass.
- [ ] Add `AgentFillError` to `src/contracts/errors.ts` (client-side fill failures; `AgentRequestError` no longer exists — Task C removed it with the editor): `class AgentFillError extends Data.TaggedError('AgentFillError')<{ status: number; detail?: string }>` with `get message()` returning `this.detail ?? \`fill request failed (${this.status})\``. Then create `src/builder/AgentFill.ts` (Live over HttpClient, mirroring the service shape of `src/images/ImageProvider.ts`):
  ```ts
  import { HttpClient, HttpClientRequest, type HttpClientResponse } from '@effect/platform';
  import { Context, Effect, Layer, Option, Schema } from 'effect';
  import { AgentFillRequest, AgentFillResponse, ErrorBody } from '../contracts/api';
  import type { AgentFillRequestT, AgentFillResponseT } from '../contracts/api';
  import { AgentFillError, NetworkError } from '../contracts/errors';

  export interface AgentFillShape {
    readonly fill: (
      req: AgentFillRequestT,
    ) => Effect.Effect<AgentFillResponseT, AgentFillError | NetworkError>;
  }
  export class AgentFill extends Context.Tag('cartis/AgentFill')<AgentFill, AgentFillShape>() {}

  export const agentFillLive: Layer.Layer<AgentFill, never, HttpClient.HttpClient> = Layer.effect(
    AgentFill,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const fill = (req: AgentFillRequestT) =>
        Effect.gen(function* () {
          const url = '/api/agent/fill';
          const wire = yield* Schema.encode(AgentFillRequest)(req).pipe(
            Effect.mapError((cause) => new NetworkError({ url, cause })),
          );
          const request = HttpClientRequest.post(url).pipe(HttpClientRequest.bodyUnsafeJson(wire));
          const response = yield* http.execute(request).pipe(
            Effect.mapError((cause) => new NetworkError({ url, cause })),
          );
          if (response.status < 200 || response.status >= 300) {
            const detail = yield* detailOf(response);
            return yield* Effect.fail(new AgentFillError({ status: response.status, detail }));
          }
          const bodyJson = yield* response.json.pipe(
            Effect.mapError((cause) => new NetworkError({ url, cause })),
          );
          return yield* Schema.decodeUnknown(AgentFillResponse)(bodyJson).pipe(
            Effect.mapError((cause) => new NetworkError({ url, cause })),
          );
        });
      return AgentFill.of({ fill });
    }),
  );
  // detailOf: copy the ErrorBody-decode helper from ImageProvider.ts:95-105.
  // agentFillEmpty: Layer.succeed failing with new AgentFillError({ status: 0, detail: 'no agent in tests' }).
  ```
- [ ] Wire `AgentFill` into `src/app/runtime.ts`: add to `AppServices` union, `appLive` merge (`agentFillLive`), `TestAppOverrides` (`fill?`), and `testAppLayerWith` (`overrides.fill ?? agentFillEmpty`). Import from `../builder/AgentFill`.
- [ ] Write the BuilderView fill tests in `src/builder/builder.test.tsx` (targeted merge, hand-edits-survive, discard-on-switch, artAction path) using a recording `AgentFill` fake via `testAppLayerWith({ fill: ... })`:
  ```ts
  import { AgentFill } from './AgentFill';
  // fill fake returns { sessionId: 's1', patch: { name: 'Vorak' } }
  it('merges a targeted fill patch and leaves other fields intact', async () => {
    setAppLayer(testAppLayerWith({
      fill: Layer.succeed(AgentFill, AgentFill.of({
        fill: () => Effect.succeed({ sessionId: 's1', patch: { name: 'Vorak' } }),
      })),
    }));
    const builder = BuilderView.new();
    builder.setField('ability', 'Draw a card.');
    builder.aiPrompt = 'rename him';
    await builder.fillWithAI();
    expect(builder.data.name).toBe('Vorak');
    expect(builder.data.ability).toBe('Draw a card.'); // untouched
    expect(builder.fillSessionId).toBe('s1');
    builder.set(null);
  });
  ```
  Add cases: (a) a second fill turn sends the CURRENT data (hand edits survive) — assert the fake receives `currentData.ability === 'Draw a card.'`; (b) `pickTheme`/`pickLayout`/`loadCard` reset `fillSessionId` to `undefined`; (c) a patch with an `artAction` triggers `PortraitSection`-style art generation (assert the image `generate` fake is called — provide both `fill` and `image` fakes).
- [ ] Add the fill UI + logic to `src/builder/BuilderView.tsx`. State: `aiPrompt = ''`, `aiBusy = false`, `aiNote = ''`, `fillSessionId?: string = undefined`. Reset `fillSessionId = undefined` at the end of `pickTheme`, `pickLayout`, and `loadCard`. `fillWithAI` (boundary pattern):
  ```ts
  async fillWithAI() {
    if (this.aiBusy || this.aiPrompt.trim().length === 0) return;
    const { shell } = this;
    // snapshot BEFORE the effect
    const userPrompt = this.aiPrompt.trim();
    const sessionId = this.fillSessionId;
    const currentData = { ...this.data };
    const theme = this.theme;
    const layout = this.layout;
    const currentArtFileName = /* resolve from shell?.library for data[artKey] if any, else undefined */;
    const req = {
      sessionId,
      themeContext: {
        lookAndFeel: theme.lookAndFeel,
        palette: theme.artFlavor?.(this.data) ?? '',
        argumentSummary: layout.fields.map((f) => f.key).join(', '),
      },
      fields: layout.fields.map((f) => ({ kind: f.kind, key: f.key, label: f.label })),
      currentData,
      currentArtFileName,
      userPrompt,
    };
    this.aiBusy = true;
    this.aiNote = 'Asking the assistant…';
    try {
      const exit = await runAppExit(Effect.flatMap(AgentFill, (a) => a.fill(req)));
      if (Exit.isFailure(exit)) { this.aiNote = noteFromCause(exit.cause); return; }
      const out = exit.value;
      this.fillSessionId = out.sessionId;
      this.data = { ...this.data, ...out.patch }; // targeted merge — only returned keys change
      this.aiNote = 'Applied.';
      if (out.artAction) {
        // auto-run Task E's pipeline through a PortraitSection-equivalent generate,
        // passing brief + editCurrentArt (needs the art field key from layout).
      }
    } finally {
      this.aiBusy = false;
    }
  }
  ```
  Render an `AI` panel above the `Details` panel in `BuilderForm` (113-135): a `TextAreaInput` bound to `aiPrompt`, a `Fill with AI` `Button` (`disabled={aiBusy}`, `onClick={() => void builder.fillWithAI()}`), and `{aiNote && <span…>}`. For `artAction` auto-run, extract a shared `generateArt`-style effect (call into `ImageProvider.generate` with `editCurrentArt: out.artAction.editCurrentArt`, `brief: out.artAction.brief`, the resolved `currentArtFileName`, and the layout arguments) — reuse the exact snapshot/boundary body from Task E's `PortraitSection.generateArt` (factor a small helper or inline). The art field key is the layout's single `image` field: `layout.fields.find((f) => f.kind === 'image')?.key`.
- [ ] Run `bun run verify` — expect green.
- [ ] Commit:
  ```
  feat: conversational AI fill — /api/agent/fill, AgentFill service, Builder AI panel

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```

---

## Task G — Sweep + docs + e2e

Update the README to the two-tab app + themes/layouts + AI concepts, grep for dead references, note the `cartis-data/cards` clean slate, and run the final verify + build + manual dev-server e2e checklist.

### Files

- **Modify** `README.md` — rewrite the intro/tabs, add themes/layouts + AI fill + art pipeline sections, `OPENCODE_MODEL` recommendation, and an "adding a theme / adding a layout" guide replacing the add-a-card-style guide.
- **Modify** `.gitignore` — confirm `cartis-data/` is ignored (it already is per `docs/.../cartis-file-store.md:15`); add a clean-slate note in the README.
- **Test** — no new automated tests; this is the sweep + manual checklist.

### Interfaces

**Consumes**: everything from Tasks A-F.

### Steps

- [ ] Rewrite `README.md`: the current intro (lines 1-7) names Builder / Code Lab / Image Lab. Replace with: a two-tab app (Builder, Gallery); **Themes** (worlds: identity + palette + parts + `lookAndFeel`) and **Layouts** (per-theme card faces parameterized by arguments); **AI fill** (conversational, targeted, vision-capable, sonnet-class via `OPENCODE_MODEL`); **art pipeline** (text-first, LLM-composed prompt → replicate `flux-kontext-pro`, optional photo/edit steering). Keep the "dev server IS the app / `/api/*` only under `bun run dev`" note (README:15-18) and the quality-gate note (README:20+).
- [ ] Add a **Adding a theme / adding a layout** section: a theme is a `Theme` object (`src/cards/types.ts`) registered via `registerTheme` in `registerBuiltinThemes` (`src/cards/index.ts`); a layout is a `Layout` in a theme's `layouts[]` (own `fields`/`defaults`/`artAspect`/`Render`, sharing the theme's exported field list). Point to `src/cards/arcane/theme.ts` as the worked example.
- [ ] Add an `OPENCODE_MODEL` note: fill runs on a sonnet-class model; set `OPENCODE_MODEL` (read by `agentClientLive`, agentBridge.ts:150) to a sonnet-class default recommendation; `REPLICATE_API_TOKEN` gates live art (else the deterministic stub).
- [ ] Add a **cartis-data** note: `cartis-data/cards/` restarts from scratch (clean break, spec decision 2 — old `templateId` sidecars fail the new `CardRecord` decode and are dropped by the lenient list). Generated art → `cartis-data/images/`, exports → `cartis-data/exports/`.
- [ ] Dead-reference sweep — run and expect ZERO matches across `src` (docs/plans/specs may legitimately mention them):
  ```
  grep -rn "getTemplate\|templateId\|registerTemplate\|listTemplates\|CardTemplate\|artStylePrompt\|arcaneTemplate\|registerBuiltinTemplates\|__clearTemplatesForTests\|ImageLabView\|src/editor\|EditorView\|AgentApi\|buildAgentPrompt\|extractCode\|runCardAgent\|AgentCardRequest\|freestyle\|Code Lab\|Image Lab" src
  ```
  Fix any stragglers.
- [ ] Run `bun run verify` — expect green.
- [ ] Run `bun run build` — expect a clean compile smoke test.
- [ ] **Sanctioned render exception** (spec §Reference example): add `whitespace-pre-wrap` to the fullart ability plate's className (`src/cards/arcane/ArcaneFullArtCard.tsx:88` — `font-card text-[13px] leading-snug text-white/95` → prepend `whitespace-pre-wrap`), matching classic's `ArcaneRulesBox` (`parts.tsx:151`), so multi-paragraph rules render as paragraphs. This is the ONLY card-TSX edit in the whole plan.
- [ ] Dev-server e2e checklist (manual, `bun run dev` → http://localhost:5173): (1) new card renders the layout defaults with an EMPTY art placeholder; (2) a fill turn "rename him to Vorak" patches `name` only (other fields unchanged); (3) art Generate on the stub path (no `REPLICATE_API_TOKEN`) applies deterministic stub art and logs compose + generate activity events; (4) Save → Gallery → click the saved card → it reopens in the Builder (theme + layout + data), edit + re-save updates the SAME record (no duplicate); (5) the activity bar shows the compose/generate/fill events and the log drawer opens.
- [ ] **Recreate The Great Henge** (the acceptance exercise — spec §Reference example, image at `docs/reference/great-henge-reference.jpg`): in the Builder pick arcane/fullart and fill (by AI or hand): name `The Great Henge`, essence `verdant`, cost `7`, typeLine `Legendary Artifact`, showStats off, rarity `mythic`, collector `2026 Custom Proxy · QP • EN`, ability (three paragraphs, unicode symbols):
  ```
  This spell costs ✦ less to cast, where ✦ is the greatest power among creatures you control.
  ⟳: Add ●●. You gain 2 life.
  Whenever a nontoken creature enters the battlefield under your control, put a +1/+1 counter on it and draw a card.
  ```
  Generate art (live token if available — expect a mystical verdant henge scene from the composed prompt; stub otherwise), save to gallery, export PNG. Compare side-by-side with the reference image; note remaining gaps (cost-pip model, no inline symbol icons) in the report — they are accepted, not defects.
- [ ] Commit:
  ```
  docs: two-tab app, themes/layouts + AI concepts; dead-reference sweep + e2e checklist

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  ```
