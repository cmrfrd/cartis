/**
 * The browser-side Effect runtime and the test seam.
 *
 * `appLive` merges the app's live services (StoreClient, ImageProvider,
 * ChatThread, ChatEvents) over the live HTTP client. A single ManagedRuntime
 * backs `runApp`/`runAppExit`/`forkApp`; `setAppLayer` swaps in a different
 * layer (the tests install in-memory/stub services via `test/setup.ts`).
 *
 * `AppServices` is the seam through which the service union grows. Because
 * every caller reaches services through this runtime, widening the union here
 * does not reshape call sites.
 */

import type { Effect } from 'effect';
import { Layer, ManagedRuntime } from 'effect';
import { type ChatEvents, chatEventsEmpty, chatEventsLive } from '@/chat/ChatEvents';
import { type ChatThread, chatThreadEmpty, chatThreadLive } from '@/chat/ChatThread';
import {
  type ImageProvider,
  imageProviderLive,
  imageProviderStubLayer,
} from '@/images/ImageProvider';
import { AppHttpLive } from '@/lib/http';
import { type StoreClient, storeClientLive, storeClientMemory } from '@/storage/StoreClient';

/** The service surface the app's effects may require. */
export type AppServices = StoreClient | ImageProvider | ChatThread | ChatEvents;

/** Live app layer: real services over the live (fetch) HTTP client. */
const appLive: Layer.Layer<AppServices> = Layer.mergeAll(
  storeClientLive,
  imageProviderLive,
  chatThreadLive,
  chatEventsLive,
).pipe(Layer.provide(AppHttpLive));

/** Per-service test-layer overrides; each defaults to the standard test fake. */
export interface TestAppOverrides {
  readonly store?: Layer.Layer<StoreClient>;
  readonly image?: Layer.Layer<ImageProvider>;
  readonly thread?: Layer.Layer<ChatThread>;
  readonly threadEvents?: Layer.Layer<ChatEvents>;
}

/**
 * Build a full test app layer from per-service overrides (each independent, so
 * no duplicate-tag merges). Store tests script the bridge via `store`; chat
 * tests install fakes via `thread`/`threadEvents`.
 */
export function testAppLayerWith(overrides: TestAppOverrides = {}): Layer.Layer<AppServices> {
  return Layer.mergeAll(
    overrides.store ?? storeClientMemory,
    overrides.image ?? imageProviderStubLayer(),
    overrides.thread ?? chatThreadEmpty,
    overrides.threadEvents ?? chatEventsEmpty,
  );
}

/** In-memory app layer for tests / headless use (no bridge, no fetch). */
export const testAppLayer: Layer.Layer<AppServices> = testAppLayerWith();

let current: ManagedRuntime.ManagedRuntime<AppServices, never> = ManagedRuntime.make(appLive);

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
