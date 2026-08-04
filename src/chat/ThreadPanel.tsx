/**
 * ThreadPanel — the ChatGPT-style chat sidebar (spec §Decision 5), hand-rolled
 * on our tokens. Renders the ThreadState the BuilderView adopts: a viewport of
 * messages (parts in order via a tool-UI registry) and a composer whose Send
 * button swaps to Cancel while a turn runs.
 *
 * assistant-ui's anatomy, our reactive store: Thread → Viewport →
 * ThreadMessageView → PartView (+ ToolUI registry) → Composer.
 */

import { Match } from 'effect';
import { ChevronDown } from 'lucide-react';
import { BuilderView } from '@/builder/BuilderView';
import { CARD_GENERATE_ART_TOOL, CARD_PATCH_TOOL } from '@/contracts/materialize';
import type { ThreadMessageT, ThreadPartT, ThreadSummaryT } from '@/contracts/thread';
import { Composer, NoteStrip } from './Composer';

/** The one live viewport element (single panel instance; reassigned per mount). */
let viewportEl: HTMLDivElement | null = null;

export function ThreadPanel() {
  const { thread } = BuilderView.get();
  const { messages, running, branches, pendingPermission, dropActive } = thread;
  const empty = messages.length === 0;
  return (
    <aside
      data-testid="chat-panel"
      className="relative flex w-[400px] shrink-0 flex-col border-edge border-l bg-surface"
      onDragOver={(e: { preventDefault(): void }) => {
        e.preventDefault();
        thread.dropActive = true;
      }}
      onDragLeave={() => {
        thread.dropActive = false;
      }}
      onDrop={(e: { dataTransfer: { files: ArrayLike<File> } | null; preventDefault(): void }) => {
        e.preventDefault();
        thread.dropActive = false;
        const files = e.dataTransfer?.files;
        if (files !== undefined && files !== null && files.length > 0) {
          void thread.addAttachments(Array.from(files));
        }
      }}
    >
      <header className="flex items-center gap-2 border-edge border-b px-4 py-3">
        <span className="font-display text-accent text-sm tracking-widest">CHAT</span>
        <span className="text-[11px] text-ink-dim">edit this card by conversation</span>
      </header>
      {branches.length > 0 && <BranchPicker branches={branches} />}
      {empty ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 p-4">
          <h2 className="text-center font-display text-ink text-lg">
            What should this card become?
          </h2>
          <div className="w-full">
            {pendingPermission !== undefined && <PermissionStrip title={pendingPermission.title} />}
            <NoteStrip />
            <Composer />
          </div>
        </div>
      ) : (
        <>
          <Viewport messages={messages} running={running} />
          {pendingPermission !== undefined && <PermissionStrip title={pendingPermission.title} />}
          <div className="relative border-edge border-t p-3">
            <ScrollToBottom />
            <NoteStrip />
            <Composer />
          </div>
        </>
      )}
      {dropActive && (
        <div
          data-testid="drop-overlay"
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-background/80"
        >
          <span className="rounded-base border-2 border-border border-dashed bg-secondary-background px-4 py-2 text-sm">
            drop files to attach
          </span>
        </div>
      )}
    </aside>
  );
}

/** Floating chevron above the composer — hidden while the viewport is pinned. */
function ScrollToBottom() {
  const { thread } = BuilderView.get();
  const { viewportPinned } = thread;
  if (viewportPinned) return null;
  return (
    <button
      type="button"
      data-testid="scroll-bottom"
      title="Scroll to bottom"
      onClick={() => {
        if (viewportEl) viewportEl.scrollTop = viewportEl.scrollHeight;
        thread.viewportPinned = true;
      }}
      className="-top-5 absolute left-1/2 z-10 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border-2 border-border bg-background shadow-shadow"
    >
      <ChevronDown className="size-4" />
    </button>
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
  const { thread } = BuilderView.get();
  const { messages } = props;
  return (
    <div
      // stick-to-bottom: autoscroll on commit ONLY while pinned; scrolling up
      // unpins (so streaming can't yank the reader back down).
      ref={(el: HTMLDivElement | null) => {
        viewportEl = el;
        if (el && thread.viewportPinned) el.scrollTop = el.scrollHeight;
      }}
      onScroll={(e: { currentTarget: HTMLDivElement }) => {
        const el = e.currentTarget;
        thread.viewportPinned = el.scrollHeight - el.scrollTop - el.clientHeight < 16;
      }}
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
    >
      {messages.map((message) => (
        <MessageView key={message.id} message={message} />
      ))}
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
  // Match.exhaustive (spec §Match): a new ThreadPart variant fails tsc here.
  return Match.value(part).pipe(
    Match.tag('Text', (p) => {
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
          {p.text}
        </div>
      );
    }),
    Match.tag('Reasoning', (p) => (
      <p className="max-w-[85%] px-1 text-[11px] text-ink-dim italic">{p.text}</p>
    )),
    Match.tag('ToolCall', (p) => <ToolUI part={p} />),
    Match.tag('Image', (p) => (
      <img src={p.url} alt="generated" className="max-w-[85%] rounded-base" />
    )),
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
