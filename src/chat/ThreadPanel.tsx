/**
 * ThreadPanel — the ChatGPT-style chat sidebar (spec §Decision 5), hand-rolled
 * on our tokens. Renders the ThreadState the BuilderView adopts: a viewport of
 * messages (parts in order via a tool-UI registry) and a composer whose Send
 * button swaps to Cancel while a turn runs.
 *
 * assistant-ui's anatomy, our reactive store: Thread → Viewport →
 * ThreadMessageView → PartView (+ ToolUI registry) → Composer.
 */

import { BuilderView } from '../builder/BuilderView';
import { CARD_GENERATE_ART_TOOL, CARD_PATCH_TOOL } from '../contracts/materialize';
import type { ThreadMessageT, ThreadPartT, ThreadSummaryT } from '../contracts/thread';

export function ThreadPanel() {
  const { thread } = BuilderView.get();
  const { messages, running, branches, pendingPermission } = thread;
  return (
    <aside className="flex w-[400px] shrink-0 flex-col border-edge border-l bg-surface">
      <header className="flex items-center gap-2 border-edge border-b px-4 py-3">
        <span className="font-display text-accent text-sm tracking-widest">CHAT</span>
        <span className="text-[11px] text-ink-dim">edit this card by conversation</span>
      </header>
      {branches.length > 0 && <BranchPicker branches={branches} />}
      <Viewport messages={messages} running={running} />
      {pendingPermission !== undefined && <PermissionStrip title={pendingPermission.title} />}
      <Composer />
    </aside>
  );
}

function BranchPicker(props: { branches: readonly ThreadSummaryT[] }) {
  const { thread } = BuilderView.get();
  return (
    <div
      data-testid="branch-picker"
      className="flex flex-wrap items-center gap-1.5 border-edge border-b px-4 py-2"
    >
      <span className="text-[11px] text-ink-dim uppercase tracking-wide">branches</span>
      {props.branches.map((branch) => (
        <button
          key={branch.sessionId}
          type="button"
          onClick={() => void thread.switchBranch(branch.sessionId)}
          className="rounded-base border border-edge bg-secondary-background px-2 py-0.5 text-[11px] hover:border-accent"
        >
          {branch.title ?? branch.sessionId.slice(0, 8)}
        </button>
      ))}
    </div>
  );
}

function PermissionStrip(props: { title: string }) {
  const { thread } = BuilderView.get();
  return (
    <div
      data-testid="permission-strip"
      className="flex items-center gap-2 border-edge border-t bg-accent/10 px-4 py-2"
    >
      <span className="min-w-0 flex-1 truncate text-xs">{props.title}</span>
      <button
        type="button"
        data-testid="permission-allow"
        onClick={() => void thread.replyPermission(true)}
        className="rounded-base border-2 border-border bg-main px-2 py-0.5 text-main-foreground text-xs shadow-shadow"
      >
        Allow
      </button>
      <button
        type="button"
        onClick={() => void thread.replyPermission(false)}
        className="rounded-base border-2 border-border bg-background px-2 py-0.5 text-xs shadow-shadow"
      >
        Deny
      </button>
    </div>
  );
}

function Viewport(props: { messages: readonly ThreadMessageT[]; running: boolean }) {
  const { messages } = props;
  return (
    <div
      // stick-to-bottom: inline callback ref scrolls on every commit
      ref={(el: HTMLDivElement | null) => {
        if (el) el.scrollTop = el.scrollHeight;
      }}
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
    >
      {messages.length === 0 ? (
        <p className="mt-8 text-center text-ink-dim text-xs">
          Ask the assistant to change fields, rewrite text, or generate art.
        </p>
      ) : (
        messages.map((message) => <MessageView key={message.id} message={message} />)
      )}
    </div>
  );
}

function MessageView(props: { message: ThreadMessageT }) {
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
      {message.status !== 'running' && (
        <ActionBar message={message} onEdit={() => thread.beginEdit(message)} />
      )}
    </div>
  );
}

/** Copy · Edit (user) · Regenerate (assistant), revealed on hover. */
function ActionBar(props: { message: ThreadMessageT; onEdit: () => void }) {
  const { thread } = BuilderView.get();
  const { message } = props;
  const text = message.parts.map((p) => (p._tag === 'Text' ? p.text : '')).join('');
  const copy = () => {
    void navigator.clipboard?.writeText(text);
  };
  return (
    <div className="flex gap-2 px-1 text-[11px] text-ink-dim opacity-0 transition group-hover:opacity-100">
      <button type="button" onClick={copy} className="hover:text-ink">
        Copy
      </button>
      {message.role === 'user' ? (
        <button
          type="button"
          data-testid="action-edit"
          onClick={props.onEdit}
          className="hover:text-ink"
        >
          Edit
        </button>
      ) : (
        <button
          type="button"
          data-testid="action-regenerate"
          onClick={() => void thread.regenerate()}
          className="hover:text-ink"
        >
          Regenerate
        </button>
      )}
    </div>
  );
}

/** Inline editor for a user message (fork-on-edit resends on submit). */
function EditBox() {
  const { thread } = BuilderView.get();
  const { editDraft } = thread;
  return (
    <div data-testid="edit-box" className="flex w-full flex-col items-end gap-1">
      <textarea
        value={editDraft}
        rows={2}
        onChange={(e: { currentTarget: HTMLTextAreaElement }) => {
          thread.editDraft = e.currentTarget.value;
        }}
        className="w-full resize-none rounded-base border-2 border-border bg-background p-2 text-sm outline-none"
      />
      <div className="flex gap-1.5">
        <button
          type="button"
          data-testid="edit-submit"
          onClick={() => void thread.submitEdit()}
          className="rounded-base border-2 border-border bg-main px-2 py-0.5 text-main-foreground text-xs shadow-shadow"
        >
          Save &amp; resend
        </button>
        <button
          type="button"
          onClick={() => thread.cancelEdit()}
          className="rounded-base border-2 border-border bg-background px-2 py-0.5 text-xs shadow-shadow"
        >
          Cancel
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
  switch (part._tag) {
    case 'Text': {
      // A running assistant's text is the raw JSON blob mid-stream — show a
      // writing indicator instead (materialization replaces it at turn end).
      if (running && role === 'assistant') {
        return <span className="animate-pulse text-ink-dim text-xs">writing response…</span>;
      }
      const bubble =
        role === 'user'
          ? 'bg-main/70 text-main-foreground'
          : error
            ? 'border border-danger/50 bg-danger/10 text-danger'
            : 'bg-secondary-background text-ink';
      return (
        <div className={`max-w-[85%] whitespace-pre-wrap rounded-base px-3 py-2 text-sm ${bubble}`}>
          {part.text}
        </div>
      );
    }
    case 'Reasoning':
      return <p className="max-w-[85%] px-1 text-[11px] text-ink-dim italic">{part.text}</p>;
    case 'ToolCall':
      return <ToolUI part={part} />;
    case 'Image':
      return <img src={part.url} alt="generated" className="max-w-[85%] rounded-base" />;
    default:
      return null; // Step — not rendered in v1
  }
}

/** Tool-UI registry: tool name → chip. Unknown tools fall back to a generic chip. */
function ToolUI(props: { part: Extract<ThreadPartT, { _tag: 'ToolCall' }> }) {
  const { part } = props;
  if (part.name === CARD_PATCH_TOOL) return <PatchChip part={part} />;
  if (part.name === CARD_GENERATE_ART_TOOL) return <ArtStrip part={part} />;
  return (
    <span className="rounded-base border border-edge bg-secondary-background px-2 py-1 font-mono text-[11px] text-ink-dim">
      {part.name} · {part.status}
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

function Composer() {
  const { thread } = BuilderView.get();
  const { draft, running } = thread;
  return (
    <div className="border-edge border-t p-3">
      <div className="flex items-end gap-2">
        <textarea
          value={draft}
          disabled={running}
          rows={2}
          placeholder="Message the assistant…"
          onChange={(e: { currentTarget: HTMLTextAreaElement }) => {
            thread.draft = e.currentTarget.value;
          }}
          onKeyDown={(e: { key: string; shiftKey: boolean; preventDefault(): void }) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              thread.submitDraft();
            }
          }}
          className="min-h-0 flex-1 resize-none rounded-base border-2 border-border bg-background p-2 text-sm outline-none disabled:opacity-60"
        />
        {running ? (
          <button
            type="button"
            data-testid="composer-cancel"
            onClick={() => void thread.cancel()}
            className="shrink-0 rounded-base border-2 border-border bg-background px-3 py-2 text-sm shadow-shadow"
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            data-testid="composer-send"
            onClick={() => thread.submitDraft()}
            className="shrink-0 rounded-base border-2 border-border bg-main px-3 py-2 text-main-foreground text-sm shadow-shadow"
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
