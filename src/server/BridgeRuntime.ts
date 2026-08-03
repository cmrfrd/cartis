import type { IncomingMessage, ServerResponse } from 'node:http';
import { Cause, Effect, Layer, ManagedRuntime, Option } from 'effect';
import { BodyError } from '../contracts/errors.ts';
import { AppHttpLive } from '../lib/http.ts';
import {
  type AgentClient,
  agentClientLive,
  type ReplicateClient,
  type ReplicateSdk,
  replicateClientLive,
  replicateSdkLive,
} from './agentBridge.ts';
import { type FileStore, fileStoreLayer } from './fileStore.ts';
import { type ThreadBus, threadBusLive } from './threadBus.ts';

/**
 * Per-dev-server Effect runtime. All bridge services live in one merged layer;
 * `cartisBridge()` builds a `ManagedRuntime` once in `configureServer` and
 * disposes it when the http server closes.
 */

/** The full bridge service surface, provided with the live HTTP client. */
export function bridgeLive(
  root: string,
): Layer.Layer<ThreadBus | FileStore | ReplicateSdk | ReplicateClient | AgentClient> {
  // Leaf services shared across the runtime (one ThreadBus, one ReplicateSdk).
  const leaves = Layer.mergeAll(threadBusLive, fileStoreLayer(root), replicateSdkLive);
  // AgentClient's thread watcher emits on the SHARED bus (from `leaves`).
  const agentClient = agentClientLive.pipe(Layer.provide(leaves));
  // ReplicateClient needs ReplicateSdk + ThreadBus (from `leaves`) + HttpClient.
  const replicateClient = replicateClientLive.pipe(
    Layer.provide(leaves),
    Layer.provide(AppHttpLive),
  );
  return Layer.mergeAll(leaves, agentClient, replicateClient);
}

export type BridgeRuntime = ManagedRuntime.ManagedRuntime<
  ThreadBus | FileStore | ReplicateSdk | ReplicateClient | AgentClient,
  never
>;

export function makeBridgeRuntime(root: string): BridgeRuntime {
  return ManagedRuntime.make(bridgeLive(root));
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(value));
}

/**
 * Read + JSON-parse a request body. Same chunk-collection as today's readJson;
 * an empty body decodes to `{}`; a parse failure becomes a `BodyError` (which
 * `respond` renders as a 500, matching today's blind-parse throw).
 */
export function readBody(req: IncomingMessage): Effect.Effect<unknown, BodyError> {
  return Effect.async<unknown, BodyError>((resume) => {
    let body = '';
    req.on('data', (chunk: unknown) => {
      body += String(chunk);
    });
    req.on('end', () => {
      try {
        resume(Effect.succeed(body.length > 0 ? JSON.parse(body) : {}));
      } catch (cause) {
        resume(Effect.fail(new BodyError({ cause })));
      }
    });
    req.on('error', (cause) => resume(Effect.fail(new BodyError({ cause }))));
  });
}

/**
 * Run `effect` on the runtime and translate the result to an HTTP response:
 *   - success        → 200 + JSON value
 *   - typed failure  → 500 `{ error: e.message }`   (parity with respondWith)
 *   - defect         → 500 `{ error: String(defect) }`
 * Explicit non-500 statuses (404/405/503) are produced by route logic before
 * this helper is reached.
 */
export function respond<A, E extends { message: string }, R>(
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
  res: ServerResponse,
  effect: Effect.Effect<A, E, R>,
): void {
  void runtime.runPromiseExit(effect).then((exit) => {
    if (exit._tag === 'Success') {
      sendJson(res, 200, exit.value);
      return;
    }
    // failureOption/dieOption see through nested causes (Sequential/Parallel).
    const failure = Cause.failureOption(exit.cause);
    if (Option.isSome(failure)) {
      sendJson(res, 500, { error: failure.value.message });
      return;
    }
    const defect = Cause.dieOption(exit.cause);
    if (Option.isSome(defect)) {
      const d = defect.value;
      sendJson(res, 500, { error: d instanceof Error ? d.message : String(d) });
      return;
    }
    // Interrupt / empty — nothing sensible to say, but keep the 500 contract.
    sendJson(res, 500, { error: 'request failed' });
  });
}
