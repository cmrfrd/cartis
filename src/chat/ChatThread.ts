/**
 * The client-side chat runtime service: a typed passthrough over the bridge's
 * session routes (spec §Decision 3). Mirrors the HTTP/boundary pattern of
 * AgentFill/ImageProvider — every wire shape Schema-decoded, non-ok responses
 * mapped to a typed error.
 */

import { HttpClient, HttpClientRequest, type HttpClientResponse } from '@effect/platform';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import {
  ChatHistoryResponse,
  ChatTurnRequest,
  type ChatTurnRequestT,
  ChatTurnResponse,
  type ChatTurnResponseT,
  ErrorBody,
  PermissionReply,
  SessionAction,
  SessionRef,
} from '../contracts/api';
import { AgentFillError, NetworkError } from '../contracts/errors';
import type { ThreadMessageT } from '../contracts/thread';

export interface ChatThreadShape {
  /** Run one conversational turn. */
  turn(req: ChatTurnRequestT): Effect.Effect<ChatTurnResponseT, AgentFillError | NetworkError>;
  /** Rehydrate a card's conversation from opencode. */
  history(sessionId: string): Effect.Effect<readonly ThreadMessageT[], NetworkError>;
  /** Interrupt the running turn. */
  cancel(sessionId: string): Effect.Effect<void, NetworkError>;
  /** Revert the session to (and undoing) `messageId`. */
  revert(sessionId: string, messageId: string): Effect.Effect<void, NetworkError>;
  /** Regenerate the last assistant turn. */
  regenerate(sessionId: string): Effect.Effect<ChatTurnResponseT, AgentFillError | NetworkError>;
  /** Branch the session; resolves the new session id. */
  fork(sessionId: string): Effect.Effect<string, NetworkError>;
  /** Reply to a pending permission request. */
  replyPermission(
    sessionId: string,
    permissionId: string,
    granted: boolean,
  ): Effect.Effect<void, NetworkError>;
}

export class ChatThread extends Context.Tag('cartis/ChatThread')<ChatThread, ChatThreadShape>() {}

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

export const chatThreadLive: Layer.Layer<ChatThread, never, HttpClient.HttpClient> = Layer.effect(
  ChatThread,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;

    /** POST `body` to `url`, decode the JSON response with `schema`. */
    const post = <A, I>(
      url: string,
      encoded: unknown,
      schema: Schema.Schema<A, I>,
    ): Effect.Effect<A, AgentFillError | NetworkError> =>
      Effect.gen(function* () {
        const request = HttpClientRequest.post(url).pipe(HttpClientRequest.bodyUnsafeJson(encoded));
        const response = yield* http
          .execute(request)
          .pipe(Effect.mapError((cause) => new NetworkError({ url, cause })));
        if (!isOk(response.status)) {
          const detail = yield* detailOf(response);
          return yield* Effect.fail(new AgentFillError({ status: response.status, detail }));
        }
        const json = yield* response.json.pipe(
          Effect.mapError((cause) => new NetworkError({ url, cause })),
        );
        return yield* Schema.decodeUnknown(schema)(json).pipe(
          Effect.mapError((cause) => new NetworkError({ url, cause })),
        );
      });

    const turn = (
      req: ChatTurnRequestT,
    ): Effect.Effect<ChatTurnResponseT, AgentFillError | NetworkError> =>
      Effect.gen(function* () {
        const wire = yield* Schema.encode(ChatTurnRequest)(req).pipe(
          Effect.mapError((cause) => new NetworkError({ url: '/api/chat/turn', cause })),
        );
        return yield* post('/api/chat/turn', wire, ChatTurnResponse);
      });

    const history = (sessionId: string): Effect.Effect<readonly ThreadMessageT[], NetworkError> =>
      Effect.gen(function* () {
        const url = `/api/chat/history?sessionId=${encodeURIComponent(sessionId)}`;
        const response = yield* http
          .get(url)
          .pipe(Effect.mapError((cause) => new NetworkError({ url, cause })));
        const json = yield* response.json.pipe(
          Effect.mapError((cause) => new NetworkError({ url, cause })),
        );
        const decoded = yield* Schema.decodeUnknown(ChatHistoryResponse)(json).pipe(
          Effect.mapError((cause) => new NetworkError({ url, cause })),
        );
        return decoded.messages;
      });

    const action = (url: string, sessionId: string, messageId?: string) =>
      Effect.gen(function* () {
        const wire = yield* Schema.encode(SessionAction)({ sessionId, messageId }).pipe(
          Effect.mapError((cause) => new NetworkError({ url, cause })),
        );
        yield* post(url, wire, SessionRef).pipe(
          Effect.catchTag('AgentFillError', (e) =>
            Effect.fail(new NetworkError({ url, cause: e })),
          ),
        );
      });

    return ChatThread.of({
      turn,
      history,
      cancel: (sessionId) => action('/api/chat/abort', sessionId),
      revert: (sessionId, messageId) => action('/api/chat/revert', sessionId, messageId),
      regenerate: (sessionId) =>
        Effect.gen(function* () {
          const wire = yield* Schema.encode(SessionAction)({ sessionId }).pipe(
            Effect.mapError((cause) => new NetworkError({ url: '/api/chat/regenerate', cause })),
          );
          return yield* post('/api/chat/regenerate', wire, ChatTurnResponse);
        }),
      fork: (sessionId) =>
        Effect.gen(function* () {
          const wire = yield* Schema.encode(SessionAction)({ sessionId }).pipe(
            Effect.mapError((cause) => new NetworkError({ url: '/api/chat/fork', cause })),
          );
          const ref = yield* post('/api/chat/fork', wire, SessionRef).pipe(
            Effect.catchTag('AgentFillError', (e) =>
              Effect.fail(new NetworkError({ url: '/api/chat/fork', cause: e })),
            ),
          );
          return ref.sessionId;
        }),
      replyPermission: (sessionId, permissionId, granted) =>
        Effect.gen(function* () {
          const url = '/api/chat/permission';
          const wire = yield* Schema.encode(PermissionReply)({
            sessionId,
            permissionId,
            granted,
          }).pipe(Effect.mapError((cause) => new NetworkError({ url, cause })));
          yield* post(url, wire, SessionRef).pipe(
            Effect.catchTag('AgentFillError', (e) =>
              Effect.fail(new NetworkError({ url, cause: e })),
            ),
          );
        }),
    });
  }),
);

/** Test default: turn/regenerate fail; passthroughs are inert. */
export const chatThreadEmpty: Layer.Layer<ChatThread> = Layer.succeed(
  ChatThread,
  ChatThread.of({
    turn: () => Effect.fail(new AgentFillError({ status: 0, detail: 'no agent in tests' })),
    history: () => Effect.succeed([]),
    cancel: () => Effect.void,
    revert: () => Effect.void,
    regenerate: () => Effect.fail(new AgentFillError({ status: 0, detail: 'no agent in tests' })),
    fork: () => Effect.succeed('fork-stub'),
    replyPermission: () => Effect.void,
  }),
);
