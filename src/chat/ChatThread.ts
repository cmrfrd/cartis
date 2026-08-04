/**
 * The client-side chat runtime service: a typed passthrough over the bridge's
 * pi routes (migration spec §3.2/§4.1). Every wire shape Schema-decoded,
 * non-ok responses mapped to a typed error carrying the server tag.
 */

import { HttpClient, HttpClientRequest, type HttpClientResponse } from '@effect/platform';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import {
  ChatEditRequest,
  ChatHistoryResponse,
  ChatSwitchRequest,
  ChatTreeResponse,
  type ChatTreeResponseT,
  ChatTurnRequest,
  type ChatTurnRequestT,
  ChatTurnResponse,
  type ChatTurnResponseT,
  ErrorBody,
  SessionAction,
  SessionRef,
} from '@/contracts/api';
import { ChatRequestError, NetworkError } from '@/contracts/errors';
import type { MessageIdT, SessionIdT } from '@/contracts/ids';
import type { ThreadMessageT } from '@/contracts/thread';

export interface ChatThreadShape {
  /** Run one conversational turn. */
  turn(req: ChatTurnRequestT): Effect.Effect<ChatTurnResponseT, ChatRequestError | NetworkError>;
  /** Edit an earlier user message — a sibling branch in the session tree. */
  edit(
    req: ChatTurnRequestT,
    targetMessageId: MessageIdT,
  ): Effect.Effect<ChatTurnResponseT, ChatRequestError | NetworkError>;
  /** Regenerate the last assistant turn (replay on a new branch). */
  regenerate(
    req: ChatTurnRequestT,
  ): Effect.Effect<ChatTurnResponseT, ChatRequestError | NetworkError>;
  /** Rehydrate the ACTIVE branch of a card's conversation. */
  history(sessionId: SessionIdT): Effect.Effect<readonly ThreadMessageT[], NetworkError>;
  /** ‹ n/m › anchors from the session tree. */
  tree(sessionId: SessionIdT): Effect.Effect<ChatTreeResponseT['anchors'], NetworkError>;
  /** Durable branch switch to a sibling leaf. */
  switch(sessionId: SessionIdT, leafId: string): Effect.Effect<void, NetworkError>;
  /** Interrupt the running turn. */
  cancel(sessionId: SessionIdT): Effect.Effect<void, NetworkError>;
}

export class ChatThread extends Context.Tag('cartis/ChatThread')<ChatThread, ChatThreadShape>() {}

const isOk = (status: number): boolean => status >= 200 && status < 300;

/** Best-effort ErrorBody off a non-ok response (server tag rides as remoteTag). */
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

    const postTurn = (
      url: string,
      req: ChatTurnRequestT,
      extra?: Record<string, unknown>,
    ): Effect.Effect<ChatTurnResponseT, ChatRequestError | NetworkError> =>
      Effect.gen(function* () {
        const schema = extra === undefined ? ChatTurnRequest : ChatEditRequest;
        const wire = yield* Schema.encode(schema as typeof ChatTurnRequest)({
          ...req,
          ...extra,
        } as ChatTurnRequestT).pipe(Effect.mapError((cause) => new NetworkError({ url, cause })));
        return yield* post(url, wire, ChatTurnResponse);
      });

    return ChatThread.of({
      turn: (req) => postTurn('/api/chat/turn', req),
      edit: (req, targetMessageId) => postTurn('/api/chat/edit', req, { targetMessageId }),
      regenerate: (req) => postTurn('/api/chat/regenerate', req),
      history: (sessionId) =>
        getDecoded(
          `/api/chat/history?sessionId=${encodeURIComponent(sessionId)}`,
          ChatHistoryResponse,
        ).pipe(Effect.map((r) => r.messages)),
      tree: (sessionId) =>
        getDecoded(
          `/api/chat/tree?sessionId=${encodeURIComponent(sessionId)}`,
          ChatTreeResponse,
        ).pipe(Effect.map((r) => r.anchors)),
      switch: (sessionId, leafId) =>
        Effect.gen(function* () {
          const url = '/api/chat/switch';
          const wire = yield* Schema.encode(ChatSwitchRequest)({ sessionId, leafId }).pipe(
            Effect.mapError((cause) => new NetworkError({ url, cause })),
          );
          yield* post(url, wire, SessionRef).pipe(
            Effect.catchTag('ChatRequestError', (e) =>
              Effect.fail(new NetworkError({ url, cause: e })),
            ),
          );
        }),
      cancel: (sessionId) =>
        Effect.gen(function* () {
          const url = '/api/chat/abort';
          const wire = yield* Schema.encode(SessionAction)({ sessionId }).pipe(
            Effect.mapError((cause) => new NetworkError({ url, cause })),
          );
          yield* post(url, wire, SessionRef).pipe(
            Effect.catchTag('ChatRequestError', (e) =>
              Effect.fail(new NetworkError({ url, cause: e })),
            ),
          );
        }),
    });
  }),
);

/** Test default: turn/edit/regenerate fail; passthroughs are inert. */
export const chatThreadEmpty: Layer.Layer<ChatThread> = Layer.succeed(
  ChatThread,
  ChatThread.of({
    turn: () => Effect.fail(new ChatRequestError({ status: 0, detail: 'no agent in tests' })),
    edit: () => Effect.fail(new ChatRequestError({ status: 0, detail: 'no agent in tests' })),
    regenerate: () => Effect.fail(new ChatRequestError({ status: 0, detail: 'no agent in tests' })),
    history: () => Effect.succeed([]),
    tree: () => Effect.succeed([]),
    switch: () => Effect.void,
    cancel: () => Effect.void,
  }),
);
