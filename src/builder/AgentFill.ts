/**
 * Conversational AI fill as an Effect service (spec §AI pipelines): POST
 * /api/agent/fill over @effect/platform HttpClient. Mirrors the service shape
 * of src/images/ImageProvider.ts.
 */

import { HttpClient, HttpClientRequest, type HttpClientResponse } from '@effect/platform';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import {
  AgentFillRequest,
  type AgentFillRequestT,
  AgentFillResponse,
  type AgentFillResponseT,
  ErrorBody,
} from '../contracts/api';
import { AgentFillError, NetworkError } from '../contracts/errors';

export interface AgentFillShape {
  readonly fill: (
    req: AgentFillRequestT,
  ) => Effect.Effect<AgentFillResponseT, AgentFillError | NetworkError>;
}

export class AgentFill extends Context.Tag('cartis/AgentFill')<AgentFill, AgentFillShape>() {}

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

export const agentFillLive: Layer.Layer<AgentFill, never, HttpClient.HttpClient> = Layer.effect(
  AgentFill,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const fill = (
      req: AgentFillRequestT,
    ): Effect.Effect<AgentFillResponseT, AgentFillError | NetworkError> =>
      Effect.gen(function* () {
        const url = '/api/agent/fill';
        const wire = yield* Schema.encode(AgentFillRequest)(req).pipe(
          Effect.mapError((cause) => new NetworkError({ url, cause })),
        );
        const request = HttpClientRequest.post(url).pipe(HttpClientRequest.bodyUnsafeJson(wire));
        const response = yield* http
          .execute(request)
          .pipe(Effect.mapError((cause) => new NetworkError({ url, cause })));
        if (!isOk(response.status)) {
          const detail = yield* detailOf(response);
          return yield* Effect.fail(new AgentFillError({ status: response.status, detail }));
        }
        const body = yield* response.json.pipe(
          Effect.mapError((cause) => new NetworkError({ url, cause })),
        );
        return yield* Schema.decodeUnknown(AgentFillResponse)(body).pipe(
          Effect.mapError((cause) => new NetworkError({ url, cause })),
        );
      });
    return AgentFill.of({ fill });
  }),
);

/** Test default: fails with a typed error so tests that need success install their own. */
export const agentFillEmpty: Layer.Layer<AgentFill> = Layer.succeed(
  AgentFill,
  AgentFill.of({
    fill: () => Effect.fail(new AgentFillError({ status: 0, detail: 'no agent in tests' })),
  }),
);
