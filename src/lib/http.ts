/**
 * HTTP client layer for Cartis.
 *
 * Provides:
 *   AppHttpLive          — live layer: FetchHttpClient.layer (works on Node 18+ and browser)
 *   httpClientFromHandler — test seam: Layer<HttpClient> from a plain handler function
 *
 * Callers use HttpClientResponse.schemaBodyJson(schema) for decoding — no
 * decodeJsonBody helper needed here.
 *
 * @effect/platform 0.97.x — HttpClient.make takes
 *   (request, url, signal, fiber) => Effect<HttpClientResponse, HttpClientError>
 * HttpClientResponse.fromWeb(request, webResponse) converts a web Response.
 */

import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from '@effect/platform';
import { Effect, Layer } from 'effect';

// ---------------------------------------------------------------------------
// Live layer — wraps globalThis.fetch via @effect/platform
// ---------------------------------------------------------------------------

export const AppHttpLive: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer;

// ---------------------------------------------------------------------------
// Test seam — accepts a plain handler returning a web Response
//
// A handler that throws / rejects surfaces an HttpClientError.RequestError
// so callers get a typed error from the standard HttpClientError channel.
// ---------------------------------------------------------------------------

export function httpClientFromHandler(
  handler: (request: HttpClientRequest.HttpClientRequest) => Response | Promise<Response>,
): Layer.Layer<HttpClient.HttpClient> {
  const client = HttpClient.make((request, _url, _signal, _fiber) =>
    Effect.tryPromise({
      try: () =>
        Promise.resolve(handler(request)).then((res) => HttpClientResponse.fromWeb(request, res)),
      catch: (cause) =>
        new HttpClientError.RequestError({
          request,
          reason: 'Transport',
          cause,
        }),
    }),
  );
  return Layer.succeed(HttpClient.HttpClient, client);
}
