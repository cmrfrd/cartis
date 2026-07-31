import { describe, expect, it } from 'vitest';
import { mount, tick } from '../../test/util';
import { compileCardSource } from './compile';
import { STARTER_CARD_SOURCE } from './starter';

describe('compileCardSource', () => {
  it('compiles plain TSX with typescript annotations and a default export', async () => {
    const result = compileCardSource(`
      const title: string = 'Hand Rolled'
      export default function Card() {
        return <p>{title}</p>
      }
    `);
    if (!result.ok) throw new Error(result.error);
    const { container, unmount } = mount(<result.Card />);
    await tick();
    expect(container.textContent).toContain('Hand Rolled');
    unmount();
  });

  it('resolves imports from cartis/cards and @expressive/react', () => {
    const result = compileCardSource(`
      import { ArcaneCard, arcaneTemplate } from 'cartis/cards'
      export default function Card() {
        return <ArcaneCard data={arcaneTemplate.defaults} />
      }
    `);
    expect(result.ok).toBe(true);
  });

  it('compiles the starter source', () => {
    expect(compileCardSource(STARTER_CARD_SOURCE).ok).toBe(true);
  });

  it('reports syntax errors as messages, not throws', () => {
    const result = compileCardSource('export default function Card() { return <p> }');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });

  it('rejects imports outside the allowed module map', () => {
    // The import must be referenced — sucrase elides unused imports like tsc does.
    const result = compileCardSource(`
      import fs from 'node:fs'
      export default function Card() { return <p>{String(fs)}</p> }
    `);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('node:fs');
  });

  it('rejects modules without a component default export', () => {
    const result = compileCardSource('export const nope = 1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('default export');
  });
});
