# App-chrome visual refresh — P0 (token-level, cards untouched)

**Date:** 2026-08-04 · **Status:** proposed (audit + direction chosen 2026-08-04)

## Context

A design pass over the running app (Builder + Gallery, captured at 1512×945) found the
**cards look premium** — real art, gold pinlines, letterpress type, essence palettes,
holo foil, print-faithful export — while the **app chrome around them reads like a dev
tool**. The gap between the two is what makes the product feel like a hobby project.

Root causes, all in the chrome (not the cards):

1. **Two design languages fight.** `src/app/theme.css:34` runs a "neobrutalism" system
   (pure-black borders `--border:#000`, hard 3px offset shadow `--shadow: 3px 3px 0 0
   #000`, hover "bounce") on top of a dark fantasy palette (navy/gold/parchment).
   Neobrutalism pops on light canvases; on the near-black surface the **black offset
   shadow renders black-on-black — invisible**. We pay for the style (hard borders,
   everything caged in outlines, a hover jump) and never see its payoff.
2. **The tool wears the card's costume.** Utilitarian chrome labels (CARD, THEME,
   LAYOUT, DETAILS, CHAT, the empty-state prompt, gallery captions) are set in **Cinzel**,
   the card's ceremonial display serif. Using the artifact's font for the tool's labels
   is the strongest "costume, not product" tell.
3. **Two of everything.** Colors are defined twice under two naming systems that carry
   the *same* hexes: neobrutalism (`--main/--background/--secondary-background/
   --foreground`) and semantic (`--color-accent/--color-surface/--color-panel/
   --color-ink`). This duplication is why styling silently drifts.

**Chosen direction (user, 2026-08-04): "P0 quick wins" only** — the safe, mostly-deletion
subset, done at the token level in `theme.css` plus a font-class swap on chrome labels.
No button/gallery/layout redesign yet; re-evaluate after seeing it. A full "quiet premium
dark UI" redirection and the P1/P2 items (button hierarchy, gallery tiles, column
rebalance) are explicitly deferred.

## Scope

- **In:** `src/app/theme.css` token rewrite; remove `font-display` from six chrome
  labels; neutralise the hover bounce via tokens; consolidate the two token systems to a
  single source of truth; visible focus ring for `ring-ring` consumers.
- **Out (unchanged):** every file under `src/cards/**` (the card artifact and its Cinzel
  usage); the `CARTIS` wordmark; all component structure/layout; the button, gallery,
  input, tabs, switch *components* (they inherit the token changes but are not edited).

## Decisions (locked)

1. **Elevation is soft ambient shadow, not a hard offset.** `--shadow` becomes a
   two-layer ambient shadow. The neobrutalist offset spacings pin to `0` so the button
   hover utilities (`translate-x-boxShadowX …` in `button.tsx`) become no-ops **without
   editing `button.tsx`** — the bounce dies at the token layer.
2. **Borders soften from pure black to the existing edge color.** `--border` aliases
   `--color-edge` (`#303752`), so `border-border` and `border-edge` render identically
   and the black cages disappear. Border *width* (`border-2`) is unchanged in P0.
3. **One source of truth for color.** The seven `--color-*` values in the plain `@theme`
   block are the only literals; the neobrutalism-era `:root` names alias them via
   `var()`. A hex is defined exactly once; both utility namespaces (`bg-main` and
   `bg-surface`, etc.) keep working and resolve to the same value.
4. **Cinzel is reserved for the wordmark and the cards.** Chrome labels drop
   `font-display` and inherit `--font-body` (system sans). Kept as Cinzel: the `CARTIS`
   wordmark (`AppShell.tsx:37`) and everything in `src/cards/**`.
5. **Focus becomes visible.** `--ring` changes from cream (`#e8e4d8`) to the gold accent,
   fixing the invisible focus ring for `ring-ring` consumers (e.g. `src/ui/inputs.tsx`).

## Change 1 — Chrome typography (Cinzel → sans)

Remove `font-display` from these six chrome labels (each inherits `--font-body` from the
`font-body` root in `AppShell`):

| File:line | Element | Before → After |
|---|---|---|
| `src/ui/layout.tsx:23` | Panel section titles (CARD/THEME/LAYOUT/DETAILS) | `font-display text-sm uppercase tracking-widest` → `text-sm uppercase tracking-widest` |
| `src/chat/ThreadPanel.tsx:50` | "CHAT" header label | `font-display text-accent text-sm tracking-widest` → `text-accent text-sm tracking-widest` |
| `src/chat/ThreadPanel.tsx:55` | Empty-state prompt ("What should this card become?") | `text-center font-display text-ink text-lg` → `text-center text-ink text-lg` |
| `src/gallery/GalleryView.tsx:210` | Tile card caption | `truncate font-display text-sm` → `truncate text-sm` |
| `src/gallery/GalleryView.tsx:281` | List card caption | `max-w-full truncate font-display text-sm` → `max-w-full truncate text-sm` |

**Kept as Cinzel (do not touch):** `src/app/AppShell.tsx:37` (`CARTIS` wordmark) and all
`font-display` in `src/cards/arcane/{parts.tsx,ArcaneFullArtCard.tsx,ArcaneCardBack.tsx}`.

**Optional refinement (recommended, still P0):** for a quieter "pro tool" section label,
also give the Panel titles `text-ink-dim font-semibold`. Flagged, not required — decide at
implementation from the screenshot.

**Judgment call:** the empty-state prompt in sans loses a small brand moment. Default is
sans (consistency wins); keeping it Cinzel is an acceptable one-line deviation.

## Change 2 & 3 — Token rewrite (`src/app/theme.css`, lines 34–87)

Replace the current `:root` + `@theme inline` + `@theme` blocks with the following. This
is the whole of changes 2 (elevation/borders) and 3 (consolidation), plus decision 5.

```css
/* ---- app chrome tokens (cards keep their own tokens; see src/cards/*) ----

   Single source of truth: the seven --color-* values in the plain @theme block
   below. Every other name (neobrutalism-era --main/--background/… and the Tailwind
   --color-* utilities) ALIASES those, so a hex is defined exactly once.

   Elevation is a soft ambient shadow, not a hard offset — the old 3px drop-shadow
   rendered black on near-black (invisible) and only produced a hover "bounce". The
   box-shadow offset spacings are pinned to 0 so the button hover utilities
   (translate-x-boxShadowX …) become no-ops WITHOUT editing button.tsx. */
:root {
  --border-radius: 5px;
  --heading-font-weight: 700;
  --base-font-weight: 500;

  /* offsets neutralised (were 3px / -3px) — kills the hover translate bounce */
  --box-shadow-x: 0px;
  --box-shadow-y: 0px;
  --reverse-box-shadow-x: 0px;
  --reverse-box-shadow-y: 0px;

  /* neobrutalism-era aliases → the @theme --color-* single source */
  --background: var(--color-surface);
  --secondary-background: var(--color-panel);
  --foreground: var(--color-ink);
  --main: var(--color-accent);
  --main-foreground: var(--color-surface);
  --border: var(--color-edge);        /* was #000000 — pure-black cages gone */
  --ring: var(--color-accent);        /* was #e8e4d8 — visible gold focus ring */
  --overlay: rgba(0, 0, 0, 0.8);

  /* soft ambient elevation (was: 3px 3px 0 0 var(--border)) */
  --shadow: 0 1px 2px rgb(0 0 0 / 0.45), 0 6px 18px rgb(0 0 0 / 0.28);
}

@theme inline {
  --color-main: var(--main);
  --color-background: var(--background);
  --color-secondary-background: var(--secondary-background);
  --color-foreground: var(--foreground);
  --color-main-foreground: var(--main-foreground);
  --color-border: var(--border);
  --color-overlay: var(--overlay);
  --color-ring: var(--ring);

  --spacing-boxShadowX: var(--box-shadow-x);
  --spacing-boxShadowY: var(--box-shadow-y);
  --spacing-reverseBoxShadowX: var(--reverse-box-shadow-x);
  --spacing-reverseBoxShadowY: var(--reverse-box-shadow-y);

  --radius-base: var(--border-radius);
  --shadow-shadow: var(--shadow);
  --font-weight-base: var(--base-font-weight);
  --font-weight-heading: var(--heading-font-weight);
}

@theme {
  --color-surface: #14161f;
  --color-panel: #1d2130;
  --color-edge: #303752;
  --color-ink: #e8e4d8;
  --color-ink-dim: #9aa0b5;
  --color-accent: #d9a441;
  --color-accent-soft: #8a6a2f;
  --font-display: "Cinzel", "Iowan Old Style", Palatino, Georgia, serif;
  --font-body: ui-sans-serif, system-ui, sans-serif;
  --font-card: "EB Garamond", "Iowan Old Style", Georgia, serif;
}
```

Unchanged: the `@font-face` block above line 34, and the `.chat-md`, `@utility holo-foil`,
`@utility holo-etched` blocks below line 87.

### Why the hover bounce dies without touching `button.tsx`

`button.tsx:14,17` (default/neutral) do `hover:translate-x-boxShadowX
hover:translate-y-boxShadowY hover:shadow-none`; `:19` (reverse) does the inverse. Those
translate utilities read `--spacing-boxShadow*`, which map to `--box-shadow-x/y`. Pinning
those to `0px` makes the translate a no-op. `hover:shadow-none` then simply removes the
(now soft) rest shadow on hover — a subtle "press", not a 3px jump. `--shadow` no longer
references the offset spacings, so zeroing them does not affect the rest elevation.

## Non-goals (deferred; discovered during the audit)

- **Button hierarchy + one button component.** Two implementations exist
  (`src/components/ui/button.tsx` variants vs `src/ui/Button.tsx` tones) — consolidate in
  P1.
- **shadcn hardcoded focus ring.** `button.tsx:9` hardcodes `focus-visible:ring-black
  ring-offset-white` (invisible ring + white halo on dark). Decision 5 fixes only
  `ring-ring` consumers; the shadcn components need a component edit → P1.
- **State-as-label toggles** ("Holo: off", "Show back", "Bleed + marks: off") → real
  toggles/segmented controls in P1.
- **Gallery tiles** (metadata, hover-reveal actions, demote the loud red Delete) → P1.
- **Layout rebalance** (center column wastes space; form cramped; header 85% empty;
  de-box form sections; style resize handles/scrollbars) → P2.
- **Border width** `border-2` → `border` (1px) is a component-level change → P1.

## Risks & mitigations

1. **Tailwind v4 `@theme` var-chaining.** The `:root` aliases reference `--color-*`
   emitted by `@theme`; utilities chain through `var()`. CSS resolves custom properties
   at use-time regardless of declaration order, and `vite build` only bundles CSS (no
   static color math), so this resolves in-browser. *Mitigation:* the verification step
   below confirms `bg-surface`, `bg-main`, `border-border`, `border-edge`, `bg-panel`,
   `text-accent` all render the intended color, and that `bun run build` succeeds.
2. **Tests asserting on `font-display`/class strings.** `gallery.test.tsx`,
   `ThreadPanel.test.tsx`, `ui.test.tsx`, `builder.test.tsx` likely query by role/text,
   but if any assert the removed class they must be updated. *Mitigation:* `bun run
   verify` in the plan; fix assertions to match the new class list.
3. **Soft shadow on tiny chips.** `shadow-shadow` is used on small pills/chips
   (`Composer.tsx`, `MessageView.tsx`, `ThreadPanel.tsx`). The two-layer ambient shadow
   is deliberately restrained (`0 1px 2px` + `0 6px 18px`) to stay subtle at small sizes;
   confirm visually. If a chip looks over-shadowed, that's a P1 per-component tweak, not a
   token change.

## Execution plan

1. Edit `src/app/theme.css` lines 34–87 to the block above (changes 2, 3, decision 5).
2. Remove `font-display` from the six chrome labels in Change 1 (leave wordmark + cards).
3. `bun run check` (biome auto-fix) then `bun run verify` (biome ci + tsc + vitest); fix
   any class-assertion fallout.
4. Visual verification (below); capture Builder + Gallery to compare against the audit
   "before".

## Verification (binding)

- `bun run verify` passes (biome ci + `tsc --noEmit` + vitest).
- `bun run build` succeeds (Tailwind emits all utilities; no unresolved var).
- Dev-server screenshots (`bun run dev`, 1512×945), Builder and Gallery:
  - Chrome labels (CARD/THEME/LAYOUT/DETAILS/CHAT/captions) render in **sans**; the
    `CARTIS` wordmark and every card face stay **Cinzel**.
  - Panels/buttons/inputs show **soft ambient shadow + `#303752` edges**, no black cages.
  - Buttons do **not** jump on hover.
  - Focus-ringing a `src/ui/inputs.tsx` field shows a **visible gold ring**.
  - The card render is **pixel-identical** to before (cards untouched).

## Repo standards

Standard repo discipline applies (spec:
`docs/superpowers/specs/2026-08-03-type-safety-and-contract-hardening-design.md`): no
`any`/`!`/`as`-on-external-data. These are CSS-token and className edits only — no schema,
contract, or Effect-boundary surface changes.
