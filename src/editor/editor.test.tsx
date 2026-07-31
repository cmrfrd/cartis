import { describe, expect, it, vi } from 'vitest';
import { mount, tick } from '../../test/util';
import { compileCardSource } from './compile';
import { EditorView } from './EditorView';
import { Sandbox } from './Sandbox';

describe('EditorView (headless)', () => {
  it('compiles the starter source on activation', async () => {
    const editor = EditorView.new();
    await vi.waitFor(() => {
      expect(editor.card).toBeDefined();
    });
    expect(editor.compileError).toBe('');
    editor.set(null);
  });

  it('recompiles on source change and surfaces errors', async () => {
    const editor = EditorView.new({ debounceMs: 0 });
    await vi.waitFor(() => {
      expect(editor.card).toBeDefined();
    });
    editor.source = 'export default function Broken() { return <p> }';
    await vi.waitFor(() => {
      expect(editor.compileError.length).toBeGreaterThan(0);
    });
    editor.source = 'export default function Fixed() { return <p>fixed</p> }';
    await vi.waitFor(() => {
      expect(editor.compileError).toBe('');
    });
    editor.set(null);
  });
});

describe('Sandbox', () => {
  it('renders the compiled card', async () => {
    const result = compileCardSource('export default function C() { return <p>sandboxed</p> }');
    if (!result.ok) throw new Error(result.error);
    const { container, unmount } = mount(<Sandbox card={result.Card} />);
    await tick();
    expect(container.textContent).toContain('sandboxed');
    unmount();
  });

  it('catches render-time crashes and shows the error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = compileCardSource(
      'export default function Boom() { throw new Error("kaboom"); return null }',
    );
    if (!result.ok) throw new Error(result.error);
    const { container, unmount } = mount(<Sandbox card={result.Card} />);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('kaboom');
    });
    unmount();
    spy.mockRestore();
  });
});
