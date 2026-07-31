// Sanctioned react-dom use: tests must mount into a real root (see Global Constraints).
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell } from '../src/app/AppShell';

export function mount(node: ReactNode): { container: HTMLElement; unmount(): void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(node);
  return {
    container,
    unmount() {
      root.unmount();
      container.remove();
    },
  };
}

/** Flush React commits + expressive update flushes (two macrotask turns). */
export async function tick(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Full press sequence like a real browser — Radix components activate on mousedown/focus. */
export async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error('click: element not found');
  const init: MouseEventInit = { bubbles: true, cancelable: true, button: 0 };
  el.dispatchEvent(new MouseEvent('mousedown', init));
  if (el instanceof HTMLElement) el.focus();
  el.dispatchEvent(new MouseEvent('mouseup', init));
  el.dispatchEvent(new MouseEvent('click', init));
  await tick();
}

function setNativeValue(el: Element | null, value: string): HTMLElement {
  if (!(el instanceof HTMLElement)) throw new Error('setInput: element not found');
  const proto = Object.getPrototypeOf(el) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  desc?.set?.call(el, value);
  return el;
}

/** Set an <input>/<textarea> value the way React sees it (native setter + input event). */
export async function setInput(el: Element | null, value: string): Promise<void> {
  setNativeValue(el, value).dispatchEvent(new Event('input', { bubbles: true }));
  await tick();
}

export async function setSelect(el: Element | null, value: string): Promise<void> {
  setNativeValue(el, value).dispatchEvent(new Event('change', { bubbles: true }));
  await tick();
}

/** Mount the whole app and capture the AppShell instance via the `is` special prop. */
export async function mountApp(): Promise<{
  container: HTMLElement;
  shell: AppShell;
  unmount(): void;
}> {
  let shell: AppShell | undefined;
  const mounted = mount(
    <AppShell
      is={(instance: AppShell) => {
        shell = instance;
      }}
    />,
  );
  await tick();
  if (!shell) throw new Error('mountApp: AppShell instance was not captured');
  return { ...mounted, shell };
}
