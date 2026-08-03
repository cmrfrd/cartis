# Type safety & contract hardening — branded ids, the Option boundary, typed errors end-to-end

**Date:** 2026-08-03 · **Status:** approved

## Context

Cartis runs on Effect v3 with Schema-decoded contracts, a `Data.TaggedError`
hierarchy, and the expressive UI framework. The foundation is sound, but an
audit surfaced three classes of avoidable type risk:

1. **Nominal gaps.** Every id is a bare `string` (`CardId`, `SessionId`,
   `ThemeId`, `LayoutId`, `MessageId`, `PermissionId`, `ExportId`, `ImageId`),
   so nothing stops passing a session id where a card id is expected. Secrets
   (`REPLICATE_API_TOKEN`) flow as plain `string` and can leak into logs.
2. **`Option` asymmetry.** The server/Effect code uses `Option` heavily
   (agentBridge 25×, fileStore 6×), but pure client logic returns `T | undefined`
   with `??`/`!== undefined` ladders and uses `try/catch` for control flow
   (`getLayout` throws → `layoutOf` catches). Composition and forced-handling
   are lost exactly where they'd help.
3. **Soft contracts.** Wire schemas under-constrain: `schemaFromFields` ignores
   a field's `min`/`max`/`options` (so a chat agent can set `cost: 999` or an
   invalid `select` value and it validates and applies); `FieldValue` is defined
   three times (drift risk); `aspectRatio` and `FieldSummary.kind` are open
   `Schema.String` where a closed set is meant; timestamps are unrefined
   `Schema.Number`; and error bodies flatten every failure to `{ error: string }`
   so the client can't tell failures apart structurally.

The goal: make illegal states unrepresentable where it's cheap, make every
failure condition a typed value whose propagation is legible end-to-end, and
tighten the contracts to reject bad data at the boundary — **without fighting
the expressive UI framework**. This is a comprehensive sweep across the
contracts, services, and pure logic; the plan sequences it by workstream so each
step is independently `bun run verify`-green and mergeable.

## Guiding principle: `Option` is for composition, `undefined` is for the UI edge

`strictNullChecks` already makes `T | undefined` null-safe (the compiler forces
narrowing). `Option`'s advantage over `T | undefined` is **composition** —
chaining `map`/`flatMap`/`getOrElse` without re-checking absence at every hop —
not safety. Therefore:

- **Pure logic, contracts, and service returns speak `Option`.** These places
  compose values through transforms; `Option` is where its combinators pay off,
  and it makes "might be absent" part of the type.
- **The expressive reactive layer speaks `T | undefined`.** State-class fields
  and JSX props are natively undefined-able; the DOM cannot consume an `Option`
  (`src={Option.some(x)}` is meaningless), and boxing defeats expressive's
  value-equality change-skip (two equal `Option`s are distinct references →
  spurious re-renders). At the UI edge composition is over (a value is rendered
  or stored), so `Option` there is a box you open immediately, for no added
  safety.

The seam is the assignment line where a value leaves pure/service code and lands
in a reactive field or JSX prop. **`Option.getOrUndefined` (or `Option.match`
producing JSX) is the one-line adapter that sits exactly there** — converted
once, not scattered. This principle is the spine of the whole design.

## Pillar A — Nominal & optional types

1. **Branded ids + validated strings** in a new `src/contracts/ids.ts` — the
   maximal-branding decision. Nominal id brands
   (`Schema.String.pipe(Schema.brand('CardId'))`): `CardId`, `ExportId`,
   `ImageId`, `ThemeId`, `LayoutId`, `SessionId`, `MessageId`, `PermissionId`.
   Refinement brands for validated strings: `DataUrl`
   (`^data:[^;]+;base64,.+` — makes "valid non-empty data URL" a type-level fact,
   the E006 empty-`input_image` bug class caught at compile time), `NonEmptyString`,
   `FileName`, `Slug`, `MimeType` (nominal). Brands apply at the Schema level so
   decode produces branded types; minting sites (`crypto.randomUUID()`, opencode
   decode, `slugOf`, `fileNameFor`) wrap in the brand constructor. Code-defined
   ids (`ThemeId`/`LayoutId` in theme/layout definitions) are branded at the
   registry boundary: definitions declare plain-string "input" shapes,
   `registerTheme`/`registerLayout` validate them into the branded domain types.
   External untyped ids (opencode session/message ids, replicate urls) are
   branded at their decode boundary. **Field-object keys stay plain `string`** —
   they are structural property names into `CardData`, not cross-cuttable entity
   ids (excluded; see Non-goals).
2. **`Redacted` for the Replicate token.** `Config.redacted('REPLICATE_API_TOKEN')`
   → `Redacted.Redacted<string>` threaded through `ReplicateSdk.createPrediction`/
   `getPrediction` and unwrapped with `Redacted.value` only at
   `new Replicate({ auth })`. It stringifies to `<redacted>` everywhere else, so
   it cannot leak into a log, error, or note. `/api/status` still branches on the
   `Option<Redacted<string>>` presence.
3. **`Option` returns for pure nullable helpers**, per the boundary principle:
   `getLayout`/`layoutOf` (drops the throw-and-catch), `BuilderView.artKey`/
   `currentArtFileName`, `ImageLibrary.url`, `outputUrlOf`, `eventSessionId`,
   `slugOf`, `dimensionsFor`, `renderThreadEvent`. Consumers compose as `Option`;
   the value is converted with `Option.getOrUndefined` exactly where it enters a
   reactive field or JSX prop.
4. **`NonEmptyReadonlyArray` for `Theme.layouts`** (+ `Array.headNonEmpty`), so
   "a theme has ≥1 layout" is a type-level fact and the `first?` dance in
   `BuilderView.new`/`pickTheme` and the registry disappears.
5. **`Schema.OptionFromNullOr`** at wire boundaries that today do
   `optional(NullOr(...))` + manual conversion (replicate `output`, opencode
   nullable reads) — decode `null | absent | T` straight into `Option<T>`.

## Pillar B — Contract hardening

6. **`schemaFromFields` honors every field constraint** (the sharpest gap). The
   derived patch schema currently drops `min`/`max`/`options`, so an agent patch
   with `cost: 999` or `essence: "banana"` validates and applies. Harden the
   derivation to `Schema.Int.pipe(Schema.between(min, max))` for numbers,
   `Schema.Literal(...options)` for selects, `Schema.Boolean` for toggles, and
   `Schema.String` for text/textarea/image. Because the bridge has no theme
   registry (it runs in Node; the registry is browser-side), the constraints must
   travel over the wire: **`FieldSummary` grows the constraints it needs**
   (`min`/`max` for numbers, `options` for selects), and the client already
   builds `FieldSummary` from `layout.fields` so it fills them in. This closes a
   real hole in the chat/fill patch path.
7. **Single source of truth for shared shapes.** `FieldValue` is defined three
   times (`cards/types.ts`, `api.ts`, `records.ts`). Make **one canonical
   `FieldValue` Schema**, derive the TS type via `typeof FieldValue.Type`, and
   import it everywhere (schema is the source; TS derives). Apply the same
   "schema-first, TS-derived" move to the `FieldKind` and `AspectRatio` sets
   below so the card layer and the contracts can't drift.
8. **Closed literal unions replace open `Schema.String`.** `AspectRatio` =
   `Schema.Literal('1:1','3:2','2:3','3:4','4:3','16:9','9:16','match_input_image')`
   shared by `ImageGenerateRequest.aspectRatio` and `Layout.artAspect`.
   `FieldKind` = `Schema.Literal('text','textarea','number','select','image','toggle')`
   shared by `FieldSummary.kind` and `FieldSpec`. Invalid values now fail decode
   instead of silently falling through.
9. **Refined numerics.** Timestamps (`updatedAt`/`createdAt`) →
   `Schema.Int.pipe(Schema.nonNegative())` (or a nominal `Timestamp` brand);
   `partIndex`/`secs` → non-negative. Rejects negatives/floats/NaN at the
   boundary.
10. **A `FieldSpec` Schema** so `registerTheme`/`registerLayout` validate layout
    field definitions at registration (today `tsc` is the only guard). Small; it
    makes a malformed layout a caught error rather than a latent shape bug.
11. **`Schema.optionalWith(..., { default })`** where a decoded optional always
    gets a downstream default (e.g. `aspectRatio` → `'match_input_image'`), so a
    decoded value is always complete and the `?? default` at the use site
    disappears.

## Pillar C — Typed errors end-to-end

The completion of the hardening story: every failure condition is a typed value,
and its propagation is legible from the point of failure to the UX or HTTP
response. `errors.ts` stays the canonical `Data.TaggedError` registry.

12. **Precise `E` channels.** Audit every `Effect` signature so its error union
    is exact — no `Effect<A, unknown>`, no over-broad or swallowed errors.
    Failure conditions that are currently defects or `throw`/`try-catch`
    control-flow become either a typed failure in the `E` channel or an `Option`
    (per Pillar A): `getLayout`, the `as unknown as OpencodeClient` seam, and any
    remaining ad-hoc `throw new Error(...)` become tagged/absent-typed.
13. **The error tag survives the HTTP round-trip.** `ErrorBody` grows a `tag`
    (and keeps `error`): `Schema.Struct({ tag: Schema.String, error: Schema.String })`.
    `respond` (server) serializes the failed cause's tagged error to
    `{ tag, error }` with an HTTP status chosen by a **typed error→status map**
    (e.g. missing token → 503, decode/body error → 400, unknown store/file → 404,
    else 500) instead of the current flat 500-with-message. Client services
    decode `ErrorBody` and map a **known** `tag` back to its typed error class
    (an unknown tag → a generic `RemoteError` carrying the tag + message), so a
    failure crosses the wire as a **typed** error the client can match on, not a
    bare string.
14. **Exhaustive handling at boundaries.** Where errors are caught, use
    `Effect.catchTags`/`Match` on the error `_tag` so the compiler enforces that
    every condition is handled and narrows the remaining channel. The expressive
    boundary keeps `noteFromCause` for the default "show a message" path, but
    specific tags may be handled structurally (e.g. a permission-required error
    routes to `pendingPermission` rather than a note).
15. **A documented error catalog.** `errors.ts` (or a short companion doc)
    tabulates each `TaggedError`: what produces it, what it means, its HTTP status
    (server) and its UX mapping (client), and its propagation path
    (`domain fail → respond → ErrorBody{tag} → client decode → typed error →
    runAppExit Exit → noteFromCause/structured handling`). This is the artifact
    that answers "what are all our error conditions and how do they propagate."

## Cross-cutting — `Match` for exhaustive dispatch

`Match.value(x).pipe(Match.tag(...), Match.exhaustive)` replaces the eight
tagged-union `switch` statements (`ThreadPart`/`ThreadEvent` in fold/threadBus/
ThreadPanel, `FieldSpec.kind` in FormRenderer/`schemaFromFields`,
`PendingIntent.kind`, error `_tag`). A missing case fails to typecheck. This
serves Pillar B (exhaustive `kind` branching), Pillar C (exhaustive error
handling), and the existing fold/UI dispatch.

## New / changed modules

- **`src/contracts/ids.ts`** (new) — all id brands, validated-string brands, and
  their constructors.
- **`src/contracts/fields.ts`** (new) — canonical `FieldValue`, `FieldKind`,
  `AspectRatio`, `FieldSpec` schemas + derived TS types; `schemaFromFields` moves
  here and honors constraints. (`api.ts`/`records.ts`/`cards/types.ts` import
  from it; the three `FieldValue` definitions collapse to this one.)
- **`src/contracts/errors.ts`** — grows the error catalog + the error→status map;
  `ErrorBody` gains `tag`.
- **`src/contracts/{records,api,replicate,theme,thread,opencode}.ts`** — adopt the
  brands, closed unions, refined numerics, `OptionFromNullOr`.
- **Services/pure logic** — `registry`, `CardArchive`, `ImageLibrary`,
  `ImageProvider`, `ChatThread`, `agentBridge`/`ReplicateSdk`, `BuilderView`,
  `gallery-helpers`, `fold`, `threadBus` — adopt `Option` returns, `Redacted`,
  `Match`, and the boundary conversions.

## Engineering requirements (binding)

Repo standards hold and tighten: no `any`/`!`/`as`-on-external-data (this spec
*removes* the remaining `as unknown as`); every wire shape Schema-decoded;
tagged errors consumed via exhaustive matching. The Option boundary rule
(Guiding principle) is binding — `Option` never enters a reactive field or JSX
prop; conversion is a single `getOrUndefined`/`match` at the seam. Tests per
workstream: brand decode accept/reject + refinement tests (`DataUrl`,
`NonEmptyString`, ranged numbers); `schemaFromFields` range/option rejection
(a `cost: 999` patch fails); `FieldValue` single-source (the three call sites
resolve to one schema); Option-converted helpers unit-tested; `Redacted`
does-not-stringify; `ErrorBody{tag}` round-trip (server serialize → client
decode → typed error) + the error→status map; `Match` conversions are
behavior-preserving (existing tests stay green). `tsc --noEmit` green *is* the
test for the nominal brands. `bun run verify` green per workstream; a final
live-build check.

## Non-goals / deliberate exclusions

- **Field-object keys stay `string`.** Branding `FieldKey` would infect every
  `CardData[key]` access for near-zero safety (field keys don't get mixed with
  entity ids). *(Overridable if desired — flagged during design.)*
- **`CardData` stays `Record<string, FieldValue>`** — dynamic by design;
  validated at the Schema boundaries (`schemaFromFields`, `CardRecord.data`).
- **Expressive reactive fields + JSX props stay `T | undefined`** — per the
  Guiding principle.
- **The connect-middleware `res as ServerResponse` casts stay** — a framework
  boundary, not external data.
- **`DateTime`/`Duration` for timestamps is out** — refined `Int` (or a
  `Timestamp` brand) is enough; raw epoch millis stays the wire representation.
- No behavior changes: this is a typing/validation hardening pass. The one
  intended behavior change is *stricter rejection* (out-of-range patches, invalid
  aspects, malformed ids now fail decode where they silently passed).
