import { Component, ref } from '@expressive/react';
import { ExportBar } from '../export/ExportBar';
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
          {compileError && (
            <p className="border-t border-red-900 bg-red-950/60 px-3 py-2 font-mono text-xs text-red-200">
              {compileError}
            </p>
          )}
        </section>
        <section className="flex w-[440px] shrink-0 flex-col items-center gap-4 overflow-y-auto p-5">
          <div ref={previewEl}>
            <Sandbox card={card} />
          </div>
          <ExportBar cardName="code-lab-card" target={() => previewEl.current ?? null} />
        </section>
      </div>
    );
  }
}
