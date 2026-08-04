# Agentic E2E Testing — Design

**Date:** 2026-08-04
**Status:** Approved (brainstorm 2026-08-04). Standalone `bun run e2e:agent`
runner with **opencode as the driver LLM**; real opencode + stub images for
the app's own agent; scratch data root; v1 scenarios: photo-card, doc-powers,
persistence-reload.

## Why

Retrospective over the last six functional bugs: three lived at the model
seam (unescaped quotes, null-cleared fields, missing layout capability), two
in real-browser lifecycle (SSE replay ghosts), one in CSS context (UA button
centering). None were catchable by the unit/mounted suite — all were found by
an LLM manually driving the real browser. This feature formalizes that
process: a small, manually-triggered suite where an LLM with a **user-facing
objective** drives the real app end-to-end, and a **mechanical harness — not
the LLM — judges the outcome**.

## Principles

1. **The driver acts; the harness judges.** Pass/fail never rests on the
   LLM's self-assessment. Criteria are typed checks the runner executes.
2. **Real seams.** The app's chat runs against REAL opencode (where the bug
   class lives); images stay on the free stub. The browser is real Chrome.
3. **Isolation.** Scenarios never touch the user's `cartis-data` or the
   repo's project-scoped opencode sessions.
4. **Small and manual.** Three scenarios, run by hand before merges that
   touch the chat/browser surface. This complements — does not replace — the
   unit suite and `bun run verify`.

## Architecture — three processes, one owner

`bun run e2e:agent [scenario-id…]` (script: `e2e/runner.ts`) orchestrates:

1. **The app under test:** the cartis dev server spawned with
   `CARTIS_DATA_ROOT=<scratch>/data` — a NEW env override read in
   `cartisBridge()` (`process.env.CARTIS_DATA_ROOT ?? 'cartis-data'`; the
   only `src/` change). **Dedicated strict port (data safety):** the runner
   starts vite with `--port 5199 --strictPort` and ABORTS if 5199 is already
   listening BEFORE spawn. Never poll the default 5173 — the user's own dev
   server is usually running there, and connecting to it would let the driver
   LLM mutate REAL cartis-data. `APP_URL = http://localhost:5199` is threaded
   from the harness into the preamble and objectives. The scratch root is
   seeded by copying the scenario's fixture dir. The app's own agent spawns
   real opencode as usual; `REPLICATE_API_TOKEN` is STRIPPED from the child
   env so art uses the stub.
2. **The driver:** a second opencode server via the same `createOpencode`
   the app uses, with two twists:
   - its `config.mcp` attaches the **chrome-devtools MCP server**
     (`chrome-devtools-mcp` npm package, run via `bunx`; requires local
     Chrome) so the driver LLM gets real browser tools;
   - its **cwd is a scratch driver dir**, not the repo — opencode sessions
     are project-scoped, and driver sessions must never pollute the card-chat
     session list. Fixture files a scenario needs (the photo to attach) are
     staged into this dir, and objectives are TEMPLATED: the harness
     substitutes `{{APP_URL}}` and `{{STAGE_DIR}}` (absolute path) so file
     references never depend on the MCP server's cwd. The driver model is
     `E2E_DRIVER_MODEL` (falls back to `OPENCODE_MODEL`). Driver permissions
     are set permissive in config so tool calls don't block on prompts.
3. **Scenarios, sequentially** (shared strict port 5199): each is one fresh driver
   session prompted with harness preamble + objective + constraints, then a
   separate verification exchange, then teardown of state between scenarios
   (fresh scratch data root per scenario; dev server restarted per scenario —
   simplest correct isolation).

Teardown is a `finally`: abort driver sessions, close both opencode servers,
kill the dev server — and VERIFY the whole tree died, including the Chrome
instance `chrome-devtools-mcp` spawns (the canary proves close() kills it;
teardown re-checks). A per-scenario timeout (`timeoutMin`) aborts the session
and fails the scenario with its transcript.

**Flake policy (LLM drivers are nondeterministic):** every verdict separates
the DRIVER outcome (`done` / `blocked` / `timeout`) from the CRITERIA
outcome. Criteria failures are treated as real findings — never weaken a
criterion to pass. Driver failures (blocked/timeout with criteria unmet) are
retryable: `--retries N` (default 0) re-runs ONLY driver-failed scenarios.
Each scenario ends with a full-page screenshot saved into the run dir as
human-checkable evidence that it passed for the right reason.

## Scenario contract (`e2e/scenarios/*.ts`)

One TS module per scenario — typed code, no invented DSL:

```ts
export interface Scenario {
  id: string;
  title: string;
  timeoutMin: number;
  /** e2e/fixtures/<name> copied to the scratch data root before boot. */
  seed?: string;
  /** files staged into the driver's cwd (e.g. the photo to attach). */
  stage?: readonly string[];
  /** user-voice objective — the driver's prompt. */
  objective: string;
  /** hard rules, e.g. "use the chat sidebar, never the form controls". */
  constraints: readonly string[];
  criteria: readonly Criterion[];
}

export type Criterion =
  | { kind: 'fs'; label: string; check: (dataRoot: string) => boolean | Promise<boolean> }
  | { kind: 'page'; label: string; script: string; expect: (result: unknown) => boolean };
```

- **`fs` criteria** run directly in the runner against the scratch data root
  (card sidecar exists with expected fields, export PNG > threshold,
  `chatSessionId` present). Fully deterministic.
- **`page` criteria** are FIXED JS snippets. After the driver reports done,
  the harness sends one verification prompt: "execute each snippet verbatim
  with your evaluate tool; return the results as one fenced JSON array, in
  order, no commentary." The runner parses the last fenced JSON block and
  applies each `expect`. Fixed snippets + raw JSON keep judgment mechanical;
  the known trust caveat (the relay runs through the agent) is accepted for
  v1, with direct-CDP verification noted as v2 hardening.

Unparseable verification reply → one retry of the verification prompt → fail
the scenario's page criteria with the raw reply as evidence.

## Harness preamble (driver prompt contract)

Prepended to every objective: you are a USER of the card app at
`{{APP_URL}}` driving a browser via the chrome-devtools tools; act
through the UI only; never read or modify source files or the data directory
directly; take a snapshot before interacting; prefer snapshots over
screenshots; wait for the app's agent turns to finish (Stop button reverts to
Send) before proceeding; when the objective is complete reply exactly
`DONE: <one-paragraph summary>`; if truly blocked reply
`BLOCKED: <why>`. Step budget: keep it under ~40 tool calls.

## v1 scenarios

1. **`photo-card`** — stage a fixture photo; objective: attach it and ask for
   a spell card called "Tinker", steampunk, funny caption, "no might/ward
   stuff" (the reproduced killer). Criteria: fs — none required (unsaved);
   page — name field = "Tinker"; chat panel contains NO `"reply"` raw-JSON
   blob; stats hidden on the preview (no might/ward shield); composer idle.
2. **`doc-powers`** — objective: rename the card, save it, export a print
   PNG, and switch to the full-art layout — all by conversation. Criteria:
   fs — exactly one card sidecar with the new name + `chatSessionId`; one
   export sidecar + PNG > 100 KB. page — layout select shows Full Art;
   `card_settings`/`card_save`/`card_export` chips present; document bar says
   Saved (before the layout switch marks dirty — criterion checks chips, not
   the dirty flag).
3. **`persistence-reload`** — seed: a fixture card WITH a real chat history
   is impossible to seed (sessions live in opencode), so the scenario builds
   it: send one chat turn, save, note the URL; hard-reload; go back and
   forward. Criteria: page — URL is `/builder/<id>` after reload; the chat
   shows the earlier conversation (its reply text present); ZERO ghost
   messages before the first user bubble; back lands on `/builder` or
   `/gallery` per history and forward returns.

## Output

Each run writes `e2e/runs/<ISO-stamp>/` (gitignored): `report.md` with a
per-scenario, per-criterion ✓/✗ table + evidence (fs paths, page-criterion
raw results, `DONE`/`BLOCKED` summaries), plus each driver session's full
message dump (via `session.messages`) as `transcript-<id>.json`. The runner
prints the verdict table and exits nonzero on any failure.

## Known risk — gated first

Whether `createOpencode({ config })` accepts an `mcp` block (and the session
can actually call a browser tool) is unverified. Plan task 1 is a CANARY
proving it; fallback: write an `opencode.json` into the driver's scratch cwd
before spawn (opencode reads project config from cwd). If neither exposes
MCP tools, STOP and redesign the driver's tool surface — do not build around
a broken assumption.

## Non-goals

CI integration (manual trigger only), the fake-agent bridge stub,
direct-CDP verification, visual pixel-diff parity, parallel scenarios,
Windows/Linux support beyond what `bunx chrome-devtools-mcp` provides.

**Scripted deterministic e2e is a deliberate SEPARATE track** (companion
spec, after this lands): a small Playwright suite driving the same
`CARTIS_DATA_ROOT`-isolated app with a scripted fake-agent bridge stub —
fast, deterministic, CI-able coverage of the golden paths (routing/reload,
attachment gating, composer states, render parity). The layering: unit suite
(fast, every commit) → scripted e2e (deterministic, pre-merge) → agentic e2e
(real model seam + user-goal accomplishment, manual). This spec is the third
layer only.

## Costs

Each run: minutes of wall clock (3 scenarios × real model turns), opencode
account tokens for driver + app agent, zero Replicate spend. Chrome must be
installed locally.
