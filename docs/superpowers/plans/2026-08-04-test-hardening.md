# Test & E2E Hardening Implementation Plan (revised for the pi runtime)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three hardening tracks per `docs/superpowers/specs/2026-08-04-test-hardening-design.md` (REVISED post-pi-migration): **A** adversarial tool-call corpus through the real pi loop (unit-speed), **B** scripted Playwright e2e on a scripted-faux-model seam incl. render parity (`bun run e2e:scripted`), **C** agentic e2e — an in-process pi driver LLM drives real Chrome to user-voice objectives, harness-judged (`bun run e2e:agent`).

**Architecture:** Track A is one table-driven vitest file scripting `FauxResponseStep[]` sequences through `runTurn` (the seam `src/server/pi/turn.test.ts` already uses). Track B gates `CARTIS_FAKE_AGENT=1` inside `cartisBridge()` to build `makePiRuntime(DATA_ROOT, { modelRuntime: fakeAgentRuntime() })` — a persistent context-reading `FauxResponseFactory` with keyword rules; the REAL agent loop/tools/persistence/SSE run underneath Playwright with a strict-port scratch-root webServer. Track C: one runner owns the dev server (scratch `CARTIS_DATA_ROOT`, strict port 5199), a harness-owned MCP client to a spawned `chrome-devtools-mcp` (Chrome), and an IN-PROCESS pi `createAgentSession` driver whose customTools wrap the MCP tools; `fs` criteria run in the runner, `page` criteria run DIRECTLY via the harness's own MCP `evaluate_script` calls.

**Tech Stack:** vitest + `src/server/pi/faux.ts` (A), `@playwright/test` + Chromium (B), `@earendil-works/pi-coding-agent` 0.83.0 (already a prod dep, pinned exact) + `@modelcontextprotocol/sdk` (new devDep, pinned exact) + `chrome-devtools-mcp` via bunx (C).

## Global Constraints

- **Task order:** Track A first (independent, immediate value). Track C's canary (Task 2) gates Tasks 3–5. Track B (Tasks 6–8) is independent of C.
- `src/` changes are EXACTLY: (1) `agentBridge.ts` `DATA_ROOT` → `process.env.CARTIS_DATA_ROOT ?? 'cartis-data'`; (2) the Track-B fake seam: new `src/server/pi/fakeAgent.ts` + the env-gated ModelRuntime injection where `cartisBridge()` calls `makePiRuntime`, and forcing `CARTIS_MODEL='faux/faux-model'` under the flag; (3) Track A's hygiene rider: DELETE `decodePatchLenient` + `schemaFromFields` from `src/contracts/fields.ts` and their tests (zero consumers since the migration — verify with grep first). All config-reachable files keep relative `.ts` imports, no `@/`.
- **Strict ports (data safety):** scripted = 5198, agentic = 5199, both `--strictPort`, pre-flight ABORT if the port already answers. NEVER 5173 — the user's live server (and REAL data) is usually there. `REPLICATE_API_TOKEN` stripped from all child envs; Track B ALSO strips `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` (the faux model needs no key); Track C KEEPS the model key (the app's real agent needs it).
- Track C driver = the SAME pi 0.83.0 the app ships; only `@modelcontextprotocol/sdk` is added (devDep, `--exact`). Driver state all in-memory. Objectives TEMPLATED (`{{APP_URL}}`, `{{STAGE_DIR}}` absolute); driver model `E2E_DRIVER_MODEL ?? CARTIS_MODEL`; auth = the same `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` the app uses. No `agentBridge.ts` import in e2e.
- Track C verdicts separate DRIVER outcome (done/blocked/timeout) from CRITERIA outcome; `--retries N` (default 0) re-runs driver-failures only; never weaken a criterion to pass; final full-page screenshot per scenario via the harness's own MCP call.
- Sequential scenarios; `rm -rf` + recreate scratch dirs per scenario; teardown VERIFIES the tree died (`vite|chrome-devtools-mcp|Chrome for Testing` — the app has NO child agent anymore).
- Pass/fail comes ONLY from `Criterion` checks (C) / Playwright assertions (B). Driver `DONE`/`BLOCKED` text is evidence, never a verdict.
- Loop control is MECHANICAL: `AbortSignal`-based `timeoutMin` + a turn cap (~40 tool calls).
- `bun run verify` green per task and must NOT run Playwright (`e2e/scripted` uses `*.spec.ts`; vitest matches `*.test.*` — no conflict). Add `"e2e"` to `tsconfig.json` include; biome covers `e2e/`; `.gitignore` += `e2e/runs/`, `e2e/.scratch/`, `test-results/`, `playwright-report/`.
- pi 0.83.0 facts (verified in-repo): `createAgentSession({ customTools, sessionManager, settingsManager, modelRuntime, resourceLoader, … })`; `session.prompt/abort/subscribe/dispose`; faux seam = `createFauxCore` + `registerProvider` (see `src/server/pi/faux.ts`); `FauxResponseFactory = (context, options, state, model) => AssistantMessage` — the factory RECEIVES the conversation Context (canary-gate the assumption that `context.messages` carries the user turn); `setResponses`/`appendResponses` consume one step per model call.
- Commits end `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Branch `feat/test-hardening`; `bun run verify` green per task; ff-merge + push + delete at end.

---

## Track A

### Task 1: Adversarial tool-call corpus + parser-era hygiene

**Files:** Create `src/server/pi/adversarial.corpus.test.ts`. Modify `src/contracts/fields.ts` (delete `decodePatchLenient`, `schemaFromFields`), `src/contracts/fields.test.ts` (delete their suites).

**Interfaces:** Consumes (existing): `fauxRuntime`, `fauxAssistantMessage`, `fauxToolCall`, `fauxText` from `./faux`; `makePiRuntime` from `./runtime`; `runTurn` from `./turn` — exactly as `turn.test.ts` does.

- [ ] **Step 1: hygiene grep.** `grep -rn 'decodePatchLenient\|schemaFromFields' src` → only fields.ts + fields.test.ts. Delete both exports + their test suites. `bun run verify` green.
- [ ] **Step 2: the table.** `interface CorpusEntry { name: string; caught?: string; responses: FauxResponseStep[]; req?: Partial<ChatTurnRequestT>; expect: (out: TurnResult) => void; }` — one `describe` iterating entries, each running `runTurn` against a fresh faux-injected runtime (same beforeAll shape as turn.test.ts). Header comment: **the bug→fixture rule — every live-caught model behavior is appended as a scripted sequence with a date.**
- [ ] **Step 3: seed 11 entries** (from the spec §Track A): off-range retry (`cost:999` → toolError + `cost:5` applies, `caught: '2026-08-03'` — the Tinker class); unknown patch key (additionalProperties) → rejected + retry; wrong-type args; off-list select value; tool-only turn / empty reply; reply-only turn; double patch in canonical order; ~50 KB reply intact through `mapSessionEntries` rehydration; unicode/quote-heavy strings intact end-to-end (`caught: '2026-08-03'` — the goblin class, now structural); `card_set_layout` with a valid Literal id records the intent; aborted mid-turn (a faux factory that calls `session.abort()` via a hook or a never-resolving step + external abort — if unworkable, assert the wall-clock timeout path instead and note it).
- [ ] **Step 4:** run the file; `bun run verify` green; commit `test(pi): adversarial tool-call corpus (bug→fixture home) + parser-era hygiene`.

## Track C — agentic e2e (pi-driven)

### Task 2: Canary — MCP browser bridge + `CARTIS_DATA_ROOT`

**Files:** Create `e2e/agentic/browser.ts`, `e2e/agentic/driver.ts`, `e2e/agentic/canary.ts`. Modify `src/server/agentBridge.ts` (DATA_ROOT env override), `package.json` (devDep `@modelcontextprotocol/sdk` pinned exact), `tsconfig.json` (include `e2e`), `.gitignore`.

**Interfaces (produces):**
```ts
// e2e/agentic/browser.ts — the harness-owned browser connection
export interface Browser {
  call(tool: string, args: Record<string, unknown>): Promise<unknown>; // verification channel
  tools: AnyTool[];                                                    // pi customTools (driver channel)
  close(): Promise<void>;                                              // must take chrome-devtools-mcp AND Chrome down
}
export async function connectBrowser(): Promise<Browser>;

// e2e/agentic/driver.ts
export interface DriverRun { reply: string; outcome: 'done' | 'blocked' | 'timeout'; events: unknown[] }
export async function runDriver(browser: Browser, systemPrompt: string, objective: string, timeoutMin: number): Promise<DriverRun>;
export const APP_URL = 'http://localhost:5199';
```

- [ ] **Step 1: bridge env override** — `const DATA_ROOT = process.env.CARTIS_DATA_ROOT ?? 'cartis-data';` + comment. Prove BOTH ways on port 5199 (`--strictPort`): with the env → `[]` from `/api/store/cards` + the scratch dir (incl. `chats/`) created on first use; without → real cards. Kill the server.
- [ ] **Step 2: deps + bridge.** `bun add -d --exact @modelcontextprotocol/sdk`. `connectBrowser()`: `new Client(...)` + `StdioClientTransport({ command: 'bunx', args: ['chrome-devtools-mcp@latest'] })`, `listTools()`, map each tool to a pi tool object (same `AnyTool` shape as `src/server/pi/cardTools.ts` — name/description/parameters passthrough, `execute` forwards to `client.callTool`, image payloads → pi image content); `call()` invokes `client.callTool` directly; `close()` closes the transport and verifies the child died.
- [ ] **Step 3: driver factory.** `runDriver`: reuse the app's own pi: `ModelRuntime.create` with `InMemoryCredentialStore` seeded from `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`; `createAgentSession` with an in-memory SessionManager + `SettingsManager.inMemory`, `customTools: browser.tools`, model from `E2E_DRIVER_MODEL ?? CARTIS_MODEL` via `parseModelRef`-style split; subscribe→collect events; turn cap ~40 tool calls; `AbortSignal.timeout(timeoutMin * 60_000)` → 'timeout'; trailing `DONE:`/`BLOCKED:` → outcome.
- [ ] **Step 4: canary run.** `bun e2e/agentic/canary.ts`: connectBrowser → runDriver(minimal system prompt, *"Navigate to https://example.com and reply DONE: followed by the page's h1 text."*, 3) → reply contains "Example Domain"; then the DIRECT channel: `browser.call('evaluate_script', { function: '() => document.querySelector("h1")?.textContent' })` → "Example Domain" WITHOUT the agent. `browser.close()` → `pgrep -fl 'chrome-devtools-mcp'` empty + no Chrome-for-Testing leftover. **GO/NO-GO recorded atop browser.ts.** STOP on failure.
- [ ] **Step 5:** `bun run verify` green; commit `feat(e2e): MCP browser bridge canary + in-process pi driver + CARTIS_DATA_ROOT override`.

### Task 3: Scenario contract + runner lifecycle (smoke)

**Files:** Create `e2e/agentic/types.ts`, `e2e/agentic/runner.ts`, `e2e/agentic/scenarios/{index,smoke}.ts`. Modify `e2e/agentic/driver.ts` (PREAMBLE + templating), `package.json` (`"e2e:agent": "bun e2e/agentic/runner.ts"`).

**Interfaces (produces):**
```ts
// e2e/agentic/types.ts — verbatim from the spec §Scenario contract
export interface Scenario { id: string; title: string; timeoutMin: number; seed?: string; stage?: readonly string[]; objective: string; constraints: readonly string[]; criteria: readonly Criterion[]; }
export type Criterion =
  | { kind: 'fs'; label: string; check: (dataRoot: string) => boolean | Promise<boolean> }
  | { kind: 'page'; label: string; script: string; expect: (result: unknown) => boolean };
// driver.ts additions
export const PREAMBLE: string;
export function template(text: string, vars: { APP_URL: string; STAGE_DIR: string }): string;
```

- [ ] **Step 1: PREAMBLE (exact, as pi system prompt):** *"You are a USER of the Cartis card app at {{APP_URL}}, driving a real browser through the provided browser tools. Act ONLY through the UI — never read or modify source files or data directories directly. Take a page snapshot before interacting. Prefer snapshots over screenshots. The app has its own AI: after sending a chat message, WAIT until its Stop button reverts to Send before your next action. When the objective is complete, reply exactly `DONE: <one-paragraph summary>`. If truly blocked, reply `BLOCKED: <why>`."*
- [ ] **Step 2: runner lifecycle.** argv: ids (default all) + `--retries N`. PRE-FLIGHT: anything answering on 5199 → abort "port busy". Per scenario: (1) `rm -rf`+create `e2e/.scratch/<id>/{data,stage}`, copy seed/staged; (2) `Bun.spawn(['bun','run','dev','--','--port','5199','--strictPort'], { env: {...process.env, CARTIS_DATA_ROOT: dataRoot, REPLICATE_API_TOKEN: undefined} })` (model key KEPT), poll `${APP_URL}/builder`→200 (30s); (3) `connectBrowser()` → `runDriver(browser, template(PREAMBLE, vars), template(objective+constraints, vars), timeoutMin)`; (4) Task-4 verdicts; driver-failure + retries left → full teardown + re-run; (5) `finally`: write transcript, `browser.close()`, kill dev server, wait 5199 free, assert no orphan `vite|chrome-devtools-mcp`. Nonzero exit on any failure.
- [ ] **Step 3: smoke.** `{ id: 'smoke', timeoutMin: 3, objective: 'Navigate to {{APP_URL}}/builder and confirm the app is showing.', constraints: [], criteria: [{ kind: 'page', label: 'builder heading', script: '() => document.querySelector("h1")?.textContent ?? null', expect: (r) => r === 'CARTIS' }] }`.
- [ ] **Step 4:** `bun run e2e:agent smoke` — boots scratch, drives, `DONE:` printed, teardown clean.
- [ ] **Step 5:** verify green; commit `feat(e2e): agentic scenario contract + runner lifecycle (smoke)`.

### Task 4: Verdicts — direct criteria execution, report, exit code

**Files:** Modify `e2e/agentic/runner.ts` (judge + report).

**Interfaces (produces):**
```ts
export interface Verdict { scenario: string; driverOutcome: 'done' | 'blocked' | 'timeout'; results: { label: string; pass: boolean; evidence: string }[]; driverReply: string; }
```

- [ ] **Step 1:** fs criteria: `await c.check(dataRoot)` in try/catch (catch = fail, error as evidence). Page criteria: `browser.call('evaluate_script', { function: c.script })` DIRECTLY, unwrap the MCP result payload, apply `expect`, raw result as evidence. Blocked/timeout runs criteria anyway, flagged. Final screenshot: `browser.call('take_screenshot', …)` into the run dir.
- [ ] **Step 2: report.** `e2e/runs/<ISO-stamp>/report.md`: verdict table (scenario × criterion ✓/✗ + evidence + driver outcome), `transcript-<id>.json`, screenshots. Print table; `process.exitCode = 1` on any ✗.
- [ ] **Step 3:** smoke → ✓; flip expectation → ✗ + exit 1; restore.
- [ ] **Step 4:** verify green; commit `feat(e2e): mechanical verdicts — direct MCP page criteria, report, exit codes`.

### Task 5: The three v1 scenarios + fixtures

**Files:** Create `e2e/agentic/scenarios/{photo-card,doc-powers,persistence-reload}.ts`, `e2e/agentic/fixtures/subject.png` (downloaded ONCE from https://thispersondoesnotexist.com — an AI-generated face, committed; no real likeness); update `scenarios/index.ts`.

- [ ] **Step 1: photo-card.** `timeoutMin: 8`; `stage: ['e2e/agentic/fixtures/subject.png']`; objective: *"There is a photo at {{STAGE_DIR}}/subject.png. In the card app, attach that photo in the chat sidebar and ask the assistant to make the card a spell card called 'Tinker' in a steampunk style featuring the person in the photo, with a funny caption and no might/ward stuff. Wait for it to finish."* Constraints: chat sidebar ONLY; do not save. Criteria — page: name input value `=== 'Tinker'`; stat shield absent (IMPLEMENTER: take the real selector from `ArcaneStatBadge`, record it in the scenario file); ≥1 `[data-testid="tool-card-patch"]` chip; `[data-testid="composer-send"]` present (settled); no `[data-testid="note-strip"]` showing `failed validation`.
- [ ] **Step 2: doc-powers.** `timeoutMin: 10`; objective: *"In the chat sidebar, ask the assistant — in one or several messages — to rename the card to 'Canary Knight', save it, export a print PNG, and switch to the full art layout. Wait for each reply."* Criteria — fs: exactly one `cards/*.json` with `name === 'Canary Knight'` + `chatSessionId`; a `chats/*_<chatSessionId>.jsonl` session file exists; ≥1 `exports/*.png` > 100 KB + sidecar. page: LAYOUT select displays `Full Art`; `[data-testid="tool-doc-action"]` count ≥ 3.
- [ ] **Step 3: persistence-reload.** `timeoutMin: 8`; objective: *"Send the chat message 'rename this card to Reload Probe' and wait for the reply. Click Save in the document bar. Note the URL. Reload the page (navigate to the same URL again). Then confirm what you see."* Criteria — page: `location.pathname` matches `^/builder/[0-9a-f-]+$`; chat contains `'Reload Probe'`; ghost check: first `.group` in the chat panel contains the user's own text, `groups.length >= 2`. fs: sidecar named `Reload Probe` with `chatSessionId`.
- [ ] **Step 4:** run each individually; iterate until passing for the RIGHT reason (inspect evidence + final.png). Failures from REAL app bugs: file/fix separately — never weaken criteria.
- [ ] **Step 5:** verify green; commit `feat(e2e): photo-card, doc-powers, persistence-reload scenarios`.

## Track B — scripted e2e

### Task 6: Scripted fake-agent seam (`fakeAgent.ts` — faux ModelRuntime)

**Files:** Create `src/server/pi/fakeAgent.ts` + `src/server/pi/fakeAgent.test.ts`. Modify `src/server/agentBridge.ts` (where `configureServer` builds the pi runtime).

**Interfaces (produces):**
```ts
// src/server/pi/fakeAgent.ts — config-reachable (relative .ts imports)
/** Scripted faux ModelRuntime for CARTIS_FAKE_AGENT=1: a persistent
 * context-reading response factory with the keyword rules below.
 * Under the flag the bridge forces CARTIS_MODEL='faux/faux-model'. */
export async function fakeAgentRuntime(): Promise<ModelRuntime>;
```
Keyword rules (documented in the module header; rules COMPOSE — one prompt may produce patch + save + export + layout rounds, each a `stopReason:'toolUse'` AssistantMessage, then one final text round):
- `/rename (?:this card |her |him )?to '?"?([A-Za-z ]+)/i` → `card_patch {name:$1}`;
- `save it` / `save the card` → `card_save {}`; `export print` → `card_export {target:'print'}`; `full art` → `card_set_layout {layoutId:'fullart'}`;
- literal `INVALID_ARGS_PLEASE` → `card_patch {cost:999}` round (validation REJECTS it), then a text apology round;
- literal `SLOW_TURN_PLEASE` → a factory step that awaits ~1500ms before the text round;
- default → one text acknowledgement round.
The factory reads the LAST user message from the faux `Context`; it re-arms itself via `appendResponses` after each consumption (canary-gate BOTH assumptions in the unit test FIRST — if `Context` lacks messages, fall back to a hand-rolled provider registration on the injected ModelRuntime).

- [ ] **Step 1: unit tests first** (`fakeAgent.test.ts`, full-loop like turn.test.ts — `makePiRuntime(root, { modelRuntime: await fakeAgentRuntime() })`): rename prompt → `toolCalls` carries the extracted name + reply text; composed `rename … save it and export print, full art` → 4 intents in canonical order; `INVALID_ARGS_PLEASE` → `toolErrors` non-empty, turn completes; two sequential turns both answered (re-arm works); `SLOW_TURN_PLEASE` takes ≥1s.
- [ ] **Step 2: gate in the bridge.** In `configureServer`: `const piRt = process.env.CARTIS_FAKE_AGENT === '1' ? makePiRuntime(DATA_ROOT, { modelRuntime: await fakeAgentRuntime() }) : makePiRuntime(DATA_ROOT);` plus forcing `process.env.CARTIS_MODEL = 'faux/faux-model'` under the flag (before any turn). Manual proof: `CARTIS_FAKE_AGENT=1 bun run dev -- --port 5198 --strictPort` + curl `/api/chat/turn` with a rename prompt → structured response carries the `card_patch` intent, no model key needed.
- [ ] **Step 3:** verify green (flag absent → default runtime untouched); commit `feat(server): CARTIS_FAKE_AGENT scripted faux model (real pi loop, deterministic replies)`.

### Task 7: Playwright infra + lifecycle specs

**Files:** Create `playwright.config.ts`, `e2e/scripted/{reload-restore,history-nav,attachments,composer}.spec.ts`; Modify `package.json` (`"e2e:scripted": "playwright test"`, devDep `@playwright/test`), `.gitignore`.

- [ ] **Step 1:** `bun add -d @playwright/test && bunx playwright install chromium`. Config: `testDir: 'e2e/scripted'`, `use: { baseURL: 'http://localhost:5198' }`, `webServer: { command: 'bun run dev -- --port 5198 --strictPort', url: 'http://localhost:5198/builder', env: { CARTIS_DATA_ROOT: 'e2e/.scratch/scripted/data', CARTIS_FAKE_AGENT: '1' }, reuseExistingServer: false }` — strip `REPLICATE_API_TOKEN`/`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` from the child env. Workers: 1 (shared data root).
- [ ] **Step 2: lifecycle specs.** `reload-restore`: send `rename this card to Probe`, Save, capture `/builder/<id>`, `page.reload()` → name field `Probe`, conversation rehydrated, ZERO messages before the first user bubble (the ghost class). `history-nav`: tab → gallery (URL `/gallery`), open card, `goBack`/`goForward`, dirty-guard bounce (edit a field, goBack, Cancel → URL snaps back). `attachments`: `.psd` on the hidden input → `unsupported attachment type` note; 7 files → cap note; thumb × removes. `composer`: Send disabled empty → enabled on text → `SLOW_TURN_PLEASE` shows `[data-testid="busy-strip"]` + Stop swap → settles back to Send.
- [ ] **Step 3:** `bun run e2e:scripted` green + `bun run verify` untouched-green; commit `test(e2e): scripted lifecycle specs (reload/ghosts, history, attachments, composer+busy)`.

### Task 8: Chat-flow, branching, validation + render-parity specs

**Files:** Create `e2e/scripted/{chat-flow,doc-actions,branching,validation,parity}.spec.ts`.

- [ ] **Step 1: chat-flow.** Rename turn → form name updates + `EDITED` chip; `full art` message → layout select flips (the knob through the REAL tool pipeline).
- [ ] **Step 2: doc-actions.** `rename this card to Keeper, save it and export print` → poll scratch data root for the card sidecar + a `chats/*.jsonl` session file + export PNG (>10 KB with fake art) + chips ≥ 2.
- [ ] **Step 3: branching (the durable-branch class, scripted).** Send turn A; Edit the user bubble to a different rename → ‹ 2/2 › arrows appear; click `branch-prev` → original conversation; `page.reload()` → STILL on the selected branch (leaf_switch durability in a real browser).
- [ ] **Step 4: validation.** Send `INVALID_ARGS_PLEASE` → note strip shows `failed validation`, the turn's reply renders, composer settles — NEVER a crash or raw blob.
- [ ] **Step 5: parity.** Save a card, open gallery: computed-style sweep on the ability paragraph in BOTH contexts — `textAlign`, `fontFamily` equal (the UA-leak class); plus ONE `toHaveScreenshot('builder-card-face.png')` baseline.
- [ ] **Step 6:** full `bun run e2e:scripted` green; verify green; commit `test(e2e): chat-flow, doc-actions, branching, validation, render-parity specs`.

## Final

### Task 9: Docs + full runs + merge

- [ ] **Step 1:** README "Testing" section — the three layers table (verify / e2e:scripted / e2e:agent), what each needs (nothing / Chromium / Chrome + model key), when to run which; the bug→fixture rule. Spec marked Implemented.
- [ ] **Step 2:** full gates: `bun run verify`, `bun run build`, `bun run e2e:scripted`, `bun run e2e:agent` (all three scenarios). Clean teardown after both e2e runs (`pgrep` empty). Real bugs found by the suites: file/fix before merge.
- [ ] **Step 3:** ff-merge to main, push, delete branch; update memory (three-layer setup, triggers, canary outcomes, gotchas).

## Self-review

Spec coverage: corpus w/ seeds + bug→fixture rule + hygiene rider (T1); DATA_ROOT override + MCP canary + fallbacks (T2); templating/preamble/turn-cap/strict-port/pre-flight (T3); direct-verification verdicts + report (T4); scenarios + subject.png with pi-session fs criteria (T5); fakeAgent faux-runtime seam incl. context-factory canary + re-arm (T6); Playwright infra + lifecycle incl. ghosts + busy strip (T7); chat-flow/branching/validation/parity (T8); docs + full runs (T9). Type consistency: `Scenario`/`Criterion`/`Browser`/`DriverRun`/`Verdict`/`fakeAgentRuntime` defined once, consumed by name; ports 5198/5199 consistent; page criteria + screenshots direct via `browser.call` everywhere; `INVALID_ARGS_PLEASE`/`SLOW_TURN_PLEASE` triggers consistent between T6 rules and T7/T8 specs.
