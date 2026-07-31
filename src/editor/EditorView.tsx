import { Component, ref } from '@expressive/react';
import { ExportBar } from '../export/ExportBar';
import { Button, PreviewStage, TextAreaInput } from '../ui';
import { CodePane } from './CodePane';
import type { CompiledCard } from './compile';
import { compileCardSource } from './compile';
import { Sandbox } from './Sandbox';
import { STARTER_CARD_SOURCE } from './starter';

export class EditorView extends Component {
  source = STARTER_CARD_SOURCE;
  card?: CompiledCard = undefined;
  compileError = '';
  debounceMs = 250;
  previewEl = ref<HTMLDivElement>();
  prompt = '';
  agentBusy = false;
  agentNote = '';
  #timer: ReturnType<typeof setTimeout> | undefined;

  protected new() {
    this.compileNow();
    const stopWatching = this.set('source', () => {
      this.queueCompile();
    });
    return () => {
      clearTimeout(this.#timer);
      stopWatching();
    };
  }

  queueCompile() {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.compileNow(), this.debounceMs);
  }

  compileNow() {
    const result = compileCardSource(this.source);
    if (result.ok) {
      this.card = result.Card;
      this.compileError = '';
    } else {
      this.compileError = result.error;
    }
  }

  async runAgent(fetchImpl: typeof fetch = fetch) {
    if (this.agentBusy || this.prompt.trim().length === 0) return;
    this.agentBusy = true;
    this.agentNote = 'Asking the agent…';
    try {
      const res = await fetchImpl('/api/agent/card', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: this.prompt, code: this.source }),
      });
      const body = (await res.json()) as { code?: string; error?: string };
      if (!res.ok || !body.code) {
        throw new Error(body.error ?? `agent request failed (${String(res.status)})`);
      }
      this.source = body.code; // CodePane picks this up; the source watcher recompiles
      this.agentNote = 'Applied — the code is yours to edit.';
    } catch (cause) {
      this.agentNote = cause instanceof Error ? cause.message : String(cause);
    } finally {
      this.agentBusy = false;
    }
  }

  render() {
    const { source, card, compileError, previewEl } = this;
    return (
      <div className="flex h-full">
        <section className="flex min-w-0 flex-1 flex-col border-r border-edge">
          <CodePane
            source={source}
            onSource={(next) => {
              this.source = next;
            }}
          />
          <EditorAgentPanel />
          {compileError && (
            <p className="border-t border-red-900 bg-red-950/60 px-3 py-2 font-mono text-xs text-red-200">
              {compileError}
            </p>
          )}
        </section>
        <section className="flex w-[440px] shrink-0 flex-col items-center gap-4 overflow-y-auto p-5">
          <PreviewStage>
            <div ref={previewEl}>
              <Sandbox card={card} />
            </div>
          </PreviewStage>
          <ExportBar cardName="code-lab-card" target={() => previewEl.current ?? null} />
        </section>
      </div>
    );
  }
}

/** Implementation scoping per the skills: freestanding function component + .get(). */
function EditorAgentPanel() {
  const { is: editor, prompt, agentBusy, agentNote } = EditorView.get();
  return (
    <div className="flex flex-col gap-2 border-t border-edge p-3">
      <TextAreaInput
        value={prompt}
        onValue={(v) => {
          editor.prompt = v;
        }}
        rows={2}
        placeholder="Describe the card: “a mythic umbral librarian who trades memories…”"
      />
      <div className="flex items-center gap-3">
        <Button disabled={agentBusy} onClick={() => void editor.runAgent()}>
          {agentBusy ? 'Generating…' : 'Generate with AI'}
        </Button>
        {agentNote && <span className="text-xs text-ink-dim">{agentNote}</span>}
      </div>
    </div>
  );
}
