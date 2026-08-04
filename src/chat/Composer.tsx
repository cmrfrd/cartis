/**
 * The pill composer (maturity spec §2; reference: docs/reference/xulux-chatgpt/
 * chatgpt.tsx L88–190, our tokens): attachment thumbs → [+ | auto-grow input |
 * morphing ↑ Send / ■ Stop]. All three attach entry points (+ picker, paste,
 * panel drop) funnel into ThreadState.addAttachments — this file wires two.
 */

import { ArrowUp, FileText, Plus, Square, X } from 'lucide-react';
import { BuilderView } from '@/builder/BuilderView';
import { ATTACHMENT_ACCEPT } from './attachments';

export function Composer() {
  const { thread } = BuilderView.get();
  const { draft, running, pendingAttachments } = thread;
  const canSend = !running && (draft.trim().length > 0 || pendingAttachments.length > 0);
  return (
    <div className="flex w-full flex-col rounded-2xl border-2 border-border bg-background p-2 shadow-shadow">
      {pendingAttachments.length > 0 && (
        <div className="flex flex-row flex-wrap gap-2 px-1 pt-1 pb-2">
          {pendingAttachments.map((a, i) => (
            <div
              key={`${a.name}-${String(i)}`}
              data-testid="composer-attachment"
              className="relative"
            >
              {a.mime.startsWith('image/') ? (
                <img
                  src={a.dataUrl}
                  alt={a.name}
                  className="size-16 rounded-base border border-edge object-cover"
                />
              ) : (
                <span className="flex h-16 items-center gap-1.5 rounded-base border border-edge bg-secondary-background px-2 text-[11px]">
                  <FileText className="size-4 shrink-0 text-ink-dim" />
                  <span className="max-w-24 truncate">{a.name}</span>
                </span>
              )}
              <button
                type="button"
                data-testid="attachment-remove"
                title="Remove attachment"
                onClick={() => thread.removeAttachment(i)}
                className="-top-1.5 -right-1.5 absolute flex size-5 items-center justify-center rounded-full border border-edge bg-background text-ink-dim hover:text-ink"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end gap-1">
        <label
          data-testid="composer-attach"
          title="Add photos & files"
          className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink-dim transition-colors hover:bg-secondary-background hover:text-ink"
        >
          <Plus className="size-5" />
          <input
            type="file"
            multiple
            accept={ATTACHMENT_ACCEPT}
            className="hidden"
            onChange={(e: { currentTarget: HTMLInputElement }) => {
              const files = e.currentTarget.files;
              if (files !== null && files.length > 0) void thread.addAttachments(Array.from(files));
              e.currentTarget.value = ''; // re-picking the same file must re-fire
            }}
          />
        </label>
        <textarea
          value={draft}
          disabled={running}
          rows={1}
          placeholder="Message the assistant…"
          style={{ fieldSizing: 'content' }}
          onChange={(e: { currentTarget: HTMLTextAreaElement }) => {
            thread.draft = e.currentTarget.value;
          }}
          onKeyDown={(e: { key: string; shiftKey: boolean; preventDefault(): void }) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              thread.submitDraft();
            }
          }}
          onPaste={(e: { clipboardData: { files: ArrayLike<File> }; preventDefault(): void }) => {
            if (e.clipboardData.files.length > 0) {
              e.preventDefault();
              void thread.addAttachments(Array.from(e.clipboardData.files));
            }
          }}
          className="max-h-40 min-h-8 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm outline-none disabled:opacity-60"
        />
        {running ? (
          <button
            type="button"
            data-testid="composer-cancel"
            title="Stop"
            onClick={() => void thread.cancel()}
            className="flex size-9 shrink-0 items-center justify-center rounded-full border-2 border-border bg-background shadow-shadow"
          >
            <Square className="size-3.5 fill-current" />
          </button>
        ) : (
          <button
            type="button"
            data-testid="composer-send"
            title="Send"
            disabled={!canSend}
            onClick={() => thread.submitDraft()}
            className="flex size-9 shrink-0 items-center justify-center rounded-full border-2 border-border bg-main text-main-foreground shadow-shadow disabled:opacity-30"
          >
            <ArrowUp className="size-5" />
          </button>
        )}
      </div>
    </div>
  );
}

/** Dismissible danger strip above the composer — the ONLY renderer of `note`. */
export function NoteStrip() {
  const { thread } = BuilderView.get();
  const { note } = thread;
  if (note === undefined) return null;
  return (
    <div
      data-testid="note-strip"
      className="mb-2 flex items-center gap-2 rounded-base border border-danger/50 bg-danger/10 px-3 py-1.5 text-danger text-xs"
    >
      <span className="min-w-0 flex-1">{note}</span>
      <button
        type="button"
        title="Dismiss"
        onClick={() => {
          thread.note = undefined;
        }}
        className="shrink-0 hover:opacity-70"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
