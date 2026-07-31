// Sanctioned react-dom use: tests must mount into a real root (see Global Constraints).
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

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

export async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error('click: element not found');
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
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
