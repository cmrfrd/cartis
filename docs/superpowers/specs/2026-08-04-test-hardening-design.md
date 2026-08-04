# Test & E2E Hardening — Design

**Date:** 2026-08-04
**Status:** Approved. Expanded from the original agentic-e2e design (user
request 2026-08-04) into a three-track hardening initiative:
**A** adversarial model-output corpus, **B** scripted Playwright e2e with a
fake-agent seam (including render parity), **C** agentic e2e (pi-driven
browser scenarios; the driver was originally designed on opencode and
switched to pi's in-process SDK after a research spike — 2026-08-04).
Property-based fuzzing was considered and explicitly skipped (marginal over
Track A).

## Why

Retrospective over the last six functional bugs: three lived at the model
seam (unescaped quotes, null-cleared fields, missing layout capability), two
in real-browser lifecycle (SSE replay ghosts), one in CSS context (UA button
centering). None were catchable by the unit/mounted suite — all were found by
an LLM manually driving the real browser, or by users. This initiative turns
each discovery mode into a permanent, repeatable layer.

## The layered strategy

| Layer | What | Speed / trigger |
|---|---|---|
| Unit + mounted suite (exists, 390+) | Our code vs our fixtures | `bun run verify`, every commit |
| **A. Adversarial corpus** | Hostile-but-real model replies through the full parse pipeline | inside `bun run verify` |
| **B. Scripted e2e** | Real Chromium + real dev server + FAKE agent — deterministic golden paths | `bun run e2e:scripted`, pre-merge |
| **C. Agentic e2e** | Real model + real browser, user-voice objectives, harness-judged | `bun run e2e:agent`, manual |

**Process rules (all tracks):**
1. **Bug → fixture.** Every live-caught bug lands as a permanent artifact in
   the right layer: model-output bugs → a corpus entry (verbatim sample,
   dated); lifecycle bugs → a scripted spec; capability bugs → an agentic
   criterion.
2. **Stub fidelity.** Any stub of an external service must also model its
   error/edge shapes (the ghost-siblings bug was a stub that only succeeded).
3. **Spec → scenario.** Feature specs name the e2e scenarios that prove their
   acceptance criteria; the plan's final task runs them.

## Track A — adversarial model-output corpus

`src/contracts/modelOutput.corpus.test.ts`: one table-driven suite running
raw model replies through the REAL pipeline (`extractJson` → `repairJson` →
contract decode → `materializeAssistantParts`, and `decodePatchLenient` for
patches). Each entry: `{ name, raw, expect }` where `expect` asserts reply
text, part tags, patch keys applied, keys dropped, actions decoded — never
just "doesn't throw".

Seed entries (all real classes we shipped bugs on): unescaped inner quotes in
string values (goblin-engineer sample verbatim); null-cleared fields +
off-list enums (Tinker class); fenced ```json blocks; prose preamble before
JSON; trailing commas; unbalanced braces (reply-salvage path, no raw blob);
plain-text conversational reply; empty contract `{}`; mistyped `actions`
entries among valid ones; settings knobs. Process rule 1 appends every future
live-caught sample verbatim with a date comment.

## Track B — scripted e2e (Playwright + fake agent)

**Infra:** `@playwright/test` as a devDependency (+ `bunx playwright install
chromium` once). `playwright.config.ts` at the repo root, `testDir:
'e2e/scripted'`, and a `webServer` block launching
`bun run dev -- --port 5198 --strictPort` with
`CARTIS_DATA_ROOT=e2e/.scratch/scripted/data`, `CARTIS_FAKE_AGENT=1`, and
`REPLICATE_API_TOKEN` stripped; `baseURL: http://localhost:5198`. Strict port
+ scratch root: scripted runs can never touch the user's live server or real
data (same safety rule as Track C, different port so the tracks coexist).

**The fake-agent seam** (the centerpiece): `CARTIS_FAKE_AGENT=1` makes the
bridge provide `agentClientFake` (new `src/server/agentFake.ts`,
config-reachable → relative `.ts` imports) instead of `agentClientLive`. The
fake is an in-memory opencode:

- Sessions/messages in Maps; `prompt()` STORES the full rich prompt text it
  receives — so `USER_REQUEST_MARKER` stripping and history rehydration are
  exercised for real, not mocked around.
- Replies come from DETERMINISTIC keyword rules documented in the module
  (tests phrase prompts to match): "rename … to X" → `{reply, patch:{name:X}}`;
  "save" / "export print" / "full art" → the matching doc actions; a dedicated
  trigger phrase returns the goblin-class MALFORMED blob (so the JSON-repair
  path is a scripted browser test); default → a plain acknowledgement.
- `withActivity` drives the REAL ThreadBus (TurnStarted/PartDelta/
  TurnCompleted) so the SSE stream, fold, and replay lifecycle are genuinely
  exercised — the ghost-bug class becomes deterministically testable.
- Session ops (`fork`/`revert`/`children`/`info`/`abort`) get minimal honest
  in-memory semantics, INCLUDING error shapes for unknown ids (process rule 2).

**Specs (~9):** deep-link reload restores card+chat with ZERO ghost messages;
back/forward across tabs incl. the dirty-guard bounce; attachment gating
(reject `.psd` with note, 6-cap, thumb remove); composer morphing
(disabled → send → stop); chat turn → patch applied to the form + chips
rendered; save/export doc actions → real files in the scratch data root;
`setLayout` knob flips the layout select; malformed-model turn → repaired or
honest error, NEVER a raw JSON blob; **render parity** — computed-style sweep
of the card face across builder and gallery-tile contexts (text-align,
font-family — the UA-leak class) plus ONE `toHaveScreenshot` baseline of the
builder card face.

## Track C — agentic e2e (pi-driven)

A small, manually-triggered suite where an LLM with a **user-facing
objective** drives the real app end-to-end, and a **mechanical harness — not
the LLM — judges the outcome**. Lives under `e2e/agentic/`.

### Principles

1. **The driver acts; the harness judges.** Pass/fail never rests on the
   LLM's self-assessment. Criteria are typed checks the runner executes —
   and with the pi design, page criteria run DIRECTLY through the harness's
   own browser connection (no agent relay at all).
2. **Real seams.** The app's chat runs against REAL opencode (where the bug
   class lives); images stay on the free stub. The browser is real Chrome.
3. **Isolation.** Scenarios never touch the user's `cartis-data`; the driver
   keeps NOTHING persistent (in-memory sessions, settings, credentials).
4. **Small and manual.** Three scenarios, run by hand before merges that
   touch the chat/browser surface.

### Why pi (decision record)

The original design spawned a second opencode server as the driver. A
research spike (2026-08-04) showed `@earendil-works/pi-coding-agent` ships a
real embeddable SDK — `createAgentSession()` runs the agent loop IN-PROCESS
(prompt/abort/subscribe/messages), which deletes the driver child process,
its port, the HTTP client, and the cwd/session-pollution concern (in-memory
`SessionManager`). Decisive extra: because the HARNESS owns the browser MCP
client, verification snippets execute mechanically through the same
connection — the fenced-JSON agent-relay (and its trust caveat) is gone.
The app's runtime stays opencode (unchanged); pi is the TEST DRIVER only.
Costs accepted: `@earendil-works/pi-coding-agent` + `@modelcontextprotocol/sdk`
as devDeps PINNED EXACT (pi is v0.x with breaking minors); pi auth is
separate from opencode auth (`ANTHROPIC_API_KEY` or `pi` OAuth login —
subscription usage bills as extra usage); pi targets node ≥ 22, bun is
secondary — the canary gates bun compatibility.

### Architecture — one owner, fewer processes

`bun run e2e:agent [scenario-id…]` (script: `e2e/agentic/runner.ts`):

1. **The app under test:** the dev server spawned with
   `CARTIS_DATA_ROOT=<scratch>/data` (env override in `cartisBridge()`).
   **Dedicated strict port (data safety):** vite runs with
   `--port 5199 --strictPort`; the runner ABORTS if 5199 answers BEFORE
   spawn. Never 5173 — the user's own server (and REAL data) is usually
   there. `APP_URL = http://localhost:5199`. Scratch root seeded from the
   scenario's fixture dir; `REPLICATE_API_TOKEN` stripped (stub art). The
   app's agent spawns its own opencode child as in production.
2. **The browser bridge (harness-owned):** the runner connects an
   `@modelcontextprotocol/sdk` stdio Client to a spawned
   `chrome-devtools-mcp` process (which launches Chrome). `listTools()`
   results are wrapped as pi `customTools` (`defineTool` per tool; image
   results flow as pi `ImageContent` — pi normalizes oversized screenshots).
   The SAME client is the verification channel.
3. **The driver (in-process pi):** `createAgentSession({ customTools:
   browserTools, sessionManager: SessionManager.inMemory(), … })` with the
   preamble as system prompt, model `E2E_DRIVER_MODEL ?? OPENCODE_MODEL`
   mapped through pi's model catalog. Loop control is MECHANICAL:
   `AbortSignal`-based timeout (`timeoutMin`) plus a `shouldStopAfterTurn`
   turn cap (~40 tool calls) — budget is enforced, not just requested.
   `session.subscribe()` streams every event; the transcript is captured
   natively as evidence. Staged fixture files live in a scratch stage dir;
   objectives are TEMPLATED (`{{APP_URL}}`, `{{STAGE_DIR}}` absolute).
4. **Scenarios, sequentially:** fresh scratch data root + fresh dev server +
   fresh pi session + fresh MCP/Chrome per scenario.

Teardown is a `finally`: `session.abort()`/`dispose()`, close the MCP client
(must take Chrome down with it — canary proves this), kill the dev server —
then VERIFY nothing from `vite|opencode serve|chrome-devtools-mcp|Chrome for
Testing` survived.

**Flake policy:** every verdict separates the DRIVER outcome
(`done`/`blocked`/`timeout`) from the CRITERIA outcome. Criteria failures are
real findings — never weaken a criterion to pass. Driver failures are
retryable via `--retries N` (default 0), re-running ONLY driver-failed
scenarios. The harness takes a final full-page screenshot DIRECTLY via the
MCP client into the run dir as passed-for-the-right-reason evidence.

### Scenario contract (`e2e/agentic/scenarios/*.ts`)

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

`fs` criteria run directly in the runner against the scratch data root.
`page` criteria run DIRECTLY too: after the driver settles, the harness calls
the MCP `evaluate_script` tool itself with each fixed snippet and applies
`expect` to the raw result. No agent relay, no fenced-JSON parsing, no trust
caveat — verification is fully mechanical by construction.

### Driver preamble (system prompt)

You are a USER of the card app at `{{APP_URL}}`, driving a real browser
through the provided browser tools; act through the UI only; never read or
modify source files or data directories directly; take a snapshot before
interacting; prefer snapshots over screenshots; wait for the app's agent
turns to finish (Stop reverts to Send) before proceeding; reply exactly
`DONE: <one-paragraph summary>` when the objective is complete, or
`BLOCKED: <why>` if truly stuck. (The tool-call budget is enforced by the
harness turn cap, not by instruction alone.)

### v1 scenarios

1. **`photo-card`** — stage `e2e/agentic/fixtures/subject.png` (an
   AI-generated face of a person who does not exist, downloaded once from
   thispersondoesnotexist.com and committed — no real person's likeness in
   the repo; a realistic face exercises the vision seam, unlike noise);
   objective: attach it and ask for a spell card called "Tinker", steampunk,
   funny caption, "no might/ward stuff" (the reproduced killer). Criteria —
   page: name field = "Tinker"; NO raw `"reply"` blob in the chat; stat
   shield absent; composer idle.
2. **`doc-powers`** — rename to "Canary Knight", save, export a print PNG,
   and switch to the full-art layout — all by conversation. Criteria — fs:
   one card sidecar with the name + `chatSessionId`; export PNG > 100 KB +
   sidecar. page: layout select shows Full Art; ≥3 doc-action chips.
3. **`persistence-reload`** — send a rename turn, save, hard-reload on the
   `/builder/<id>` URL, then back/forward. Criteria — page: pathname matches
   `/builder/<id>`; conversation rehydrated; ZERO ghost messages before the
   first user bubble. fs: sidecar with `chatSessionId`.

### Output

`e2e/runs/<ISO-stamp>/`: `report.md` (per-scenario × per-criterion ✓/✗ table
with evidence + driver outcome), `transcript-<id>.json` (the captured
`subscribe()` event stream + final `session.messages`), final screenshots.
Verdict table printed; nonzero exit on any failure.

### Known risk — gated first

Two unverified assumptions, proven by the canary before anything else is
built: (1) the pi SDK (`createAgentSession`) runs under BUN (pi targets
node ≥ 22; bun is secondary) — fallback: run the agentic runner under
`node`; (2) the MCP→customTools bridge works end-to-end (spawn
`chrome-devtools-mcp`, list tools, drive one navigation via a pi session,
and call `evaluate_script` DIRECTLY from the harness). If pi proves
unworkable, the documented fallback is the previous opencode-driver design
(preserved in git history of this spec). Either way: STOP at the canary on
failure — never build the runner on an unproven driver.

## Non-goals

CI wiring (all triggers manual for now; Track B is CI-ready by design),
direct-CDP verification, property-based fuzzing (explicitly skipped), visual
pixel-diff beyond the single builder-face baseline, parallel scenarios,
Windows/Linux support beyond what the tools provide.

## Costs

Track A: none (unit-speed). Track B: one devDependency + a Chromium
download; runs in tens of seconds, free. Track C: minutes per run; DRIVER
tokens via pi auth (`ANTHROPIC_API_KEY` or Claude subscription as
extra-usage billing) + APP-agent tokens via the existing opencode account;
zero Replicate spend; local Chrome required; two pinned devDeps
(`@earendil-works/pi-coding-agent`, `@modelcontextprotocol/sdk`).
