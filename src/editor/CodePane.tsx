import { javascript } from '@codemirror/lang-javascript';
import { Component, ref } from '@expressive/react';
import { basicSetup, EditorView as CmView } from 'codemirror';

/** Thin CodeMirror 6 wrapper. Not unit-tested (CM needs real layout); exercised via dev server. */
export class CodePane extends Component {
  source = '';
  onSource?: (source: string) => void = undefined;
  host = ref<HTMLDivElement>();
  #cm: CmView | undefined;

  mount() {
    const host = this.host.current;
    if (!host) return;
    const cm = new CmView({
      parent: host,
      doc: this.source,
      extensions: [
        basicSetup,
        javascript({ jsx: true, typescript: true }),
        CmView.updateListener.of((update) => {
          if (update.docChanged) this.onSource?.(update.state.doc.toString());
        }),
        CmView.theme(
          {
            '&': { height: '100%', fontSize: '13px', backgroundColor: '#0d0f16' },
            '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
            '.cm-gutters': { backgroundColor: '#0d0f16', border: 'none' },
          },
          { dark: true },
        ),
      ],
    });
    this.#cm = cm;
    // Push external source changes (agent rewrites, resets) into the editor without echo loops.
    const stopWatching = this.set('source', () => {
      const current = cm.state.doc.toString();
      if (current !== this.source) {
        cm.dispatch({ changes: { from: 0, to: current.length, insert: this.source } });
      }
    });
    return () => {
      stopWatching();
      cm.destroy();
    };
  }

  render() {
    return (
      <div
        className="h-full min-h-0 overflow-hidden [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto"
        ref={this.host}
      />
    );
  }
}
