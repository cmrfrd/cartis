/**
 * Message rendering (maturity spec §2; reference: docs/reference/xulux-chatgpt/
 * chatgpt.tsx L205–405): user = attachments above a right-aligned bubble;
 * assistant = bubble-less markdown; hover icon action bars (Copy ✓ swap, Edit,
 * Regenerate on the LAST assistant only); ‹ n/m › arrows on tree-anchor
 * messages; the EditBox soft inline editor.
 */

import { Match } from 'effect';
import { Check, ChevronLeft, ChevronRight, Copy, Pencil, RefreshCw } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BuilderView } from '@/builder/BuilderView';
import {
  CARD_EXPORT_TOOL,
  CARD_GENERATE_ART_TOOL,
  CARD_PATCH_TOOL,
  CARD_SAVE_COPY_TOOL,
  CARD_SAVE_TOOL,
  CARD_SET_HOLO_TOOL,
  CARD_SET_LAYOUT_TOOL,
  CARD_SET_THEME_TOOL,
} from '@/contracts/materialize';
import type { ThreadMessageT, ThreadPartT } from '@/contracts/thread';

const iconButton =
  'flex size-7 items-center justify-center rounded-base text-ink-dim transition-colors hover:bg-secondary-background hover:text-ink';

export function MessageView(props: { message: ThreadMessageT; isLastAssistant: boolean }) {
  const { thread } = BuilderView.get();
  const { editingId } = thread;
  const { message } = props;
  const isUser = message.role === 'user';
  const incomplete = message.status === 'incomplete';
  if (isUser && editingId === message.id) return <EditBox />;
  return (
    <div className={`group flex flex-col gap-1 ${isUser ? 'items-end' : 'items-start'}`}>
      {message.parts.map((part, i) => (
        <PartView
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional (upsert-by-index)
          key={i}
          part={part}
          role={message.role}
          running={message.status === 'running'}
          error={incomplete}
        />
      ))}
      <div className="flex items-center gap-1">
        {message.status !== 'running' && (
          <ActionBar message={message} isLastAssistant={props.isLastAssistant} />
        )}
        <BranchArrows messageId={message.id} />
      </div>
    </div>
  );
}

/** Hover-revealed icon actions: Copy (✓ swap) · Edit (user) / Regenerate (last assistant). */
function ActionBar(props: { message: ThreadMessageT; isLastAssistant: boolean }) {
  const { thread } = BuilderView.get();
  const { copiedId } = thread;
  const { message } = props;
  const copied = copiedId === message.id;
  return (
    <div className="flex items-center gap-0.5 px-0.5 opacity-0 transition group-hover:opacity-100">
      <button
        type="button"
        data-testid="action-copy"
        title={copied ? 'Copied' : 'Copy'}
        onClick={() => thread.copyMessage(message)}
        className={iconButton}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      {message.role === 'user' ? (
        <button
          type="button"
          data-testid="action-edit"
          title="Edit"
          onClick={() => thread.beginEdit(message)}
          className={iconButton}
        >
          <Pencil className="size-3.5" />
        </button>
      ) : props.isLastAssistant ? (
        <button
          type="button"
          data-testid="action-regenerate"
          title="Regenerate"
          onClick={() => void thread.regenerate()}
          className={iconButton}
        >
          <RefreshCw className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/** ‹ n/m › on a tree-anchor message — ChatGPT-style sibling navigation. */
function BranchArrows(props: { messageId: string }) {
  const { thread } = BuilderView.get();
  const { anchors } = thread;
  const anchor = anchors.find((a) => a.messageId === props.messageId);
  if (anchor === undefined || anchor.count < 2) return null;
  return (
    <span className="flex items-center text-[11px] text-ink-dim">
      <button
        type="button"
        data-testid="branch-prev"
        title="Previous branch"
        disabled={anchor.index <= 1}
        onClick={() => void thread.switchSibling(anchor, -1)}
        className={`${iconButton} disabled:opacity-30`}
      >
        <ChevronLeft className="size-3.5" />
      </button>
      {anchor.index}/{anchor.count}
      <button
        type="button"
        data-testid="branch-next"
        title="Next branch"
        disabled={anchor.index >= anchor.count}
        onClick={() => void thread.switchSibling(anchor, 1)}
        className={`${iconButton} disabled:opacity-30`}
      >
        <ChevronRight className="size-3.5" />
      </button>
    </span>
  );
}

/** Soft inline editor for a user message (submit → sibling branch in the tree). */
function EditBox() {
  const { thread } = BuilderView.get();
  const { editDraft } = thread;
  return (
    <div
      data-testid="edit-box"
      className="flex w-full flex-col gap-1 rounded-2xl bg-secondary-background p-3"
    >
      <textarea
        value={editDraft}
        rows={2}
        onChange={(e: { currentTarget: HTMLTextAreaElement }) => {
          thread.editDraft = e.currentTarget.value;
        }}
        className="w-full resize-none bg-transparent text-sm outline-none"
      />
      <div className="flex gap-1.5 self-end">
        <button
          type="button"
          onClick={() => thread.cancelEdit()}
          className="rounded-full border-2 border-border bg-background px-3 py-1 text-xs shadow-shadow"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="edit-submit"
          onClick={() => void thread.submitEdit()}
          className="rounded-full border-2 border-border bg-main px-3 py-1 text-main-foreground text-xs shadow-shadow"
        >
          Send
        </button>
      </div>
    </div>
  );
}

function PartView(props: {
  part: ThreadPartT;
  role: 'user' | 'assistant';
  running: boolean;
  error: boolean;
}) {
  const { part, role, running, error } = props;
  // Match.exhaustive (spec §Match): a new ThreadPart variant fails tsc here.
  return Match.value(part).pipe(
    Match.tag('Text', (p) => {
      // A running assistant streams cumulative partial text; show it live,
      // with a writing indicator until the first delta lands.
      if (running && role === 'assistant' && p.text.trim().length === 0) {
        return <span className="animate-pulse text-ink-dim text-xs">writing response…</span>;
      }
      if (role === 'user') {
        return (
          <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-main/70 px-3 py-2 text-main-foreground text-sm">
            {p.text}
          </div>
        );
      }
      if (error) {
        return (
          <div className="max-w-[85%] whitespace-pre-wrap rounded-base border border-danger/50 bg-danger/10 px-3 py-2 text-danger text-sm">
            {p.text}
          </div>
        );
      }
      // Assistant prose is markdown, bubble-less (ChatGPT-style).
      return (
        <div className="chat-md max-w-full text-ink text-sm">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{p.text}</ReactMarkdown>
        </div>
      );
    }),
    Match.tag('Reasoning', (p) => (
      <p className="max-w-[85%] px-1 text-[11px] text-ink-dim italic">{p.text}</p>
    )),
    Match.tag('ToolCall', (p) => <ToolUI part={p} />),
    Match.tag('Image', (p) =>
      role === 'user' ? (
        // a user attachment thumb (rides above the bubble)
        <img
          src={p.url}
          alt="attachment"
          className="size-16 rounded-base border border-edge object-cover"
        />
      ) : (
        <img src={p.url} alt="generated" className="max-w-[85%] rounded-base" />
      ),
    ),
    Match.tag('File', (p) => (
      <span className="rounded-base border border-edge bg-secondary-background px-2 py-1 font-mono text-[11px] text-ink-dim">
        {p.name}
      </span>
    )),
    Match.tag('Step', () => null), // not rendered in v1
    Match.exhaustive,
  );
}

/** Tool-UI registry: tool name → chip. Unknown tools fall back to a generic chip. */
function ToolUI(props: { part: Extract<ThreadPartT, { _tag: 'ToolCall' }> }) {
  const { part } = props;
  if (part.name === CARD_PATCH_TOOL) return <PatchChip part={part} />;
  if (part.name === CARD_GENERATE_ART_TOOL) return <ArtStrip part={part} />;
  if (
    part.name === CARD_SAVE_TOOL ||
    part.name === CARD_SAVE_COPY_TOOL ||
    part.name === CARD_EXPORT_TOOL ||
    part.name === CARD_SET_LAYOUT_TOOL ||
    part.name === CARD_SET_THEME_TOOL ||
    part.name === CARD_SET_HOLO_TOOL
  ) {
    return <DocActionChip part={part} />;
  }
  return (
    <span className="rounded-base border border-edge bg-secondary-background px-2 py-1 font-mono text-[11px] text-ink-dim">
      {part.name} · {part.status}
    </span>
  );
}

/** Save / export / settings receipt chip — the agent ran a document action. */
function DocActionChip(props: { part: Extract<ThreadPartT, { _tag: 'ToolCall' }> }) {
  const { part } = props;
  let label = part.title ?? part.name;
  let verb =
    part.name === CARD_SAVE_TOOL || part.name === CARD_SAVE_COPY_TOOL ? 'saved' : 'exported';
  if (part.argsText !== undefined) {
    try {
      const args: unknown = JSON.parse(part.argsText);
      const a = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
      if (part.name === CARD_EXPORT_TOOL && typeof a.target === 'string') {
        label = `export ${a.target}`;
      }
      if (part.name === CARD_SET_LAYOUT_TOOL) {
        verb = 'set';
        label = `layout: ${String(a.layoutId ?? '')}`;
      } else if (part.name === CARD_SET_THEME_TOOL) {
        verb = 'set';
        label = `theme: ${String(a.themeId ?? '')}`;
      } else if (part.name === CARD_SET_HOLO_TOOL) {
        verb = 'set';
        label = `holo: ${a.value === true ? 'on' : 'off'}`;
      }
    } catch {
      // keep the title
    }
  }
  return (
    <span
      data-testid="tool-doc-action"
      className="inline-flex items-center gap-1 rounded-base border border-accent/40 bg-accent/10 px-2 py-1 text-[11px] text-ink"
    >
      {part.status === 'running' && (
        <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
      )}
      <span className="font-base uppercase tracking-wide text-accent">{verb}</span>
      <span className="font-mono">{label}</span>
    </span>
  );
}

const patchKeys = (argsText?: string): string[] => {
  if (argsText === undefined) return [];
  try {
    const obj: unknown = JSON.parse(argsText);
    return typeof obj === 'object' && obj !== null ? Object.keys(obj) : [];
  } catch {
    return [];
  }
};

function PatchChip(props: { part: Extract<ThreadPartT, { _tag: 'ToolCall' }> }) {
  const keys = patchKeys(props.part.argsText);
  return (
    <span
      data-testid="tool-card-patch"
      className="inline-flex items-center gap-1 rounded-base border border-accent/40 bg-accent/10 px-2 py-1 text-[11px] text-ink"
    >
      {props.part.status === 'running' && (
        <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
      )}
      <span className="font-base uppercase tracking-wide text-accent">edited</span>
      <span className="font-mono">{keys.length > 0 ? keys.join(', ') : 'card'}</span>
    </span>
  );
}

function ArtStrip(props: { part: Extract<ThreadPartT, { _tag: 'ToolCall' }> }) {
  const { status, result } = props.part;
  const label =
    status === 'completed'
      ? 'art generated'
      : status === 'error'
        ? `art failed${result !== undefined ? ` — ${result}` : ''}`
        : 'generating art…';
  return (
    <span
      data-testid="tool-card-art"
      className={`inline-flex items-center gap-2 rounded-base border px-2 py-1 text-[11px] ${
        status === 'error'
          ? 'border-danger/50 bg-danger/10 text-danger'
          : 'border-edge bg-secondary-background text-ink-dim'
      }`}
    >
      {status !== 'completed' && status !== 'error' && (
        <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
      )}
      {label}
    </span>
  );
}
