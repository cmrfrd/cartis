// Sanctioned type-only react import (see Global Constraints).

import type { NonEmptyReadonlyArray } from 'effect/Array';
import type { ComponentType } from 'react';
import type { AspectRatioT, FieldSpecT, FieldValueT } from '@/contracts/fields';
import type { LayoutIdT, ThemeIdT } from '@/contracts/ids';

/**
 * Single source of truth: these types DERIVE from the canonical Schemas in
 * src/contracts/fields.ts (spec: type-safety & contract hardening §7). Layout
 * field definitions are additionally Schema-validated at theme registration.
 */
export type FieldValue = FieldValueT;

/** The data record a template's form edits and its renderer consumes. */
export type CardData = Record<string, FieldValue>;

export type FieldSpec = FieldSpecT;

/**
 * `data` is optional because expressive Component fields surface as optional JSX
 * props — renderers must tolerate missing data (and default it internally).
 */
export type CardRenderProps = { data?: CardData; holo?: boolean };
export type CardRenderer = ComponentType<CardRenderProps>;

/** A card face: how theme components organize into a layout, parameterized by arguments. */
export interface Layout {
  id: LayoutIdT;
  name: string;
  description: string;
  fields: readonly FieldSpec[];
  defaults: CardData;
  /** Preferred replicate aspect for this layout's art slot (closed union). */
  artAspect?: AspectRatioT;
  Render: CardRenderer;
}

/** A collection/world: identity + shared code parts + ordered layouts. */
export interface Theme {
  id: ThemeIdT;
  name: string;
  description: string;
  /** Prose visual identity consumed by the AI art + fill pipelines. */
  lookAndFeel: string;
  CardBack: CardRenderer;
  /** Ordered; the head is the default — non-emptiness is a type-level fact. */
  layouts: NonEmptyReadonlyArray<Layout>;
  /** Optional per-card flavor derived from data (e.g. palette artFlavor). */
  artFlavor?: (data: CardData) => string;
}
