/**
 * The browser-side Effect runtime and the test seam.
 *
 * `appLive` merges the app's live services (StoreClient, ImageProvider,
 * ActivityClient) over the live HTTP client. A single ManagedRuntime
 * backs `runApp`/`runAppExit`/`forkApp`; `setAppLayer` swaps in a different
 * layer (the tests install in-memory/stub services via `test/setup.ts`).
 *
 * `AppServices` is the seam through which the service union grows. Because
 * every caller reaches services through this runtime, widening the union here
 * does not reshape call sites.
 */

import type { Effect } from 'effect';
import { Layer, ManagedRuntime } from 'effect';
import { type AgentFill, agentFillEmpty, agentFillLive } from '../builder/AgentFill';
import {
  type ImageProvider,
  imageProviderLive,
  imageProviderStubLayer,
} from '../images/ImageProvider';
import { AppHttpLive } from '../lib/http';
import { type StoreClient, storeClientLive, storeClientMemory } from '../storage/StoreClient';
import { type ActivityClient, activityClientEmpty, activityClientLive } from './ActivityClient';

/** The service surface the app's effects may require. */
export type AppServices = StoreClient | ImageProvider | AgentFill | ActivityClient;

/** Live app layer: real services over the live (fetch) HTTP client. */
export const appLive: Layer.Layer<AppServices> = Layer.mergeAll(
  storeClientLive,
  imageProviderLive,
  agentFillLive,
  activityClientLive,
).pipe(Layer.provide(AppHttpLive));

/** Per-service test-layer overrides; each defaults to the standard test fake. */
export interface TestAppOverrides {
  readonly store?: Layer.Layer<StoreClient>;
  readonly image?: Layer.Layer<ImageProvider>;
  readonly fill?: Layer.Layer<AgentFill>;
  readonly activity?: Layer.Layer<ActivityClient>;
}

/**
 * Build a full test app layer from per-service overrides (each independent, so
 * no duplicate-tag merges). Store tests script the bridge via `store`; view
 * tests install recording fakes via `image`/`activity`.
 */
export function testAppLayerWith(overrides: TestAppOverrides = {}): Layer.Layer<AppServices> {
  return Layer.mergeAll(
    overrides.store ?? storeClientMemory,
    overrides.image ?? imageProviderStubLayer(),
    overrides.fill ?? agentFillEmpty,
    overrides.activity ?? activityClientEmpty,
  );
}

/** In-memory app layer for tests / headless use (no bridge, no fetch). */
export const testAppLayer: Layer.Layer<AppServices> = testAppLayerWith();

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
