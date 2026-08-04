# Chat Document Actions — Design

**Date:** 2026-08-03
**Status:** Approved scope (user Q&A): Save / Save as copy + Export renders,
executed immediately (no confirmation strip). Deferred: layout/theme/holo
switching, new/open-card lifecycle.

## Goal

Give the chat agent the current-card abilities the author has beyond field
patches and art: **save**, **save as copy**, and **export renders** — "looks
good, save it and export a print PNG" works in one turn. Scope stays the open
document only (session-per-card unchanged).

## Transport (v1 JSON contract extension)

The reply contract gains an optional `actions` array:

```json
{ "reply": "...", "patch": {...}, "artAction": {...},
  "actions": [ {"kind": "save"} , {"kind": "saveAsCopy"},
               {"kind": "export", "target": "png" | "print" | "sheet"} ] }
```

- `src/contracts/api.ts`: `DocAction` union schema; `ChatTurnResponse.actions`
  optional array. Export targets map to the existing pipeline: `png` = 300 DPI
  no bleed, `print` = 600 DPI + bleed/crop marks, `sheet` = 3×3 A4 300 DPI.
- Bridge `parseChatReply` decodes `actions` **per entry, leniently** — a
  mistyped entry is dropped (unlike `patch`, where a mistype is an error);
  the valid entries still run. CHAT_GUIDE documents the shape and says to
  include actions ONLY when the author asks to save/export.

## Execution (client, ChatContext)

`ChatContext` grows appliers implemented by BuilderView:

- `save(): Promise<boolean>` / `saveAsCopy(): Promise<boolean>` — delegate to
  the existing `saveCard`/`saveAsCopy` (which now RETURN success); failure text
  stays in `savedNote` as today.
- `exportRender(target): Promise<boolean>` — new `BuilderView.exportRender`
  using the pure export fns (`renderCardBlob`/`renderSheetBlob`) on
  `previewEl.current`, downloading + archiving via `shell.archive.saveExport`
  with `cardId: savedId` (same delivery as ExportBar).
- `runArt` now returns the run's Promise (was fire-and-forget) so actions can
  sequence after art.

`ThreadState.applyTurnExit` (and regenerate): finalize the message FIRST (reply
renders immediately), apply the patch, then run a detached async chain:
`await runArt (if any) → for each action in order: await it` — so "generate art
and save" saves the card WITH the new art. A failed action sets `note`
(`save failed` / `export failed`) — the note strip surfaces it. Destroyed-state
guards (`this.get(null)`) before every write.

## Display

`materialize.ts` chips: `CARD_SAVE_TOOL = 'card_save'`,
`CARD_EXPORT_TOOL = 'card_export'`; one chip per action, after patch/art chips.
`MessageView` ToolUI registry renders them ("saved" / "saved as copy" /
"export png|print|sheet"). History replays chips identically (shared
materializer). Regenerating a turn re-runs its actions (a re-save is
idempotent; a re-export re-downloads — accepted).

## Testing

Contracts: DocAction decode + lenient per-entry drop. Materializer: chips for
each action kind. Bridge: parseChatReply passes valid actions, drops mistyped,
still errors on mistyped patch. ThreadState: order (art before actions),
failure → note, success path calls ChatContext appliers (stub context).
Mounted: chips render with labels. Live e2e: "save this card" turn actually
persists (cartis-data write) before merge.
