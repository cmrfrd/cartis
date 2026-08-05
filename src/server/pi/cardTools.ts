/**
 * Card tools — the tool transport (migration spec §3.1). Declarative intents:
 * every tool's execute() records its VALIDATED params into the per-turn
 * collector and returns a short text result; the actual effect happens
 * client-side. Schemas are built PER TURN from the request's fields and
 * docContext, so the provider itself enforces field ranges, select options,
 * and valid layout/theme ids (invalid ids are unrepresentable).
 *
 * Config-reachable file: runtime imports are `typebox` only; all pi imports
 * are TYPE-ONLY (erased — safe for vite's native config loader).
 */

import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { ChatTurnRequestT, DocContextT } from '../../contracts/api.ts';
import type { FieldSummaryT } from '../../contracts/fields.ts';
import {
  CARD_EXPORT_TOOL,
  CARD_GENERATE_ART_TOOL,
  CARD_PATCH_TOOL,
  CARD_SAVE_COPY_TOOL,
  CARD_SAVE_TOOL,
  CARD_SET_ASPECT_TOOL,
  CARD_SET_HOLO_TOOL,
  CARD_SET_LAYOUT_TOOL,
  CARD_SET_THEME_TOOL,
} from '../../contracts/materialize.ts';

/** Validated tool intents, in execution (== call, tools are sequential) order. */
export interface IntentCollector {
  calls: Array<{ name: string; args: Record<string, unknown> }>;
}

const ok = { content: [{ type: 'text' as const, text: 'ok' }], details: {} };

/** One field's TypeBox schema — mirrors the old patchValueFor constraints. */
function fieldSchema(field: FieldSummaryT) {
  if (field.kind === 'number') {
    return field.min !== undefined && field.max !== undefined
      ? Type.Integer({ minimum: field.min, maximum: field.max })
      : Type.Integer();
  }
  if (field.kind === 'toggle') return Type.Boolean();
  if (field.kind === 'select' && field.options !== undefined && field.options.length > 0) {
    return Type.Union(field.options.map((o) => Type.Literal(o)));
  }
  return Type.String();
}

/* biome-ignore-start lint/suspicious/noExplicitAny: pi's ToolDefinition generics need a loose schema slot */
type AnyTool = ToolDefinition<any, any, any>;
/* biome-ignore-end lint/suspicious/noExplicitAny: pi's ToolDefinition generics */

function tool(
  name: string,
  label: string,
  description: string,
  parameters: unknown,
  collector: IntentCollector,
  guidelines?: string[],
): AnyTool {
  return {
    name,
    label,
    description,
    parameters,
    executionMode: 'sequential', // deterministic observable order (spec §3.1)
    ...(guidelines !== undefined ? { promptGuidelines: guidelines } : {}),
    execute: async (_id: string, params: Record<string, unknown>) => {
      collector.calls.push({ name, args: params });
      return ok;
    },
  } as AnyTool;
}

/** The per-turn tool set. Fields/doc options shape the schemas. */
export function cardTools(
  fields: readonly FieldSummaryT[],
  doc: DocContextT | undefined,
  collector: IntentCollector,
): AnyTool[] {
  const tools: AnyTool[] = [];
  if (fields.length > 0) {
    const shape: Record<string, unknown> = {};
    for (const field of fields) shape[field.key] = Type.Optional(fieldSchema(field));
    tools.push(
      tool(
        CARD_PATCH_TOOL,
        'Edit card fields',
        'Update one or more card fields. Include ONLY the fields you are changing.',
        Type.Object(shape as never, { additionalProperties: false }),
        collector,
        ['Hand-edited current values win: change only what the author asked for.'],
      ),
    );
  }
  tools.push(
    tool(
      CARD_GENERATE_ART_TOOL,
      'Generate art',
      'Generate or edit the art illustration from a short visual brief.',
      Type.Object(
        { brief: Type.String(), editCurrentArt: Type.Boolean() },
        { additionalProperties: false },
      ),
      collector,
      [
        'Set editCurrentArt true only when modifying the existing art rather than replacing it.',
        'The brief describes ONLY the artwork — subject, scene, mood, style. ' +
          'NEVER mention a card, frame, border, text, title, stats, or layout in the brief: ' +
          'the image model paints just the art slot, and any mention of "card" makes it ' +
          'hallucinate card frames and text inside the artwork.',
      ],
    ),
    tool(CARD_SAVE_TOOL, 'Save card', 'Save the current card.', Type.Object({}), collector),
    tool(
      CARD_SAVE_COPY_TOOL,
      'Save as copy',
      'Save the current card as a new copy.',
      Type.Object({}),
      collector,
    ),
    tool(
      CARD_EXPORT_TOOL,
      'Export render',
      'Export a render of the card: png = plain 300 DPI, print = 600 DPI with bleed and crop marks, sheet = a 3x3 A4 cut sheet.',
      Type.Object(
        { target: Type.Union([Type.Literal('png'), Type.Literal('print'), Type.Literal('sheet')]) },
        { additionalProperties: false },
      ),
      collector,
    ),
  );
  if (doc !== undefined) {
    if (doc.layoutOptions.length > 0) {
      tools.push(
        tool(
          CARD_SET_LAYOUT_TOOL,
          'Switch layout',
          `Switch the card layout. Current: ${doc.layoutId}.`,
          Type.Object(
            { layoutId: Type.Union(doc.layoutOptions.map((o) => Type.Literal(o))) },
            { additionalProperties: false },
          ),
          collector,
          ['Layout switches apply BEFORE any art generation in the same turn.'],
        ),
      );
    }
    if (doc.themeOptions.length > 0) {
      tools.push(
        tool(
          CARD_SET_THEME_TOOL,
          'Switch theme',
          `Switch the card theme. Current: ${doc.themeId}.`,
          Type.Object(
            { themeId: Type.Union(doc.themeOptions.map((o) => Type.Literal(o))) },
            { additionalProperties: false },
          ),
          collector,
        ),
      );
    }
    tools.push(
      tool(
        CARD_SET_HOLO_TOOL,
        'Toggle holo',
        `Turn the holo finish on or off. Currently: ${doc.holo ? 'on' : 'off'}.`,
        Type.Object({ value: Type.Boolean() }, { additionalProperties: false }),
        collector,
      ),
    );
    if (doc.aspectOptions.length > 0) {
      tools.push(
        tool(
          CARD_SET_ASPECT_TOOL,
          'Set art aspect',
          `Set the art aspect ratio ('auto' = pick the best fit at generation time). Current: ${doc.artAspect}.`,
          Type.Object(
            { aspectRatio: Type.Union(doc.aspectOptions.map((o) => Type.Literal(o))) },
            { additionalProperties: false },
          ),
          collector,
          ['Aspect changes apply BEFORE any art generation in the same turn.'],
        ),
      );
    }
  }
  return tools;
}

/**
 * The per-turn system prompt: persona + THIS turn's card context. The user
 * message stays the author's typed text alone — the old `Author request: `
 * marker convention is gone (spec §2.2).
 */
export function personaPrompt(req: ChatTurnRequestT): string {
  return [
    'You are the card-editing assistant inside Cartis, a trading-card studio. ' +
      'You edit the OPEN card through your tools, in conversation with its author. ' +
      'Use tools for every change — never describe a change without making it. ' +
      'A reply with no tool calls is fine when the author is just talking or you need to ask something.',
    `Look and feel: ${req.themeContext.lookAndFeel}`,
    req.themeContext.palette.length > 0 ? `Palette: ${req.themeContext.palette}` : '',
    `Fields: ${req.fields.map((f) => `${f.key} (${f.kind})`).join(', ')}`,
    `Current values (the author may have hand-edited these; they win): ${JSON.stringify(req.currentData)}`,
    'An image of the CURRENT rendered card may be attached — use it to judge the visual state.',
  ]
    .filter((line) => line.length > 0)
    .join('\n\n');
}
