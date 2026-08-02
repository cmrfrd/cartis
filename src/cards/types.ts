// Sanctioned type-only react import (see Global Constraints).
import type { ComponentType } from 'react';

export type FieldValue = string | number | boolean | undefined;

/** The data record a template's form edits and its renderer consumes. */
export type CardData = Record<string, FieldValue>;

/** Show a field only while another field holds a specific value. */
export interface FieldCondition {
  key: string;
  equals: FieldValue;
}

export type FieldSpec = (
  | { kind: 'text'; key: string; label: string; placeholder?: string; maxLength?: number }
  | { kind: 'textarea'; key: string; label: string; rows?: number; placeholder?: string }
  | { kind: 'number'; key: string; label: string; min: number; max: number }
  | {
      kind: 'select';
      key: string;
      label: string;
      options: readonly { value: string; label: string }[];
    }
  | { kind: 'image'; key: string; label: string }
  | { kind: 'toggle'; key: string; label: string }
) & { showIf?: FieldCondition };

/**
 * `data` is optional because expressive Component fields surface as optional JSX
 * props — renderers must tolerate missing data (and default it internally).
 */
export type CardRenderProps = { data?: CardData; holo?: boolean };
export type CardRenderer = ComponentType<CardRenderProps>;

/**
 * A registered card definition: what the Builder's form edits (fields/defaults),
 * how the AI image pipeline should style portraits (artStylePrompt), and how it renders.
 */
export interface CardTemplate {
  id: string;
  kitId: string;
  name: string;
  description: string;
  fields: readonly FieldSpec[];
  defaults: CardData;
  artStylePrompt: (data: CardData) => string;
  /** Preferred replicate aspect for this template's art slot (e.g. '3:2'). */
  artAspect?: string;
  Render: CardRenderer;
}

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
