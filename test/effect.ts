import { Effect, type Scope, TestContext } from 'effect';
import { onTestFinished, type TestFunction, test } from 'vitest';

/**
 * Minimal @effect/vitest-compatible adapter over vitest 4 + effect core.
 *
 * Why this exists: @effect/vitest 0.30.0 peer-depends on vitest ^3 (the vitest-4
 * fix PR is unmerged), and vitest 3 is itself blocked here by vite 8 +
 * @vitejs/plugin-react 6. So we can't take the package. This file reproduces the
 * slice of its `it` surface the suite uses, written so that tests read as real
 * `@effect/vitest` tests. When the upstream peer range widens, this whole file
 * collapses to `export * from '@effect/vitest'` with no test changes.
 *
 * `self` takes no arguments (the vitest ctx is intentionally unused), matching
 * @effect/vitest's `it.effect(name, () => Effect<...>)` shape.
 */

/** An effect a test body returns. `A` is asserted-on; failures reject the run. */
type EffectSelf<R> = () => Effect.Effect<unknown, unknown, R>;

/** vitest's runner registrar (`test`, `test.skip`, `test.only`). */
type Runner = (name: string, fn: () => Promise<void>, timeout?: number) => void;

/**
 * Run an effect that needs nothing beyond the TestContext (deterministic clock,
 * TestClock, etc.), wrapping it in a Scope so `forkScoped`/scoped resources work.
 */
function runTest(self: EffectSelf<Scope.Scope>): () => Promise<void> {
  return () =>
    Effect.runPromise(
      Effect.scoped(self()).pipe(Effect.provide(TestContext.TestContext), Effect.asVoid),
    );
}

/** Run an effect with the live environment — real clock, no TestContext. */
function runLive(self: EffectSelf<Scope.Scope>): () => Promise<void> {
  return () => Effect.runPromise(Effect.scoped(self()).pipe(Effect.asVoid));
}

/** Build an `it.effect`-style method plus its `.skip`/`.only` variants. */
function makeVariant(build: (self: EffectSelf<Scope.Scope>) => () => Promise<void>) {
  const register =
    (runner: Runner) =>
    (name: string, self: EffectSelf<Scope.Scope>, timeout?: number): void => {
      runner(name, build(self), timeout);
    };
  const method = register(test);
  return Object.assign(method, {
    skip: register(test.skip),
    only: register(test.only),
  });
}

/** vitest's plain-test body (used for the non-effect `it(...)` passthrough). */
type PlainFn = TestFunction;

interface EffectIt {
  /** Runs `self()` under TestContext (TestClock) in a Scope via `Effect.runPromise`. */
  effect: ReturnType<typeof makeVariant>;
  /** Same as `effect`, but the effect requires `Scope.Scope` explicitly. */
  scoped: ReturnType<typeof makeVariant>;
  /** Runs `self()` with the live environment (no TestContext). */
  live: ReturnType<typeof makeVariant>;
  /** Passthrough to vitest's `test` for plain (non-effect) cases. */
  (name: string, fn: PlainFn, timeout?: number): void;
}

// `onTestFinished` is imported (vitest 4 top-level) so cleanup hooks are wired
// through the supported API rather than the removed `ctx.onTestFinished`.
export const onFinished = onTestFinished;

const base: EffectIt = Object.assign(
  (name: string, fn: PlainFn, timeout?: number): void => {
    test(name, fn, timeout);
  },
  {
    effect: makeVariant(runTest),
    scoped: makeVariant(runTest),
    live: makeVariant(runLive),
  },
);

export const it: EffectIt = base;
