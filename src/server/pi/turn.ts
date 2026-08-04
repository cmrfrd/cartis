/**
 * The pi turn orchestrator (migration spec §2.2/§3.2): per-turn AgentSession
 * over the cached SessionManager; tool intents collected + canonicalized from
 * the persisted entries; authoritative entry ids read from the branch tail
 * after `prompt()` resolves. Async/promise code by design (pi's world) — the
 * bridge routes wrap it in Effect at the boundary.
 *
 * Config-reachable: pi imported only via PiRuntime.deps() (lazy).
 */

import { join } from 'node:path';
import type { SessionManager } from '@earendil-works/pi-coding-agent';
import type { ChatAttachmentT, ChatTurnRequestT } from '../../contracts/api.ts';
import { SessionId, type SessionIdT } from '../../contracts/ids.ts';
import type { ThreadEventT } from '../../contracts/thread.ts';
import { cardTools, type IntentCollector, personaPrompt } from './cardTools.ts';
import { initialPiWatchState, mapPiEvent } from './mapPiEvent.ts';
import { type PiRuntime, parseModelRef } from './runtime.ts';

/** Structured turn result (wire contract v2, spec §3.2). */
export interface TurnResult {
  sessionId: string;
  reply: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  toolErrors: Array<{ name: string; message: string }>;
  userEntryId: string;
  assistantEntryId: string;
}

export class TurnBusyError extends Error {
  constructor() {
    super('a turn is already running for this session');
  }
}
export class TurnFailedError extends Error {}

const WALL_CLOCK_TIMEOUT_MS = 180_000;

interface ImageInput {
  type: 'image';
  data: string;
  mimeType: string;
}

const dataUrlToImage = (dataUrl: string): ImageInput | undefined => {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  return match
    ? { type: 'image', data: match[2] as string, mimeType: match[1] as string }
    : undefined;
};

const isImage = (a: ChatAttachmentT): boolean => a.mime.startsWith('image/');

/** Text-file attachments inline into the user content (pi CLI convention). */
const inlineTextFiles = (attachments: readonly ChatAttachmentT[]): string =>
  attachments
    .filter((a) => !isImage(a))
    .map((a) => {
      const match = /^data:[^;]+;base64,(.+)$/.exec(a.dataUrl);
      const text = match ? Buffer.from(match[1] as string, 'base64').toString('utf8') : '';
      return `\n\n<file name="${a.name}">\n${text}\n</file>`;
    })
    .join('');

type Entry = {
  id: string;
  type: string;
  message?: {
    role?: string;
    content?: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      arguments?: unknown;
    }>;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
  };
};

/** Everything the caller derives from the branch tail after a prompt. */
export function readTurnTail(sessionManager: SessionManager): {
  userEntryId: string;
  assistantEntryId: string;
  reply: string;
  blockOrder: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  toolErrors: Array<{ name: string; message: string }>;
} {
  const branch = sessionManager.getBranch() as unknown as Entry[];
  let userAt = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i] as Entry;
    if (e.type === 'message' && e.message?.role === 'user') {
      userAt = i;
      break;
    }
  }
  if (userAt < 0) throw new TurnFailedError('no user entry after turn');
  const tail = branch.slice(userAt);
  const userEntryId = (tail[0] as Entry).id;
  const assistants = tail.filter((e) => e.type === 'message' && e.message?.role === 'assistant');
  const last = assistants.at(-1);
  if (last === undefined) throw new TurnFailedError('no assistant entry after turn');
  // Reply = concatenated text of the FINAL assistant message.
  const reply = (last.message?.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('')
    .trim();
  // Canonical tool-call order: toolCall blocks across assistant entries in
  // entry+block order (spec §3.2), paired with their toolResult entries.
  const blockOrder: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
  for (const entry of assistants) {
    for (const block of entry.message?.content ?? []) {
      if (block.type === 'toolCall') {
        blockOrder.push({
          id: block.id ?? '',
          name: block.name ?? 'tool',
          args: (block.arguments ?? {}) as Record<string, unknown>,
        });
      }
    }
  }
  const toolErrors: Array<{ name: string; message: string }> = [];
  for (const entry of tail) {
    if (
      entry.type === 'message' &&
      entry.message?.role === 'toolResult' &&
      entry.message.isError === true
    ) {
      const text = (entry.message.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('');
      toolErrors.push({ name: entry.message.toolName ?? 'tool', message: text });
    }
  }
  return { userEntryId, assistantEntryId: last.id, reply, blockOrder, toolErrors };
}

export interface TurnIo {
  emit: (event: ThreadEventT) => void; // ThreadBus events (SSE)
  log: (message: string) => void; // console-lane notes (heartbeat etc.)
  /** current-art reader (same injection as the old runChatTurn). */
  readArt?: (fileName: string) => Promise<{ mime: string; dataUrl: string } | undefined>;
  now?: () => number;
  mintId?: () => string;
}

export async function runTurn(
  rt: PiRuntime,
  req: ChatTurnRequestT,
  io: TurnIo,
): Promise<TurnResult> {
  const sessionId: SessionIdT = req.sessionId ?? SessionId.make(crypto.randomUUID());
  if (rt.inFlight.has(sessionId)) throw new TurnBusyError();

  const { pi, modelRuntime, settings } = await rt.deps();
  const ref = parseModelRef(process.env.CARTIS_MODEL);
  const model = modelRuntime.getModel(ref.provider, ref.modelId);
  if (model === undefined) {
    throw new TurnFailedError(`unknown model ${ref.provider}/${ref.modelId}`);
  }

  const sessionManager = await rt.getSession(sessionId);
  const loader = new pi.DefaultResourceLoader({
    cwd: rt.dataRoot,
    agentDir: join(rt.dataRoot, 'agent'),
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: personaPrompt(req),
    appendSystemPrompt: [],
  });
  await loader.reload();

  const collector: IntentCollector = { calls: [] };
  const tools = cardTools(req.fields, req.docContext, collector);
  const { session } = await pi.createAgentSession({
    cwd: rt.dataRoot,
    agentDir: join(rt.dataRoot, 'agent'),
    modelRuntime,
    model: model as never,
    sessionManager,
    settingsManager: settings,
    resourceLoader: loader,
    noTools: 'all',
    customTools: tools as never,
    tools: tools.map((t) => t.name),
  });

  rt.inFlight.set(sessionId, session);
  const now = io.now ?? (() => Date.now());
  const mintId = io.mintId ?? (() => crypto.randomUUID());
  let watch = initialPiWatchState;
  const unsubscribe = session.subscribe((event) => {
    const out = mapPiEvent(event, sessionId, watch, now(), mintId);
    watch = out.state;
    for (const e of out.events) io.emit(e);
  });
  const heartbeatStart = now();
  const heartbeat = setInterval(() => {
    io.log(`still working… (${String(Math.round((now() - heartbeatStart) / 1000))}s)`);
  }, 5000);
  const timeout = setTimeout(() => {
    void session.abort();
  }, WALL_CLOCK_TIMEOUT_MS);

  try {
    // User content: typed text (or the attachment stand-in) + inlined text
    // files; images = user image attachments, then preview snapshot, then
    // current-art context (spec §3.3 order).
    const attachments = req.attachments ?? [];
    const baseText = req.userPrompt.trim().length > 0 ? req.userPrompt : '(see attached files)';
    const text = baseText + inlineTextFiles(attachments);
    const images: ImageInput[] = [];
    for (const a of attachments) {
      if (!isImage(a)) continue;
      const img = dataUrlToImage(a.dataUrl);
      if (img) images.push(img);
    }
    const userImageCount = images.length;
    if (req.previewDataUrl !== undefined) {
      const img = dataUrlToImage(req.previewDataUrl);
      if (img) images.push(img);
    }
    if (req.currentArtFileName !== undefined && io.readArt !== undefined) {
      const art = await io.readArt(req.currentArtFileName);
      if (art !== undefined) {
        const img = dataUrlToImage(art.dataUrl);
        if (img) images.push(img);
      }
    }

    await session.prompt(text, images.length > 0 ? { images: images as never } : undefined);

    const tail = readTurnTail(sessionManager);
    // Validated calls only, in canonical block order: intersect the persisted
    // block order with the collector's executed (validated) set.
    const executed = [...collector.calls];
    const toolCalls: TurnResult['toolCalls'] = [];
    for (const block of tail.blockOrder) {
      const at = executed.findIndex((c) => c.name === block.name);
      if (at >= 0) {
        toolCalls.push({ name: block.name, args: executed[at]?.args ?? {} });
        executed.splice(at, 1);
      }
    }
    // Attachment metadata entry — keyed to the user entry EXPLICITLY (§3.3).
    sessionManager.appendCustomEntry('turn_meta', {
      userEntryId: tail.userEntryId,
      attachments: attachments.map((a) => ({ name: a.name, mime: a.mime })),
      contextImages: images.length - userImageCount,
    });
    return {
      sessionId,
      reply: tail.reply,
      toolCalls,
      toolErrors: tail.toolErrors,
      userEntryId: tail.userEntryId,
      assistantEntryId: tail.assistantEntryId,
    };
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
    unsubscribe();
    rt.inFlight.delete(sessionId);
    session.dispose();
  }
}
