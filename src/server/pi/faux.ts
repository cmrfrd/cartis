/**
 * Deterministic pi test seam (migration spec §8.2), built on pi's OWN faux
 * provider: scripted AssistantMessages stream through the REAL agent loop,
 * REAL tool validation, and REAL SessionManager persistence — no network,
 * no auth. Used by the canary and the full-loop vitest tier.
 *
 * Pinned against @earendil-works/pi-* 0.83.0 (re-verify on every pin bump —
 * npm 0.83.0 differs from repo HEAD in ResourceLoader option names).
 */

import {
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  InMemoryCredentialStore,
} from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

export { fauxAssistantMessage, fauxText, fauxToolCall };

export interface FauxRuntime {
  modelRuntime: ModelRuntime;
  /** The registered faux model — pass as `model` to createAgentSession. */
  model: unknown;
  setResponses: (
    responses: Parameters<ReturnType<typeof createFauxCore>['setResponses']>[0],
  ) => void;
  appendResponses: (
    responses: Parameters<ReturnType<typeof createFauxCore>['appendResponses']>[0],
  ) => void;
  callCount: () => number;
}

/** An isolated ModelRuntime with a scripted faux provider registered. */
export async function fauxRuntime(): Promise<FauxRuntime> {
  const core = createFauxCore({ provider: 'faux', models: [{ id: 'faux-model' }] });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  modelRuntime.registerProvider('faux', {
    name: 'Faux (tests)',
    api: core.api as never,
    baseUrl: 'http://faux.invalid',
    apiKey: 'faux-key', // satisfies the auth check; streamSimple never uses it
    streamSimple: core.streamSimple,
    models: [
      {
        id: 'faux-model',
        name: 'Faux Model',
        reasoning: false,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
    ],
  });
  const model = modelRuntime.getModel('faux', 'faux-model');
  return {
    modelRuntime,
    model,
    setResponses: core.setResponses,
    appendResponses: core.appendResponses,
    callCount: () => core.state.callCount,
  };
}
