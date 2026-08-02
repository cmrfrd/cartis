import { Cause, Data, Option } from 'effect';

/**
 * Tagged error hierarchy for Cartis' business logic.
 *
 * Each class carries the structured fields that describe *what* went wrong and
 * a `message` getter that reproduces the user-visible string the plain-TS code
 * throws *today*, verbatim. The strings are the contract: error-UX parity is a
 * global constraint, so every getter here was cross-checked against the current
 * source (file references live beside each class).
 */

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
  readonly reason: 'no-session-id' | 'no-fill';
}> {
  override get message(): string {
    const byReason: Record<AgentError['reason'], string> = {
      'no-session-id': 'opencode session did not return an id',
      'no-fill': 'agent returned no fill patch',
    };
    return byReason[this.reason];
  }
}

/** Client-side fill request failures. src/builder/AgentFill.ts */
export class AgentFillError extends Data.TaggedError('AgentFillError')<{
  readonly status: number;
  readonly detail?: string;
}> {
  override get message(): string {
    return this.detail ?? `fill request failed (${String(this.status)})`;
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

/** Free function (not a getter) so exhaustive-switch narrowing satisfies biome's useGetterReturn. */
function replicateMessage(fields: {
  readonly reason: ReplicateFields['reason'];
  readonly status?: number;
  readonly detail?: string;
}): string {
  switch (fields.reason) {
    case 'create':
      return `replicate error ${fields.status}: ${fields.detail}`;
    case 'poll':
      return `replicate poll error ${fields.status}`;
    case 'failed':
      return `replicate failed: ${fields.detail ?? 'no detail'}`;
    case 'canceled':
      return `replicate canceled: ${fields.detail ?? 'no detail'}`;
    case 'timeout':
      return 'replicate timed out after 120s';
    case 'no-output':
      return 'replicate succeeded but returned no output';
  }
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
