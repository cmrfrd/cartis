import { Either } from 'effect';
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
    if (Either.isLeft(result)) throw new Error(result.left.detail);
    const Card = result.right;
    const { container, unmount } = mount(<Card />);
    await tick();
    expect(container.textContent).toContain('Hand Rolled');
    unmount();
  });

  it('resolves imports from cartis/cards and @expressive/react', () => {
    const result = compileCardSource(`
      import { ArcaneCard, arcaneTheme } from 'cartis/cards'
      export default function Card() {
        return <ArcaneCard data={arcaneTheme.layouts[0].defaults} />
      }
    `);
    expect(Either.isRight(result)).toBe(true);
  });

  it('compiles the starter source', () => {
    expect(Either.isRight(compileCardSource(STARTER_CARD_SOURCE))).toBe(true);
  });

  it('reports syntax errors as messages, not throws', () => {
    const result = compileCardSource('export default function Card() { return <p> }');
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.phase).toBe('transform');
      expect(result.left.detail.length).toBeGreaterThan(0);
    }
  });

  it('rejects imports outside the allowed module map', () => {
    // The import must be referenced — sucrase elides unused imports like tsc does.
    const result = compileCardSource(`
      import fs from 'node:fs'
      export default function Card() { return <p>{String(fs)}</p> }
    `);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.phase).toBe('evaluate');
      expect(result.left.detail).toContain('node:fs');
    }
  });

  it('rejects modules without a component default export', () => {
    const result = compileCardSource('export const nope = 1');
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.phase).toBe('shape');
      expect(result.left.detail).toContain('default export');
    }
  });
});
