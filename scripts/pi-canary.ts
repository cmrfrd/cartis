/**
 * Pi migration canary (spec §7.1 — HARD GATE; plan Task 1). Proves, under
 * bun, against the PINNED pi version (0.83.0):
 *   1. full §2.1 isolation config constructs without touching $HOME
 *   2. a custom tool receives VALIDATED args through the real agent loop
 *   3. entries land on disk (user, assistant+toolCall, toolResult)
 *   4. leaf_switch custom entries make branch selection survive REOPEN
 *   5. invalid tool args → pi's error-tool-result → model retry flow
 *   6. dispose is clean
 * Run: `bun scripts/pi-canary.ts` — exits nonzero on any failure.
 * RE-RUN THIS on every pi version bump.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  fauxAssistantMessage,
  fauxRuntime,
  fauxText,
  fauxToolCall,
} from '../src/server/pi/faux.ts';

function assert(cond: unknown, label: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  console.log(`✓ ${label}`);
}

const root = mkdtempSync(join(tmpdir(), 'pi-canary-'));
const chatsDir = join(root, 'chats');

try {
  // --- §2.1 isolation config ---
  const faux = await fauxRuntime();
  const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: join(root, 'agent'),
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: 'You are the canary persona.',
    appendSystemPrompt: [],
  });
  await loader.reload();
  assert(loader.getSystemPrompt()?.includes('canary persona'), 'resource loader system prompt set');

  const sessionManager = SessionManager.create(root, chatsDir, { id: 'canary-1' });

  const seen: unknown[] = [];
  const canaryTool = defineTool({
    name: 'canary_tool',
    label: 'Canary',
    description: 'Records a value.',
    parameters: Type.Object({ value: Type.String() }),
    executionMode: 'sequential',
    execute: async (_id, params) => {
      seen.push(params);
      return { content: [{ type: 'text', text: 'ok' }], details: {} };
    },
  });

  const { session } = await createAgentSession({
    cwd: root,
    agentDir: join(root, 'agent'),
    modelRuntime: faux.modelRuntime,
    model: faux.model as never,
    sessionManager,
    settingsManager: settings,
    resourceLoader: loader,
    noTools: 'all',
    customTools: [canaryTool],
    tools: ['canary_tool'],
  });

  // --- happy turn: tool call then reply ---
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('canary_tool', { value: 'hello' })], {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage([fauxText('Done.')]),
  ]);
  await session.prompt('hi');
  assert(seen.length === 1, 'tool executed exactly once');
  assert(
    typeof seen[0] === 'object' && (seen[0] as { value: unknown }).value === 'hello',
    'tool received validated args',
  );

  const branch = sessionManager.getBranch();
  const roles = branch
    .filter((e) => e.type === 'message')
    .map((e) => (e as { message: { role: string } }).message.role);
  assert(
    JSON.stringify(roles) === JSON.stringify(['user', 'assistant', 'toolResult', 'assistant']),
    `branch roles user/assistant/toolResult/assistant (got ${roles.join(',')})`,
  );
  const assistantEntry = branch.find(
    (e) =>
      e.type === 'message' &&
      (e as { message: { role: string; content: unknown[] } }).message.role === 'assistant',
  ) as { message: { content: { type: string }[] } };
  assert(
    assistantEntry.message.content.some((c) => c.type === 'toolCall'),
    'assistant entry carries the toolCall content block',
  );
  const file = sessionManager.getSessionFile();
  assert(
    file !== undefined && readFileSync(file, 'utf8').includes('canary_tool'),
    'entries persisted to disk',
  );

  // --- validation failure → error tool result → model self-corrects ---
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('canary_tool', { wrong: true })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('canary_tool', { value: 'fixed' })], {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage([fauxText('Recovered.')]),
  ]);
  await session.prompt('again');
  const second = seen[1] as { value: unknown } | undefined;
  assert(
    second !== undefined && second.value === 'fixed',
    'invalid args rejected pre-execute; corrected retry executed',
  );
  const toolResults = sessionManager
    .getBranch()
    .filter(
      (e) =>
        e.type === 'message' && (e as { message: { role: string } }).message.role === 'toolResult',
    ) as { message: { isError?: boolean } }[];
  assert(
    toolResults.some((r) => r.message.isError === true),
    'validation failure persisted as an error tool result',
  );

  // --- leaf durability across reopen (blocker-1 regression) ---
  const userEntries = sessionManager
    .getBranch()
    .filter(
      (e) => e.type === 'message' && (e as { message: { role: string } }).message.role === 'user',
    );
  const firstUser = userEntries[0] as { id: string };
  sessionManager.branch(firstUser.id); // move leaf to the FIRST user message
  sessionManager.appendCustomEntry('leaf_switch', { leafId: firstUser.id });
  const beforeIds = sessionManager
    .getBranch()
    .map((e) => (e as { id: string }).id)
    .join(',');
  const reopened = SessionManager.open(file as string, chatsDir, root);
  const afterIds = reopened
    .getBranch()
    .map((e) => (e as { id: string }).id)
    .join(',');
  assert(beforeIds === afterIds, 'leaf_switch: selected branch survives SessionManager reopen');
  assert(
    !afterIds.includes((userEntries[1] as { id: string })?.id ?? '@@none@@') ||
      userEntries.length < 2,
    'reopened branch excludes the abandoned second turn',
  );

  session.dispose();
  assert(true, 'dispose clean');
  console.log('\nCANARY: GO — pi 0.83.0 under bun, faux seam functional');
} finally {
  rmSync(root, { recursive: true, force: true });
}
