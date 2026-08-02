/**
 * Code Lab agent as an Effect service.
 *
 * Replaces the inline fetch in `EditorView.runAgent`. The Live layer POSTs
 * `/api/agent/card` over `@effect/platform` HttpClient exactly as the old
 * plain-fetch path did (same route, same wire body, same error strings).
 */

import { HttpClient, HttpClientRequest, type HttpClientResponse } from '@effect/platform';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import { AgentCardRequest, AgentCardResponse, ErrorBody } from '../contracts/api';
import { AgentRequestError, NetworkError } from '../contracts/errors';

export interface AgentApiShape {
  readonly generateCard: (
    prompt: string,
    currentCode: string,
  ) => Effect.Effect<string, AgentRequestError | NetworkError>;
}

export class AgentApi extends Context.Tag('cartis/AgentApi')<AgentApi, AgentApiShape>() {}

// ---------------------------------------------------------------------------
// Live layer (over @effect/platform HttpClient)
// ---------------------------------------------------------------------------

const isOk = (status: number): boolean => status >= 200 && status < 300;

/** Best-effort ErrorBody detail off a non-ok response (missing → undefined). */
function detailOf(
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<string | undefined> {
  return response.json.pipe(
    Effect.map((body) => {
      const decoded = Schema.decodeUnknownOption(ErrorBody)(body);
      return Option.isSome(decoded) ? decoded.value.error : undefined;
    }),
    Effect.orElseSucceed(() => undefined),
  );
}

export const agentApiLive: Layer.Layer<AgentApi, never, HttpClient.HttpClient> = Layer.effect(
  AgentApi,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;

    const generateCard = (
      prompt: string,
      currentCode: string,
    ): Effect.Effect<string, AgentRequestError | NetworkError> =>
      Effect.gen(function* () {
        const url = '/api/agent/card';
        const wire = yield* Schema.encode(AgentCardRequest)({ prompt, code: currentCode }).pipe(
          Effect.mapError((cause) => new NetworkError({ url, cause })),
        );
        const request = HttpClientRequest.post(url).pipe(HttpClientRequest.bodyUnsafeJson(wire));
        const response = yield* http
          .execute(request)
          .pipe(Effect.mapError((cause) => new NetworkError({ url, cause })));
        if (!isOk(response.status)) {
          const detail = yield* detailOf(response);
          return yield* Effect.fail(new AgentRequestError({ status: response.status, detail }));
        }
        const body = yield* response.json.pipe(
          Effect.mapError((cause) => new NetworkError({ url, cause })),
        );
        const decoded = yield* Schema.decodeUnknown(AgentCardResponse)(body).pipe(
          Effect.mapError((cause) => new NetworkError({ url, cause })),
        );
        return decoded.code;
      });

    return AgentApi.of({ generateCard });
  }),
);
