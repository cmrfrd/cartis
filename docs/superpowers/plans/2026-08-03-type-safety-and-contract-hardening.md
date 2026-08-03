# Type Safety & Contract Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement spec `docs/superpowers/specs/2026-08-03-type-safety-and-contract-hardening-design.md` — branded ids + validated strings, the Option boundary, Redacted secrets, NonEmptyReadonlyArray, hardened contracts (constraint-honoring `schemaFromFields`, single-source `FieldValue`, closed unions, refined numerics), Match exhaustiveness, and typed errors end-to-end.

**Architecture:** Three pillars sequenced as twelve verify-green workstreams: contract foundations first (`fields.ts`, `ids.ts`), then brand adoption in two waves (cards domain, chat domain), then the image-pipeline `DataUrl`, `Redacted`, Option conversions, Match, and the typed-error round-trip. Behavior-preserving throughout — the only intended change is stricter rejection of already-invalid data.

**Tech Stack:** effect 3.22 (`Schema.brand`, `Redacted`, `Config.redacted`, `Match`, `Array.NonEmptyReadonlyArray`, `Schema.optionalWith`), TS 7 native preview, vitest 4 via `test/effect.ts`, expressive 0.83.

## Global Constraints

- Spec Engineering-requirements binding: no `any`/`!`/`as`-on-external-data; this plan *removes* the remaining `as unknown as`.
- **Option boundary rule (binding):** `Option` never enters an expressive reactive field or JSX prop; convert once at the seam with `Option.getOrUndefined`/`Option.match`.
- Id brands are **pure nominal** (no refinement — empty-string sentinels stay constructible); validated-string brands carry real refinements.
- Field-object keys stay plain `string`; `CardData` stays `Record<string, FieldValue>`; `res as ServerResponse` casts stay.
- Gate per task: `bun run verify` green. Branch `feat/type-safety-hardening` off main. Commits end `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Deviation from spec (stronger, less churn — approved at plan time): theme/layout definitions brand their own ids at the definition site (`ThemeId.make('arcane')`) instead of a plain-input + registry-branding dual shape; the registry still Schema-validates each layout's `fields` at registration.

---

### Task 1: `contracts/fields.ts` — canonical field/aspect schemas + registry validation

**Files:**
- Create: `src/contracts/fields.ts`, `src/contracts/fields.test.ts`
- Modify: `src/cards/types.ts` (derive `FieldValue`/`CardData`/`FieldSpec` kinds from schemas), `src/contracts/api.ts` + `src/contracts/records.ts` (delete local `FieldValue`, import), `src/cards/registry.ts` (validate `layout.fields` on register), `src/cards/types.ts` `Layout.artAspect: AspectRatioT`
- Test: `src/contracts/fields.test.ts`, existing `contracts.test.ts` + registry tests stay green

**Produces (later tasks rely on):**
```ts
export const FieldValue: Schema<string | number | boolean | undefined>;
export type FieldValueT = typeof FieldValue.Type;
export const CardDataSchema: Schema.Record$<typeof Schema.String, typeof FieldValue>;
export const FieldKind = Schema.Literal('text', 'textarea', 'number', 'select', 'image', 'toggle');
export type FieldKindT = typeof FieldKind.Type;
export const AspectRatio = Schema.Literal('1:1','3:2','2:3','3:4','4:3','16:9','9:16','match_input_image');
export type AspectRatioT = typeof AspectRatio.Type;
export const FieldSpecSchema: Schema<...>;   // discriminated on kind, mirrors cards/types.ts FieldSpec
```

- [ ] Write `fields.test.ts`: FieldValue accepts string/number/boolean/undefined + rejects null/object; FieldKind rejects `'slider'`; AspectRatio rejects `'5:7'`; FieldSpecSchema accepts each of the six kinds (number requires min+max, select requires options) and rejects a select without options.
- [ ] Implement `fields.ts`. `FieldSpecSchema` is a `Schema.Union` of six `Schema.Struct`s discriminated by `kind: Schema.Literal(...)`, each with the exact optional/required fields from `cards/types.ts` (`showIf` = `Schema.optional(Schema.Struct({ key: Schema.String, equals: FieldValue }))`).
- [ ] Single-source: `cards/types.ts` → `export type FieldValue = FieldValueT` (import type from contracts); delete the duplicated `const FieldValue` in `api.ts` + `records.ts`, import `FieldValue`/`CardDataSchema` from `./fields.ts`. `Layout.artAspect?: AspectRatioT`.
- [ ] `registry.ts` `registerTheme`: for each layout run `Schema.decodeUnknownSync(Schema.Array(FieldSpecSchema))(layout.fields)` (throw = registration error, same failure mode as today's identity validation); add a registry test registering a layout with a bad field spec → throws.
- [ ] `bun run verify` → green. Commit `feat(contracts): canonical field/aspect schemas; single-source FieldValue; registry validates field specs`.

### Task 2: `schemaFromFields` honors constraints; `FieldSummary` carries them

**Files:**
- Modify: `src/contracts/fields.ts` (move + harden `schemaFromFields`; new `FieldSummary`), `src/contracts/api.ts` (`ChatTurnRequest.fields: Schema.Array(FieldSummary)`; delete old `schemaFromFields` + `FieldSummary`), `src/builder/BuilderView.tsx` `chatContext()` (fill min/max/options), `src/chat/ThreadState.ts` (`ChatFieldSummary` → import `FieldSummaryT`), `src/server/agentBridge.ts` (import path)
- Test: `src/contracts/fields.test.ts` (+ existing schemaFromFields tests move here), `src/server/agentBridge.test.ts` `chatReq` fixture

**Produces:**
```ts
export const FieldSummary = Schema.Struct({
  kind: FieldKind, key: Schema.String, label: Schema.String,
  min: Schema.optional(Schema.Number), max: Schema.optional(Schema.Number),
  options: Schema.optional(Schema.Array(Schema.String)),
});
export type FieldSummaryT = typeof FieldSummary.Type;
export function schemaFromFields(fields: readonly FieldSummaryT[]): Schema.Struct<...>;
```

- [ ] Failing tests: `schemaFromFields([{kind:'number',key:'cost',label:'Cost',min:0,max:9}])` rejects `{cost: 999}`, `{cost: 1.5}`, accepts `{cost: 5}`; select with `options:['ember','tide']` rejects `{essence:'banana'}`, accepts `{essence:'tide'}`; number without min/max = plain int; unknown keys still dropped.
- [ ] Harden: number → `Schema.Number.pipe(Schema.int(), ...(min/max present ? [Schema.between(min, max)] : []))` (compose via pipe conditionally); select with options → `Schema.Literal(...options)`; toggle → Boolean; else String.
- [ ] `BuilderView.chatContext()` maps `layout.fields` → summaries including `f.kind==='number' ? {min:f.min, max:f.max} : {}` and `f.kind==='select' ? {options: f.options.map(o=>o.value)} : {}`.
- [ ] Verify → green. Commit `feat(contracts): schemaFromFields enforces min/max/options; constraints travel on FieldSummary`.

### Task 3: `contracts/ids.ts` — brands for ids, validated strings, Timestamp

**Files:**
- Create: `src/contracts/ids.ts`, `src/contracts/ids.test.ts`

**Produces:**
```ts
// nominal (no refinement): CardId, ExportId, ImageId, ThemeId, LayoutId, SessionId, MessageId, PermissionId
export const CardId = Schema.String.pipe(Schema.brand('CardId'));
export type CardIdT = typeof CardId.Type;            // …same pattern ×8
// refined:
export const NonEmptyString = Schema.String.pipe(Schema.minLength(1), Schema.brand('NonEmptyString'));
export const DataUrl = Schema.String.pipe(Schema.pattern(/^data:[^;]+;base64,.+$/), Schema.brand('DataUrl'));
export const FileName = Schema.String.pipe(Schema.minLength(1), Schema.brand('FileName'));
export const Slug = Schema.String.pipe(Schema.pattern(/^[a-z0-9-]*$/), Schema.brand('Slug'));
export const MimeType = Schema.String.pipe(Schema.pattern(/^[\w.+-]+\/[\w.+-]+$/), Schema.brand('MimeType'));
export const Timestamp = Schema.Number.pipe(Schema.int(), Schema.nonNegative(), Schema.brand('Timestamp'));
export type ... // T-suffixed type per brand; minting via Brand.make e.g. CardId.make(crypto.randomUUID())
```

- [ ] Tests: each nominal brand round-trips decode; `DataUrl.make('data:image/png;base64,QQ==')` ok and `.make('data:;base64,')`/`''` throws; `Timestamp` rejects `-1`/`1.5`; two different brands are not assignable (compile-time — assert via `@ts-expect-error` lines in the test file).
- [ ] Verify → green. Commit `feat(contracts): branded ids, validated strings, Timestamp (ids.ts)`.

### Task 4: Refined numerics adoption

**Files:**
- Modify: `src/contracts/records.ts` (`updatedAt`/`createdAt`: `Timestamp`), `src/contracts/thread.ts` (`partIndex`: `Schema.Number.pipe(Schema.int(), Schema.nonNegative())`, `secs`: nonNegative), minting sites `CardArchive.saveCard/saveExport` + `ImageLibrary.add` (`Timestamp.make(Date.now())`)
- Test: `contracts.test.ts` (negative/float timestamp rejected), existing storage tests green

- [ ] Failing test: `CardRecord` with `updatedAt: -5` or `1.5` rejects. Adopt; fix minting sites; verify → green. Commit `feat(contracts): refined numerics (Timestamp, non-negative indexes)`.

### Task 5: Brand adoption wave 1 — cards domain + NonEmptyReadonlyArray

**Files:**
- Modify: `src/cards/types.ts` (`Theme.id: ThemeIdT`, `Layout.id: LayoutIdT`, `layouts: NonEmptyReadonlyArray<Layout>`), theme definition files under `src/cards/arcane/` (`ThemeId.make('arcane')`, `LayoutId.make('classic'|'fullart')` — tuple literal satisfies NonEmpty), `src/cards/registry.ts` (`getTheme(id: ThemeIdT)`, `getLayout(themeId: ThemeIdT, layoutId: LayoutIdT)`, `listThemes`), `src/contracts/records.ts` (`CardRecord.id: CardId`, `themeId: ThemeId`, `layoutId: LayoutId`; `ExportRecord.id: ExportId`, `cardId: Schema.optional(CardId)`; `ImageRecord.id: ImageId`), `src/storage/CardArchive.ts` + `src/storage/ImageLibrary.ts` (input/mint types; `CardId.make(crypto.randomUUID())`), `src/builder/BuilderView.tsx` (`themeId: ThemeIdT` with `ThemeId.make('')` transient sentinel until `new()` picks; `savedId?: CardIdT`; UI select boundary re-brands: `onValue={(id) => builder.pickTheme(ThemeId.make(id))}`), `src/gallery/GalleryView.tsx` + `gallery-helpers.ts`, `src/export/ExportBar.tsx` (`cardId?: CardIdT`)
- Test: follow `tsc` — existing tests updated where fixtures build records (wrap ids in brands); registry test asserts `Arr.headNonEmpty(theme.layouts)` typing replaces `layouts[0]` + `first?` dances in `BuilderView.new/pickTheme` and `FormRenderer` default-option guard stays

**Interfaces produced:** all cards-domain signatures accept/return branded ids; `getTheme(id).layouts` is `NonEmptyReadonlyArray<Layout>`.

- [ ] Tighten types; let `tsc --noEmit` enumerate every call site; convert each (brand at mint/UI boundaries, plain flow elsewhere — brands are strings at runtime so wire encode is unchanged).
- [ ] Replace `listThemes()[0]` + `layouts[0]` guards with `Arr.headNonEmpty` where the array is typed NonEmpty; `BuilderView.new()` keeps its `listThemes()[0]` optional-check (themes *list* is not NonEmpty-typed).
- [ ] Verify → green (fixtures updated). Commit `feat(types): branded ids across the cards domain; Theme.layouts is NonEmptyReadonlyArray`.

### Task 6: Brand adoption wave 2 — chat domain

**Files:**
- Modify: `src/contracts/thread.ts` (`sessionId: SessionId`, `messageId: MessageId`, `permissionId: PermissionId` in every event/summary), `src/contracts/api.ts` (chat request/response/session-action ids), `src/contracts/records.ts` (`chatSessionId: Schema.optional(SessionId)`), `src/server/agentBridge.ts` (brand at opencode decode boundaries: `SessionId.make(id)` in `createSession`/`fork`/`sessionSummary`; `MessageId.make` in watcher/history mapping), `src/chat/{ChatThread,ThreadState,ThreadPanel,fold}.ts(x)` (types follow; local user-bubble ids `MessageId.make(crypto.randomUUID())`), `src/server/threadBus.ts`
- Test: follow `tsc`; thread contract codec tests brand their fixture ids

- [ ] Same mechanic as Task 5: tighten schemas, follow the compiler, brand at minting/decode boundaries. SSE wire format unchanged (brands encode as plain strings).
- [ ] Verify → green. Commit `feat(types): branded session/message/permission ids across the chat domain`.

### Task 7: `DataUrl` through the image pipeline

**Files:**
- Modify: `src/contracts/api.ts` (`ImageGenerateRequest.imageDataUrl: Schema.optional(DataUrl)` — **absent replaces today's empty-string sentinel**; `aspectRatio: Schema.optionalWith(AspectRatio, { default: () => 'match_input_image' as const })`), `src/images/codec.ts` (`bytesToDataUrl` returns `DataUrlT` via `DataUrl.make`), `src/images/ImageProvider.ts` + `src/images/stub.ts` (omit field when no source; `dimensionsFor(aspectRatio: AspectRatioT)`), `src/server/agentBridge.ts` (`ReplicateClient.generate` input `{ prompt; imageDataUrl?: DataUrlT; aspectRatio: AspectRatioT }`; `hasSource` regex → presence check `input.imageDataUrl !== undefined` — the brand *is* the validity proof), `src/builder/BuilderView.tsx`/`PortraitSection` call sites
- Test: agentBridge replicate tests (fixtures use `DataUrl.make('data:image/png;base64,QQ==')`; "omits input_image" test now passes `imageDataUrl: undefined`); contracts test: empty-string `imageDataUrl` now **fails decode**; aspectRatio decode default fills `match_input_image`

- [ ] Convert; the E006 class ("empty input_image sent") is now unrepresentable. Verify → green. Commit `feat(types): DataUrl brand through the image pipeline; aspectRatio closed union with decode default`.

### Task 8: `Redacted` token + opencode client adapter (fixes latent permission bug)

**Files:**
- Modify: `src/server/agentBridge.ts`:
  - `envOption` gains a redacted sibling: `envRedacted(name): Effect<Option<Redacted.Redacted<string>>>` = `Effect.orDie(Config.option(Config.redacted(name))).pipe(Effect.map(Option.filter((r) => Redacted.value(r).length > 0)))`.
  - `ReplicateSdk.createPrediction/getPrediction(token: Redacted.Redacted<string>, …)`; `clientFor` unwraps with `Redacted.value(token)` at `new Replicate({ auth })` only. Routes `/api/status` + `/api/image/generate` use `envRedacted('REPLICATE_API_TOKEN')`.
  - **Adapter replaces the cast:** the SDK client's permission method is `postSessionIdPermissionsPermissionId`, not `permission` — today's `client as unknown as OpencodeClient` would throw at runtime on a permission reply. Add
    ```ts
    function opencodeClientOf(sdk: {
      session: OpencodeClient['session'];
      postSessionIdPermissionsPermissionId(input: unknown): Promise<unknown>;
      event: OpencodeClient['event'];
    }): OpencodeClient {
      return { session: sdk.session, event: sdk.event,
        permission: (input) => sdk.postSessionIdPermissionsPermissionId(input) };
    }
    ```
    and use it in `agentClientLive` (structural param typing absorbs the SDK type; zero casts).
- Test: agentBridge tests — `String(token)`/`JSON.stringify` of a `Redacted` never contains the secret (assert `<redacted>`); replicate stubs take `Redacted.make('tok')`; an adapter test: a fake sdk with only `postSessionIdPermissionsPermissionId` receives the permission reply.

- [ ] TDD the adapter + redaction; convert; verify → green. Commit `feat(server): Redacted replicate token; opencode adapter replaces cast (fixes permission-reply dispatch)`.

### Task 9: Option returns + `optionalWith(as: 'Option')` wire decode

**Files:**
- Modify: `src/cards/registry.ts` (`getLayoutOption(themeId, layoutId): Option<Layout>` — keep throwing `getLayout` delegating to it for the hot paths that structurally can't miss, or convert all callers; **convert `gallery-helpers.layoutOf` to return `Option<Layout>` and delete its try/catch**), `src/builder/BuilderView.tsx` (`artKey(): Option<string>` + `currentArtFileName(): Option<FileNameT>` as private pure helpers; `Option.getOrUndefined` exactly where values land in `chatContext`/reactive fields), `src/storage/ImageLibrary.ts` (`urlOption(id): Option<string>`; JSX call sites `Option.getOrUndefined`), `src/server/agentBridge.ts` (`outputUrlOf: Option<string>`; `Prediction.output/error` → `Schema.optionalWith(..., { as: 'Option', nullable: true })` — deletes the manual NullOr juggling), `src/chat/ThreadState.ts` (`eventSessionId: Option<SessionIdT>`), `src/server/fileStore.ts` (`slugOf` returns `SlugT`), `src/images/stub.ts` (`dimensionsFor(aspect: AspectRatioT)` — total, no undefined), `src/server/threadBus.ts` (`renderThreadEvent: Option<string>`; bus consumes via `Option.match`)
- Test: gallery-helpers tests (`Option.isNone` for unregistered theme); replicate decode test: `"output": null` → `Option.none()`; helper unit tests updated

- [ ] Convert helpers; every consumer composes as Option; `getOrUndefined` only at reactive/JSX seams (grep the diff: no `Option<` in State field declarations or JSX prop positions).
- [ ] Verify → green. Commit `feat(types): Option returns for pure helpers; OptionFromNull wire decode; expressive boundary conversions`.

### Task 10: `Match` for the eight tagged-union switches

**Files:**
- Modify: `src/chat/fold.ts`, `src/server/threadBus.ts` (renderThreadEvent ×2 switches), `src/chat/ThreadPanel.tsx` (PartView), `src/chat/ThreadState.ts` (eventSessionId — may already be Match from Task 9), `src/server/agentBridge.ts` (part-type dispatch), `src/builder/FormRenderer.tsx` (FieldSpec.kind), `src/builder/BuilderView.tsx` (PendingIntent), `src/contracts/errors.ts` (noteFromCause cause dispatch stays switch-free/Match)
- Test: zero behavior change — the entire existing suite is the test; conversions use `Match.value(x).pipe(Match.tag('Text', …), …, Match.exhaustive)` (or `Match.discriminator('kind')` for FieldSpec)

- [ ] Convert one file at a time, running that file's tests after each. Verify → green. Commit `refactor: Match.exhaustive replaces tagged-union switches`.

### Task 11: Typed errors end-to-end

**Files:**
- Modify: `src/contracts/errors.ts` (`ErrorBody = Schema.Struct({ tag: Schema.String, error: Schema.String })`; new `RemoteError extends Data.TaggedError('RemoteError')<{ tag: string; status: number; detail: string }>`; exported `statusOfError(tag: string): number` map — `BodyError`→400, decode/ParseError→400, `StoreError`/`FileStoreError` op-miss→404 pass-through, missing-token→503 (route-level, unchanged), default 500; **error catalog**: module-header table documenting each tag → producer, meaning, HTTP status, UX mapping, propagation path), `src/server/BridgeRuntime.ts` (`respond` failure branch: `sendJson(res, statusOfError(failure._tag), { tag: failure._tag, error: failure.message })`; defect branch `{ tag: 'Defect', error: … }`), client services `src/chat/ChatThread.ts`, `src/storage/StoreClient.ts`, `src/images/ImageProvider.ts`, (`detailOf` → `remoteErrorOf(response): Effect<RemoteError>` decoding `ErrorBody{tag}`; `ChatRequestError`/`StoreError` construction carries the remote tag in `detail` or is replaced by `RemoteError` — keep existing error *classes* where UI matches on them, embed the tag), `src/chat/ThreadState.ts` (example structured handling: match `RemoteError` tag for permission-flavored failures stays future-proofed; default remains `noteFromCause`)
- Test: round-trip test — a bridge route failing with `StoreError` yields `{ tag: 'StoreError', error: … }` + mapped status; client decode produces the typed error whose `_tag`/detail match; `noteFromCause` strings unchanged (byte parity where asserted); precise-E audit: grep no `Effect<[^,]+, unknown` in src (excluding platform-forced), no `throw new Error` in business logic

- [ ] TDD the round-trip; upgrade respond + clients; write the catalog table. Verify → green. Commit `feat(errors): tagged errors survive the HTTP round-trip; status map; error catalog`.

### Task 12: Sweep, docs, merge prep

- [ ] Greps: `as unknown as` → zero in src; `catch (` in business logic only at sanctioned expressive boundaries; recount ` as [A-Z]` casts vs. audit baseline (expect ~ServerResponse + tests only); `Option<` absent from State fields/JSX props.
- [ ] README: short "Type discipline" note under Effect architecture (brands, Option boundary rule, error catalog pointer). Memory update post-merge.
- [ ] `bun run verify` + `bun run build`; quick live smoke (`bun run dev`: load app, one stub-path generate, save/open card) since contracts changed shape on the wire.
- [ ] Commit `docs: type-discipline sweep`; then finishing-a-development-branch (merge to main + push per repo convention).

## Self-review

- **Spec coverage:** Pillar A items 1–5 → Tasks 3,5,6,7 (brands), 8 (Redacted), 9 (Option + OptionFromNullOr), 5 (NonEmptyArray). Pillar B 6–11 → Tasks 2 (schemaFromFields), 1 (FieldValue single-source, closed unions, FieldSpec schema), 4 (numerics), 7 (optionalWith default). Pillar C 12–15 → Task 11 (+ precise-E grep), catalog in Task 11. Match cross-cutting → Task 10. Non-goals respected throughout. ✓
- **Placeholders:** none — every task names exact files, signatures, and test assertions. ✓
- **Type consistency:** brand names (`CardId`/`…T` types), `FieldSummaryT`, `AspectRatioT`, `opencodeClientOf`, `remoteErrorOf`, `statusOfError` used consistently across tasks. ✓
