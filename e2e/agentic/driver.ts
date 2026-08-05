/**
 * The in-process pi driver (test-hardening spec §Track C): the SAME pi
 * runtime the app ships, given the browser tools and a user-voice objective.
 * All state in-memory; auth = the app's own ANTHROPIC_API_KEY/OPENAI_API_KEY.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import type { Browser } from './browser.ts';

export const APP_URL = 'http://localhost:5199';

/** The driver's system prompt (spec §Driver preamble). */
export const PREAMBLE =
  'You are a USER of the Cartis card app at {{APP_URL}}, driving a real browser ' +
  'through the provided browser tools. Act ONLY through the UI — never read or ' +
  'modify source files or data directories directly. Take a page snapshot before ' +
  'interacting. Prefer snapshots over screenshots. The app has its own AI: after ' +
  'sending a chat message, WAIT until its Stop button reverts to Send before your ' +
  'next action. When the objective is complete, reply exactly ' +
  '`DONE: <one-paragraph summary>`. If truly blocked, reply `BLOCKED: <why>`.';

/** {{APP_URL}} / {{STAGE_DIR}} substitution for objectives + the preamble. */
export function template(text: string, vars: { APP_URL: string; STAGE_DIR: string }): string {
  return text.replaceAll('{{APP_URL}}', vars.APP_URL).replaceAll('{{STAGE_DIR}}', vars.STAGE_DIR);
}

const TOOL_CALL_CAP = 40;

export interface DriverRun {
  reply: string;
  outcome: 'done' | 'blocked' | 'timeout';
  events: unknown[];
}

function modelRef(): { provider: string; modelId: string } {
  const raw = process.env.E2E_DRIVER_MODEL ?? process.env.CARTIS_MODEL ?? '';
  const at = raw.indexOf('/');
  if (at <= 0 || at === raw.length - 1) {
    throw new Error(`E2E_DRIVER_MODEL/CARTIS_MODEL must be "provider/model-id", got "${raw}"`);
  }
  return { provider: raw.slice(0, at), modelId: raw.slice(at + 1) };
}

export async function runDriver(
  browser: Browser,
  systemPrompt: string,
  objective: string,
  timeoutMin: number,
): Promise<DriverRun> {
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  const ref = modelRef();
  const model = modelRuntime.getModel(ref.provider, ref.modelId);
  if (model === undefined) throw new Error(`unknown driver model ${ref.provider}/${ref.modelId}`);

  // Throwaway scratch cwd — the driver never touches the repo; sessions are
  // written here and deleted with it.
  const scratch = mkdtempSync(join(tmpdir(), 'cartis-e2e-driver-'));
  const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: scratch,
    agentDir: join(scratch, 'agent'),
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
    appendSystemPrompt: [],
  });
  await loader.reload();

  const sessionManager = SessionManager.create(scratch, join(scratch, 'sessions'));
  const { session } = await createAgentSession({
    cwd: scratch,
    agentDir: join(scratch, 'agent'),
    modelRuntime,
    model: model as never,
    sessionManager,
    settingsManager: settings,
    resourceLoader: loader,
    noTools: 'all',
    customTools: browser.tools as never,
    tools: browser.tools.map((t: { name: string }) => t.name),
  });

  const events: unknown[] = [];
  let toolCalls = 0;
  let aborted = false; // timeout or cap — either way the run did not finish
  const unsubscribe = session.subscribe((event) => {
    events.push(event);
    const e = event as { type?: string };
    if (e.type === 'tool_execution_start') toolCalls += 1;
    if (toolCalls >= TOOL_CALL_CAP && !aborted) {
      aborted = true;
      void session.abort();
    }
  });
  const timeout = setTimeout(() => {
    aborted = true;
    void session.abort();
  }, timeoutMin * 60_000);

  let reply = '';
  try {
    await session.prompt(objective);
    // The reply = the final assistant text on the branch (read BEFORE the
    // scratch dir is deleted).
    const branch = sessionManager.getBranch() as unknown as Array<{
      type: string;
      message?: { role?: string; content?: Array<{ type: string; text?: string }> };
    }>;
    const lastAssistant = [...branch]
      .reverse()
      .find((e) => e.type === 'message' && e.message?.role === 'assistant');
    reply = (lastAssistant?.message?.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('')
      .trim();
  } finally {
    clearTimeout(timeout);
    unsubscribe();
    session.dispose();
    rmSync(scratch, { recursive: true, force: true });
  }

  const outcome: DriverRun['outcome'] =
    !aborted && /^\s*DONE:/m.test(reply)
      ? 'done'
      : !aborted && /^\s*BLOCKED:/m.test(reply)
        ? 'blocked'
        : 'timeout';
  return { reply, outcome, events };
}
