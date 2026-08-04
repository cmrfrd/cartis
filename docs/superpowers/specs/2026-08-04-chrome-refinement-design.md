# App-chrome refinement & polish (cards untouched)

**Date:** 2026-08-04 · **Status:** proposed (audit + direction chosen 2026-08-04)

## Context

A design pass over the running app (Builder + Gallery, captured at 1512×945) found the
**cards look premium** — real art, gold pinlines, letterpress type, essence palettes,
holo foil, print-faithful export — while the **app chrome around them reads like a dev
tool**. The gap between the two is what makes the product feel like a hobby project. The
goal of this work is to make the chrome feel **refined and polished** so it disappears and
lets the cards be the hero.

Root causes, all in the chrome (not the cards):

1. **Two design languages fight.** `src/app/theme.css:34` runs a "neobrutalism" system
   (pure-black borders `--border:#000`, hard 3px offset shadow `--shadow: 3px 3px 0 0
   #000`, hover "bounce") on top of a dark fantasy palette. On the near-black surface the
   black offset shadow renders **black-on-black — invisible**: we pay for the style (hard
   borders, caged boxes, a hover jump) and never see its payoff.
2. **The tool wears the card's costume.** Utilitarian chrome labels (CARD, THEME, LAYOUT,
   DETAILS, CHAT, captions, the empty-state prompt) are set in **Cinzel**, the card's
   ceremonial display serif — the strongest "costume, not product" tell.
3. **Inconsistency from duplication.** Colors are defined twice under two naming systems
   with the *same* hexes (`--main`≡`--color-accent`, …). Interactive elements have
   **no consistent state model** (hover/focus/active/disabled), **mismatched control
   heights** (`Input` `h-10` vs `SelectInput` ≈`h-8`), **two focus-ring treatments**
   (`ring-black` vs `ring-ring`, plus `ring-offset-white` halos on a dark bg), **three
   destructive-color treatments** (`text-danger` [undefined], `text-red-400`,
   `text-red-300`), fake toggles (a button whose label is its state), raw browser
   scrollbars, and sparse/uneven motion.

## Scope & principles

- **In:** the app chrome — `src/app/theme.css`, `src/components/ui/*`, `src/ui/*`,
  `src/builder/*`, `src/gallery/*`, `src/chat/*`, `src/export/*`, `src/images/*`.
- **Out (unchanged pixels):** everything under `src/cards/**` (the card artifact + its
  Cinzel/EB-Garamond usage) and the `CARTIS` wordmark. The card render must stay
  pixel-identical through every phase.
- **Principle — recede, don't decorate.** The chrome is a neutral dark instrument; the
  card is the only ornamented thing on screen. Accent (gold) is used *sparingly* — one
  primary action + active state per zone.
- **Principle — systemic over piecemeal.** Define foundations (tokens for elevation,
  state, motion, sizing) once, then apply them; don't hand-tune each element.

## Phases (each independently shippable)

| Phase | Theme | Risk | Touches |
|---|---|---|---|
| **P0** | Token pass (fonts, soften, consolidate) | Very low | `theme.css` + 6 label swaps |
| **P1** | Component refinement (buttons, inputs, focus, toggles, danger, scrollbars) | Low | `components/ui/*`, `ui/*`, `theme.css` |
| **P2** | Screen layout & structure (Builder, Gallery, Chat) | Medium | view files |
| **P3** | Micro-polish & motion (transitions, states, empty/loading, iconography) | Low | broad, shallow |

P0 stays the safe first step and is fully specified below; P1–P3 are specified to
intent + concrete before→after, and each gets a short plan doc at implementation time.

---

## Design foundations (define once, in `src/app/theme.css`)

These tokens/conventions are introduced across P0–P1 and are the vocabulary the rest of
the plan references.

- **Color — single source of truth.** Seven `--color-*` values are the only literals;
  every other name aliases them (see P0 block). Add semantic **state + status** tokens:
  - `--color-danger: #e5726b` (muted terracotta-red; harmonises with the warm palette),
    `--color-danger-strong: #d64f4f` (solid destructive fill). Replaces `text-danger`
    [undefined], `text-red-400`, `text-red-300` — **one** destructive color everywhere.
  - `--color-hover: rgb(255 255 255 / 0.05)` (subtle raise for ghost/hover surfaces),
    `--color-active: rgb(255 255 255 / 0.09)` (pressed). Filled (gold) controls shift via
    `--color-accent-hover` / `--color-accent-active` instead of a neutral overlay.
- **Elevation.** Surfaces carry meaning by tint, not by hard shadow: `surface` (app base)
  → `panel` (raised) → hover/active tints. Shadow is a soft ambient
  (`--shadow`, P0) reserved for genuinely floating things (composer, popovers, dialogs) —
  not every chip.
- **Radius scale.** `--radius-base` 5–6px for controls/inputs; `rounded-lg` (8px) for
  cards/tiles; `rounded-full` for pills/switch/icon-buttons; `rounded-2xl` reserved for
  the chat composer (deliberate ChatGPT-style shape). No other ad-hoc radii.
- **Control height.** One compact form-control height: **`h-9` (36px)** for
  `input` / `select` / `textarea`(min) / `sm` buttons, so fields and buttons align on a
  row. (Fixes the current `h-10` vs `h-8` mismatch.)
- **Focus.** Exactly one focus treatment, visible on dark:
  `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2
  focus-visible:ring-offset-surface` where `--ring` = gold accent. Removes every
  `ring-black` and `ring-offset-white`.
- **Motion.** Interactive elements transition `colors`/`background`/`border`/`opacity`
  over **150ms ease** on hover/focus/active. Convention: `transition-colors
  duration-150`. No layout-affecting transitions (no `transition-all` that animates size).
- **Type scale (chrome).** Sans (`--font-body`). Section labels: `text-xs uppercase
  tracking-wide text-ink-dim font-semibold`. Body `text-sm text-ink`. Meta `text-[11px]
  text-ink-dim`. Cinzel only for the wordmark + cards.

### Interaction states — every interactive element implements this

Live feedback on pointer/keyboard is a hallmark of polish. Two states people conflate:
**hover** = transient ("this is interactive / you're pointing at it"), subtle and
temporary; **selected/active** = persistent ("this is the current choice" — active tab,
Tiles·List toggle, toggled switch), stronger and it stays. Keep them visually distinct.
Every interactive element implements the row below, driven by the *same* tokens and the
*same* 150ms ease — that sameness is what makes the whole app feel like one mind.

| Element | Hover (transient) | Focus-visible | Pressed (active) | Selected (persistent) | Disabled |
|---|---|---|---|---|---|
| Primary (gold) button | `bg-accent-hover` | gold ring | `bg-accent-active` | — | `opacity-50`, no hover |
| Secondary / ghost / icon button | `bg-[--color-hover]` + `text-ink` | gold ring | `bg-[--color-active]` | — | `opacity-50` |
| Tab / view toggle (Tiles·List) | inactive → `bg-[--color-hover]` | gold ring | — | gold fill + dark text | `opacity-50` |
| Switch | track brightens | gold ring | — | `bg-main` + thumb slid | `opacity-50` |
| Input / Select / Textarea | `border-ink-dim/40` | gold ring | — | (focused = editing) | `opacity-50` |
| Gallery tile | `scale-[1.02]` + border brighten + actions reveal | ring on open button | `scale-[0.99]` | open card marked in Builder | — |
| List row / menu item | `bg-[--color-hover]` | ring | `bg-[--color-active]` | — | — |
| Link (chat markdown) | brighten accent | ring | — | — | — |

- **Subtle is the point.** A 5–9% tint or one step of gold — "changes slightly" is exactly
  right; overshoot reads as cheap/flickery.
- **Timing.** `transition-colors duration-150` (and `duration-150` on the tile transform),
  eased. Wrap transforms in `motion-safe:` so `prefers-reduced-motion` users still get the
  colour feedback but skip the scale.
- **Precedent to generalise.** The composer `+` button already nails this
  (`Composer.tsx:55` — `hover:bg-secondary-background hover:text-ink transition-colors`);
  every ghost/icon control should feel like that.
- **Enforced by construction.** The matrix lives in the canonical primitives (§Cohesion)
  and every state is rendered in the `/styleguide` catalog — so no control ever ships dead
  and feedback-less, and hover/pressed/selected can be eyeballed side by side.

---

## Cohesion & governance — how the system stays "one mind"

Cohesion is a property of **constraints, not vigilance**: the UI reads as one style when
every element is forced through the same small set of decisions and it is *hard* to
diverge. Three layers, each with a concrete mechanism in this repo. Foundations make the
style explicit; the canonical surface makes it the *only* option; the guard + catalog +
docs keep it that way — so cohesion stops depending on anyone remembering to be consistent.

### 1. One source of truth (foundations as a contract)
The tokens above are the whole style encoded as data. **Rule:** no raw hex and no
arbitrary Tailwind values (`text-[#…]`, `rounded-[9px]`, `bg-[…]`) in chrome — semantic
token utilities only (`bg-panel`, `text-danger`, `rounded-base`). `src/cards/**` is exempt
(the card art legitimately uses bespoke values and is its own closed system).

### 2. One canonical vocabulary (one public component surface)
Today there are **two Buttons** (`src/components/ui/button.tsx` + `src/ui/Button.tsx`) and
**two folders** (`src/components/ui/*` shadcn primitives + `src/ui/*` app components),
imported inconsistently — the single biggest cohesion risk.
- **Boundary rule:** `src/components/ui/*` are private primitives; **`@/ui` is the only
  app-facing surface.** App code (builder/gallery/chat/export/images) imports from `@/ui`
  exclusively; only `@/ui` reaches into `@/components/ui`.
- **Closed APIs, no escape hatches:** components expose a fixed `variant`/`tone` set, not
  free `className` color overrides. Remove `Button`'s `className={… 'text-red-400'}`
  (`ui/Button.tsx:26`) — `danger` is a variant, not a per-call hack.
- **The canonical set** (everything composes from these; anything new joins the set,
  never inline): `Button`, `Input`, `Select`, `Textarea`, `Switch`, `SegmentedControl`,
  `Tabs`, `Card`/`Panel`, `SectionHeader`, `Chip`/`Badge`, `EmptyState`, `Spinner`,
  `IconButton`, and layout primitives (`Stack`/`Row`/`Grid`).

### 3. The immune system (catch drift automatically + make it visible)
- **CI token-guard** — a check in `bun run verify` that fails when chrome files (`src/**`
  minus `src/cards/**` and `theme.css`) match arbitrary-value/hex patterns (`-\[#`,
  `text-red-`, `bg-red-`, `rounded-\[`, `text-\[[0-9]`) or import `@/components/ui`
  outside `@/ui`. This is what maintains cohesion as new code lands.
- **Living catalog** — a dev-only `/styleguide` route (cheap: routing already exists) that
  renders **every primitive × every state** (rest/hover/focus/active/disabled) on one
  screen. Cohesion becomes eyeball-checkable; new primitives must appear here.
- **Written intent** — a one-page `docs/design/principles.md` (personality: "recede, don't
  decorate; accent sparingly; the card is the only ornament" + the rules) so humans and
  agents decide alike, plus a UI **definition of done** checklist (uses tokens · canonical
  primitive · all states · one focus ring · type scale) every new component/screen passes.

### Mapping to current gaps
| Gap (today) | Mechanism that closes it |
|---|---|
| Two Buttons, two ui folders, mixed imports | Boundary rule: `@/ui` is the only surface (P1) |
| `text-red-400` / `red-300` / undefined `danger` | One `--color-danger` + `danger` variant (P0/P1) |
| Ad-hoc radii (`rounded-2xl`/`-lg`/`-[9px]`) | Radius scale + token-guard bans arbitrary values |
| Two focus rings + white halos | One focus treatment in foundations (P1) |
| Drift in future PRs | CI token-guard + `/styleguide` + principles/DoD |

---

## Phase 0 — Token pass (VERY LOW risk; the safe quick win)

### P0.1 Chrome typography (Cinzel → sans)

Remove `font-display` from these six chrome labels (each then inherits `--font-body`):

| File:line | Element | Before → After |
|---|---|---|
| `src/ui/layout.tsx:23` | Panel section titles (CARD/THEME/LAYOUT/DETAILS) | `font-display text-sm uppercase tracking-widest` → `text-xs uppercase tracking-wide text-ink-dim font-semibold` |
| `src/chat/ThreadPanel.tsx:50` | "CHAT" header label | `font-display text-accent text-sm tracking-widest` → `text-accent text-sm tracking-widest` |
| `src/chat/ThreadPanel.tsx:55` | Empty-state prompt | `text-center font-display text-ink text-lg` → `text-center text-ink text-lg` |
| `src/gallery/GalleryView.tsx:210` | Tile/list card caption | `truncate font-display text-sm` → `truncate text-sm font-medium` |
| `src/gallery/GalleryView.tsx:281` | Tile card caption | `max-w-full truncate font-display text-sm` → `max-w-full truncate text-sm font-medium` |

**Kept as Cinzel:** `src/app/AppShell.tsx:37` (`CARTIS` wordmark) + all `font-display` in
`src/cards/arcane/*`. **Judgment call:** the empty-state prompt in sans loses a small brand
moment; keeping it Cinzel is an acceptable one-line deviation.

### P0.2 + P0.3 Token rewrite — soften elevation/borders + consolidate

Replace `src/app/theme.css` lines 34–87 with:

```css
/* ---- app chrome tokens (cards keep their own tokens; see src/cards/*) ----

   Single source of truth: the --color-* values in the plain @theme block below.
   Every other name (neobrutalism-era --main/--background/… and the Tailwind
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
  --color-accent-hover: #e4b45c;    /* NEW — filled-button hover (lighter gold) */
  --color-accent-active: #c69337;   /* NEW — filled-button pressed (darker gold) */
  --color-danger: #e5726b;          /* NEW — one destructive color */
  --color-danger-strong: #d64f4f;   /* NEW — solid destructive fill */
  --color-hover: rgb(255 255 255 / 0.05);   /* NEW — ghost hover raise */
  --color-active: rgb(255 255 255 / 0.09);  /* NEW — pressed */
  --font-display: "Cinzel", "Iowan Old Style", Palatino, Georgia, serif;
  --font-body: ui-sans-serif, system-ui, sans-serif;
  --font-card: "EB Garamond", "Iowan Old Style", Georgia, serif;
}
```

Unchanged: the `@font-face` block above line 34 and the `.chat-md` / `@utility holo-*`
blocks below line 87. **Why the hover bounce dies without touching `button.tsx`:** its
`hover:translate-x-boxShadowX …` utilities read `--spacing-boxShadow*` → `--box-shadow-*`,
now `0px`, so the translate is a no-op; `--shadow` no longer references those spacings.

---

## Phase 1 — Component refinement (LOW risk)

Systemic states + one of each control. All within `src/components/ui/*` and `src/ui/*`.

### P1.1 Buttons — one system, real hierarchy
- **Consolidate** the two implementations. `src/ui/Button.tsx` becomes the single app
  entry; keep the shadcn `src/components/ui/button.tsx` as its primitive but give it a
  proper variant set: `primary` (gold fill), `secondary` (panel fill, edge border),
  `ghost` (no border; `hover:bg-[--color-hover]`), `danger` (real: `text-danger`,
  `hover:bg-danger/10`; `danger-solid` = `bg-danger-strong text-white` for confirm
  dialogs). Remove `text-red-400` (`Button.tsx:26`).
- Hover = background/brightness shift (not the removed translate). Add `active:` pressed
  state (`active:bg-[--color-active]` / slight `active:brightness-95`).
- Fix base focus ring: `button.tsx:9` `ring-black … ring-offset-white` →
  `ring-ring … ring-offset-surface`.

### P1.2 Inputs / selects / textarea — align + state
- One height (`h-9`) and one padding across `components/ui/input.tsx`,
  `components/ui/textarea.tsx`, and `ui/inputs.tsx` `SelectInput` (currently `py-1.5`).
- One focus ring (foundations) — replace `input.tsx:11` `ring-black … ring-offset-2` and
  the select's ring. Add `hover:border-ink-dim/40` rest→hover feedback.
- `SelectInput`: add a custom chevron (lucide `ChevronDown`, `appearance-none`) so the
  native arrow doesn't clash on dark.

### P1.3 Real toggles (kill state-as-label buttons)
Replace the three fake toggles with the `Switch` + a label, or a 2-option segmented
control:
- `src/export/ExportBar.tsx:118` "Bleed + marks: on/off" → `Switch` + "Bleed + marks".
- `src/builder/BuilderView.tsx:577` "Holo: on/off" → `Switch` + "Holo".
- `src/builder/BuilderView.tsx:580` "Show front/back" → segmented `[Front | Back]`.

### P1.4 Switch / Tabs polish
- `switch.tsx`: thumb `bg-white` → `bg-ink` (off-white, less harsh on dark); keep sizes.
- `tabs.tsx`: remove `ring-offset-white` (→ `ring-offset-surface`); trigger label
  `font-heading` (700) → `font-medium`; inactive trigger gets `hover:bg-[--color-hover]`.

### P1.5 Destructive color + scrollbars (systemic)
- Apply `--color-danger` everywhere destructive: `Composer.tsx:128`, `MessageView.tsx:192,
  321` (already reference `danger` — now defined), `PhotoPicker.tsx:61` (`red-300` →
  `danger`).
- Add custom thin scrollbars in `theme.css` (webkit + `scrollbar-width`/`scrollbar-color`)
  scoped to the app: ~10px, `--color-edge` thumb on transparent track, brighter on hover.
  Fixes the raw light scrollbars visible in the audit screenshots.

---

## Phase 2 — Screen layout & structure (MEDIUM risk)

### P2.1 Builder — rebalance & de-box (`BuilderView.tsx`, `ui/layout.tsx`)
- **Columns:** the preview `section` is `flex-1` and just centers a fixed card, so it
  balloons while the form is a cramped `w-96` rail (`BuilderView.tsx:502,569`). Give the
  form more room (`w-[380px]`→`w-[420px]` or `lg:w-[30%] max-w-[460px]`) and cap the
  preview column (`max-w-[720px] mx-auto`) so the card isn't marooned in dead space.
- **De-box the form:** `Panel` (`ui/layout.tsx:18`) currently wraps every section in a
  bordered `Card`. Switch form sections to header + hairline divider (`border-edge`) +
  spacing — not nested boxes. (Keep `Card` for genuinely elevated things.)
- **Preview vs output controls** (`BuilderView.tsx:576`, `ExportBar.tsx`): separate the
  two intents. Preview toggles (Holo, Front/Back) become a small toolbar attached under
  the card; Export becomes a distinct grouped block (segmented format selector + DPI +
  bleed switch), not a loose row of equal ghost buttons.
- **Status** (`DocumentBar`, `BuilderView.tsx:460`): the "● Unsaved / Saved / New card"
  text becomes a small pill/badge with a state color (amber dot for unsaved).

### P2.2 Header (`AppShell.tsx:36`)
The header is ~85% empty. Either slim its height, or use the space: open-card title/
breadcrumb on the left of the tabs, save-state and a compact action (New) on the right.
Keep the wordmark (Cinzel) as the only serif.

### P2.3 Gallery (`GalleryView.tsx`)
- **Tiles → uniform responsive grid:** `flex flex-wrap` of `w-fit` tiles
  (`GalleryView.tsx:266`) → a CSS grid with consistent column width so tiles align.
- **Hover-reveal actions + demote Delete:** `CardActions` (Open/Duplicate/Delete) are
  always visible and equal weight, with a loud red Delete (`GalleryView.tsx:191`). Reveal
  actions on tile hover/focus; make Open the primary affordance (tile already opens on
  click — keep, add a visible "Open" only on hover); move Delete into a quiet `⋯` overflow
  or an icon with the new muted danger color + confirm.
- **Metadata parity:** tiles show only the name; the list shows `theme · layout · date`
  (`GalleryView.tsx:211`). Add the same meta line under tiles.

### P2.4 Chat (`ThreadPanel.tsx`, `Composer.tsx`, `MessageView.tsx`)
- Composer already close (pill, good hover on `+`): unify its border/shadow with the new
  soft tokens; keep `rounded-2xl`.
- Empty state: pair the (now-sans) prompt with 2–3 example-prompt chips to seed intent.
- Tool-call chips (`card_patch`, `card_generate_art`, …) get one consistent chip style
  (icon + label + status), aligned to the new tokens.

---

## Phase 3 — Micro-polish & motion (LOW risk, broad/shallow)

- **Motion:** apply the 150ms transition convention to all interactive elements
  (buttons, inputs, tabs, tiles, icon-buttons) that currently lack hover/focus feedback.
- **Focus-visible audit:** every interactive element reachable by keyboard shows the one
  gold ring; no element uses `ring-black`/`ring-offset-white`.
- **Empty & loading states:** consistent treatment (`EmptyState` for empties; `Spinner`
  or subtle skeletons for loading — gallery tiles, image library, art generation).
- **Iconography:** replace text/emoji glyphs with lucide — the `✶` portrait placeholder
  (`BuilderView.tsx:539`), and any check/arrow drawn with characters. Consistent
  `size-4`/`size-5`.
- **Placeholder & selection:** `placeholder:text-ink-dim/60`, selection `bg-accent/30` —
  applied uniformly.
- **Cursor & disabled:** `cursor-pointer` on all buttons/toggles; `disabled:opacity-50
  disabled:cursor-not-allowed` uniform.

---

## Non-goals (this spec is chrome-only)

- No changes to any `src/cards/**` render, the card frame, essence palettes, holo, or the
  export pipeline. Card pixels are invariant.
- No new user-facing features or data model changes. The one sanctioned addition is a
  **dev-only `/styleguide` catalog route** (governance; ships nothing to users). Purely
  visual/interaction refinement otherwise.
- No component-library swap (stays Tailwind v4 + Radix + CVA + lucide).

## Risks & mitigations

1. **Tailwind v4 `@theme` var-chaining.** `:root` aliases reference `--color-*` emitted by
   `@theme`; utilities chain through `var()`, which CSS resolves at use-time regardless of
   order, and `vite build` only bundles CSS. *Mitigation:* verification confirms
   `bg-surface`/`bg-main`/`border-border`/`border-edge`/`text-danger` render correctly and
   `bun run build` succeeds.
2. **Tests asserting on class strings / `font-display`.** `gallery.test.tsx`,
   `ThreadPanel.test.tsx`, `ui.test.tsx`, `builder.test.tsx`, `export.test.tsx` — update
   any assertion that names a removed class. *Mitigation:* `bun run verify` each phase.
3. **Real toggles change the a11y tree** (button → switch role). *Mitigation:* update
   tests that query the old toggle by its text label ("Holo: off" etc.).
4. **Layout rebalance (P2) is the only medium-risk change** — do it behind its own plan
   doc with before/after screenshots at 3 widths (1280/1512/1920).

## Execution plan

Ship phase-by-phase; each ends green.
1. **P0** — `theme.css` rewrite + 6 label swaps → `bun run check` → `bun run verify` →
   screenshot Builder + Gallery.
2. **P1** — buttons/inputs/toggles/switch/tabs/danger/scrollbars; enforce the `@/ui`-only
   import boundary + remove `className` color escape hatches → `verify` → screenshot.
3. **Governance** (land with P1, before P2 widens the surface) — CI token-guard in
   `verify`; dev-only `/styleguide` catalog route; `docs/design/principles.md` + UI
   definition-of-done checklist.
4. **P2** — Builder rebalance, header, Gallery tiles, chat (own plan doc) → `verify` →
   screenshots at 3 widths.
5. **P3** — motion/focus/empty-loading/iconography sweep → `verify` → screenshot.

## Verification (binding, every phase)

- `bun run verify` (biome ci + `tsc --noEmit` + vitest) and `bun run build` pass.
- Dev-server screenshots (`bun run dev`, 1512×945), Builder + Gallery, compared to the
  audit "before":
  - Chrome is sans; wordmark + card faces stay Cinzel.
  - Soft ambient shadow + `#303752` edges; no black cages; no hover jump.
  - One visible gold focus ring on every control; no white halo.
  - One destructive color; error strips are actually styled.
  - Subtle hover + pressed feedback on every button, tab, toggle and tile; selected states
    are visibly distinct from hover.
  - **The card render is pixel-identical to before.**
- Governance (from P1 on): the token-guard **fails** on a planted `text-[#fff]` or
  `@/components/ui` import in a chrome file and **passes** clean; `/styleguide` renders
  every canonical primitive across all states on one screen.

## Repo standards

Standard discipline applies (spec: `.../2026-08-03-type-safety-and-contract-hardening-design.md`):
no `any`/`!`/`as`-on-external-data. These are CSS-token, className, and small-component
edits — no schema, contract, or Effect-boundary changes.
