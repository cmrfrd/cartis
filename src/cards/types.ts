// Sanctioned type-only react import (see Global Constraints).
import type { ComponentType } from 'react';

export type FieldValue = string | number | boolean | undefined;

/** The data record a template's form edits and its renderer consumes. */
export type CardData = Record<string, FieldValue>;

export type FieldSpec =
  | { kind: 'text'; key: string; label: string; placeholder?: string; maxLength?: number }
  | { kind: 'textarea'; key: string; label: string; rows?: number; placeholder?: string }
  | { kind: 'number'; key: string; label: string; min: number; max: number }
  | {
      kind: 'select';
      key: string;
      label: string;
      options: readonly { value: string; label: string }[];
    }
  | { kind: 'image'; key: string; label: string };

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
  Render: CardRenderer;
}
