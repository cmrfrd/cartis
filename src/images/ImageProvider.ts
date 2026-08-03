/**
 * Image generation as an Effect service.
 *
 * Replaces the old `selectImageProvider(fetchImpl?)` + the replicate client
 * wrapper. The Live layer talks to the dev-server bridge over `@effect/platform`
 * HttpClient exactly as the old plain-fetch path did (same routes, same wire
 * body, same silent stub fallback), but the fallback is now typed and visible
 * in the pipeline. The Stub layer keeps the canvas stylizer (and its
 * return-source-unchanged-on-failure behavior) and stays usable headlessly via
 * an injectable `paint` function.
 *
 * `GenerationResult` extends the old provider output with `via` so views can
 * build today's "generated via stub." / "via replicate" notes byte-identically.
 */

import { HttpClient, HttpClientRequest, type HttpClientResponse } from '@effect/platform';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import {
  ErrorBody,
  ImageGenerateRequest,
  ImageGenerateResponse,
  StatusResponse,
} from '../contracts/api';
import { ImageBridgeError, NetworkError } from '../contracts/errors';
import { bytesToDataUrl, dataUrlToBytes } from './codec';
import { type GenerationInput, type PaintFn, paintStylizedFrame, stubStyleFor } from './stub';

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** Re-export so callers keep importing `GenerationInput` from the service module. */
export type { GenerationInput } from './stub';

/** The old provider output plus which path produced it (for the view notes). */
export interface GenerationResult {
  bytes: ArrayBuffer;
  type: string;
  via: 'stub' | 'replicate';
}

export interface ImageProviderShape {
  readonly generate: (
    input: GenerationInput,
  ) => Effect.Effect<GenerationResult, ImageBridgeError | NetworkError>;
}

export class ImageProvider extends Context.Tag('cartis/ImageProvider')<
  ImageProvider,
  ImageProviderShape
>() {}

// ---------------------------------------------------------------------------
// Stub path (pure canvas stylizer, silent source-passthrough on failure)
// ---------------------------------------------------------------------------

/**
 * Today's `createStubProvider(paint).generate` inlined as an Effect: paint the
 * source, and on ANY paint failure return the source unchanged (canvas
 * unavailable in tests / decode failure). Never fails.
 */
function stubGenerate(paint: PaintFn, input: GenerationInput): Effect.Effect<GenerationResult> {
  return Effect.tryPromise(() => paint(input, stubStyleFor(input.styleId))).pipe(
    Effect.map((out): GenerationResult => ({ bytes: out.bytes, type: out.type, via: 'stub' })),
    Effect.catchAll(() =>
      Effect.succeed<GenerationResult>({
        bytes: input.sourceBytes,
        type: input.sourceType,
        via: 'stub',
      }),
    ),
  );
}

/**
 * Stub layer. `paint` is the headless-test seam (default: the canvas stylizer).
 * Requires no environment — safe as the test default and in vite preview.
 */
export function imageProviderStubLayer(
  paint: PaintFn = paintStylizedFrame,
): Layer.Layer<ImageProvider> {
  return Layer.succeed(
    ImageProvider,
    ImageProvider.of({ generate: (input) => stubGenerate(paint, input) }),
  );
}

// ---------------------------------------------------------------------------
// Live layer (over @effect/platform HttpClient)
// ---------------------------------------------------------------------------

const isOk = (status: number): boolean => status >= 200 && status < 300;

/** Best-effort ErrorBody off a non-ok response — carries the server error's tag (spec §13). */
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

export const imageProviderLive: Layer.Layer<ImageProvider, never, HttpClient.HttpClient> =
  Layer.effect(
    ImageProvider,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;

      /**
       * Probe the bridge: does it report `replicate`? ANY failure (transport,
       * non-ok, decode) → false, so we take the stub path. This reproduces the
       * old `try { ... } catch { /* offline stub *\/ }` silently, now typed.
       */
      const wantsReplicate: Effect.Effect<boolean> = Effect.gen(function* () {
        const url = '/api/status';
        const response = yield* http.get(url);
        if (!isOk(response.status)) return false;
        const body = yield* response.json;
        const status = yield* Schema.decodeUnknown(StatusResponse)(body);
        return status.image === 'replicate';
      }).pipe(Effect.orElseSucceed(() => false));

      /** POST /api/image/generate; non-ok → ImageBridgeError, ok → replicate bytes. */
      const replicateGenerate = (
        input: GenerationInput,
      ): Effect.Effect<GenerationResult, ImageBridgeError | NetworkError> =>
        Effect.gen(function* () {
          const url = '/api/image/generate';
          const wire = yield* Schema.encode(ImageGenerateRequest)({
            prompt: input.prompt,
            // Absent = text-to-image; the old empty-data-URL sentinel is gone.
            imageDataUrl:
              input.sourceBytes.byteLength > 0
                ? bytesToDataUrl(input.sourceBytes, input.sourceType)
                : undefined,
            aspectRatio: input.aspectRatio ?? 'match_input_image',
            themeContext: input.themeContext,
            argumentValues: input.argumentValues,
            brief: input.brief,
            editCurrentArt: input.editCurrentArt,
            currentArtFileName: input.currentArtFileName,
          }).pipe(Effect.mapError((cause) => new NetworkError({ url, cause })));
          const request = HttpClientRequest.post(url).pipe(HttpClientRequest.bodyUnsafeJson(wire));
          const response = yield* http
            .execute(request)
            .pipe(Effect.mapError((cause) => new NetworkError({ url, cause })));
          if (!isOk(response.status)) {
            const { detail, remoteTag } = yield* errorBodyOf(response);
            return yield* Effect.fail(
              new ImageBridgeError({ status: response.status, detail, remoteTag }),
            );
          }
          const body = yield* response.json.pipe(
            Effect.mapError((cause) => new NetworkError({ url, cause })),
          );
          const decoded = yield* Schema.decodeUnknown(ImageGenerateResponse)(body).pipe(
            Effect.mapError((cause) => new NetworkError({ url, cause })),
          );
          const out = dataUrlToBytes(decoded.dataUrl);
          return { bytes: out.bytes, type: out.type, via: 'replicate' };
        });

      const generate = (
        input: GenerationInput,
      ): Effect.Effect<GenerationResult, ImageBridgeError | NetworkError> =>
        wantsReplicate.pipe(
          Effect.flatMap((replicate) =>
            replicate ? replicateGenerate(input) : stubGenerate(paintStylizedFrame, input),
          ),
        );

      return ImageProvider.of({ generate });
    }),
  );
