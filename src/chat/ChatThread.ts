/**
 * The client-side chat runtime service: a typed passthrough over the bridge's
 * session routes (spec §Decision 3). Mirrors the HTTP/boundary pattern of
 * ImageProvider — every wire shape Schema-decoded, non-ok responses mapped to a
 * typed error.
 */

import { HttpClient, HttpClientRequest, type HttpClientResponse } from '@effect/platform';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import {
  ChatBranchesResponse,
  ChatHistoryResponse,
  ChatTurnRequest,
  type ChatTurnRequestT,
  ChatTurnResponse,
  type ChatTurnResponseT,
  ErrorBody,
  PermissionReply,
  SessionAction,
  SessionRef,
} from '@/contracts/api';
import { ChatRequestError, NetworkError } from '@/contracts/errors';
import { type MessageIdT, type PermissionIdT, SessionId, type SessionIdT } from '@/contracts/ids';
import type { ThreadMessageT, ThreadSummaryT } from '@/contracts/thread';

export interface ChatThreadShape {
  /** Run one conversational turn. */
  turn(req: ChatTurnRequestT): Effect.Effect<ChatTurnResponseT, ChatRequestError | NetworkError>;
  /** Rehydrate a card's conversation from opencode. */
  history(sessionId: SessionIdT): Effect.Effect<readonly ThreadMessageT[], NetworkError>;
  /** Interrupt the running turn. */
  cancel(sessionId: SessionIdT): Effect.Effect<void, NetworkError>;
  /** Revert the session to (and undoing) `messageId`. */
  revert(sessionId: SessionIdT, messageId: MessageIdT): Effect.Effect<void, NetworkError>;
  /** Regenerate the last assistant turn. */
  regenerate(
    sessionId: SessionIdT,
  ): Effect.Effect<ChatTurnResponseT, ChatRequestError | NetworkError>;
  /** Branch the session; resolves the new session id. */
  fork(sessionId: SessionIdT): Effect.Effect<SessionIdT, NetworkError>;
  /** Branch (fork) siblings of a session — the branch picker. */
  children(sessionId: SessionIdT): Effect.Effect<readonly ThreadSummaryT[], NetworkError>;
  /** Reply to a pending permission request. */
  replyPermission(
    sessionId: SessionIdT,
    permissionId: PermissionIdT,
    granted: boolean,
  ): Effect.Effect<void, NetworkError>;
}

export class ChatThread extends Context.Tag('cartis/ChatThread')<ChatThread, ChatThreadShape>() {}

const isOk = (status: number): boolean => status >= 200 && status < 300;

/**
 * Best-effort ErrorBody off a non-ok response. The decoded `tag` is the
 * server-side error's identity (spec §13) — it rides on the client error as
 * `remoteTag`, so failures are structurally discriminable end-to-end.
 */
function errorBodyOf(
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<{ detail?: string; remoteTag?: string }> {
  return response.json.pipe(
    Effect.map((body) => {
      const decoded = Schema.decodeUnknownOption(ErrorBody)(body);
      return Option.isSome(decoded)
        ? { detail: decoded.value.error, remoteTag: decoded.value.tag }
        : {};
    }),
    Effect.orElseSucceed(() => ({})),
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
    ): Effect.Effect<A, ChatRequestError | NetworkError> =>
      Effect.gen(function* () {
        const request = HttpClientRequest.post(url).pipe(HttpClientRequest.bodyUnsafeJson(encoded));
        const response = yield* http
          .execute(request)
          .pipe(Effect.mapError((cause) => new NetworkError({ url, cause })));
        if (!isOk(response.status)) {
          const { detail, remoteTag } = yield* errorBodyOf(response);
          return yield* Effect.fail(
            new ChatRequestError({ status: response.status, detail, remoteTag }),
          );
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
    ): Effect.Effect<ChatTurnResponseT, ChatRequestError | NetworkError> =>
      Effect.gen(function* () {
        const wire = yield* Schema.encode(ChatTurnRequest)(req).pipe(
          Effect.mapError((cause) => new NetworkError({ url: '/api/chat/turn', cause })),
        );
        return yield* post('/api/chat/turn', wire, ChatTurnResponse);
      });

    /** Shared GET → decode-with-schema helper (history + children). */
    const getDecoded = <A, I>(
      url: string,
      schema: Schema.Schema<A, I>,
    ): Effect.Effect<A, NetworkError> =>
      Effect.gen(function* () {
        const response = yield* http
          .get(url)
          .pipe(Effect.mapError((cause) => new NetworkError({ url, cause })));
        const json = yield* response.json.pipe(
          Effect.mapError((cause) => new NetworkError({ url, cause })),
        );
        return yield* Schema.decodeUnknown(schema)(json).pipe(
          Effect.mapError((cause) => new NetworkError({ url, cause })),
        );
      });

    const history = (sessionId: string): Effect.Effect<readonly ThreadMessageT[], NetworkError> =>
      getDecoded(
        `/api/chat/history?sessionId=${encodeURIComponent(sessionId)}`,
        ChatHistoryResponse,
      ).pipe(Effect.map((r) => r.messages));

    const children = (sessionId: string): Effect.Effect<readonly ThreadSummaryT[], NetworkError> =>
      getDecoded(
        `/api/chat/children?sessionId=${encodeURIComponent(sessionId)}`,
        ChatBranchesResponse,
      ).pipe(Effect.map((r) => r.branches));

    const action = (url: string, sessionId: SessionIdT, messageId?: MessageIdT) =>
      Effect.gen(function* () {
        const wire = yield* Schema.encode(SessionAction)({ sessionId, messageId }).pipe(
          Effect.mapError((cause) => new NetworkError({ url, cause })),
        );
        yield* post(url, wire, SessionRef).pipe(
          Effect.catchTag('ChatRequestError', (e) =>
            Effect.fail(new NetworkError({ url, cause: e })),
          ),
        );
      });

    return ChatThread.of({
      turn,
      history,
      children,
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
            Effect.catchTag('ChatRequestError', (e) =>
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
            Effect.catchTag('ChatRequestError', (e) =>
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
    turn: () => Effect.fail(new ChatRequestError({ status: 0, detail: 'no agent in tests' })),
    history: () => Effect.succeed([]),
    children: () => Effect.succeed([]),
    cancel: () => Effect.void,
    revert: () => Effect.void,
    regenerate: () => Effect.fail(new ChatRequestError({ status: 0, detail: 'no agent in tests' })),
    fork: () => Effect.succeed(SessionId.make('fork-stub')),
    replyPermission: () => Effect.void,
  }),
);
