// tsxLanguage alone (not javascript({jsx:true})): the latter force-bundles
// autoCloseTags, which rewrites typed `>`/`/` and doubles manually-typed
// closers. Same reason we use minimalSetup — basicSetup bundles closeBrackets.
// Typing complete code must produce exactly that code.
import { tsxLanguage } from '@codemirror/lang-javascript';
import { lineNumbers } from '@codemirror/view';
import { Component, ref } from '@expressive/react';
import { EditorView as CmView, minimalSetup } from 'codemirror';

/**
 * Thin CodeMirror 6 wrapper. ONE-WAY data flow: while typing, CM is the source
 * of truth and only reports upward via onSource. External rewrites (agent
 * apply, resets) arrive through the `external` object — never through a live
 * `source` prop. A previous two-way binding re-applied the prop on every
 * render and stomped the document mid-keystroke, garbling fast typing.
 */
export class CodePane extends Component {
  /** Seed for the CodeMirror document, read once when the editor is created. */
  initial = '';
  /** Assign a fresh `{ text }` object to force-replace the document (agent rewrites). */
  external?: { text: string } = undefined;
  onSource?: (source: string) => void = undefined;
  host = ref<HTMLDivElement>();

  mount() {
    const host = this.host.current;
    if (!host) return;
    const cm = new CmView({
      parent: host,
      doc: this.initial,
      extensions: [
        minimalSetup,
        lineNumbers(),
        tsxLanguage.extension,
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
    const stopWatching = this.set('external', () => {
      const next = this.external?.text;
      const current = cm.state.doc.toString();
      if (typeof next === 'string' && next !== current) {
        cm.dispatch({ changes: { from: 0, to: current.length, insert: next } });
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
