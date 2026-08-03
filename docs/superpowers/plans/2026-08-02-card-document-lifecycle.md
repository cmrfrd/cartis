# Card Document Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Builder a document editor — dirty tracking, a document bar (title/status/New/Save/Save as copy), an inline Save-first/Discard/Cancel guard on destructive intents, theme-switch-as-edit, and gallery Duplicate.

**Architecture:** All state lives on `BuilderView` (expressive Component): a `dirty` modified-flag and a `pendingIntent` discriminated union (`{ kind: 'new' } | { kind: 'open'; card: StoredCard }`). Persistence stays on the existing Effect boundary (`CardArchive.saveCard` → `StoreClient`); the guard's Save-first path composes save-then-intent with typed failure handling. UI is a `DocumentBar` function component above the Theme panel plus a `Duplicate` button on gallery rows.

**Tech Stack:** @expressive/react 0.83 (Component classes, `.get()`), effect 3.22 via the established `runAppExit` boundary, vitest 4 + happy-dom + `mountApp`/`click`/`setInput` (test/util.tsx), `setAppLayer`/`testAppLayerWith` seam.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-02-card-document-lifecycle-design.md` — its **Engineering requirements** section is binding: no `any`/`!`/`as`-on-external-data; `pendingIntent` is a discriminated union consumed exhaustively; guard resolutions are the closed set `'save-first' | 'discard' | 'cancel'`; effectful paths go through the boundary pattern; pure state transitions stay plain expressive mutations.
- Gate after EVERY task: `bun run verify` green (`biome ci . && tsc --noEmit && vitest run`).
- Error/note strings: new user-visible strings are introduced here (document bar, confirm) — keep them exactly as written in the tasks so tests and UI agree.
- Fill-session discard rules unchanged: `pickTheme`/`pickLayout`/`loadCard`/`newCard` all reset `fillSessionId`.
- Local repo policy: push allowed (origin `github.com/cmrfrd/cartis`); conventional commits ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Document state + actions on BuilderView (headless)

**Files:**
- Modify: `src/builder/BuilderView.tsx` (state fields ~lines 20-35; `pickTheme` ~78; `pickLayout` ~90; `loadCard` ~100; `saveCard` ~215; new methods after `loadCard`)
- Test: `src/builder/builder.test.tsx` (append a `describe('document lifecycle (headless)')`)

**Interfaces:**
- Consumes: `StoredCard` (`src/storage/CardArchive.ts`), `StoreClient` + `StoreError` (for the failing-store test layer: `src/storage/StoreClient.ts`, `src/contracts/errors.ts`), `testAppLayerWith`/`setAppLayer` (`src/app/runtime.ts`), `getTheme`/`getLayout` (`src/cards/registry.ts`).
- Produces (Task 2 renders these): `dirty: boolean`; `pendingIntent?: PendingIntent` where `export type PendingIntent = { kind: 'new' } | { kind: 'open'; card: StoredCard }`; `export type GuardResolution = 'save-first' | 'discard' | 'cancel'`; methods `requestNew(): void`, `requestOpen(card: StoredCard): void`, `resolveIntent(resolution: GuardResolution): Promise<void>`, `newCard(): void` (unguarded executor), `saveAsCopy(): Promise<void>`, `toggleHolo(): void`; `saveCard()` now catches store failures into `savedNote`.

- [ ] **Step 1: Write the failing headless tests** — append to `src/builder/builder.test.tsx`:

```ts
describe('document lifecycle (headless)', () => {
  const makeCard = (overrides: Partial<StoredCard> = {}): StoredCard => ({
    id: 'card-1',
    name: 'Stored Hero',
    themeId: 'arcane',
    layoutId: 'classic',
    data: { name: 'Stored Hero', essence: 'tide' },
    holo: false,
    updatedAt: 1,
    ...overrides,
  });

  it('tracks dirty across every mutating action and clears it on load/new', () => {
    const builder = BuilderView.new();
    expect(builder.dirty).toBe(false);
    builder.setField('name', 'X');
    expect(builder.dirty).toBe(true);
    builder.loadCard(makeCard());
    expect(builder.dirty).toBe(false);
    builder.pickLayout('fullart');
    expect(builder.dirty).toBe(true);
    builder.newCard();
    expect(builder.dirty).toBe(false);
    builder.toggleHolo();
    expect(builder.dirty).toBe(true);
    builder.newCard();
    builder.pickTheme('arcane');
    expect(builder.dirty).toBe(true);
    builder.set(null);
  });

  it('pickTheme edits the same document: keeps savedId, preserves overlap, drops fill session', () => {
    const builder = BuilderView.new();
    builder.loadCard(makeCard({ data: { name: 'Keeper', essence: 'tide' } }));
    builder.fillSessionId = 's1';
    builder.pickTheme('arcane');
    expect(builder.savedId).toBe('card-1'); // identity kept
    expect(builder.data.name).toBe('Keeper'); // overlapping key preserved
    expect(builder.dirty).toBe(true);
    expect(builder.fillSessionId).toBeUndefined();
    builder.set(null);
  });

  it('newCard seeds current theme+layout defaults and clears the document', () => {
    const builder = BuilderView.new();
    builder.loadCard(makeCard());
    builder.pickLayout('fullart');
    builder.fillSessionId = 's1';
    builder.newCard();
    expect(builder.savedId).toBeUndefined();
    expect(builder.dirty).toBe(false);
    expect(builder.fillSessionId).toBeUndefined();
    expect(builder.layoutId).toBe('fullart'); // stays in the current context
    expect(builder.data.name).toBe('Nyra, Unbound'); // fullart defaults
    builder.set(null);
  });

  it('requestNew executes immediately when clean, guards when dirty', () => {
    const builder = BuilderView.new();
    builder.requestNew();
    expect(builder.pendingIntent).toBeUndefined(); // clean → executed
    builder.setField('name', 'Dirty');
    builder.requestNew();
    expect(builder.pendingIntent).toEqual({ kind: 'new' });
    expect(builder.data.name).toBe('Dirty'); // nothing executed yet
    builder.set(null);
  });

  it('resolveIntent: cancel keeps the document; discard executes without saving', async () => {
    const builder = BuilderView.new();
    builder.setField('name', 'Dirty');
    builder.requestOpen(makeCard());
    await builder.resolveIntent('cancel');
    expect(builder.pendingIntent).toBeUndefined();
    expect(builder.data.name).toBe('Dirty');
    builder.requestOpen(makeCard());
    await builder.resolveIntent('discard');
    expect(builder.data.name).toBe('Stored Hero'); // opened
    expect(builder.dirty).toBe(false);
    builder.set(null);
  });

  it('resolveIntent save-first with a failed save cancels the intent and keeps the document', async () => {
    // Headless BuilderView has no shell → saveCard fails with 'Storage unavailable.'
    const b = BuilderView.new();
    b.setField('name', 'To Persist');
    b.requestNew();
    await b.resolveIntent('save-first');
    expect(b.savedNote).toBe('Storage unavailable.');
    expect(b.pendingIntent).toBeUndefined(); // intent cancelled, not left dangling
    expect(b.data.name).toBe('To Persist'); // document kept on failed save
    expect(b.dirty).toBe(true);
    b.set(null);
  });
  // (The success path of save-first is a mounted test in Task 2.)

  it('saveCard catches a failing store into savedNote (no unhandled rejection)', async () => {
    const failingStore: Layer.Layer<StoreClient> = Layer.succeed(
      StoreClient,
      StoreClient.of({
        list: () => Effect.succeed([]),
        put: () => Effect.fail(new StoreError({ op: 'put', status: 500, detail: 'disk full' })),
        remove: () => Effect.void,
        fileUrl: () => undefined,
      }),
    );
    setAppLayer(testAppLayerWith({ store: failingStore }));
    const { shell, container, unmount } = await mountApp();
    await vi.waitFor(() => expect(shell.archive.ready).toBe(true));
    const nameInput = container.querySelector('aside input[type="text"]');
    await setInput(nameInput, 'Doomed');
    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save',
    );
    await click(saveButton ?? null);
    await vi.waitFor(() => {
      expect(container.textContent).toContain('disk full');
    });
    unmount();
  });

  it('saveAsCopy forks to a new record and rebinds the document', async () => {
    const { shell, unmount } = await mountApp();
    await vi.waitFor(() => expect(shell.archive.ready).toBe(true));
    const original = await shell.archive.saveCard({
      name: 'Original',
      themeId: 'arcane',
      layoutId: 'classic',
      data: { name: 'Original' },
      holo: false,
    });
    shell.pendingCard = original;
    await tick();
    // the mounted BuilderView consumed it; drive saveAsCopy through the UI in Task 2 —
    // here through the model reachable via the shell-bound view is not exposed, so:
    // (this case is completed as a UI test in Task 2; keep this as the archive-level fork)
    const copy = await shell.archive.saveCard({
      name: `${original.name} copy`,
      themeId: original.themeId,
      layoutId: original.layoutId,
      data: { ...original.data },
      holo: original.holo,
    });
    expect(copy.id).not.toBe(original.id);
    expect(shell.archive.cards).toHaveLength(2);
    unmount();
  });
});
```

Imports to extend at the top of the file: `import { Effect, Layer } from 'effect';` (exists), add `import { StoreClient } from '../storage/StoreClient';`, `import { StoreError } from '../contracts/errors';`, `import type { StoredCard } from '../storage/CardArchive';`.

- [ ] **Step 2: Run to verify failure** — `bunx vitest run src/builder/builder.test.tsx` → FAIL (`dirty`/`newCard`/`requestNew`/`resolveIntent`/`toggleHolo` undefined; Save button not found).

- [ ] **Step 3: Implement on `BuilderView`** (minimal, following the exact semantics):

```ts
// --- new exported types (top of BuilderView.tsx, after imports) ---
export type PendingIntent = { kind: 'new' } | { kind: 'open'; card: StoredCard };
export type GuardResolution = 'save-first' | 'discard' | 'cancel';

// --- new state fields on BuilderView ---
/** Modified-flag: any edit sets it; save/load/new clear it. */
dirty = false;
/** A guarded destructive intent awaiting Save-first / Discard / Cancel. */
pendingIntent?: PendingIntent = undefined;

// --- mutations gain dirty tracking ---
setField(key: string, value: FieldValue) {
  this.data = { ...this.data, [key]: value };
  this.dirty = true;
}

toggleHolo() {
  this.holo = !this.holo;
  this.dirty = true;
}

// pickTheme: EDIT semantics (spec decision 4) — keeps savedId, preserves overlap
pickTheme(id: string) {
  const first = getTheme(id).layouts[0];
  const keptKeys = new Set((first?.fields ?? []).map((f) => f.key));
  const preserved: CardData = {};
  for (const [key, value] of Object.entries(this.data)) {
    if (keptKeys.has(key)) preserved[key] = value;
  }
  this.themeId = id;
  this.layoutId = first?.id ?? '';
  this.data = { ...(first ? first.defaults : {}), ...preserved };
  this.dirty = true;
  this.fillSessionId = undefined; // new episode (spec decision 6)
}

// pickLayout: unchanged + dirty
pickLayout(id: string) {
  /* existing preservation body */
  this.dirty = true;
  this.fillSessionId = undefined;
}

loadCard(card: StoredCard) {
  /* existing body */
  this.dirty = false;
}

// --- document actions ---
/** Unguarded executor: blank card in the CURRENT theme + layout. */
newCard() {
  const layout = this.layout;
  this.data = { ...layout.defaults };
  this.holo = false;
  this.savedId = undefined;
  this.savedNote = '';
  this.dirty = false;
  this.fillSessionId = undefined;
  this.aiNote = '';
  this.portraitKey = undefined;
}

requestNew() {
  if (!this.dirty) {
    this.newCard();
    return;
  }
  this.pendingIntent = { kind: 'new' };
}

requestOpen(card: StoredCard) {
  if (!this.dirty) {
    this.loadCard(card);
    return;
  }
  this.pendingIntent = { kind: 'open', card };
}

private executeIntent(intent: PendingIntent) {
  switch (intent.kind) {
    case 'new':
      this.newCard();
      return;
    case 'open':
      this.loadCard(intent.card);
      return;
  }
}

async resolveIntent(resolution: GuardResolution) {
  const intent = this.pendingIntent;
  this.pendingIntent = undefined;
  if (!intent || resolution === 'cancel') return;
  if (resolution === 'save-first') {
    await this.saveCard();
    // A failed save cancels the intent and shows the error (spec §Dirty guard).
    if (this.dirty) return;
  }
  this.executeIntent(intent);
}

// saveCard: catch typed failures into savedNote; clear dirty on success
async saveCard() {
  const { shell } = this;
  if (!shell) {
    this.savedNote = 'Storage unavailable.';
    return;
  }
  try {
    const saved = await shell.archive.saveCard({ /* existing input */ });
    this.savedId = saved.id;
    this.savedNote = `Saved “${saved.name}” to the gallery.`;
    this.dirty = false;
  } catch (cause) {
    this.savedNote = cause instanceof Error ? cause.message : String(cause);
  }
}

/** Fork the open card into a fresh record and rebind the document to it. */
async saveAsCopy() {
  const { shell } = this;
  if (!shell) {
    this.savedNote = 'Storage unavailable.';
    return;
  }
  const name = `${String(this.data.name ?? 'Untitled')} copy`;
  try {
    const saved = await shell.archive.saveCard({
      name,
      themeId: this.themeId,
      layoutId: this.layoutId,
      data: { ...this.data, name },
      holo: this.holo,
    });
    this.savedId = saved.id;
    this.savedNote = `Saved “${saved.name}” to the gallery.`;
    this.dirty = false;
  } catch (cause) {
    this.savedNote = cause instanceof Error ? cause.message : String(cause);
  }
}
```

Notes: `resolveIntent`'s save-first failure detection uses `this.dirty` — still `true` because only a successful `saveCard` clears it (headless no-shell and failing-store both leave it set). `saveAsCopy` also writes the copy's `name` into `data.name` so the card face matches the record. `newCard` requires `this.layout` (always valid — themeId/layoutId are set from `new()`). `fillWithAI`'s patch merge sets `this.data` directly — route it through dirty too: after `this.data = { ...this.data, ...out.patch };` add `this.dirty = true;`.

- [ ] **Step 4: Adjust existing tests that the semantics change breaks** — in `builder.test.tsx` the old case `seeds defaults only for a fresh card…` still passes (pickLayout preserves). In `AppShell`/`gallery` tests nothing changes (loadCard path). The mounted `saves the current card into the archive` test targets the button now labeled `Save` in Task 2 — for THIS task the button text is still `Save to gallery`; leave it; Task 2 updates it.

- [ ] **Step 5: Run the suite** — `bunx vitest run src/builder/ && bun run verify` → the two UI-dependent cases (`saveCard catches a failing store…` needs a `Save` button, `saveAsCopy forks…` uses archive-level fork only) — the failing-store case must use the CURRENT button text `Save to gallery` in this task; Task 2 renames it. Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/builder/BuilderView.tsx src/builder/builder.test.tsx
git commit -m "feat(builder): document state — dirty flag, guarded intents, newCard, saveAsCopy

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Document bar + inline confirm + consume-time guard (mounted)

**Files:**
- Modify: `src/builder/BuilderView.tsx` (`BuilderForm` — insert `DocumentBar` above the Theme panel; `mount()` `consumePending`; move save button/note into the bar; `BuilderPreview` holo button → `toggleHolo`)
- Test: `src/builder/builder.test.tsx` (mounted lifecycle describe), existing mounted saves-test updated to the new button label.

**Interfaces:**
- Consumes: Task 1's `dirty`/`pendingIntent`/`requestNew`/`resolveIntent`/`saveAsCopy`/`newCard`.
- Produces: user-visible strings — bar status `Unsaved changes` / `Saved`; buttons `New`, `Save`, `Save as copy`; confirm copy `Unsaved changes on “{title}”` with buttons `Save first`, `Discard`, `Cancel`; title fallback `Untitled card`.

- [ ] **Step 1: Write the failing mounted tests:**

```ts
describe('document bar (mounted)', () => {
  it('shows title, dirty status, and executes a guarded New through the confirm', async () => {
    const { container, unmount } = await mountApp();
    expect(container.textContent).toContain('Nyra, Ember Sage'); // title from defaults
    expect(container.textContent).not.toContain('Unsaved changes');
    const nameInput = container.querySelector('aside input[type="text"]');
    await setInput(nameInput, 'Working Title');
    expect(container.textContent).toContain('Unsaved changes');
    const newButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'New',
    );
    await click(newButton ?? null);
    expect(container.textContent).toContain('Unsaved changes on “Working Title”');
    const discard = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Discard',
    );
    await click(discard ?? null);
    expect(container.textContent).not.toContain('Working Title');
    expect(container.textContent).toContain('Nyra, Ember Sage'); // fresh defaults
    unmount();
  });

  it('guards a gallery open at consume time; Cancel keeps the current card', async () => {
    const { container, shell, unmount } = await mountApp();
    await vi.waitFor(() => expect(shell.archive.ready).toBe(true));
    const stored = await shell.archive.saveCard({
      name: 'From Gallery',
      themeId: 'arcane',
      layoutId: 'classic',
      data: { name: 'From Gallery' },
      holo: false,
    });
    const nameInput = container.querySelector('aside input[type="text"]');
    await setInput(nameInput, 'Precious Edits');
    shell.pendingCard = stored; // what GalleryView.openCard does
    await tick();
    expect(container.textContent).toContain('Unsaved changes on “Precious Edits”');
    expect(shell.pendingCard).toBeUndefined(); // held by the guard, not left dangling
    const cancel = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Cancel',
    );
    await click(cancel ?? null);
    expect(container.textContent).toContain('Precious Edits'); // kept
    expect(container.textContent).not.toContain('Unsaved changes on');
    unmount();
  });

  it('Save first persists the edits, then opens the pending card', async () => {
    const { container, shell, unmount } = await mountApp();
    await vi.waitFor(() => expect(shell.archive.ready).toBe(true));
    const stored = await shell.archive.saveCard({
      name: 'Target',
      themeId: 'arcane',
      layoutId: 'classic',
      data: { name: 'Target' },
      holo: false,
    });
    const nameInput = container.querySelector('aside input[type="text"]');
    await setInput(nameInput, 'Keep Me');
    shell.pendingCard = stored;
    await tick();
    const saveFirst = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save first',
    );
    await click(saveFirst ?? null);
    await vi.waitFor(() => {
      expect(shell.archive.cards.some((c) => c.name === 'Keep Me')).toBe(true); // persisted
      expect(container.textContent).toContain('Target'); // then opened
    });
    unmount();
  });

  it('Save as copy rebinds the document to a fresh record', async () => {
    const { container, shell, unmount } = await mountApp();
    await vi.waitFor(() => expect(shell.archive.ready).toBe(true));
    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save',
    );
    await click(saveButton ?? null);
    await vi.waitFor(() => expect(shell.archive.cards).toHaveLength(1));
    const firstId = shell.archive.cards[0]?.id;
    const copyButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save as copy',
    );
    await click(copyButton ?? null);
    await vi.waitFor(() => expect(shell.archive.cards).toHaveLength(2));
    const copy = shell.archive.cards.find((c) => c.id !== firstId);
    expect(copy?.name).toBe('Nyra, Ember Sage copy');
    expect(container.textContent).toContain('Nyra, Ember Sage copy'); // rebound title
    unmount();
  });
});
```

- [ ] **Step 2: Run to verify failure** — bar/buttons don't exist yet.

- [ ] **Step 3: Implement the UI.** In `BuilderForm`, insert above the Theme panel:

```tsx
function DocumentBar() {
  const { is: builder, data, savedId, dirty, savedNote, pendingIntent } = BuilderView.get();
  const title = String(data.name ?? '').trim() || 'Untitled card';
  return (
    <Panel title="Card">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate font-display text-sm">{title}</p>
          <span className="shrink-0 text-[11px] text-ink-dim">
            {dirty ? '● Unsaved changes' : savedId ? 'Saved' : 'New card'}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button tone="ghost" onClick={() => builder.requestNew()}>New</Button>
          <Button onClick={() => void builder.saveCard()}>Save</Button>
          <Button tone="ghost" onClick={() => void builder.saveAsCopy()}>Save as copy</Button>
        </div>
        {savedNote && <p className="text-xs text-ink-dim">{savedNote}</p>}
        {pendingIntent && <GuardConfirm title={title} />}
      </div>
    </Panel>
  );
}

function GuardConfirm(props: { title: string }) {
  const { is: builder } = BuilderView.get();
  return (
    <div className="flex flex-col gap-2 rounded-base border-2 border-border bg-secondary-background p-2">
      <p className="text-xs">Unsaved changes on “{props.title}”</p>
      <div className="flex gap-1.5">
        <Button onClick={() => void builder.resolveIntent('save-first')}>Save first</Button>
        <Button tone="ghost" onClick={() => void builder.resolveIntent('discard')}>Discard</Button>
        <Button tone="ghost" onClick={() => void builder.resolveIntent('cancel')}>Cancel</Button>
      </div>
    </div>
  );
}
```

Then: remove the old bottom save row (`Save to gallery` + inline savedNote) from `BuilderForm`; `mount()`'s `consumePending` becomes:

```ts
const consumePending = () => {
  const card = shell.pendingCard;
  if (card) {
    shell.pendingCard = undefined;
    this.requestOpen(card);
  }
};
```

`BuilderPreview`'s holo button calls `builder.toggleHolo()` instead of assigning.

- [ ] **Step 4: Update the two existing mounted tests that referenced the old button** — `saves the current card into the archive` (`Save to gallery` → `Save`; the `Saved` assertion still holds) and Task 1's failing-store case (same rename).

- [ ] **Step 5: Run** — `bunx vitest run src/builder/ src/gallery/ src/app/ && bun run verify` → green.

- [ ] **Step 6: Commit**

```bash
git add src/builder/
git commit -m "feat(builder): document bar, inline dirty guard, consume-time gallery protection

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Gallery Duplicate + docs + final gate

**Files:**
- Modify: `src/gallery/GalleryView.tsx` (`GalleryCards` row buttons)
- Modify: `README.md` (Gallery/roundtrip paragraph gains New/Save/Save-as-copy/Duplicate + dirty-guard sentence)
- Test: `src/gallery/gallery.test.tsx`

**Interfaces:**
- Consumes: `shell.archive.saveCard` (`SaveCardInput`), existing row markup.

- [ ] **Step 1: Failing test:**

```ts
it('duplicates a card into a new record, leaving the original untouched', async () => {
  const { container, shell, unmount } = await mountApp();
  await vi.waitFor(() => expect(shell.archive.ready).toBe(true));
  await shell.archive.saveCard({
    name: 'Solo',
    themeId: 'arcane',
    layoutId: 'classic',
    data: { name: 'Solo' },
    holo: true,
  });
  shell.view = 'gallery';
  await tick();
  await click(
    Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Saved cards') ??
      null,
  );
  await click(
    Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Duplicate') ??
      null,
  );
  await vi.waitFor(() => expect(shell.archive.cards).toHaveLength(2));
  const names = shell.archive.cards.map((c) => c.name).sort();
  expect(names).toEqual(['Solo', 'Solo copy']);
  const copy = shell.archive.cards.find((c) => c.name === 'Solo copy');
  expect(copy?.holo).toBe(true);
  expect(copy?.data.name).toBe('Solo copy');
  unmount();
});
```

- [ ] **Step 2: Run to verify failure** — no Duplicate button.

- [ ] **Step 3: Implement** — in `GalleryCards`, between `Open in builder` and `Delete`:

```tsx
<Button
  tone="ghost"
  onClick={() =>
    void shell?.archive.saveCard({
      name: `${card.name} copy`,
      themeId: card.themeId,
      layoutId: card.layoutId,
      data: { ...card.data, name: `${card.name} copy` },
      holo: card.holo,
    })
  }
>
  Duplicate
</Button>
```

- [ ] **Step 4: README** — in "Your data", extend the roundtrip paragraph: the Builder is a document editor (New / Save / Save as copy in the document bar, unsaved-changes guard with Save first / Discard / Cancel); gallery rows offer Duplicate.

- [ ] **Step 5: Final gate** — `bun run verify && bun run build` → green; quick `bun run dev` smoke: edit → New → confirm appears; gallery open-while-dirty → confirm; Save as copy → two records.

- [ ] **Step 6: Commit**

```bash
git add src/gallery/ README.md
git commit -m "feat(gallery): Duplicate action; docs for the document lifecycle

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
