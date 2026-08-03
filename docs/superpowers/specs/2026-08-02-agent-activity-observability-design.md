# Agent-action observability — every agent action in the activity log

**Date:** 2026-08-02 · **Status:** approved (brainstorm 2026-08-02)

## Context

During a fill or art-compose turn the bridge emits one activity event at the start and
one at the end; the 10-60s in between is silent even though the opencode agent takes
many discrete actions. The user must see each action to know things are progressing.

The opencode SDK (1.18) exposes `client.event.subscribe({ onSseEvent, signal })` — an
SSE stream of typed `Event`s including `message.part.updated` whose `Part` union carries
`ToolPart` (tool name, `ToolState` running/completed/error with `title`, `time.start/end`),
`StepStartPart`, `ReasoningPart`, and `TextPart`; parts carry `sessionID` for filtering.
The downstream pipeline (ActivityBus → `/api/activity` SSE → ActivityFeed → log drawer)
already exists — this is purely a bridge-side producer change.

## Design

### `watchSessionActivity` (src/server/agentBridge.ts)

A scoped Effect forked around every in-flight prompt (fill turns AND art composition):

- Acquire: an `AbortController`; call the SDK's `event.subscribe` with `onSseEvent` and
  the controller's `signal`. Release: `controller.abort()`. Wrapped with
  `Effect.acquireRelease` inside `Effect.scoped` so the watcher lives exactly as long
  as the turn (interrupted when the prompt settles or fails).
- Filter: only events whose part `sessionID` matches the in-flight session.
- Decode: incoming SSE payloads are external data — decoded with a lenient Schema
  (only the fields we read: event `type`, `part.type/sessionID/tool/state/time`,
  `state.title/error/status`); unrecognized events are silently skipped.
- Emit (ActivityBus, source `agent`):
  - `StepStartPart` → `step started`
  - `ToolPart` running → `` `tool ${tool}: running${title ? ` — ${title}` : ''}` ``
  - `ToolPart` completed → `` `tool ${tool}: done — ${title} (${secs}s)` `` (duration
    from `time.end - time.start`)
  - `ToolPart` error → `` `tool ${tool}: FAILED — ${error}` ``
  - first `ReasoningPart` of a message → `thinking…`
  - `TextPart` progress → `` `writing response… (${chars} chars)` `` THROTTLED: first
    chunk immediately, then at most one update per 2 seconds (Clock-based, so
    TestClock-deterministic). Raw deltas are deliberately not streamed — they would
    flood the 200-event history cap (approved verbosity decision).
  - `session.error` events → `` `agent error: ${message}` ``
  - Dedupe: a tool call logs `running` once (transition-based, keyed by `callID`), not
    on every part update.

### Heartbeat

`runFillAgent` regains the elapsed heartbeat the old card agent had:
`Effect.forkScoped` of `still working… (${secs}s)` on `Schedule.spaced('5 seconds')`,
elapsed from `Clock.currentTimeMillis` — auto-interrupted when the prompt settles.
(`composeArtPrompt` turns are short; the watcher's tool/step lines cover them — no
heartbeat there.)

### AgentClient surface

`OpencodeClient` (the SDK slice the bridge drives) gains
`event: { subscribe(opts): Promise<unknown> }`; the `AgentClient` service gains an
optional capability the live layer implements —
`watch?(sessionId): Effect<never, never, Scope>` style is NOT used; instead the
watcher needs the RAW client, so: `agentClientFromSdk` returns the existing service
PLUS the live layer exposes `withActivity<A, E>(sessionId, effect): Effect<A, E>`
that runs `effect` with the watcher forked in scope. Stub/test AgentClients implement
`withActivity` as identity (or with a canned event script for watcher tests).
Exact shape may be simplified at plan time — the binding requirement: fill and compose
prompts run under the watcher in the live path, identity in tests, no `as` casts on
event payloads (Schema-decoded).

## Engineering requirements (binding)

Repo standards: no `any`/`!`/`as`-on-external-data; SSE event payloads Schema-decoded
leniently; Effect for all lifecycle (acquireRelease subscription, Clock-based throttle
+ heartbeat, forkScoped watchers); TestClock-driven tests for throttle + heartbeat;
transition-dedupe tested (a tool emitting three running updates logs once); watcher
lifecycle tested (subscription aborted when the prompt settles). `bun run verify`
green per task.

## Out of scope

UI changes (the log drawer already renders these events); persisting agent transcripts;
client-side filtering of the busier log; streaming raw token deltas (rejected for
history-cap flooding).
