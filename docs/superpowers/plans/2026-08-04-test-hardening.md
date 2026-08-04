# Test & E2E Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three hardening tracks per `docs/superpowers/specs/2026-08-04-test-hardening-design.md`: **A** adversarial model-output corpus (unit-speed), **B** scripted Playwright e2e with a fake-agent bridge seam incl. render parity (`bun run e2e:scripted`), **C** agentic e2e — a pi-driven (in-process SDK) LLM drives real Chrome to user-voice objectives, harness-judged (`bun run e2e:agent`).

**Architecture:** Track A is one table-driven vitest file over the real parse pipeline. Track B swaps `agentClientLive` for an in-memory `agentClientFake` (env-gated) that drives the REAL ThreadBus, under Playwright with a strict-port scratch-root webServer. Track C: one runner owns the dev server (scratch `CARTIS_DATA_ROOT`, strict port 5199), a harness-owned MCP client to a spawned `chrome-devtools-mcp` (Chrome), and an IN-PROCESS pi `createAgentSession` driver whose customTools wrap the MCP tools; `fs` criteria run in the runner, `page` criteria run DIRECTLY via the harness's own MCP `evaluate_script` calls — no agent relay.

**Tech Stack:** vitest (A), `@playwright/test` + Chromium (B), `@earendil-works/pi-coding-agent` (in-process driver) + `@modelcontextprotocol/sdk` (stdio client) + `chrome-devtools-mcp` (C), bun scripts, `node:fs/promises`.

## Global Constraints

- **Task order:** Track A first (independent, immediate value). Track C's canary (Task 2) gates Tasks 3–5. Track B (Tasks 6–8) is independent of C and follows it here only for review sanity.
- `src/` changes are EXACTLY: (1) `agentBridge.ts:1337` → `const DATA_ROOT = process.env.CARTIS_DATA_ROOT ?? 'cartis-data';` and (2) the Track-B fake seam (`src/server/agentFake.ts` + the env-gated provide). Both are config-reachable → relative `.ts` imports, no `@/`.
- **Strict ports (data safety):** scripted = 5198, agentic = 5199, both `--strictPort`, pre-flight ABORT if the port already answers. NEVER 5173 — the user's live server (and REAL data) is usually there. `REPLICATE_API_TOKEN` stripped from all child envs.
- Track C driver = pi IN-PROCESS: `@earendil-works/pi-coding-agent` + `@modelcontextprotocol/sdk` as devDeps PINNED EXACT (pi is v0.x with breaking minors). In-memory SessionManager/settings/credentials — nothing persisted, no driver cwd concern. Objectives TEMPLATED (`{{APP_URL}}`, `{{STAGE_DIR}}` absolute stage dir); driver model `E2E_DRIVER_MODEL ?? OPENCODE_MODEL` via pi's catalog; pi auth = `ANTHROPIC_API_KEY` or `pi` OAuth (separate from opencode auth). No `agentBridge.ts` import in e2e.
- Track C verdicts separate DRIVER outcome (done/blocked/timeout) from CRITERIA outcome; `--retries N` (default 0) re-runs driver-failures only; never weaken a criterion to pass; final full-page screenshot per scenario.
- Sequential scenarios; `rm -rf` + recreate scratch dirs per scenario; teardown VERIFIES the tree died (vite, the app's opencode, chrome-devtools-mcp, its Chrome).
- Pass/fail comes ONLY from `Criterion` checks (C) / Playwright assertions (B). Driver `DONE`/`BLOCKED` text is evidence, never a verdict. Page criteria + final screenshot execute DIRECTLY through the harness's MCP client — never relayed through the agent.
- Loop control is MECHANICAL: `AbortSignal`-based `timeoutMin` + a `shouldStopAfterTurn` turn cap (~40 tool calls).
- `bun run verify` green per task and must NOT run Playwright (separate `e2e:scripted` script; exclude `e2e/scripted` from vitest globs — they're `*.spec.ts`, vitest matches `*.test.*`, no conflict). Add `"e2e"` to `tsconfig.json` include; biome covers `e2e/`; `.gitignore` += `e2e/runs/`, `e2e/.scratch/`, `test-results/`, `playwright-report/`.
- pi facts (from the 2026-08-04 research spike): `createAgentSession({ customTools, sessionManager: SessionManager.inMemory(), modelRuntime, … })`; `session.prompt/abort/subscribe/messages`; `defineTool` with TypeBox schemas; tool results may carry `ImageContent` (screenshots auto-normalized); `PromptOptions.images` for user-side images. Verify exact API names against the PINNED version's `docs/sdk.md` at implementation time.
- Commits end `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Branch `feat/test-hardening`; ff-merge + push + delete at end.

---

## Track A

### Task 1: Adversarial model-output corpus

**Files:** Create `src/contracts/modelOutput.corpus.test.ts`.

**Interfaces:** Consumes (existing): `materializeAssistantParts`, `extractJson`, `repairJson`, `looksLikeContract` from `./materialize`; `decodePatchLenient` from `./fields`.

- [ ] **Step 1: the table.** `interface CorpusEntry { name: string; caught?: string /* date live-caught */; raw: string; parts?: (tags: string[]) => boolean; reply?: string; patch?: { fields: FieldSummaryT[]; applied: Record<string, unknown>; dropped: string[] }; }` — one `describe` iterating entries; for each: assert `materializeAssistantParts(raw)` part tags + first-Text reply when given, and when `patch` is given, `decodePatchLenient(fields, extractJson(raw) patch member)` equals `applied`/`dropped`. Never a bare "doesn't throw".
- [ ] **Step 2: seed 10 entries** (samples verbatim where live-caught): goblin unescaped quotes (`caught: '2026-08-03'`); Tinker nulls + off-list enums (`caught: '2026-08-03'`); fenced ```json; prose preamble + JSON; trailing commas; unbalanced braces → reply-salvage, `JSON.stringify(parts)` contains no `"patch"`; plain-text reply; `{}`; valid+mistyped `actions` mix; `setLayout`/`setTheme`/`setHolo` knobs. Header comment: **the bug→fixture rule — every live-caught sample is appended verbatim with a date.**
- [ ] **Step 3:** run the file; `bun run verify` green; commit `test(contracts): adversarial model-output corpus (bug→fixture home)`.

## Track C — agentic e2e (pi-driven)

### Task 2: Canary — pi-under-bun + MCP browser bridge + `CARTIS_DATA_ROOT`

**Files:** Create `e2e/agentic/browser.ts` (MCP bridge), `e2e/agentic/driver.ts` (pi session factory), `e2e/agentic/canary.ts`. Modify `src/server/agentBridge.ts:1337`, `package.json` (devDeps pinned exact), `tsconfig.json` (include `e2e`), `.gitignore` (`e2e/runs/`, `e2e/.scratch/`).

**Interfaces (produces):**
```ts
// e2e/agentic/browser.ts — the harness-owned browser connection
export interface Browser {
  /** call any chrome-devtools tool directly (verification channel). */
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
  /** pi customTools wrapping every MCP tool (driver channel). */
  tools: PiTool[];
  close(): Promise<void>;   // must take chrome-devtools-mcp AND Chrome down
}
export async function connectBrowser(): Promise<Browser>;

// e2e/agentic/driver.ts
export interface DriverRun { reply: string; outcome: 'done' | 'blocked' | 'timeout'; events: unknown[] }
export async function runDriver(browser: Browser, systemPrompt: string, objective: string, timeoutMin: number): Promise<DriverRun>;
export const APP_URL = 'http://localhost:5199';
```

- [ ] **Step 1: bridge env override** — `const DATA_ROOT = process.env.CARTIS_DATA_ROOT ?? 'cartis-data';` + comment. Prove BOTH ways on port 5199 (`--strictPort`): with the env → `[]` from `/api/store/cards` + probe dir created; without → real cards. Kill server.
- [ ] **Step 2: deps + bridge.** `bun add -d --exact @earendil-works/pi-coding-agent @modelcontextprotocol/sdk`. `connectBrowser()`: `new Client(...)` + `StdioClientTransport({ command: 'bunx', args: ['chrome-devtools-mcp@latest'] })`, `listTools()`, map each to a pi `defineTool` whose `execute` forwards to `client.callTool` and converts image payloads to pi `ImageContent`; `call()` invokes `client.callTool` directly; `close()` closes the transport and verifies the child died.
- [ ] **Step 3: driver factory.** `runDriver`: `ModelRuntime.create()` (in-memory credentials honoring `ANTHROPIC_API_KEY`), `createAgentSession` with `SessionManager.inMemory()`, `customTools: browser.tools`, system prompt = param, model from `E2E_DRIVER_MODEL ?? OPENCODE_MODEL`; subscribe→collect events; `shouldStopAfterTurn` counts ~40 tool calls; `AbortSignal.timeout(timeoutMin * 60_000)` → outcome 'timeout'; parse trailing `DONE:`/`BLOCKED:` → outcome.
- [ ] **Step 4: canary run.** `bun e2e/agentic/canary.ts`: connectBrowser → runDriver(preamble-less system prompt, *"Navigate to https://example.com and reply DONE: followed by the page's h1 text."*, 3) → assert reply contains "Example Domain"; then the DIRECT channel: `browser.call('evaluate_script', { function: '() => document.querySelector("h1")?.textContent' })` → "Example Domain" WITHOUT the agent. `browser.close()` → `pgrep -fl 'chrome-devtools-mcp'` empty + no Chrome-for-Testing leftover (add explicit child-kill if it survives). **GO/NO-GO recorded atop browser.ts.** Bun-incompat fallback: run the agentic runner under `node`; pi-unworkable fallback: revert to the opencode-driver design (git history of the spec). STOP on failure — never build the runner on an unproven driver.
- [ ] **Step 5:** `bun run verify` green; commit `feat(e2e): pi in-process driver canary + MCP browser bridge + CARTIS_DATA_ROOT override`.

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
export const PREAMBLE: string;   // spec §Driver preamble; used as the pi system prompt
export function template(text: string, vars: { APP_URL: string; STAGE_DIR: string }): string;
```

- [ ] **Step 1: PREAMBLE (exact, as pi system prompt):** *"You are a USER of the Cartis card app at {{APP_URL}}, driving a real browser through the provided browser tools. Act ONLY through the UI — never read or modify source files or data directories directly. Take a page snapshot before interacting. Prefer snapshots over screenshots. The app has its own AI: after sending a chat message, WAIT until its Stop button reverts to Send before your next action. When the objective is complete, reply exactly `DONE: <one-paragraph summary>`. If truly blocked, reply `BLOCKED: <why>`."* (budget enforced by the turn cap, not instruction).
- [ ] **Step 2: runner lifecycle.** argv: ids (default all) + `--retries N`. PRE-FLIGHT: anything answering on 5199 → abort "port busy". Per scenario: (1) `rm -rf`+create `e2e/.scratch/<id>/{data,stage}`, copy seed/staged; (2) `Bun.spawn(['bun','run','dev','--','--port','5199','--strictPort'], { env: {...process.env, CARTIS_DATA_ROOT: dataRoot, REPLICATE_API_TOKEN: undefined} })`, poll `${APP_URL}/builder`→200 (30s); (3) `connectBrowser()` → `runDriver(browser, template(PREAMBLE, vars), template(objective+constraints, vars), timeoutMin)`; (4) Task-4 verdicts (direct via `browser.call`); driver-failure + retries left → full teardown + re-run; (5) `finally`: write events transcript, `browser.close()`, kill dev server, wait 5199 free, assert no orphan `vite|opencode serve|chrome-devtools-mcp`. Nonzero exit on any failure.
- [ ] **Step 3: smoke.** `{ id: 'smoke', timeoutMin: 3, objective: 'Navigate to {{APP_URL}}/builder and confirm the app is showing.', constraints: [], criteria: [{ kind: 'page', label: 'builder heading', script: '() => document.querySelector("h1")?.textContent ?? null', expect: (r) => r === 'CARTIS' }] }`.
- [ ] **Step 4:** `bun run e2e:agent smoke` — boots scratch, drives, `DONE:` printed, teardown clean (`pgrep` empty).
- [ ] **Step 5:** verify green; commit `feat(e2e): agentic scenario contract + runner lifecycle (smoke)`.

### Task 4: Verdicts — direct criteria execution, report, exit code

**Files:** Modify `e2e/agentic/runner.ts` (judge + report; small helpers in `driver.ts`/`browser.ts` as needed).

**Interfaces (produces):**
```ts
export interface Verdict { scenario: string; driverOutcome: 'done' | 'blocked' | 'timeout'; results: { label: string; pass: boolean; evidence: string }[]; driverReply: string; }
```

- [ ] **Step 1:** fs criteria: `await c.check(dataRoot)` in try/catch (catch = fail, error as evidence). Page criteria: for each, `browser.call('evaluate_script', { function: c.script })` DIRECTLY — no agent involvement — unwrap the MCP result payload, apply `expect`, raw result as evidence. Blocked/timeout runs criteria anyway (state may be salvageable), flagged. Final screenshot: `browser.call('take_screenshot', …)` into the run dir.
- [ ] **Step 2: report.** `e2e/runs/<ISO-stamp>/report.md`: verdict table (scenario × criterion ✓/✗ + evidence + driver outcome), `transcript-<id>.json` (subscribe events + final messages), screenshots. Print table; `process.exitCode = 1` on any ✗.
- [ ] **Step 3:** smoke → ✓; flip expectation → ✗ + exit 1; restore.
- [ ] **Step 4:** verify green; commit `feat(e2e): mechanical verdicts — direct MCP page criteria, report, exit codes`.

### Task 5: The three v1 scenarios + fixtures

**Files:** Create `e2e/agentic/scenarios/{photo-card,doc-powers,persistence-reload}.ts`, `e2e/agentic/fixtures/subject.png` (downloaded ONCE from https://thispersondoesnotexist.com — an AI-generated face of a person who does not exist, committed; no real likeness in the repo, and a realistic face exercises the vision seam unlike noise); update `scenarios/index.ts`.

- [ ] **Step 1: photo-card.** `timeoutMin: 8`; `stage: ['e2e/agentic/fixtures/subject.png']`; objective: *"There is a photo at {{STAGE_DIR}}/subject.png. In the card app, attach that photo in the chat sidebar and ask the assistant to make the card a spell card called 'Tinker' in a steampunk style featuring the person in the photo, with a funny caption and no might/ward stuff. Wait for it to finish."* Constraints: chat sidebar ONLY (not the form); do not save. Criteria — page: name input value `=== 'Tinker'`; chat panel textContent does NOT include `'"reply"'`; `[data-testid="composer-send"]` present (settled); stat shield absent (IMPLEMENTER: take the real selector from `ArcaneStatBadge` and record it in the scenario file).
- [ ] **Step 2: doc-powers.** `timeoutMin: 10`; objective: *"In the chat sidebar, ask the assistant — in one or several messages — to rename the card to 'Canary Knight', save it, export a print PNG, and switch to the full art layout. Wait for each reply."* Criteria — fs: exactly one `cards/*.json` with `name === 'Canary Knight'` + `chatSessionId`; ≥1 `exports/*.png` > 100 KB + sidecar. page: LAYOUT select displays `Full Art` (IMPLEMENTER: reuse the proven live-session snippet); `[data-testid="tool-doc-action"]` count ≥ 3.
- [ ] **Step 3: persistence-reload.** `timeoutMin: 8`; objective: *"Send the chat message 'rename this card to Reload Probe' and wait for the reply. Click Save in the document bar. Note the URL. Reload the page (navigate to the same URL again). Then confirm what you see."* Criteria — page: `location.pathname` matches `^/builder/[0-9a-f-]+$`; chat contains `'Reload Probe'`; ghost check: first `.group` in the chat panel contains the user's own text, `groups.length >= 2`. fs: sidecar named `Reload Probe` with `chatSessionId`.
- [ ] **Step 4:** run each individually; iterate until passing for the RIGHT reason (inspect evidence + final.png). Failures from REAL app bugs: file/fix separately — never weaken criteria.
- [ ] **Step 5:** verify green; commit `feat(e2e): photo-card, doc-powers, persistence-reload scenarios`.

## Track B — scripted e2e

### Task 6: Fake-agent seam (`agentClientFake`)

**Files:** Create `src/server/agentFake.ts` (+ `src/server/agentFake.test.ts`); Modify `src/server/agentBridge.ts` (env-gated provide where `agentClientLive` is composed in `BridgeRuntime.bridgeLive` — gate INSIDE `bridgeLive`: `const agent = process.env.CARTIS_FAKE_AGENT === '1' ? agentFakeLive : agentClientLive;`), `src/server/BridgeRuntime.ts`.

**Interfaces (produces):** `export const agentFakeLive: Layer.Layer<AgentClient, never, ThreadBus>` — full `AgentClient` surface, in-memory:
- Maps for sessions + messages; `prompt()` STORES the full rich prompt (marker-stripping rehydration stays real) and computes the reply from DETERMINISTIC rules documented in the module header: `/rename (?:this card |her |him )?to '?"?([A-Za-z ]+)/i` → `{reply, patch:{name:$1}}`; text containing `save it`/`save the card` → `actions:[{kind:'save'}]`; `export print` → export print action; `full art` → `setLayout fullart`; the literal trigger `BREAK_JSON_PLEASE` → the goblin-class malformed blob VERBATIM; otherwise `{reply:'Understood.'}`. Rules compose (one reply may carry patch + several actions).
- `withActivity` emits REAL ThreadBus events (TurnStarted → one Text PartDelta → TurnCompleted) so SSE/fold/replay lifecycle is genuinely exercised.
- `fork`/`revert`/`children`/`info`/`abort`: honest in-memory semantics INCLUDING unknown-id error shapes (stub-fidelity rule).

- [ ] **Step 1:** unit tests first (`agentFake.test.ts`): rename rule extracts the name; composed save+export+layout reply; BREAK_JSON trigger returns invalid JSON; `messages()` returns stored prompts; unknown session id errors like the real client (id-less info).
- [ ] **Step 2:** implement + gate in `bridgeLive`. Manual proof: `CARTIS_FAKE_AGENT=1 bun run dev -- --port 5198 --strictPort` + curl `/api/chat/turn` with a rename prompt → patch in response, no opencode process spawned (`pgrep` empty).
- [ ] **Step 3:** verify green (fake untouched when env absent — assert `bridgeLive()` default unchanged in an existing BridgeRuntime test); commit `feat(server): CARTIS_FAKE_AGENT in-memory agent (deterministic scripted replies, real ThreadBus)`.

### Task 7: Playwright infra + lifecycle specs

**Files:** Create `playwright.config.ts`, `e2e/scripted/{reload-restore,history-nav,attachments,composer}.spec.ts`; Modify `package.json` (`"e2e:scripted": "playwright test"`, devDep `@playwright/test`), `.gitignore`.

- [ ] **Step 1:** `bun add -d @playwright/test && bunx playwright install chromium`. Config: `testDir: 'e2e/scripted'`, `use: { baseURL: 'http://localhost:5198' }`, `webServer: { command: 'bun run dev -- --port 5198 --strictPort', url: 'http://localhost:5198/builder', env: { CARTIS_DATA_ROOT: 'e2e/.scratch/scripted/data', CARTIS_FAKE_AGENT: '1' }, reuseExistingServer: false }` (strip REPLICATE token in env). Workers: 1 (shared data root).
- [ ] **Step 2: lifecycle specs.** `reload-restore`: send `rename this card to Probe` in the chat, Save, capture `/builder/<id>`, `page.reload()` → name field `Probe`, conversation present, ZERO messages before the first user bubble (the ghost class). `history-nav`: tab → gallery (URL `/gallery`), open card, `goBack`/`goForward`, dirty-guard bounce (edit a field, goBack, Cancel → URL snaps back). `attachments`: set a `.psd` file on the hidden input → note strip text `unsupported attachment type`; 7 files → cap note; thumb × removes. `composer`: Send disabled empty → enabled on text → Stop while running (fake adds ~300ms delay option? keep: assert Send re-enabled after turn; skip Stop race if not reliably observable — note it).
- [ ] **Step 3:** `bun run e2e:scripted` green + `bun run verify` untouched-green; commit `test(e2e): scripted lifecycle specs (reload/ghosts, history, attachments, composer)`.

### Task 8: Chat-flow + render-parity specs

**Files:** Create `e2e/scripted/{chat-flow,doc-actions,malformed,parity}.spec.ts`.

- [ ] **Step 1: chat-flow.** Send rename → form name updates + `EDITED` chip; `full art` message → layout select flips (setLayout knob through the REAL client pipeline).
- [ ] **Step 2: doc-actions.** `save it and export print` → poll scratch data root for the card sidecar + export PNG (>10 KB with fake art) + chips ≥ 2.
- [ ] **Step 3: malformed.** Send `BREAK_JSON_PLEASE` → chat shows an honest error or repaired reply and NEVER a raw `"reply"` blob (assert panel text).
- [ ] **Step 4: parity.** Save a card, open gallery: for the card face in BOTH contexts compare `getComputedStyle` on the ability paragraph — `textAlign`, `fontFamily` equal (the UA-leak class); plus ONE `toHaveScreenshot('builder-card-face.png')` of the builder card root (commit baseline).
- [ ] **Step 5:** full `bun run e2e:scripted` green; verify green; commit `test(e2e): chat-flow, doc-actions, malformed-model, render-parity specs`.

## Final

### Task 9: Docs + full runs + merge

- [ ] **Step 1:** README "Testing" section — the three layers table (verify / e2e:scripted / e2e:agent), what each needs (Chrome, opencode auth, tokens), when to run which; the bug→fixture rule. Spec marked Implemented.
- [ ] **Step 2:** full gates: `bun run verify`, `bun run build`, `bun run e2e:scripted`, `bun run e2e:agent` (all three scenarios). Clean teardown after both e2e runs (`pgrep` empty). Real bugs found by the suites: file/fix before merge.
- [ ] **Step 3:** ff-merge to main, push, delete branch; update memory (three-layer setup, triggers, canary outcome, gotchas).

## Self-review

Spec coverage: corpus w/ seeds + rule (T1); env override + pi/bun canary + MCP bridge + fallbacks (T2); templating/preamble/turn-cap/strict-port/pre-flight (T3); direct-verification verdicts + driverOutcome + screenshot + report (T4); scenarios + subject.png (T5); fake seam incl. ThreadBus + error shapes (T6); Playwright infra + lifecycle incl. ghosts (T7); chat-flow/malformed/parity (T8); docs + full runs (T9). Type consistency: `Scenario`/`Criterion`/`Browser`/`DriverRun`/`Verdict`/`agentFakeLive` defined once, consumed by name; ports 5198/5199 consistent throughout; page criteria + screenshots direct via `browser.call` everywhere. IMPLEMENTER-selector notes in T5 are bounded lookups to be recorded in scenario files, not placeholders.
