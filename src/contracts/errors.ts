import { Cause, Data, Match, Option } from 'effect';

/**
 * Tagged error hierarchy for Cartis' business logic — THE error catalog
 * (spec: type-safety & contract hardening, Pillar C §15).
 *
 * Each class carries the structured fields that describe *what* went wrong and
 * a `message` getter that reproduces the user-visible string the plain-TS code
 * throws *today*, verbatim. The strings are the contract: error-UX parity is a
 * global constraint, so every getter here was cross-checked against the current
 * source (file references live beside each class).
 *
 * ## Catalog: producer → HTTP status → UX → propagation
 *
 * | Tag              | Produced by                                   | HTTP | UX surface                          |
 * |------------------|-----------------------------------------------|------|-------------------------------------|
 * | NetworkError     | client HttpClient transport/encode/decode     | n/a  | note via noteFromCause              |
 * | StoreError       | StoreClient non-ok store responses            | n/a  | savedNote / thrown to view catch    |
 * | FileStoreError   | server fs I/O under cartis-data               | 500  | ErrorBody → client error → note     |
 * | BodyError        | server readBody JSON parse                    | 400  | ErrorBody → client error → note     |
 * | ParseError       | server route Schema decode (effect/Schema)    | 400  | ErrorBody → client error → note     |
 * | AgentError       | opencode contract violations (bridge)         | 500  | ErrorBody → client error → note     |
 * | ChatRequestError | client chat routes non-ok (carries remoteTag) | n/a  | incomplete message + error strip    |
 * | ReplicateError   | replicate create/poll/failed/timeout (bridge) | 500  | ErrorBody → Art 'error' + note      |
 * | ImageBridgeError | client image route non-ok (carries remoteTag) | n/a  | generation note                     |
 * | ExportError      | client canvas/rasterize                       | n/a  | export note                         |
 * | MediaError       | client camera/media devices                   | n/a  | camera note                         |
 * | Defect           | any unexpected throw (server)                 | 500  | ErrorBody { tag: 'Defect' } → note  |
 *
 * Propagation path (server-originated): domain `Effect.fail(TaggedError)` →
 * `respond` (BridgeRuntime) serializes `{ tag, error: message }` with the
 * status from `statusOfError` → client service decodes `ErrorBody` and fails
 * its own typed class CARRYING `remoteTag` (structural discrimination without
 * breaking message byte-parity) → `runAppExit` Exit → `noteFromCause` string
 * or structured handling at the expressive boundary.
 *
 * Sanctioned non-Effect throws (documented, not converted): expressive model
 * methods (`CardArchive`/`ImageLibrary`) rethrow `noteFromCause` strings for
 * their view-level try/catch; the theme registry throws at registration
 * (programmer error = defect by design).
 */

/**
 * HTTP status for a server-side failure tag (spec §13). Route-level explicit
 * statuses (404 unknown store, 405 method, 503 missing token) are produced
 * before `respond` and unaffected.
 */
export function statusOfError(tag: string): number {
  // Malformed input is the caller's fault; everything else is on us.
  return tag === 'BodyError' || tag === 'ParseError' ? 400 : 500;
}

/** fetch() rejected before any HTTP response (network down, DNS, abort). */
export class NetworkError extends Data.TaggedError('NetworkError')<{
  readonly url: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

/** HTTP store-client failures. src/storage/StoreClient.ts */
export class StoreError extends Data.TaggedError('StoreError')<{
  readonly op: 'list' | 'put' | 'delete';
  readonly status: number;
  readonly detail?: string;
}> {
  override get message(): string {
    const byOp: Record<StoreError['op'], string> = {
      list: `store list failed (${this.status})`,
      put: this.detail ?? `store put failed (${this.status})`,
      delete: `store delete failed (${this.status})`,
    };
    return byOp[this.op];
  }
}

/** File-backed persistence failures. src/server/fileStore.ts */
export class FileStoreError extends Data.TaggedError('FileStoreError')<{
  readonly op: string;
  readonly path: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

/** JSON body parse failures. src/server/BridgeRuntime.ts readBody */
export class BodyError extends Data.TaggedError('BodyError')<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

/** opencode agent contract violations. src/server/agentBridge.ts */
export class AgentError extends Data.TaggedError('AgentError')<{
  readonly reason: 'no-session-id' | 'no-fill' | 'bad-reply' | 'busy' | 'turn-failed';
  readonly detail?: string;
}> {
  override get message(): string {
    const byReason: Record<AgentError['reason'], string> = {
      'no-session-id': 'opencode session did not return an id',
      'no-fill': 'agent returned no fill patch',
      'bad-reply': 'the agent returned malformed output — try again or regenerate',
      busy: 'a turn is already running for this card — wait for it to finish',
      'turn-failed': this.detail ?? 'the agent turn failed — try again',
    };
    return byReason[this.reason];
  }
}

/**
 * Client-side chat/turn request failures. src/chat/ChatThread.ts
 * `remoteTag` is the server-side error's tag decoded from the ErrorBody — the
 * typed identity of the failure survives the HTTP round-trip (spec §13) and is
 * structurally matchable without changing the user-visible message.
 */
export class ChatRequestError extends Data.TaggedError('ChatRequestError')<{
  readonly status: number;
  readonly detail?: string;
  readonly remoteTag?: string;
}> {
  override get message(): string {
    return this.detail ?? `chat request failed (${String(this.status)})`;
  }
}

/**
 * Replicate image-generation failures. src/server/agentBridge.ts:130-194
 *
 * `create`   → `replicate error ${status}: ${detail}`      (line 155)
 * `poll`     → `replicate poll error ${status}`            (line 180)
 * `failed`   → `replicate failed: ${detail}`               (line 172, status='failed')
 * `canceled` → `replicate canceled: ${detail}`             (line 172, status='canceled')
 * `timeout`  → `replicate timed out after 120s`            (line 175)
 * `no-output`→ `replicate succeeded but returned no output`(line 186)
 *
 * The constructor takes a discriminated union over `reason`, so the degenerate
 * cases ("replicate error undefined: …") are unrepresentable: `create` requires
 * the HTTP status plus the response-body text the source interpolates, `poll`
 * requires the status, `failed`/`canceled` carry the prediction error (falling
 * back to `'no detail'` exactly like the source), and `timeout`/`no-output`
 * take no fields.
 *
 * TS 7 rejects `extends` over a union-shaped instance type (TS2509: base
 * constructor return type must have statically known members), so the class
 * itself keeps flat fields and the exported constructor is narrowed to the
 * union instead — same runtime class, degenerate construction impossible.
 */
export type ReplicateFields =
  | { readonly reason: 'create'; readonly status: number; readonly detail: string }
  | { readonly reason: 'poll'; readonly status: number }
  | { readonly reason: 'failed'; readonly detail?: string }
  | { readonly reason: 'canceled'; readonly detail?: string }
  | { readonly reason: 'timeout' }
  | { readonly reason: 'no-output' };

/** Match.exhaustive over the reason union (spec §Match): a new reason fails tsc here. */
function replicateMessage(fields: {
  readonly reason: ReplicateFields['reason'];
  readonly status?: number;
  readonly detail?: string;
}): string {
  return Match.value(fields.reason).pipe(
    Match.when('create', () => `replicate error ${fields.status}: ${fields.detail}`),
    Match.when('poll', () => `replicate poll error ${fields.status}`),
    Match.when('failed', () => `replicate failed: ${fields.detail ?? 'no detail'}`),
    Match.when('canceled', () => `replicate canceled: ${fields.detail ?? 'no detail'}`),
    Match.when('timeout', () => 'replicate timed out after 120s'),
    Match.when('no-output', () => 'replicate succeeded but returned no output'),
    Match.exhaustive,
  );
}

class ReplicateErrorClass extends Data.TaggedError('ReplicateError')<{
  readonly reason: ReplicateFields['reason'];
  readonly status?: number;
  readonly detail?: string;
}> {
  override get message(): string {
    return replicateMessage(this);
  }
}

export type ReplicateError = ReplicateErrorClass;
export const ReplicateError: new (fields: ReplicateFields) => ReplicateError = ReplicateErrorClass;

/** Client-side image-bridge failures. src/images/ImageProvider.ts */
export class ImageBridgeError extends Data.TaggedError('ImageBridgeError')<{
  readonly status: number;
  readonly detail?: string;
  /** Server-side error tag decoded from the ErrorBody (spec §13). */
  readonly remoteTag?: string;
}> {
  override get message(): string {
    return this.detail ?? `image bridge failed (${this.status})`;
  }
}

/** Card export/rasterization failures. src/export/exportCard.ts */
export class ExportError extends Data.TaggedError('ExportError')<{
  readonly detail: string;
}> {
  override get message(): string {
    return this.detail;
  }
}

/** Camera / media-device failures. src/images/CameraCapture.tsx */
export class MediaError extends Data.TaggedError('MediaError')<{
  readonly detail: string;
}> {
  override get message(): string {
    return this.detail;
  }
}

/**
 * Reduce a `Cause` to the user-facing note string a boundary would surface.
 *
 * - failure → the error's `.message`
 * - defect  → `d instanceof Error ? d.message : String(d)`
 * - interrupt / empty → `''`
 *
 * No casts: we pattern-match the cause via `Cause.failureOption` /
 * `Cause.dieOption`, which return typed `Option`s.
 */
export function noteFromCause(cause: Cause.Cause<unknown>): string {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    const error = failure.value;
    // Every domain failure is a Data.TaggedError (an Error subclass), so its
    // `.message` getter reproduces today's user-visible string.
    if (error instanceof Error) return error.message;
    if (typeof error === 'object' && error !== null && 'message' in error) {
      const { message } = error;
      return typeof message === 'string' ? message : String(error);
    }
    return String(error);
  }
  const defect = Cause.dieOption(cause);
  if (Option.isSome(defect)) {
    const d = defect.value;
    return d instanceof Error ? d.message : String(d);
  }
  return '';
}
