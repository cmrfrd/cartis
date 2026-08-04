/**
 * ThreadPanel — the ChatGPT-style chat sidebar shell (maturity spec §2),
 * hand-rolled on our tokens. Anatomy: resizable aside → header → empty state
 * OR (stick-to-bottom viewport → permission strip → sticky footer with
 * scroll-to-bottom chevron + note strip + pill composer), plus a drag-drop
 * overlay. Messages render via MessageView; ‹ n/m › arrows live there too.
 */

import { ChevronDown } from 'lucide-react';
import { BuilderView } from '@/builder/BuilderView';
import type { ThreadMessageT } from '@/contracts/thread';
import { Composer, NoteStrip } from './Composer';
import { MessageView } from './MessageView';

/** The one live viewport element (single panel instance; reassigned per mount). */
let viewportEl: HTMLDivElement | null = null;

const MIN_WIDTH = 340;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 400;

export function ThreadPanel() {
  const view = BuilderView.get();
  const { thread, chatWidth } = view;
  const { messages, running, pendingPermission, dropActive } = thread;
  const empty = messages.length === 0;
  return (
    <aside
      data-testid="chat-panel"
      style={{ width: chatWidth }}
      className="relative flex shrink-0 flex-col border-edge border-l bg-surface"
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
      <ResizeHandle />
      <header className="flex items-center gap-2 border-edge border-b px-4 py-3">
        <span className="text-accent text-sm tracking-widest">CHAT</span>
        <span className="text-[11px] text-ink-dim">edit this card by conversation</span>
      </header>
      {empty ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 p-4">
          <h2 className="text-center text-ink text-lg">What should this card become?</h2>
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

/**
 * Left-edge drag handle: pointer drag clamps to [340, 600]; double-click
 * resets to 400. Width is session state on BuilderView (not persisted).
 */
function ResizeHandle() {
  const view = BuilderView.get();
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drag handle is inherently pointer-only chrome
    <div
      data-testid="chat-resize"
      title="Drag to resize · double-click to reset"
      style={{ cursor: 'col-resize' }}
      className="absolute top-0 left-0 z-20 h-full w-1 hover:bg-accent/60"
      onPointerDown={(e: { clientX: number; pointerId: number; currentTarget: HTMLDivElement }) => {
        const startX = e.clientX;
        const startWidth = view.chatWidth;
        const el = e.currentTarget;
        el.setPointerCapture?.(e.pointerId);
        const move = (ev: PointerEvent) => {
          const next = startWidth + (startX - ev.clientX);
          view.chatWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next));
        };
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
      }}
      onDoubleClick={() => {
        view.chatWidth = DEFAULT_WIDTH;
      }}
    />
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
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
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
        <MessageView
          key={message.id}
          message={message}
          isLastAssistant={message.id === lastAssistant?.id}
        />
      ))}
    </div>
  );
}
