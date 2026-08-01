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

/**
 * A body for `it.effect`/`it.live`: self-contained (`R = never`), matching
 * @effect/vitest — the runner supplies only the (test) environment.
 */
type EffectSelf = () => Effect.Effect<unknown, unknown, never>;

/** A body for `it.scoped`: may require `Scope.Scope`; the runner closes it. */
type ScopedSelf = () => Effect.Effect<unknown, unknown, Scope.Scope>;

/** vitest's runner registrar (`test`, `test.skip`, `test.only`). */
type Runner = (name: string, fn: () => Promise<void>, timeout?: number) => void;

/** Run an effect under TestContext (deterministic TestClock-controlled time). */
function runTest(self: EffectSelf): () => Promise<void> {
  return () =>
    Effect.runPromise(self().pipe(Effect.provide(TestContext.TestContext), Effect.asVoid));
}

/** Same, but the body's `R` includes `Scope.Scope`, satisfied by `Effect.scoped`. */
function runScoped(self: ScopedSelf): () => Promise<void> {
  return () =>
    Effect.runPromise(
      Effect.scoped(self()).pipe(Effect.provide(TestContext.TestContext), Effect.asVoid),
    );
}

/** Run an effect with the live environment — real clock, no TestContext. */
function runLive(self: EffectSelf): () => Promise<void> {
  return () => Effect.runPromise(self().pipe(Effect.asVoid));
}

/** An `it.effect`-style method with its `.skip`/`.only` variants. */
interface TestVariant<Self> {
  (name: string, self: Self, timeout?: number): void;
  skip: (name: string, self: Self, timeout?: number) => void;
  only: (name: string, self: Self, timeout?: number) => void;
}

/** Build an `it.effect`-style method plus its `.skip`/`.only` variants. */
function makeVariant<Self>(build: (self: Self) => () => Promise<void>): TestVariant<Self> {
  const register =
    (runner: Runner) =>
    (name: string, self: Self, timeout?: number): void => {
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
  /** Runs `self()` under TestContext (TestClock). The body's `R` must be `never`. */
  effect: TestVariant<EffectSelf>;
  /** Like `effect`, but the body may require `Scope.Scope` (closed by the runner). */
  scoped: TestVariant<ScopedSelf>;
  /** Runs `self()` with the live environment (no TestContext). `R` must be `never`. */
  live: TestVariant<EffectSelf>;
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
    scoped: makeVariant(runScoped),
    live: makeVariant(runLive),
  },
);

export const it: EffectIt = base;
