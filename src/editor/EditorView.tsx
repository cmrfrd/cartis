import { Component, ref } from '@expressive/react';
import { Effect, Either, Exit } from 'effect';
import { runAppExit } from '../app/runtime';
import { noteFromCause } from '../contracts/errors';
import { ExportBar } from '../export/ExportBar';
import { Button, PreviewStage, TextAreaInput } from '../ui';
import { AgentApi } from './AgentApi';
import { CodePane } from './CodePane';
import type { CompiledCard } from './compile';
import { compileCardSource } from './compile';
import { Sandbox } from './Sandbox';
import { STARTER_CARD_SOURCE } from './starter';

export class EditorView extends Component {
  source = STARTER_CARD_SOURCE;
  /** External rewrite signal for CodePane (agent apply/reset) — never live-synced while typing. */
  external?: { text: string } = undefined;
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
    Either.match(compileCardSource(this.source), {
      onLeft: (err) => {
        this.compileError = err.detail;
      },
      onRight: (Card) => {
        this.card = Card;
        this.compileError = '';
      },
    });
  }

  async runAgent() {
    if (this.agentBusy || this.prompt.trim().length === 0) return;
    // Snapshot reactive fields before building the effect (snapshot rule).
    const prompt = this.prompt;
    const source = this.source;
    this.agentBusy = true;
    this.agentNote = 'Asking the agent…';
    try {
      const exit = await runAppExit(
        Effect.flatMap(AgentApi, (api) => api.generateCard(prompt, source)),
      );
      if (Exit.isFailure(exit)) {
        this.agentNote = noteFromCause(exit.cause);
        return;
      }
      this.source = exit.value; // recompiles via the source watcher
      this.external = { text: exit.value }; // pushes the rewrite into CodeMirror
      this.agentNote = 'Applied — the code is yours to edit.';
    } finally {
      this.agentBusy = false;
    }
  }

  render() {
    const { card, compileError, external, previewEl } = this;
    return (
      <div className="flex h-full">
        <section className="flex min-w-0 flex-1 flex-col border-r border-edge">
          <CodePane
            initial={STARTER_CARD_SOURCE}
            external={external}
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
          <ExportBar cardName="code-lab-card" target={previewEl} />
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
