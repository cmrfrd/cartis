# Test & E2E Hardening — Design (revised for the pi runtime)

**Date:** 2026-08-04
**Status:** Approved; **REVISED 2026-08-04 after the pi runtime migration
landed** (merged to main, `e856194`). The original three tracks were designed
against the opencode runtime and its v1 JSON transport — both gone. This
revision re-grounds each track on what shipped: the in-process pi runtime,
real provider-validated tool calls, and the faux-provider test seam
(`src/server/pi/faux.ts`) the migration built. Property-based fuzzing remains
explicitly skipped.

## Why

Retrospective over the last nine functional bugs (six pre-migration, three
live-caught during the migration's browser gate): the model seam moved but
did not disappear — multi-round streaming ghosts, art-strip identity
mismatches, and stale-thread leaks were all found by an LLM (or a human)
driving the real browser, not by the 350-test unit suite. The layered
strategy stands; the seams it tests move to where the bugs now live.

## The layered strategy

| Layer | What | Speed / trigger |
|---|---|---|
| Unit + mounted suite (exists, 350+) | Our code vs our fixtures; full-loop pi via faux | `bun run verify`, every commit |
| **A. Adversarial tool-call corpus** | Hostile-but-real model behavior through the REAL pi agent loop | inside `bun run verify` |
| **B. Scripted e2e** | Real Chromium + real dev server + SCRIPTED faux model — deterministic golden paths | `bun run e2e:scripted`, pre-merge |
| **C. Agentic e2e** | Real model + real browser, user-voice objectives, harness-judged | `bun run e2e:agent`, manual |

**Process rules (all tracks):**
1. **Bug → fixture.** Every live-caught bug lands as a permanent artifact in
   the right layer: model-behavior bugs → a corpus entry (scripted faux
   sequence, dated); lifecycle bugs → a scripted spec; capability bugs → an
   agentic criterion. (The migration already seeded three: multi-round
   ghost → turn.test assertion; art-strip identity → fold.test; stale
   thread → covered by reload specs here.)
2. **Stub fidelity.** Any stub of an external service must also model its
   error/edge shapes. The faux provider satisfies this by construction — it
   runs the REAL agent loop, REAL tool validation, REAL persistence.
3. **Spec → scenario.** Feature specs name the e2e scenarios that prove their
   acceptance criteria; the plan's final task runs them.

## Track A — adversarial tool-call corpus

The v1 JSON transport is gone: no model output is parsed as JSON anywhere, so
the old corpus (`extractJson`/`repairJson`/`materializeAssistantParts`
samples) has nothing to test. The adversarial seam is now **what the model
DOES with the tools** — and the faux provider scripts exactly that through
the real loop.

`src/server/pi/adversarial.corpus.test.ts`: one table-driven suite; each
entry scripts a faux response sequence (`FauxResponseStep[]`) and asserts the
STRUCTURED turn result — `toolCalls` (validated, canonical order),
`toolErrors` (named), `reply`, and where relevant the persisted entries.
Never just "doesn't throw".

Seed entries (real classes, several already live-caught):
- off-range number args (`cost: 999`) → toolError + successful retry applies
  (exists in turn.test — moves/extends here);
- unknown field keys in `card_patch` (additionalProperties) → rejected,
  retry lands;
- wrong-type args (`cost: "five"`, `value: "yes"` on holo) → rejected;
- off-list select values (`essence: "plasma"`) → rejected (the old
  Tinker-class bug);
- invalid `layoutId`/`themeId` (unrepresentable via Literal unions) →
  rejected;
- tool-only turn with an EMPTY final reply → valid, empty reply string;
- reply-only turn (no tools) → valid;
- the same tool called twice in one turn (two patches) → both in canonical
  order;
- a huge (~50 KB) reply text → intact through persistence + rehydration;
- unicode/emoji/quote-heavy strings in args and reply → intact end-to-end
  (the old goblin-quotes class, now a non-event by construction — the corpus
  proves it stays one);
- an aborted mid-stream turn (faux abort) → incomplete status, no partial
  tool intents leak.

**Hygiene rider:** `decodePatchLenient` + `schemaFromFields` in
`src/contracts/fields.ts` are parser-era dead code (zero consumers since the
migration) — deleted with their tests as part of this track.

## Track B — scripted e2e (Playwright + scripted faux model)

**Infra (unchanged):** `@playwright/test` devDependency; config at repo root,
`testDir: 'e2e/scripted'`, `webServer` launching
`bun run dev -- --port 5198 --strictPort` with
`CARTIS_DATA_ROOT=e2e/.scratch/scripted/data`, `CARTIS_FAKE_AGENT=1`, and
`REPLICATE_API_TOKEN`/`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` stripped;
`baseURL: http://localhost:5198`. Strict port + scratch root: scripted runs
can never touch the user's live server or real data.

**The fake seam (reshaped — the centerpiece):** `CARTIS_FAKE_AGENT=1` makes
`cartisBridge()` build its `PiRuntime` with an INJECTED scripted faux
ModelRuntime (`makePiRuntime(DATA_ROOT, { modelRuntime })` — the exact seam
the unit tests already use). No fake client, no mocked transport: the REAL
agent loop, REAL card tools with typebox validation, REAL SessionManager
persistence, REAL SSE event mapping all run — only the model is scripted.

- `src/server/pi/fakeAgent.ts` (config-reachable → relative `.ts` imports):
  a single persistent `FauxResponseFactory` — pi's faux factories receive
  the conversation `Context`, so the fake reads the LAST USER MESSAGE and
  answers by DETERMINISTIC keyword rules documented in the module (tests
  phrase prompts to match):
  - `/rename (?:this card |her |him )?to '?"?([A-Za-z ]+)/i` →
    `card_patch {name}` round + a text round;
  - `save it` / `save the card` → `card_save`; `export print` →
    `card_export {target:'print'}`; `full art` → `card_set_layout`;
  - the literal trigger `INVALID_ARGS_PLEASE` → a `card_patch` round with
    `cost: 999` (validation rejects it), then an apology text round — the
    validation-failure UX (note strip, turn still lands) becomes a scripted
    browser test;
  - the literal trigger `SLOW_TURN_PLEASE` → a delayed response (the busy
    strip and Stop swap become deterministically observable);
  - default → a plain acknowledgement text round.
  Rules compose (one prompt can trigger patch + save + export + layout).
  The factory re-arms itself (`appendResponses`) so the dev server never
  runs dry. `CARTIS_MODEL` is forced to `faux/faux-model` under the flag.
- Because the loop is real, streaming (TurnStarted/PartDelta), tool chips,
  toolErrors, session files, tree branching, and rehydration are all
  genuinely exercised — the ghost/SSE-replay class, the multi-round-merge
  class, and the branch-durability class are all deterministically testable.

**Specs (~10):** deep-link reload restores card+chat with ZERO ghost
messages; back/forward across tabs incl. the dirty-guard bounce; attachment
gating (reject `.psd` with note, 6-cap, thumb remove); composer morphing
(disabled → send → busy strip + Stop via `SLOW_TURN_PLEASE` → settled);
chat turn → patch applied to the form + `EDITED` chip; save/export doc
actions → real files in the scratch data root; `card_set_layout` flips the
layout select; **edit → sibling branch → ‹ n/m › arrows → switch → RELOAD →
selection retained** (the durable-branch class, scripted); validation
failure via `INVALID_ARGS_PLEASE` → note strip, turn complete, NEVER a
crash; **render parity** — computed-style sweep of the card face across
builder and gallery-tile contexts (text-align, font-family — the UA-leak
class) plus ONE `toHaveScreenshot` baseline of the builder card face.

## Track C — agentic e2e (pi-driven)

A small, manually-triggered suite where an LLM with a **user-facing
objective** drives the real app end-to-end, and a **mechanical harness — not
the LLM — judges the outcome**. Lives under `e2e/agentic/`.

### Principles (unchanged)

1. **The driver acts; the harness judges.** Criteria are typed checks the
   runner executes; page criteria run DIRECTLY through the harness's own
   browser connection (no agent relay).
2. **Real seams.** The app's chat runs against the REAL pi runtime + real
   provider (where the bug class lives); images stay on the free stub.
3. **Isolation.** Scenarios never touch the user's `cartis-data`; the driver
   keeps NOTHING persistent.
4. **Small and manual.** Three scenarios, run by hand before merges that
   touch the chat/browser surface.

### What the migration simplified (decision record)

The original design treated pi as a NEW test-only dependency with an
unproven runtime. Pi is now the app's own production runtime, pinned exact
(0.83.0), and `scripts/pi-canary.ts` already recorded **GO under bun** — so:
- **Dependencies:** only `@modelcontextprotocol/sdk` is new (devDep, pinned
  exact); `chrome-devtools-mcp` is spawned via bunx.
- **Canary scope shrinks** to the one unproven piece: the MCP→customTools
  bridge (spawn `chrome-devtools-mcp`, list tools, wrap as pi tools, drive
  one navigation, call `evaluate_script` directly from the harness).
- **Driver model/auth:** `E2E_DRIVER_MODEL ?? CARTIS_MODEL`, same
  `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` the app uses — no second auth system.
- **No child agent:** the app's agent is in-process; teardown's orphan sweep
  is just `vite | chrome-devtools-mcp | Chrome for Testing`.

### Architecture — one owner, fewer processes

`bun run e2e:agent [scenario-id…]` (script: `e2e/agentic/runner.ts`):

1. **The app under test:** dev server spawned with
   `CARTIS_DATA_ROOT=<scratch>/data` (env override in `cartisBridge()` — the
   one `src/` change this track needs; pi session files land under
   `<scratch>/data/chats` automatically). **Dedicated strict port 5199**;
   the runner ABORTS if 5199 answers before spawn. Never 5173.
   `REPLICATE_API_TOKEN` stripped (stub art); the REAL model key kept (the
   app's agent needs it).
2. **The browser bridge (harness-owned):** an `@modelcontextprotocol/sdk`
   stdio Client to a spawned `chrome-devtools-mcp` (which launches Chrome).
   `listTools()` results wrapped as pi `customTools`; the SAME client is the
   verification channel.
3. **The driver (in-process pi):** `createAgentSession` with an in-memory
   SessionManager/settings, `customTools` = the browser tools, the preamble
   as system prompt. Loop control MECHANICAL: `AbortSignal` timeout
   (`timeoutMin`) + a turn cap (~40 tool calls). `session.subscribe()`
   streams events; the transcript is the evidence.
4. **Scenarios, sequentially:** fresh scratch + fresh dev server + fresh pi
   session + fresh MCP/Chrome per scenario.

Teardown is a `finally`: abort/dispose the session, close the MCP client
(must take Chrome down — canary proves this), kill the dev server — then
VERIFY nothing from `vite|chrome-devtools-mcp|Chrome for Testing` survived.

**Flake policy (unchanged):** DRIVER outcome (`done`/`blocked`/`timeout`)
separate from CRITERIA outcome; criteria failures are real findings — never
weaken a criterion; `--retries N` re-runs driver-failures only; final
full-page screenshot taken DIRECTLY via the MCP client.

### Scenario contract (`e2e/agentic/scenarios/*.ts`) — unchanged

```ts
export interface Scenario {
  id: string;
  title: string;
  timeoutMin: number;
  seed?: string;                    // e2e/agentic/fixtures/<name> → scratch data root
  stage?: readonly string[];        // repo-relative files → scratch stage dir
  objective: string;                // user-voice; {{APP_URL}}/{{STAGE_DIR}} templated
  constraints: readonly string[];
  criteria: readonly Criterion[];
}
export type Criterion =
  | { kind: 'fs'; label: string; check: (dataRoot: string) => boolean | Promise<boolean> }
  | { kind: 'page'; label: string; script: string; expect: (result: unknown) => boolean };
```

### Driver preamble (system prompt) — unchanged

You are a USER of the card app at `{{APP_URL}}`, driving a real browser
through the provided browser tools; act through the UI only; never read or
modify source files or data directories directly; take a snapshot before
interacting; prefer snapshots over screenshots; wait for the app's agent
turns to finish (Stop reverts to Send) before proceeding; reply exactly
`DONE: <one-paragraph summary>` when the objective is complete, or
`BLOCKED: <why>` if truly stuck.

### v1 scenarios (criteria re-grounded)

1. **`photo-card`** — stage `e2e/agentic/fixtures/subject.png` (an
   AI-generated face, no real person's likeness); objective: attach it and
   ask for a spell card called "Tinker", steampunk, funny caption, "no
   might/ward stuff". Criteria — page: name field = "Tinker"; stat shield
   absent; ≥1 `tool-card-patch` chip rendered (the change went through a
   REAL tool call); composer idle; no note strip showing a validation
   failure.
2. **`doc-powers`** — rename to "Canary Knight", save, export a print PNG,
   switch to the full-art layout — all by conversation. Criteria — fs: one
   card sidecar with the name + `chatSessionId`; a pi session file under
   `chats/` whose id matches it; export PNG > 100 KB + sidecar. page:
   layout select shows Full Art; ≥3 doc-action chips.
3. **`persistence-reload`** — send a rename turn, save, hard-reload on the
   `/builder/<id>` URL, then use the ‹ › arrows if present. Criteria — page:
   pathname matches `/builder/<id>`; conversation rehydrated; ZERO ghost
   messages before the first user bubble. fs: sidecar with `chatSessionId`.

### Output — unchanged

`e2e/runs/<ISO-stamp>/`: `report.md`, `transcript-<id>.json`, screenshots.
Verdict table printed; nonzero exit on any failure.

### Known risk — gated first

One unverified assumption (pi-under-bun is already GO): the MCP→customTools
bridge works end-to-end. The canary proves it before anything else is built:
spawn `chrome-devtools-mcp`, list tools, drive one navigation via a pi
session, call `evaluate_script` DIRECTLY from the harness, close cleanly.
STOP at the canary on failure.

For Track B, one implementation-detail assumption is canary-gated inside its
first task: a `FauxResponseFactory` receives the conversation `Context`
(typed so in 0.83.0) and `appendResponses` re-arming keeps a long-lived dev
server supplied. If either fails, the fallback seam is a hand-rolled
scripted provider registered on the injected ModelRuntime (same shape the
faux registration uses).

## Non-goals

CI wiring (all triggers manual; Track B is CI-ready by design), direct-CDP
verification, property-based fuzzing, visual pixel-diff beyond the single
builder-face baseline, parallel scenarios, Windows/Linux support beyond what
the tools provide.

## Costs

Track A: none (unit-speed; faux is free). Track B: one devDependency + a
Chromium download; tens of seconds, free — the faux model costs nothing.
Track C: minutes per run; driver + app tokens on the SAME provider key
(`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`); zero Replicate spend; local Chrome;
one new pinned devDep (`@modelcontextprotocol/sdk`).
