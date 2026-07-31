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

describe('EditorView agent', () => {
  it('applies agent-returned code to the buffer and recompiles', async () => {
    const editor = EditorView.new({ debounceMs: 0 });
    editor.prompt = 'a spooky umbral card';
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ code: 'export default function Spooky() { return <p>boo</p> }' }),
        ),
    ) as unknown as typeof fetch;
    await editor.runAgent(fetchImpl);
    expect(editor.source).toContain('Spooky');
    // One-way flow contract: agent rewrites reach CodeMirror ONLY via the
    // `external` signal — a live source prop once stomped fast typing.
    expect(editor.external?.text).toContain('Spooky');
    await vi.waitFor(() => {
      expect(editor.compileError).toBe('');
      expect(editor.card).toBeDefined();
    });
    expect(editor.agentNote).toContain('Applied');
    editor.set(null);
  });

  it('surfaces agent errors without touching the buffer', async () => {
    const editor = EditorView.new({ debounceMs: 0 });
    editor.prompt = 'anything';
    const before = editor.source;
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'opencode is not running' }), { status: 500 }),
    ) as unknown as typeof fetch;
    await editor.runAgent(fetchImpl);
    expect(editor.source).toBe(before);
    expect(editor.agentNote).toContain('opencode is not running');
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
