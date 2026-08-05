/**
 * CARTIS_FAKE_AGENT=1 — the scripted faux model for scripted e2e (Track B of
 * the test-hardening spec). NOT a fake client: the REAL pi agent loop, REAL
 * card tools (typebox validation), REAL SessionManager persistence, and REAL
 * SSE event mapping all run — only the MODEL is scripted. The bridge builds
 * its PiRuntime with this injected ModelRuntime and forces
 * `CARTIS_MODEL=faux/faux-model` while the flag is set.
 *
 * DETERMINISTIC KEYWORD RULES over the LAST USER MESSAGE (tests phrase
 * prompts to match; rules COMPOSE — one prompt can produce several tool
 * rounds, then one final text round):
 *   - /rename (?:this card |her |him )?to '?"?([A-Za-z ]+)/i  → card_patch {name}
 *   - "save it" | "save the card"                             → card_save
 *   - "export print"                                          → card_export {target:'print'}
 *   - "full art"                                              → card_set_layout {layoutId:'fullart'}
 *   - literal INVALID_ARGS_PLEASE → card_patch {cost:999} (validation
 *     REJECTS it) then an apology text round — the validation-failure UX
 *     becomes a deterministic browser test;
 *   - literal SLOW_TURN_PLEASE    → ~1.5s delay before the text round (makes
 *     the busy strip + Stop swap observable);
 *   - default                     → one acknowledgement text round.
 *
 * Config-reachable file: relative `.ts` imports only.
 */

import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import type { ModelRuntime as ModelRuntimeT } from '@earendil-works/pi-coding-agent';
import { fauxRuntime } from './faux.ts';

interface ContextView {
  messages: Array<{ role?: string; content?: string | Array<{ type: string; text?: string }> }>;
}

/** The last user message's text (inline <file> blocks and all). */
function lastUserText(context: ContextView): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const message = context.messages[i];
    if (message?.role !== 'user') continue;
    const content = message.content;
    if (typeof content === 'string') return content;
    return (content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');
  }
  return '';
}

const RENAME = /rename (?:this card |her |him )?to '?"?([A-Za-z ]+)/i;

export async function fakeAgentRuntime(): Promise<ModelRuntimeT> {
  // Reuse the proven faux registration (src/server/pi/faux.ts) — same
  // provider/model ids the unit tier uses: faux/faux-model.
  const faux = await fauxRuntime();

  /**
   * One persistent factory per model call: reads the context, decides the
   * NEXT round. Because tool results come back as new context messages, the
   * factory sees its own earlier tool calls and emits the remaining rounds —
   * pending intents are tracked per conversation turn via the plan queue.
   */
  type Round =
    | { kind: 'tool'; name: string; args: Record<string, unknown> }
    | { kind: 'text'; text: string; delayMs?: number };

  /** Build the full round plan for one user prompt. */
  const planFor = (text: string): Round[] => {
    if (text.includes('INVALID_ARGS_PLEASE')) {
      return [
        { kind: 'tool', name: 'card_patch', args: { cost: 999 } },
        { kind: 'text', text: 'Sorry — that cost was out of range, so I left the card unchanged.' },
      ];
    }
    const rounds: Round[] = [];
    const rename = RENAME.exec(text);
    if (rename?.[1] !== undefined) {
      rounds.push({ kind: 'tool', name: 'card_patch', args: { name: rename[1].trim() } });
    }
    if (/save (it|the card)/i.test(text)) {
      rounds.push({ kind: 'tool', name: 'card_save', args: {} });
    }
    if (/export print/i.test(text)) {
      rounds.push({ kind: 'tool', name: 'card_export', args: { target: 'print' } });
    }
    if (/full art/i.test(text)) {
      rounds.push({ kind: 'tool', name: 'card_set_layout', args: { layoutId: 'fullart' } });
    }
    const delayMs = text.includes('SLOW_TURN_PLEASE') ? 1500 : undefined;
    rounds.push({
      kind: 'text',
      text: rounds.length > 0 ? 'Done — applied your changes.' : 'Understood.',
      ...(delayMs !== undefined ? { delayMs } : {}),
    });
    return rounds;
  };

  // Per-prompt state: keyed by the user text + how many assistant rounds the
  // context already shows for it (the loop appends assistant/toolResult
  // messages between rounds, so counting assistant messages AFTER the last
  // user message tells us which round comes next).
  const factory = async (context: unknown) => {
    const view = context as ContextView;
    const text = lastUserText(view);
    // rounds already played for THIS user turn:
    let played = 0;
    for (let i = view.messages.length - 1; i >= 0; i--) {
      const m = view.messages[i];
      if (m?.role === 'user') break;
      if (m?.role === 'assistant') played += 1;
    }
    const plan = planFor(text);
    const round = plan[Math.min(played, plan.length - 1)] ?? plan[plan.length - 1];
    // re-arm for the next model call, forever.
    faux.appendResponses([factory]);
    if (round === undefined) return fauxAssistantMessage([fauxText('Understood.')]);
    if (round.kind === 'tool') {
      return fauxAssistantMessage([fauxToolCall(round.name, round.args)], {
        stopReason: 'toolUse',
      });
    }
    if (round.delayMs !== undefined) {
      await new Promise((r) => setTimeout(r, round.delayMs));
    }
    return fauxAssistantMessage([fauxText(round.text)]);
  };
  faux.setResponses([factory]);

  return faux.modelRuntime;
}
