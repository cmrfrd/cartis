/**
 * The browser-side Effect runtime and the test seam.
 *
 * `appLive` merges the app's live services (currently just StoreClient) over
 * the live HTTP client. A single ManagedRuntime backs `runApp`/`runAppExit`/
 * `forkApp`; `setAppLayer` swaps in a different layer (the tests install the
 * in-memory StoreClient via `test/setup.ts`).
 *
 * `AppServices` is the seam Phases 4-5 widen (ImageProvider | AgentApi |
 * ActivityClient). Because every caller reaches services through this runtime,
 * widening the union here does not reshape call sites.
 */

import { type Effect, Layer, ManagedRuntime } from 'effect';
import { AppHttpLive } from '../lib/http';
import { type StoreClient, storeClientLive, storeClientMemory } from '../storage/StoreClient';

/** The service surface the app's effects may require. Grows in Phase 4. */
export type AppServices = StoreClient;

/** Live app layer: real services over the live (fetch) HTTP client. */
export const appLive: Layer.Layer<AppServices> = Layer.mergeAll(storeClientLive).pipe(
  Layer.provide(AppHttpLive),
);

/** In-memory app layer for tests / headless use (no bridge, no fetch). */
export const testAppLayer: Layer.Layer<AppServices> = Layer.mergeAll(storeClientMemory);

let current: ManagedRuntime.ManagedRuntime<AppServices, never> = ManagedRuntime.make(appLive);

/** Run an app effect to a Promise (rejects on failure/defect). */
export const runApp = <A, E>(effect: Effect.Effect<A, E, AppServices>): Promise<A> =>
  current.runPromise(effect);

/** Run an app effect to an Exit (never rejects; inspect success/failure). */
export const runAppExit = <A, E>(effect: Effect.Effect<A, E, AppServices>) =>
  current.runPromiseExit(effect);

/** Fork an app effect onto the runtime (fire-and-forget). */
export const forkApp = <A, E>(effect: Effect.Effect<A, E, AppServices>) => current.runFork(effect);

/**
 * Swap the runtime's layer. Disposes the previous ManagedRuntime and builds a
 * fresh one — the single seam through which tests install fakes.
 */
export function setAppLayer(layer: Layer.Layer<AppServices>): void {
  void current.dispose();
  current = ManagedRuntime.make(layer);
}
