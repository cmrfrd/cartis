# Cartis Card Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local browser app ("Cartis") for building custom trading cards — an MTG-inspired starter card kit, a live form-driven builder, an AI image pipeline (webcam/upload → stylized portrait, stubbed offline), a free-edit TSX code lab with an opencode-powered AI assistant, history/gallery, and print-quality PNG/WebP/JPEG export.

**Architecture:** A Vite + Tailwind single-page app whose state lives entirely in expressive-mvc `State`/`Component` classes (React exists only as the hidden render substrate). Card styles are "kits": libraries of composable TSX components plus registered "templates" (form schema + renderer) — the static Builder renders forms from a template's schema, while the Code Lab compiles user TSX in-browser with sucrase against the same kit library. Server-only concerns (opencode agent, Replicate image API) live in a Vite dev-server middleware plugin; persistence is a hand-rolled typed IndexedDB wrapper.

**Tech Stack:** bun 1.3+, TypeScript (strict), Vite 8, Tailwind CSS 4 (`@tailwindcss/vite`), `@expressive/react` 0.83, CodeMirror 6, sucrase, html-to-image, `@opencode-ai/sdk` (dev-server side), Vitest 4 + happy-dom + fake-indexeddb, Biome (lint + format).

## Global Constraints

Copied from the spec — every task implicitly includes these:

- Stack is exactly "bun + typescript + tailwind + vite" plus expressive (https://expressive.dev / gabeklein/expressive-mvc).
- "**do not use react** use expressive": no `useState`/`useEffect`/any React hook, no `React.Component` subclassing, no react imports in app code. All state lives in expressive `State`/`Component` classes. Sanctioned React substrate uses, exactly four: (1) `react-dom/client` `createRoot` in `src/main.tsx` and in `test/util.tsx`, (2) type-only imports `import type { ReactNode, ComponentType } from 'react'`, (3) the invisible `react/jsx-runtime` emitted by TSX compilation, (4) JSX callback refs (`ref={el => ...}`) to reach host elements.
- "minimal set of dependencies": runtime deps are exactly `react`, `react-dom`, `@expressive/react`, `codemirror`, `@codemirror/lang-javascript`, `sucrase`, `html-to-image`. Dev deps only as listed in Task 1. Do not add others.
- "It should have tests" + "tests, proper typing, and linting and formatting automatically": `bun run verify` (biome ci + tsc --noEmit + vitest run) must pass before **every** commit.
- "do not push to github, keep everything purely locally run": commit locally; never `git push`, never add a remote, never call external services except the explicitly optional Replicate/opencode paths.
- "This UI should be in one consistent style": only Tailwind utilities + the `@theme` tokens defined in `src/app/theme.css`; UI chrome built from the `src/ui` kit.
- Expressive state discipline: reactive collections are **replaced immutably** (`this.data = { ...this.data, k: v }`, `this.images = [img, ...this.images]`), never mutated in place — expressive detects assignment, not mutation.
- Views (`*View`, stateful widgets) are `Component` subclasses; leaf presentational pieces are plain function components taking props. Cross-model reads inside a Component are mirrored into own fields via `otherModel.get(effect)` in `mount()` (renders only reliably track `this`).
- Vocabulary (user asked us to pick names): **Kit** = a style library of card part components (e.g. `arcane`). **Template** = a registered card definition inside a kit (id, form-field schema, defaults, art-style prompt, renderer). The Builder's dropdown lists Templates.
- Card geometry: preview renders at exactly 375×525 CSS px (`CARD_WIDTH`/`CARD_HEIGHT`); exports upscale to 750×1050 px = 2.5"×3.5" at 300 DPI (standard trading-card print size).
- Environment variables (all optional, read by the dev-server bridge only): `REPLICATE_API_TOKEN` enables real image generation, `OPENCODE_MODEL` (e.g. `anthropic/claude-fable-5`) overrides the opencode model. With neither set the app is fully offline (stub image provider; agent endpoint returns a clear error).

## Reference Docs

Consult when a task touches the area — do not guess APIs:

- Expressive State API (`.new()`, `set()`, `get()`, lifecycle): https://expressive.dev/docs/api/state
- Expressive Component API (`render()`, `catch()`, `fallback`, subcomponents, special props `is`/`ref`): https://expressive.dev/docs/api/component
- opencode SDK: https://opencode.ai/docs/sdk/ (also read `node_modules/@opencode-ai/sdk` types after install — the plan's structural types are defensive)
- Replicate model HTTP API: https://replicate.com/black-forest-labs/flux-kontext-pro/api
- sucrase: https://github.com/alangpierce/sucrase
- html-to-image: https://github.com/bubkoo/html-to-image
- Tailwind v4 theme tokens: https://tailwindcss.com/docs/theme
- CodeMirror 6: https://codemirror.net/docs/

## Expressive Cheat Sheet (memorize before Task 1)

```tsx
import State, { Component } from '@expressive/react'

class CounterModel extends State {        // plain reactive model
  count = 0                               // reactive field (must be initialized, even `= undefined`)
  bump() { this.count++ }                 // methods auto-bound
  get double() { return this.count * 2 }  // computed, tracks reads
  protected new() {                       // runs once on activation; return cleanup
    return this.set('count', () => { /* key watcher */ })
  }
}
const m = CounterModel.new()              // standalone activation (headless tests!)
m.bump(); await m.set()                   // await update flush
const stop = m.get(cur => { cur.count })  // tracked effect (runs now + on change); stop() unsubs
m.set(null)                               // destroy

class ClickerView extends Component {     // renderable state; provides itself as context
  n = 0                                   // reactive field, doubles as optional JSX prop
  mount() { return () => {/* unmount */} }// client commit; context lookups go here: this.get(AppShell)
  async catch(error: Error) { this.fallback = <p>boom</p>; /* await = stay in fallback */ }
  Row() { return <li>{this.n}</li> }      // capital-letter method = subcomponent <this.Row/>
  render() { return <button onClick={() => { this.n++ }}>{this.n}</button> }
}
// <ClickerView n={5} is={i => ref = i} />  — fields as props; `is` captures the instance
```

## File Map

```
cartis/
├── index.html                      Vite entry
├── package.json / tsconfig.json / vite.config.ts / vitest.config.ts / biome.json / .gitignore
├── test/
│   ├── setup.ts                    fake-indexeddb reset, db reset, template registration
│   └── util.tsx                    mount/mountApp/tick/click/setInput/setSelect helpers
└── src/
    ├── main.tsx                    createRoot bootstrap (sanctioned react-dom use)
    ├── vite-env.d.ts
    ├── app/
    │   ├── AppShell.tsx            Component: tab nav, owns ImageLibrary/CardArchive singletons
    │   └── theme.css               tailwind import + @theme tokens + holo keyframes
    ├── ui/                         consistent UI kit (function components)
    │   ├── index.ts  Button.tsx  inputs.tsx  layout.tsx
    ├── cards/                      THE card component system
    │   ├── index.ts                barrel + registerBuiltinTemplates()
    │   ├── types.ts                CardData/FieldSpec/CardTemplate
    │   ├── registry.ts             template registry
    │   ├── base/CardSurface.tsx    375×525 surface + HoloFoil overlay
    │   └── arcane/                 MTG-inspired starter kit ("like it, not it")
    │       ├── palette.ts  parts.tsx  ArcaneCard.tsx  template.ts
    ├── storage/
    │   ├── db.ts                   typed IndexedDB wrapper (no deps)
    │   ├── ImageLibrary.ts         State: generated/source images
    │   └── CardArchive.ts          State: saved cards + exports
    ├── builder/
    │   ├── BuilderView.tsx         static mode: form left, live card right
    │   ├── FormRenderer.tsx        FieldSpec[] → ui-kit controls
    │   └── PortraitSection.tsx     sub-view: webcam/upload/library → AI portrait
    ├── images/
    │   ├── provider.ts             ImageProvider interface + selection
    │   ├── stub.ts                 offline canvas stylizer
    │   ├── replicate.ts            client for /api/image/generate
    │   ├── codec.ts                bytes ⇄ data-url (shared with server)
    │   ├── prompt.ts               persona → portrait prompt
    │   ├── CameraCapture.tsx       getUserMedia Component
    │   └── ImageLabView.tsx        isolated generation tab
    ├── editor/
    │   ├── compile.ts              sucrase TSX → component (module map sandbox)
    │   ├── starter.ts              STARTER_CARD_SOURCE
    │   ├── CodePane.tsx            CodeMirror wrapper Component
    │   ├── Sandbox.tsx             error-boundary preview Component
    │   └── EditorView.tsx          Code Lab: editor + agent + live preview
    ├── export/
    │   ├── exportCard.ts           html-to-image → 300 DPI png/webp/jpeg
    │   └── ExportBar.tsx           export buttons + archive save
    ├── gallery/GalleryView.tsx     past renders / generations / saved cards
    └── server/agentBridge.ts       Vite middleware: opencode + replicate endpoints
```

Scope note: this is one cohesive app — the image subsystem and code lab only produce "working, testable software" wired into the shell, so they are tasks here rather than separate plans. Every task ends green and committed.

---

### Task 1: Scaffold, Toolchain, and Expressive Smoke Test

**Files:**
- Create: `package.json`, `.gitignore`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `biome.json`, `index.html`, `src/vite-env.d.ts`, `src/app/theme.css`, `src/app/AppShell.tsx`, `src/main.tsx`, `test/util.tsx`, `test/setup.ts`
- Test: `src/app/AppShell.test.tsx`, `src/app/expressive-probe.test.tsx`

**Interfaces:**
- Consumes: nothing (empty repo, zero commits).
- Produces: `bun run dev|test|typecheck|check|verify` scripts; test helpers `mount(node): { container: HTMLElement; unmount(): void }`, `tick(ms?: number): Promise<void>`, `click(el: Element | null): Promise<void>`, `setInput(el: Element | null, value: string): Promise<void>`, `setSelect(el: Element | null, value: string): Promise<void>` from `test/util.tsx`; theme tokens `bg-surface bg-panel border-edge text-ink text-ink-dim text-accent font-display font-body`; `AppShell` component (minimal, replaced in Task 2).

- [ ] **Step 1: Write config files**

`package.json`:

```json
{
  "name": "cartis",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "check": "biome check --write .",
    "verify": "biome ci . && tsc --noEmit && vitest run"
  }
}
```

`.gitignore`:

```
node_modules/
dist/
.env
.env.*
*.log
.DS_Store
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "test", "vite.config.ts", "vitest.config.ts"]
}
```

`vite.config.ts`:

```ts
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
})
```

`vitest.config.ts` (separate config keeps tailwind/bridge plugins out of tests):

```ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
```

`biome.json`:

```json
{
  "$schema": "./node_modules/@biomejs/biome/configuration_schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "style": { "noNonNullAssertion": "error" },
      "suspicious": { "noExplicitAny": "error" }
    }
  },
  "javascript": { "formatter": { "quoteStyle": "single" } },
  "assist": { "actions": { "source": { "organizeImports": "on" } } }
}
```

`index.html`:

```html
<!doctype html>
<html lang="en" class="h-full">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Cartis — Card Studio</title>
  </head>
  <body class="h-full">
    <div id="root" class="h-full"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`src/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />
```

- [ ] **Step 2: Install dependencies**

```bash
bun add react@^19.2.0 react-dom@^19.2.0 @expressive/react@^0.83.1 codemirror@^6.0.2 @codemirror/lang-javascript@^6.2.5 sucrase@^3.35.0 html-to-image@^1.11.13
bun add -d vite@^8.2.0 @vitejs/plugin-react@^6.0.5 typescript@^7.0.2 tailwindcss@^4.3.3 @tailwindcss/vite@^4.3.3 vitest@^4.1.10 happy-dom@^20.11.1 fake-indexeddb@^6.2.5 @biomejs/biome@^2.5.6 @opencode-ai/sdk@^1.18.10 @types/react @types/react-dom @types/node
```

Commit `bun.lock`. (Contingency, not expected: if `tsc --noEmit` misbehaves under typescript 7's native compiler, pin `typescript@^5.9` — nothing else changes.)

- [ ] **Step 3: Write theme, shell, and entry**

`src/app/theme.css`:

```css
@import 'tailwindcss';

@theme {
  --color-surface: #14161f;
  --color-panel: #1d2130;
  --color-edge: #303752;
  --color-ink: #e8e4d8;
  --color-ink-dim: #9aa0b5;
  --color-accent: #d9a441;
  --color-accent-soft: #8a6a2f;
  --font-display: 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif;
  --font-body: ui-sans-serif, system-ui, sans-serif;
}
```

`src/app/AppShell.tsx` (minimal — Task 2 replaces it):

```tsx
import { Component } from '@expressive/react'

export class AppShell extends Component {
  render() {
    return (
      <div className="flex h-screen items-center justify-center bg-surface font-body text-ink">
        <h1 className="font-display text-3xl tracking-widest text-accent">CARTIS</h1>
      </div>
    )
  }
}
```

`src/main.tsx`:

```tsx
// Sanctioned react-dom use: the one-time renderer bootstrap (see Global Constraints).
import { createRoot } from 'react-dom/client'
import { AppShell } from './app/AppShell'
import './app/theme.css'

createRoot(document.getElementById('root') as HTMLElement).render(<AppShell />)
```

- [ ] **Step 4: Write test helpers**

`test/setup.ts` (grows in Tasks 4 and 5):

```ts
// Global test setup. Later tasks add IndexedDB + template-registry resets here.
export {}
```

`test/util.tsx`:

```tsx
// Sanctioned react-dom use: tests must mount into a real root (see Global Constraints).
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

export function mount(node: ReactNode): { container: HTMLElement; unmount(): void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  root.render(node)
  return {
    container,
    unmount() {
      root.unmount()
      container.remove()
    },
  }
}

/** Flush React commits + expressive update flushes (two macrotask turns). */
export async function tick(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

export async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error('click: element not found')
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await tick()
}

function setNativeValue(el: Element | null, value: string): HTMLElement {
  if (!(el instanceof HTMLElement)) throw new Error('setInput: element not found')
  const proto = Object.getPrototypeOf(el) as object
  const desc = Object.getOwnPropertyDescriptor(proto, 'value')
  desc?.set?.call(el, value)
  return el
}

/** Set an <input>/<textarea> value the way React sees it (native setter + input event). */
export async function setInput(el: Element | null, value: string): Promise<void> {
  setNativeValue(el, value).dispatchEvent(new Event('input', { bubbles: true }))
  await tick()
}

export async function setSelect(el: Element | null, value: string): Promise<void> {
  setNativeValue(el, value).dispatchEvent(new Event('change', { bubbles: true }))
  await tick()
}
```

- [ ] **Step 5: Write the failing tests**

`src/app/expressive-probe.test.tsx` — proves expressive works under this exact toolchain (models headless, components mounted) before anything is built on it:

```tsx
import State, { Component } from '@expressive/react'
import { describe, expect, it } from 'vitest'
import { click, mount, tick } from '../../test/util'

class ProbeModel extends State {
  count = 0
  bump() {
    this.count++
  }
  get double() {
    return this.count * 2
  }
}

class ProbeView extends Component {
  n = 0
  render() {
    return (
      <button type="button" onClick={() => { this.n++ }}>
        clicks:{this.n}
      </button>
    )
  }
}

describe('expressive under vite/vitest toolchain', () => {
  it('standalone model: fields update and flush awaits', async () => {
    const probe = ProbeModel.new()
    probe.bump()
    await probe.set()
    expect(probe.count).toBe(1)
    expect(probe.double).toBe(2)
    probe.set(null)
  })

  it('mounted Component: click updates render', async () => {
    const { container, unmount } = mount(<ProbeView />)
    await tick()
    expect(container.textContent).toContain('clicks:0')
    await click(container.querySelector('button'))
    expect(container.textContent).toContain('clicks:1')
    unmount()
  })
})
```

`src/app/AppShell.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { mount, tick } from '../../test/util'
import { AppShell } from './AppShell'

describe('AppShell', () => {
  it('renders the app title', async () => {
    const { container, unmount } = mount(<AppShell />)
    await tick()
    expect(container.textContent).toContain('CARTIS')
    unmount()
  })
})
```

- [ ] **Step 6: Run tests — expect fail, then pass**

Run: `bun run test`. Before Step 3's files exist the suite cannot even collect (module not found) — that is the failing state. With all files in place, expect: **4 tests pass**. If the probe test fails, stop and fix the toolchain now (this is the whole point of Task 1).

- [ ] **Step 7: Verify toolchain gates**

Run: `bun run check` (biome formats/fixes), then `bun run verify`. Expected: biome ci clean, tsc clean, vitest 4 passed. Also run `bun run dev` briefly and load http://localhost:5173 — expect the CARTIS title on a dark background. Stop the server.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: scaffold Cartis — vite + tailwind + expressive toolchain with verify gate"
```

---

### Task 2: UI Kit and Tabbed App Shell

**Files:**
- Create: `src/ui/Button.tsx`, `src/ui/inputs.tsx`, `src/ui/layout.tsx`, `src/ui/index.ts`
- Modify: `src/app/AppShell.tsx` (full replacement below)
- Modify: `test/util.tsx` (add `mountApp`)
- Test: `src/ui/ui.test.tsx`, replace `src/app/AppShell.test.tsx`

**Interfaces:**
- Consumes: theme tokens + test helpers from Task 1.
- Produces (all re-exported from `src/ui/index.ts`):
  - `Button(props: { onClick: () => void; children?: ReactNode; tone?: 'accent' | 'ghost' | 'danger'; disabled?: boolean })`
  - `TextInput(props: { value: string; onValue: (v: string) => void; placeholder?: string; maxLength?: number })`
  - `TextAreaInput(props: { value: string; onValue: (v: string) => void; rows?: number; placeholder?: string })`
  - `NumberInput(props: { value: number; onValue: (v: number) => void; min: number; max: number })` — clamps to [min, max]
  - `SelectInput(props: { value: string; onValue: (v: string) => void; options: readonly { value: string; label: string }[] })`
  - `FieldRow(props: { label: string; children?: ReactNode })`
  - `Panel(props: { title?: string; children?: ReactNode; className?: string })`
  - `TabBar(props: { tabs: readonly { id: string; label: string }[]; active: string; onSelect: (id: string) => void })`
  - `EmptyState(props: { message: string; hint?: string })`
  - `AppShell` Component with field `view: ViewId` (`type ViewId = 'builder' | 'editor' | 'images' | 'gallery'`, exported from `src/app/AppShell.tsx`)
  - `mountApp(): Promise<{ container: HTMLElement; shell: AppShell; unmount(): void }>` in `test/util.tsx`

- [ ] **Step 1: Write the failing tests**

`src/ui/ui.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { click, mount, setInput, setSelect, tick } from '../../test/util'
import { Button, NumberInput, SelectInput, TabBar, TextInput } from './index'

describe('ui kit', () => {
  it('Button fires onClick', async () => {
    const onClick = vi.fn()
    const { container, unmount } = mount(<Button onClick={onClick}>Go</Button>)
    await tick()
    await click(container.querySelector('button'))
    expect(onClick).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('TextInput reports typed value', async () => {
    const onValue = vi.fn()
    const { container, unmount } = mount(<TextInput value="" onValue={onValue} />)
    await tick()
    await setInput(container.querySelector('input'), 'Zara')
    expect(onValue).toHaveBeenCalledWith('Zara')
    unmount()
  })

  it('NumberInput clamps to min/max', async () => {
    const onValue = vi.fn()
    const { container, unmount } = mount(<NumberInput value={3} onValue={onValue} min={0} max={9} />)
    await tick()
    await setInput(container.querySelector('input'), '42')
    expect(onValue).toHaveBeenCalledWith(9)
    await setInput(container.querySelector('input'), '-5')
    expect(onValue).toHaveBeenCalledWith(0)
    unmount()
  })

  it('SelectInput reports chosen option', async () => {
    const onValue = vi.fn()
    const options = [
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Beta' },
    ]
    const { container, unmount } = mount(<SelectInput value="a" onValue={onValue} options={options} />)
    await tick()
    await setSelect(container.querySelector('select'), 'b')
    expect(onValue).toHaveBeenCalledWith('b')
    unmount()
  })

  it('TabBar renders tabs and reports selection', async () => {
    const onSelect = vi.fn()
    const tabs = [
      { id: 'one', label: 'One' },
      { id: 'two', label: 'Two' },
    ]
    const { container, unmount } = mount(<TabBar tabs={tabs} active="one" onSelect={onSelect} />)
    await tick()
    const buttons = Array.from(container.querySelectorAll('button'))
    expect(buttons.map((b) => b.textContent)).toEqual(['One', 'Two'])
    await click(buttons[1] ?? null)
    expect(onSelect).toHaveBeenCalledWith('two')
    unmount()
  })
})
```

Replace `src/app/AppShell.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { click, mountApp } from '../../test/util'

describe('AppShell', () => {
  it('shows four view tabs and switches the visible pane', async () => {
    const { container, shell, unmount } = await mountApp()
    expect(container.textContent).toContain('CARTIS')
    for (const label of ['Builder', 'Code Lab', 'Image Lab', 'Gallery']) {
      expect(container.textContent).toContain(label)
    }
    expect(shell.view).toBe('builder')
    const tabs = Array.from(container.querySelectorAll('header button'))
    await click(tabs.find((b) => b.textContent === 'Gallery') ?? null)
    expect(shell.view).toBe('gallery')
    const panes = Array.from(container.querySelectorAll('main > div'))
    expect(panes).toHaveLength(4)
    expect(panes.filter((p) => p.className.includes('hidden'))).toHaveLength(3)
    unmount()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test`. Expected: FAIL — `src/ui/index.ts` does not exist; `mountApp` is not exported.

- [ ] **Step 3: Implement the UI kit**

`src/ui/Button.tsx`:

```tsx
import type { ReactNode } from 'react'

const TONES = {
  accent: 'bg-accent text-surface hover:brightness-110',
  ghost: 'border border-edge text-ink hover:border-accent hover:text-accent',
  danger: 'border border-red-900 text-red-300 hover:bg-red-950',
} as const

export type ButtonTone = keyof typeof TONES

export function Button(props: {
  onClick: () => void
  children?: ReactNode
  tone?: ButtonTone
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      disabled={props.disabled === true}
      onClick={props.onClick}
      className={`rounded px-3 py-1.5 text-sm font-medium transition disabled:opacity-40 ${TONES[props.tone ?? 'accent']}`}
    >
      {props.children}
    </button>
  )
}
```

`src/ui/inputs.tsx`:

```tsx
const INPUT_CLASS =
  'w-full rounded border border-edge bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none'

export function TextInput(props: {
  value: string
  onValue: (v: string) => void
  placeholder?: string
  maxLength?: number
}) {
  return (
    <input
      type="text"
      className={INPUT_CLASS}
      value={props.value}
      placeholder={props.placeholder}
      maxLength={props.maxLength}
      onChange={(e) => props.onValue(e.target.value)}
    />
  )
}

export function TextAreaInput(props: {
  value: string
  onValue: (v: string) => void
  rows?: number
  placeholder?: string
}) {
  return (
    <textarea
      className={`${INPUT_CLASS} resize-none`}
      value={props.value}
      rows={props.rows ?? 3}
      placeholder={props.placeholder}
      onChange={(e) => props.onValue(e.target.value)}
    />
  )
}

export function NumberInput(props: {
  value: number
  onValue: (v: number) => void
  min: number
  max: number
}) {
  return (
    <input
      type="number"
      className={INPUT_CLASS}
      value={props.value}
      min={props.min}
      max={props.max}
      onChange={(e) => {
        const n = Number(e.target.value)
        const safe = Number.isFinite(n) ? n : props.min
        props.onValue(Math.min(props.max, Math.max(props.min, safe)))
      }}
    />
  )
}

export function SelectInput(props: {
  value: string
  onValue: (v: string) => void
  options: readonly { value: string; label: string }[]
}) {
  return (
    <select className={INPUT_CLASS} value={props.value} onChange={(e) => props.onValue(e.target.value)}>
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}
```

`src/ui/layout.tsx`:

```tsx
import type { ReactNode } from 'react'

export function FieldRow(props: { label: string; children?: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-ink-dim">{props.label}</span>
      {props.children}
    </label>
  )
}

export function Panel(props: { title?: string; children?: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-edge bg-panel p-4 ${props.className ?? ''}`}>
      {props.title ? (
        <h2 className="mb-3 font-display text-sm uppercase tracking-widest text-accent">{props.title}</h2>
      ) : null}
      {props.children}
    </section>
  )
}

export function TabBar(props: {
  tabs: readonly { id: string; label: string }[]
  active: string
  onSelect: (id: string) => void
}) {
  return (
    <nav className="flex gap-1">
      {props.tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => props.onSelect(tab.id)}
          className={`rounded px-3 py-1.5 text-sm transition ${
            tab.id === props.active
              ? 'bg-panel font-semibold text-accent'
              : 'text-ink-dim hover:text-ink'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  )
}

export function EmptyState(props: { message: string; hint?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center">
      <p className="text-sm text-ink-dim">{props.message}</p>
      {props.hint ? <p className="text-xs text-ink-dim/70">{props.hint}</p> : null}
    </div>
  )
}
```

`src/ui/index.ts`:

```ts
export { Button, type ButtonTone } from './Button'
export { NumberInput, SelectInput, TextAreaInput, TextInput } from './inputs'
export { EmptyState, FieldRow, Panel, TabBar } from './layout'
```

- [ ] **Step 4: Replace AppShell with the tabbed shell**

`src/app/AppShell.tsx` (full replacement — later tasks swap each `EmptyState` pane for the real view):

```tsx
import { Component } from '@expressive/react'
import type { ReactNode } from 'react'
import { EmptyState, TabBar } from '../ui'

export type ViewId = 'builder' | 'editor' | 'images' | 'gallery'

const VIEW_TABS: readonly { id: ViewId; label: string }[] = [
  { id: 'builder', label: 'Builder' },
  { id: 'editor', label: 'Code Lab' },
  { id: 'images', label: 'Image Lab' },
  { id: 'gallery', label: 'Gallery' },
]

export class AppShell extends Component {
  view: ViewId = 'builder'

  render() {
    return (
      <div className="flex h-screen flex-col bg-surface font-body text-ink">
        <header className="flex items-center gap-6 border-b border-edge px-6 py-3">
          <h1 className="font-display text-xl tracking-widest text-accent">CARTIS</h1>
          <TabBar
            tabs={VIEW_TABS}
            active={this.view}
            onSelect={(id) => {
              this.view = id as ViewId
            }}
          />
        </header>
        <main className="min-h-0 flex-1">
          <Pane active={this.view === 'builder'}>
            <EmptyState message="Builder arrives in Task 6." />
          </Pane>
          <Pane active={this.view === 'editor'}>
            <EmptyState message="Code Lab arrives in Task 12." />
          </Pane>
          <Pane active={this.view === 'images'}>
            <EmptyState message="Image Lab arrives in Task 7." />
          </Pane>
          <Pane active={this.view === 'gallery'}>
            <EmptyState message="Gallery arrives in Task 10." />
          </Pane>
        </main>
      </div>
    )
  }
}

function Pane(props: { active: boolean; children?: ReactNode }) {
  return <div className={props.active ? 'h-full' : 'hidden'}>{props.children}</div>
}
```

Panes stay mounted and merely hide (`hidden`) so view-local state (form entries, editor buffers) survives tab switches.

- [ ] **Step 5: Add `mountApp` to `test/util.tsx`**

Append to `test/util.tsx`:

```tsx
import { AppShell } from '../src/app/AppShell'

/** Mount the whole app and capture the AppShell instance via the `is` special prop. */
export async function mountApp(): Promise<{
  container: HTMLElement
  shell: AppShell
  unmount(): void
}> {
  let shell: AppShell | undefined
  const mounted = mount(
    <AppShell
      is={(instance: AppShell) => {
        shell = instance
      }}
    />,
  )
  await tick()
  if (!shell) throw new Error('mountApp: AppShell instance was not captured')
  return { ...mounted, shell }
}
```

(Move the `import { AppShell } ...` line to the top of the file with the other imports; biome's organize-imports does this on `bun run check`.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun run test`. Expected: PASS — 5 ui tests + 1 shell test + 2 probe tests.

- [ ] **Step 7: Verify and commit**

Run: `bun run check && bun run verify`. Expected: clean. Then:

```bash
git add -A
git commit -m "feat: add ui kit and tabbed app shell"
```

---

### Task 3: Card Types, Template Registry, and Base Surface

**Files:**
- Create: `src/cards/types.ts`, `src/cards/registry.ts`, `src/cards/base/CardSurface.tsx`
- Modify: `src/app/theme.css` (append holo utility)
- Test: `src/cards/registry.test.ts`, `src/cards/base/CardSurface.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `types.ts`: `type FieldValue = string | number | boolean | undefined`; `type CardData = Record<string, FieldValue>`; `type FieldSpec` (discriminated union, kinds `text | textarea | number | select | image`, exact shapes below); `interface CardTemplate { id: string; kitId: string; name: string; description: string; fields: readonly FieldSpec[]; defaults: CardData; artStylePrompt: (data: CardData) => string; Render: CardRenderer }`; `type CardRenderProps = { data: CardData; holo?: boolean }`; `type CardRenderer = ComponentType<CardRenderProps>`
  - `registry.ts`: `registerTemplate(template: CardTemplate): void` (throws on duplicate id), `getTemplate(id: string): CardTemplate` (throws on unknown), `listTemplates(): CardTemplate[]`, `__clearTemplatesForTests(): void`
  - `CardSurface.tsx`: `CARD_WIDTH = 375`, `CARD_HEIGHT = 525`, `CardSurface(props: { holo?: boolean; frameClass?: string; children?: ReactNode })` (renders `data-card-root="true"`), `HoloFoil(props: { active: boolean })` (renders `data-holo="true"` overlay when active)

- [ ] **Step 1: Write the failing tests**

`src/cards/registry.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { __clearTemplatesForTests, getTemplate, listTemplates, registerTemplate } from './registry'
import type { CardTemplate } from './types'

function fakeTemplate(id: string): CardTemplate {
  return {
    id,
    kitId: 'test',
    name: `Template ${id}`,
    description: 'test template',
    fields: [{ kind: 'text', key: 'name', label: 'Name' }],
    defaults: { name: 'Test' },
    artStylePrompt: () => 'test style',
    Render: () => null,
  }
}

describe('template registry', () => {
  beforeEach(() => {
    __clearTemplatesForTests()
  })

  it('registers and retrieves a template', () => {
    registerTemplate(fakeTemplate('t1'))
    expect(getTemplate('t1').name).toBe('Template t1')
    expect(listTemplates().map((t) => t.id)).toEqual(['t1'])
  })

  it('throws on duplicate registration', () => {
    registerTemplate(fakeTemplate('t1'))
    expect(() => registerTemplate(fakeTemplate('t1'))).toThrow(/already registered/)
  })

  it('throws on unknown template id', () => {
    expect(() => getTemplate('nope')).toThrow(/unknown template/i)
  })
})
```

`src/cards/base/CardSurface.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { mount, tick } from '../../../test/util'
import { CARD_HEIGHT, CARD_WIDTH, CardSurface } from './CardSurface'

describe('CardSurface', () => {
  it('renders children on a fixed-size rooted surface', async () => {
    const { container, unmount } = mount(
      <CardSurface>
        <p>inner</p>
      </CardSurface>,
    )
    await tick()
    const root = container.querySelector('[data-card-root="true"]') as HTMLElement
    expect(root).not.toBeNull()
    expect(root.textContent).toContain('inner')
    expect(root.style.width).toBe(`${CARD_WIDTH}px`)
    expect(root.style.height).toBe(`${CARD_HEIGHT}px`)
    expect(root.querySelector('[data-holo="true"]')).toBeNull()
    unmount()
  })

  it('shows the holo overlay only when enabled', async () => {
    const { container, unmount } = mount(<CardSurface holo>{null}</CardSurface>)
    await tick()
    expect(container.querySelector('[data-holo="true"]')).not.toBeNull()
    unmount()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test`. Expected: FAIL — modules `./registry`, `./types`, `./CardSurface` not found.

- [ ] **Step 3: Implement types and registry**

`src/cards/types.ts`:

```ts
// Sanctioned type-only react import (see Global Constraints).
import type { ComponentType } from 'react'

export type FieldValue = string | number | boolean | undefined

/** The data record a template's form edits and its renderer consumes. */
export type CardData = Record<string, FieldValue>

export type FieldSpec =
  | { kind: 'text'; key: string; label: string; placeholder?: string; maxLength?: number }
  | { kind: 'textarea'; key: string; label: string; rows?: number; placeholder?: string }
  | { kind: 'number'; key: string; label: string; min: number; max: number }
  | { kind: 'select'; key: string; label: string; options: readonly { value: string; label: string }[] }
  | { kind: 'image'; key: string; label: string }

export type CardRenderProps = { data: CardData; holo?: boolean }
export type CardRenderer = ComponentType<CardRenderProps>

/**
 * A registered card definition: what the Builder's form edits (fields/defaults),
 * how the AI image pipeline should style portraits (artStylePrompt), and how it renders.
 */
export interface CardTemplate {
  id: string
  kitId: string
  name: string
  description: string
  fields: readonly FieldSpec[]
  defaults: CardData
  artStylePrompt: (data: CardData) => string
  Render: CardRenderer
}
```

`src/cards/registry.ts`:

```ts
import type { CardTemplate } from './types'

const templates = new Map<string, CardTemplate>()

export function registerTemplate(template: CardTemplate): void {
  if (templates.has(template.id)) {
    throw new Error(`Template "${template.id}" is already registered`)
  }
  templates.set(template.id, template)
}

export function getTemplate(id: string): CardTemplate {
  const found = templates.get(id)
  if (!found) throw new Error(`Unknown template "${id}"`)
  return found
}

export function listTemplates(): CardTemplate[] {
  return Array.from(templates.values())
}

export function __clearTemplatesForTests(): void {
  templates.clear()
}
```

- [ ] **Step 4: Implement CardSurface + HoloFoil and the holo utility**

`src/cards/base/CardSurface.tsx`:

```tsx
import type { ReactNode } from 'react'

/** Trading-card preview geometry: 2.5"×3.5" at 150 px/inch; exports double it to 300 DPI. */
export const CARD_WIDTH = 375
export const CARD_HEIGHT = 525

export function CardSurface(props: { holo?: boolean; frameClass?: string; children?: ReactNode }) {
  return (
    <div
      data-card-root="true"
      className={`relative overflow-hidden rounded-[18px] shadow-xl ${props.frameClass ?? 'bg-panel'}`}
      style={{ width: CARD_WIDTH, height: CARD_HEIGHT }}
    >
      {props.children}
      <HoloFoil active={props.holo === true} />
    </div>
  )
}

/** Rainbow-sheen overlay approximating holographic foil; also prints nicely as a keepsake. */
export function HoloFoil(props: { active: boolean }) {
  if (!props.active) return null
  return (
    <div
      data-holo="true"
      className="holo-sheen pointer-events-none absolute inset-0 opacity-60 mix-blend-screen"
    />
  )
}
```

Append to `src/app/theme.css`:

```css
@utility holo-sheen {
  background: linear-gradient(
    115deg,
    transparent 20%,
    rgba(255, 0, 128, 0.25) 35%,
    rgba(0, 255, 255, 0.3) 50%,
    rgba(255, 220, 0, 0.25) 65%,
    transparent 80%
  );
  background-size: 300% 300%;
  animation: holo-sheen 6s ease-in-out infinite;
}

@keyframes holo-sheen {
  0% { background-position: 0% 0%; }
  50% { background-position: 100% 100%; }
  100% { background-position: 0% 0%; }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run test`. Expected: PASS (5 new tests green, all prior suites still green).

- [ ] **Step 6: Verify and commit**

Run: `bun run check && bun run verify`. Then:

```bash
git add -A
git commit -m "feat: add card template types, registry, and base card surface"
```

---

### Task 4: IndexedDB Storage, ImageLibrary, and CardArchive

**Files:**
- Create: `src/storage/db.ts`, `src/storage/ImageLibrary.ts`, `src/storage/CardArchive.ts`
- Modify: `src/app/AppShell.tsx` (add owned model fields), `test/setup.ts` (reset storage between tests)
- Test: `src/storage/storage.test.ts`

**Interfaces:**
- Consumes: `CardData` from `src/cards/types.ts` (Task 3).
- Produces:
  - `db.ts`: `type StoreName = 'images' | 'cards' | 'exports'`; `openDatabase(): Promise<IDBDatabase>`; `dbPut<T extends { id: string }>(store: StoreName, value: T): Promise<void>`; `dbGetAll<T>(store: StoreName): Promise<T[]>`; `dbDelete(store: StoreName, id: string): Promise<void>`; `__resetDbForTests(): void`
  - `ImageLibrary.ts`: `interface StoredImage { id: string; kind: 'source' | 'generated'; prompt?: string; styleId?: string; bytes: ArrayBuffer; type: string; createdAt: number }`; `type NewImage = Omit<StoredImage, 'id' | 'createdAt'>`; `class ImageLibrary extends State` with fields `images: StoredImage[]`, `urls: Record<string, string>`, `ready: boolean` and methods `add(input: NewImage): Promise<StoredImage>`, `remove(id: string): Promise<void>`, `url(id: string): string | undefined`
  - `CardArchive.ts`: `type ExportFormat = 'png' | 'jpeg' | 'webp'`; `interface StoredCard { id: string; name: string; templateId: string; data: CardData; holo: boolean; updatedAt: number }`; `interface StoredExport { id: string; name: string; format: ExportFormat; bytes: ArrayBuffer; type: string; createdAt: number }`; `interface SaveCardInput { id?: string; name: string; templateId: string; data: CardData; holo: boolean }`; `class CardArchive extends State` with fields `cards: StoredCard[]`, `exports: StoredExport[]`, `exportUrls: Record<string, string>`, `ready: boolean` and methods `saveCard(input: SaveCardInput): Promise<StoredCard>`, `deleteCard(id: string): Promise<void>`, `saveExport(input: { name: string; format: ExportFormat; bytes: ArrayBuffer; type: string }): Promise<StoredExport>`, `deleteExport(id: string): Promise<void>`, `exportUrl(id: string): string | undefined`
  - `AppShell` gains fields `library = ImageLibrary.new()`, `archive = CardArchive.new()`, `pendingCard?: StoredCard = undefined` — descendants reach them via `this.get(AppShell).library` etc.

Design notes: image payloads are stored as `ArrayBuffer + mime type` (not `Blob`) so structured-clone works identically in browser, node, and fake-indexeddb. Object URLs are derived, kept in a `urls` map, and revoked on remove.

- [ ] **Step 1: Write the failing tests**

`src/storage/storage.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { CardArchive } from './CardArchive'
import { ImageLibrary } from './ImageLibrary'

const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer

async function ready(model: { ready: boolean }): Promise<void> {
  await vi.waitFor(() => {
    expect(model.ready).toBe(true)
  })
}

describe('ImageLibrary', () => {
  it('adds, lists newest-first, persists, and removes images', async () => {
    const lib = ImageLibrary.new()
    await ready(lib)
    const a = await lib.add({ kind: 'generated', prompt: 'a', styleId: 's', bytes: bytesOf('a'), type: 'image/png' })
    const b = await lib.add({ kind: 'source', bytes: bytesOf('b'), type: 'image/jpeg' })
    expect(lib.images.map((i) => i.id)).toEqual([b.id, a.id])
    expect(typeof lib.url(a.id)).toBe('string')

    const reloaded = ImageLibrary.new()
    await ready(reloaded)
    expect(reloaded.images.map((i) => i.id)).toEqual([b.id, a.id])
    reloaded.set(null)

    await lib.remove(a.id)
    expect(lib.images.map((i) => i.id)).toEqual([b.id])
    expect(lib.url(a.id)).toBeUndefined()
    lib.set(null)
  })
})

describe('CardArchive', () => {
  it('upserts cards by id and orders by recency', async () => {
    const archive = CardArchive.new()
    await ready(archive)
    const first = await archive.saveCard({ name: 'One', templateId: 't', data: { name: 'One' }, holo: false })
    await archive.saveCard({ name: 'Two', templateId: 't', data: { name: 'Two' }, holo: true })
    const updated = await archive.saveCard({ id: first.id, name: 'One v2', templateId: 't', data: { name: 'One v2' }, holo: false })
    expect(updated.id).toBe(first.id)
    expect(archive.cards).toHaveLength(2)
    expect(archive.cards[0]?.name).toBe('One v2')
    await archive.deleteCard(first.id)
    expect(archive.cards.map((c) => c.name)).toEqual(['Two'])
    archive.set(null)
  })

  it('saves and deletes exports with derived urls', async () => {
    const archive = CardArchive.new()
    await ready(archive)
    const exp = await archive.saveExport({ name: 'hero', format: 'png', bytes: bytesOf('img'), type: 'image/png' })
    expect(archive.exports[0]?.format).toBe('png')
    expect(typeof archive.exportUrl(exp.id)).toBe('string')
    await archive.deleteExport(exp.id)
    expect(archive.exports).toHaveLength(0)
    archive.set(null)
  })
})
```

- [ ] **Step 2: Update `test/setup.ts` for storage isolation**

Replace `test/setup.ts`:

```ts
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach } from 'vitest'
import { __resetDbForTests } from '../src/storage/db'

beforeEach(() => {
  // Fresh database per test: new factory + drop the cached connection.
  globalThis.indexedDB = new IDBFactory()
  __resetDbForTests()
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun run test`. Expected: FAIL — `src/storage/*` modules do not exist.

- [ ] **Step 4: Implement the db wrapper**

`src/storage/db.ts`:

```ts
const DB_NAME = 'cartis'
const DB_VERSION = 1
const STORES = ['images', 'cards', 'exports'] as const

export type StoreName = (typeof STORES)[number]

let connection: Promise<IDBDatabase> | undefined

export function openDatabase(): Promise<IDBDatabase> {
  connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      for (const store of STORES) {
        if (!request.result.objectStoreNames.contains(store)) {
          request.result.createObjectStore(store, { keyPath: 'id' })
        }
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'))
  })
  return connection
}

function inTransaction<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  run: (objectStore: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode)
        const request = run(tx.objectStore(store))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error(`indexedDB ${mode} failed`))
      }),
  )
}

export async function dbPut<T extends { id: string }>(store: StoreName, value: T): Promise<void> {
  await inTransaction(store, 'readwrite', (s) => s.put(value))
}

export function dbGetAll<T>(store: StoreName): Promise<T[]> {
  return inTransaction(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>)
}

export async function dbDelete(store: StoreName, id: string): Promise<void> {
  await inTransaction(store, 'readwrite', (s) => s.delete(id))
}

export function __resetDbForTests(): void {
  connection = undefined
}
```

- [ ] **Step 5: Implement ImageLibrary**

`src/storage/ImageLibrary.ts`:

```ts
import State from '@expressive/react'
import { dbDelete, dbGetAll, dbPut } from './db'

export interface StoredImage {
  id: string
  kind: 'source' | 'generated'
  prompt?: string
  styleId?: string
  bytes: ArrayBuffer
  type: string
  createdAt: number
}

export type NewImage = Omit<StoredImage, 'id' | 'createdAt'>

/** Object URLs are unavailable in some test environments; render code treats missing urls as "no art". */
export function safeObjectUrl(bytes: ArrayBuffer, type: string): string | undefined {
  try {
    return URL.createObjectURL(new Blob([bytes], { type }))
  } catch {
    return undefined
  }
}

function withoutKey(map: Record<string, string>, id: string): Record<string, string> {
  const { [id]: dropped, ...rest } = map
  if (dropped) {
    try {
      URL.revokeObjectURL(dropped)
    } catch {
      // happy-dom may not implement revoke; leaking in tests is fine
    }
  }
  return rest
}

export class ImageLibrary extends State {
  images: StoredImage[] = []
  urls: Record<string, string> = {}
  ready = false

  protected new() {
    void this.load()
  }

  private async load(): Promise<void> {
    const rows = await dbGetAll<StoredImage>('images')
    rows.sort((a, b) => b.createdAt - a.createdAt)
    const urls: Record<string, string> = {}
    for (const row of rows) {
      const url = safeObjectUrl(row.bytes, row.type)
      if (url) urls[row.id] = url
    }
    this.images = rows
    this.urls = urls
    this.ready = true
  }

  async add(input: NewImage): Promise<StoredImage> {
    const image: StoredImage = { ...input, id: crypto.randomUUID(), createdAt: Date.now() }
    await dbPut('images', image)
    const url = safeObjectUrl(image.bytes, image.type)
    this.images = [image, ...this.images]
    if (url) this.urls = { ...this.urls, [image.id]: url }
    return image
  }

  async remove(id: string): Promise<void> {
    await dbDelete('images', id)
    this.images = this.images.filter((image) => image.id !== id)
    this.urls = withoutKey(this.urls, id)
  }

  url(id: string): string | undefined {
    return this.urls[id]
  }
}
```

- [ ] **Step 6: Implement CardArchive**

`src/storage/CardArchive.ts`:

```ts
import State from '@expressive/react'
import type { CardData } from '../cards/types'
import { dbDelete, dbGetAll, dbPut } from './db'
import { safeObjectUrl } from './ImageLibrary'

export type ExportFormat = 'png' | 'jpeg' | 'webp'

export interface StoredCard {
  id: string
  name: string
  templateId: string
  data: CardData
  holo: boolean
  updatedAt: number
}

export interface StoredExport {
  id: string
  name: string
  format: ExportFormat
  bytes: ArrayBuffer
  type: string
  createdAt: number
}

export interface SaveCardInput {
  id?: string
  name: string
  templateId: string
  data: CardData
  holo: boolean
}

export class CardArchive extends State {
  cards: StoredCard[] = []
  exports: StoredExport[] = []
  exportUrls: Record<string, string> = {}
  ready = false

  protected new() {
    void this.load()
  }

  private async load(): Promise<void> {
    const [cards, exports] = await Promise.all([
      dbGetAll<StoredCard>('cards'),
      dbGetAll<StoredExport>('exports'),
    ])
    cards.sort((a, b) => b.updatedAt - a.updatedAt)
    exports.sort((a, b) => b.createdAt - a.createdAt)
    const exportUrls: Record<string, string> = {}
    for (const row of exports) {
      const url = safeObjectUrl(row.bytes, row.type)
      if (url) exportUrls[row.id] = url
    }
    this.cards = cards
    this.exports = exports
    this.exportUrls = exportUrls
    this.ready = true
  }

  async saveCard(input: SaveCardInput): Promise<StoredCard> {
    const card: StoredCard = {
      id: input.id ?? crypto.randomUUID(),
      name: input.name,
      templateId: input.templateId,
      data: { ...input.data },
      holo: input.holo,
      updatedAt: Date.now(),
    }
    await dbPut('cards', card)
    this.cards = [card, ...this.cards.filter((c) => c.id !== card.id)]
    return card
  }

  async deleteCard(id: string): Promise<void> {
    await dbDelete('cards', id)
    this.cards = this.cards.filter((c) => c.id !== id)
  }

  async saveExport(input: {
    name: string
    format: ExportFormat
    bytes: ArrayBuffer
    type: string
  }): Promise<StoredExport> {
    const record: StoredExport = { ...input, id: crypto.randomUUID(), createdAt: Date.now() }
    await dbPut('exports', record)
    this.exports = [record, ...this.exports]
    const url = safeObjectUrl(record.bytes, record.type)
    if (url) this.exportUrls = { ...this.exportUrls, [record.id]: url }
    return record
  }

  async deleteExport(id: string): Promise<void> {
    await dbDelete('exports', id)
    this.exports = this.exports.filter((e) => e.id !== id)
    const { [id]: _dropped, ...rest } = this.exportUrls
    this.exportUrls = rest
  }

  exportUrl(id: string): string | undefined {
    return this.exportUrls[id]
  }
}
```

- [ ] **Step 7: Wire singletons into AppShell**

In `src/app/AppShell.tsx`, add imports and fields:

```tsx
import { CardArchive, type StoredCard } from '../storage/CardArchive'
import { ImageLibrary } from '../storage/ImageLibrary'
```

```tsx
export class AppShell extends Component {
  view: ViewId = 'builder'
  library = ImageLibrary.new()
  archive = CardArchive.new()
  /** Set by the Gallery to hand a saved card to the Builder (consumed in BuilderView.mount). */
  pendingCard?: StoredCard = undefined
  // render() unchanged
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `bun run test`. Expected: PASS — 3 new storage tests plus all prior suites (AppShell test still green with the new fields).

- [ ] **Step 9: Verify and commit**

Run: `bun run check && bun run verify`. Then:

```bash
git add -A
git commit -m "feat: add IndexedDB storage with image library and card archive models"
```

---

### Task 5: The Arcane Kit (MTG-Inspired Starter Style)

Style brief: evoke the referenced Magic frame — layered colored border, parchment title bar with cost pips, framed art window, italic type line with a rarity gem, parchment rules box with ability + italic flavor, oval stat badge bottom-right — but with Cartis's own identity: six "essences" instead of MTG colors, gradient frames, `might/ward` instead of power/toughness. **Like** it, never **it**.

**Files:**
- Create: `src/cards/arcane/palette.ts`, `src/cards/arcane/parts.tsx`, `src/cards/arcane/ArcaneCard.tsx`, `src/cards/arcane/template.ts`, `src/cards/index.ts`
- Modify: `test/setup.ts` (register builtin templates per test)
- Test: `src/cards/arcane/arcane.test.tsx`

**Interfaces:**
- Consumes: `CardSurface`/`HoloFoil`/`CARD_WIDTH` (Task 3), `CardTemplate`/`CardData` types, `registerTemplate`/`listTemplates` (Task 3).
- Produces:
  - `palette.ts`: `type EssenceId = 'ember' | 'tide' | 'verdant' | 'radiant' | 'umbral' | 'relic'`; `interface EssencePalette { id: EssenceId; label: string; frame: string; plate: string; plateText: string; artEdge: string; pip: string; artFlavor: string }`; `ESSENCES: readonly EssencePalette[]`; `paletteFor(id: string): EssencePalette` (falls back to `relic`)
  - `parts.tsx`: `type RarityId = 'common' | 'uncommon' | 'rare' | 'mythic'`; `RARITIES: readonly { value: RarityId; label: string }[]`; function components `ArcaneCostPips({ cost, palette })`, `ArcaneTitleBar({ name, cost, palette })`, `ArcaneArtWindow({ art, alt, palette })`, `ArcaneTypeLine({ text, rarity, palette })`, `ArcaneRulesBox({ ability, flavor, palette })`, `ArcaneStatBadge({ might, ward, palette })`
  - `ArcaneCard.tsx`: `class ArcaneCard extends Component` with fields `data: CardData = {}`, `holo = false`, getter `palette`, overridable subcomponent methods `TitleBar() ArtWindow() TypeLine() RulesBox() StatBadge()`
  - `template.ts`: `arcaneTemplate: CardTemplate` with `id: 'arcane-hero'`, `kitId: 'arcane'`
  - `src/cards/index.ts`: barrel re-exporting everything above plus base/types/registry, and `registerBuiltinTemplates(): void` (idempotent)

- [ ] **Step 1: Write the failing tests**

`src/cards/arcane/arcane.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { getTemplate } from '../registry'
import { mount, tick } from '../../../test/util'
import { ArcaneCard } from './ArcaneCard'
import { paletteFor } from './palette'
import { arcaneTemplate } from './template'

describe('arcane palette', () => {
  it('resolves known essences and falls back to relic', () => {
    expect(paletteFor('ember').id).toBe('ember')
    expect(paletteFor('bogus').id).toBe('relic')
  })
})

describe('arcane template', () => {
  it('is registered by test setup', () => {
    expect(getTemplate('arcane-hero').kitId).toBe('arcane')
  })

  it('provides defaults for every non-image field', () => {
    for (const field of arcaneTemplate.fields) {
      if (field.kind === 'image') continue
      expect(arcaneTemplate.defaults[field.key], `default for ${field.key}`).toBeDefined()
    }
  })

  it('bakes the essence art flavor into the style prompt', () => {
    const prompt = arcaneTemplate.artStylePrompt({ essence: 'tide' })
    expect(prompt).toContain(paletteFor('tide').artFlavor)
    expect(prompt.toLowerCase()).toContain('portrait')
  })
})

describe('ArcaneCard', () => {
  it('renders name, type line, rules, and stats from data', async () => {
    const { container, unmount } = mount(<ArcaneCard data={arcaneTemplate.defaults} />)
    await tick()
    const text = container.textContent ?? ''
    expect(text).toContain('Nyra, Ember Sage')
    expect(text).toContain('Hero — Pyromancer')
    expect(text).toContain('deal 2 damage')
    expect(text).toContain('2')
    expect(text).toContain('3')
    expect(container.querySelector('[data-holo="true"]')).toBeNull()
    unmount()
  })

  it('shows holo foil when enabled', async () => {
    const { container, unmount } = mount(<ArcaneCard data={arcaneTemplate.defaults} holo />)
    await tick()
    expect(container.querySelector('[data-holo="true"]')).not.toBeNull()
    unmount()
  })
})
```

- [ ] **Step 2: Update `test/setup.ts`**

Append to `test/setup.ts` (inside the existing `beforeEach`, after `__resetDbForTests()`):

```ts
import { registerBuiltinTemplates } from '../src/cards'
import { __clearTemplatesForTests } from '../src/cards/registry'
```

```ts
  __clearTemplatesForTests()
  registerBuiltinTemplates()
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun run test`. Expected: FAIL — arcane modules and `src/cards/index.ts` do not exist (setup.ts import fails, so the whole suite errors: implement the barrel first if you want a cleaner failure).

- [ ] **Step 4: Implement the palette**

`src/cards/arcane/palette.ts`:

```ts
export type EssenceId = 'ember' | 'tide' | 'verdant' | 'radiant' | 'umbral' | 'relic'

export interface EssencePalette {
  id: EssenceId
  label: string
  /** Outer frame gradient + border. */
  frame: string
  /** Parchment plate behind title/type/rules text. */
  plate: string
  plateText: string
  /** Inner border around the art window. */
  artEdge: string
  /** Cost pip chip. */
  pip: string
  /** Feeds artStylePrompt for AI portrait generation. */
  artFlavor: string
}

export const ESSENCES: readonly EssencePalette[] = [
  {
    id: 'ember',
    label: 'Ember',
    frame: 'bg-gradient-to-b from-[#4a1a10] via-[#8a3018] to-[#2a0d08] border-2 border-[#c96a3a]',
    plate: 'bg-[#f3ddba] border border-[#8a4a2a]',
    plateText: 'text-[#3a1a0d]',
    artEdge: 'border-[3px] border-[#c96a3a]',
    pip: 'bg-[#e0512d] text-[#ffe9d6]',
    artFlavor: 'warm ember tones, volcanic glow, sparks in the air',
  },
  {
    id: 'tide',
    label: 'Tide',
    frame: 'bg-gradient-to-b from-[#0e2a4a] via-[#1c4a7a] to-[#081828] border-2 border-[#4a8ac0]',
    plate: 'bg-[#dbe8f3] border border-[#2a5a8a]',
    plateText: 'text-[#0d2036]',
    artEdge: 'border-[3px] border-[#4a8ac0]',
    pip: 'bg-[#2d7ac0] text-[#dff0ff]',
    artFlavor: 'cool aquamarine light, mist and deep water reflections',
  },
  {
    id: 'verdant',
    label: 'Verdant',
    frame: 'bg-gradient-to-b from-[#12300f] via-[#2a5a20] to-[#0a1c08] border-2 border-[#6aa04a]',
    plate: 'bg-[#e2ecd2] border border-[#3a6a2a]',
    plateText: 'text-[#14300d]',
    artEdge: 'border-[3px] border-[#6aa04a]',
    pip: 'bg-[#4a8a2d] text-[#e8ffd6]',
    artFlavor: 'lush forest greens, dappled sunlight through leaves',
  },
  {
    id: 'radiant',
    label: 'Radiant',
    frame: 'bg-gradient-to-b from-[#5a5030] via-[#9a8a50] to-[#3a3018] border-2 border-[#e0d090]',
    plate: 'bg-[#f8f2dc] border border-[#8a7a4a]',
    plateText: 'text-[#3a300d]',
    artEdge: 'border-[3px] border-[#e0d090]',
    pip: 'bg-[#d8c060] text-[#3a300d]',
    artFlavor: 'golden dawn light, halos and soft radiance',
  },
  {
    id: 'umbral',
    label: 'Umbral',
    frame: 'bg-gradient-to-b from-[#241430] via-[#3a2050] to-[#120818] border-2 border-[#7a5aa0]',
    plate: 'bg-[#e0d8ea] border border-[#4a3a6a]',
    plateText: 'text-[#1c0d30]',
    artEdge: 'border-[3px] border-[#7a5aa0]',
    pip: 'bg-[#5a3a8a] text-[#eadfff]',
    artFlavor: 'violet shadows, moonlit gloom, drifting wisps',
  },
  {
    id: 'relic',
    label: 'Relic',
    frame: 'bg-gradient-to-b from-[#3a3a40] via-[#6a6a72] to-[#222228] border-2 border-[#a8a8b0]',
    plate: 'bg-[#ecece8] border border-[#5a5a62]',
    plateText: 'text-[#26262c]',
    artEdge: 'border-[3px] border-[#a8a8b0]',
    pip: 'bg-[#8a8a92] text-[#f4f4f0]',
    artFlavor: 'weathered stone and antique metal, museum lighting',
  },
]

export function paletteFor(id: string): EssencePalette {
  return ESSENCES.find((p) => p.id === id) ?? (ESSENCES[ESSENCES.length - 1] as EssencePalette)
}
```

- [ ] **Step 5: Implement the parts**

`src/cards/arcane/parts.tsx`:

```tsx
import type { EssencePalette } from './palette'

export type RarityId = 'common' | 'uncommon' | 'rare' | 'mythic'

export const RARITIES: readonly { value: RarityId; label: string }[] = [
  { value: 'common', label: 'Common' },
  { value: 'uncommon', label: 'Uncommon' },
  { value: 'rare', label: 'Rare' },
  { value: 'mythic', label: 'Mythic' },
]

const RARITY_GEM: Record<RarityId, string> = {
  common: 'bg-[#3a3a40]',
  uncommon: 'bg-gradient-to-br from-[#c0c8d0] to-[#707880]',
  rare: 'bg-gradient-to-br from-[#f0d060] to-[#a08020]',
  mythic: 'bg-gradient-to-br from-[#f08030] to-[#c02020]',
}

export function ArcaneCostPips(props: { cost: number; palette: EssencePalette }) {
  const pips = Math.max(0, Math.min(9, Math.round(props.cost)))
  return (
    <span className="flex items-center gap-0.5" data-testid="cost-pips">
      {Array.from({ length: pips }, (_, i) => (
        <span
          key={`pip-${String(i)}`}
          className={`inline-block h-3.5 w-3.5 rounded-full shadow-inner ${props.palette.pip}`}
        />
      ))}
    </span>
  )
}

export function ArcaneTitleBar(props: { name: string; cost: number; palette: EssencePalette }) {
  return (
    <div
      className={`flex items-center justify-between gap-2 rounded-md px-2.5 py-1 ${props.palette.plate}`}
    >
      <span className={`truncate font-display text-[15px] font-semibold ${props.palette.plateText}`}>
        {props.name}
      </span>
      <ArcaneCostPips cost={props.cost} palette={props.palette} />
    </div>
  )
}

export function ArcaneArtWindow(props: { art?: string; alt: string; palette: EssencePalette }) {
  return (
    <div className={`h-[210px] overflow-hidden rounded-sm bg-black/40 ${props.palette.artEdge}`}>
      {props.art ? (
        <img src={props.art} alt={props.alt} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full items-center justify-center bg-[radial-gradient(circle_at_50%_35%,rgba(255,255,255,0.12),transparent_60%)]">
          <span className="font-display text-4xl opacity-30">✶</span>
        </div>
      )}
    </div>
  )
}

export function ArcaneTypeLine(props: { text: string; rarity: RarityId; palette: EssencePalette }) {
  return (
    <div
      className={`flex items-center justify-between rounded-md px-2.5 py-0.5 ${props.palette.plate}`}
    >
      <span className={`truncate text-[11px] font-medium italic ${props.palette.plateText}`}>
        {props.text}
      </span>
      <span
        data-testid="rarity-gem"
        className={`h-3 w-3 shrink-0 rotate-45 rounded-[2px] shadow ${RARITY_GEM[props.rarity]}`}
      />
    </div>
  )
}

export function ArcaneRulesBox(props: { ability: string; flavor: string; palette: EssencePalette }) {
  return (
    <div className={`flex-1 space-y-1.5 overflow-hidden rounded-md px-2.5 py-2 ${props.palette.plate}`}>
      <p className={`whitespace-pre-wrap text-[12px] leading-snug ${props.palette.plateText}`}>
        {props.ability}
      </p>
      {props.flavor ? (
        <p className={`text-[11px] italic leading-snug opacity-75 ${props.palette.plateText}`}>
          {props.flavor}
        </p>
      ) : null}
    </div>
  )
}

export function ArcaneStatBadge(props: { might: number; ward: number; palette: EssencePalette }) {
  return (
    <div
      data-testid="stat-badge"
      className={`absolute bottom-2.5 right-3.5 rounded-full px-3 py-0.5 font-display text-[15px] font-bold shadow-lg ${props.palette.plate}`}
    >
      <span className={props.palette.plateText}>
        {props.might} / {props.ward}
      </span>
    </div>
  )
}
```

- [ ] **Step 6: Implement ArcaneCard**

`src/cards/arcane/ArcaneCard.tsx`:

```tsx
import { Component } from '@expressive/react'
import type { CardData } from '../types'
import { CardSurface } from '../base/CardSurface'
import { paletteFor } from './palette'
import {
  ArcaneArtWindow,
  ArcaneRulesBox,
  ArcaneStatBadge,
  ArcaneTitleBar,
  ArcaneTypeLine,
  type RarityId,
} from './parts'

/**
 * The Arcane kit's card. Capital-letter methods are expressive subcomponents —
 * subclasses (including Code Lab users) can override any of them:
 *   class MyCard extends ArcaneCard { TitleBar = () => <div>custom</div> }
 */
export class ArcaneCard extends Component {
  data: CardData = {}
  holo = false

  get palette() {
    return paletteFor(String(this.data.essence ?? 'relic'))
  }

  TitleBar() {
    return (
      <ArcaneTitleBar
        name={String(this.data.name ?? 'Unnamed')}
        cost={Number(this.data.cost ?? 0)}
        palette={this.palette}
      />
    )
  }

  ArtWindow() {
    const art = this.data.art
    return (
      <ArcaneArtWindow
        art={typeof art === 'string' && art.length > 0 ? art : undefined}
        alt={String(this.data.name ?? 'card art')}
        palette={this.palette}
      />
    )
  }

  TypeLine() {
    return (
      <ArcaneTypeLine
        text={String(this.data.typeLine ?? '')}
        rarity={(this.data.rarity ?? 'common') as RarityId}
        palette={this.palette}
      />
    )
  }

  RulesBox() {
    return (
      <ArcaneRulesBox
        ability={String(this.data.ability ?? '')}
        flavor={String(this.data.flavor ?? '')}
        palette={this.palette}
      />
    )
  }

  StatBadge() {
    return (
      <ArcaneStatBadge
        might={Number(this.data.might ?? 0)}
        ward={Number(this.data.ward ?? 0)}
        palette={this.palette}
      />
    )
  }

  render() {
    return (
      <CardSurface holo={this.holo} frameClass={this.palette.frame}>
        <div className="flex h-full flex-col gap-1.5 p-3.5">
          <this.TitleBar />
          <this.ArtWindow />
          <this.TypeLine />
          <this.RulesBox />
        </div>
        <this.StatBadge />
      </CardSurface>
    )
  }
}
```

- [ ] **Step 7: Implement the template and barrel**

`src/cards/arcane/template.ts`:

```ts
import type { CardTemplate } from '../types'
import { ArcaneCard } from './ArcaneCard'
import { ESSENCES, paletteFor } from './palette'
import { RARITIES } from './parts'

export const arcaneTemplate: CardTemplate = {
  id: 'arcane-hero',
  kitId: 'arcane',
  name: 'Arcane Hero',
  description: 'Cartis take on a classic fantasy trading card: essence frame, ability box, might/ward.',
  fields: [
    { kind: 'text', key: 'name', label: 'Name', placeholder: 'Nyra, Ember Sage', maxLength: 28 },
    {
      kind: 'select',
      key: 'essence',
      label: 'Essence',
      options: ESSENCES.map((e) => ({ value: e.id, label: e.label })),
    },
    { kind: 'number', key: 'cost', label: 'Cost', min: 0, max: 9 },
    { kind: 'image', key: 'art', label: 'Portrait' },
    { kind: 'text', key: 'typeLine', label: 'Type line', placeholder: 'Hero — Baker' },
    { kind: 'textarea', key: 'ability', label: 'Ability', rows: 3 },
    { kind: 'textarea', key: 'flavor', label: 'Flavor text', rows: 2 },
    { kind: 'number', key: 'might', label: 'Might', min: 0, max: 20 },
    { kind: 'number', key: 'ward', label: 'Ward', min: 0, max: 20 },
    { kind: 'select', key: 'rarity', label: 'Rarity', options: RARITIES },
  ],
  defaults: {
    name: 'Nyra, Ember Sage',
    essence: 'ember',
    cost: 3,
    typeLine: 'Hero — Pyromancer',
    ability: 'When Nyra enters play, deal 2 damage to any target.',
    flavor: '“The spark was always hers to keep.”',
    might: 2,
    ward: 3,
    rarity: 'rare',
  },
  artStylePrompt: (data) =>
    [
      'Fantasy oil painting portrait of the person, head and shoulders',
      paletteFor(String(data.essence ?? 'relic')).artFlavor,
      'dramatic lighting, painterly brushwork, ornate trading card illustration',
    ].join(', '),
  Render: ArcaneCard,
}
```

`src/cards/index.ts`:

```ts
import { arcaneTemplate } from './arcane/template'
import { listTemplates, registerTemplate } from './registry'

export { CARD_HEIGHT, CARD_WIDTH, CardSurface, HoloFoil } from './base/CardSurface'
export { ArcaneCard } from './arcane/ArcaneCard'
export { ESSENCES, paletteFor, type EssenceId, type EssencePalette } from './arcane/palette'
export {
  ArcaneArtWindow,
  ArcaneCostPips,
  ArcaneRulesBox,
  ArcaneStatBadge,
  ArcaneTitleBar,
  ArcaneTypeLine,
  RARITIES,
  type RarityId,
} from './arcane/parts'
export { arcaneTemplate } from './arcane/template'
export { getTemplate, listTemplates, registerTemplate } from './registry'
export type { CardData, CardRenderProps, CardRenderer, CardTemplate, FieldSpec, FieldValue } from './types'

/** Idempotent: safe to call from main.tsx and from every test's setup. */
export function registerBuiltinTemplates(): void {
  if (!listTemplates().some((t) => t.id === arcaneTemplate.id)) {
    registerTemplate(arcaneTemplate)
  }
}
```

Also add to `src/main.tsx`, before `createRoot(...)`:

```ts
import { registerBuiltinTemplates } from './cards'

registerBuiltinTemplates()
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `bun run test`. Expected: PASS — 7 new arcane tests, everything else green.

- [ ] **Step 9: Verify in the browser, then commit**

Run `bun run dev` and temporarily eyeball nothing (the shell still shows placeholders — the card appears in Task 6; skip if impatient). Then:

```bash
bun run check && bun run verify
git add -A
git commit -m "feat: add arcane card kit with palette, parts, card, and registered template"
```

---

### Task 6: Static Builder — Schema Form Left, Live Card Right

**Files:**
- Create: `src/builder/FormRenderer.tsx`, `src/builder/BuilderView.tsx`
- Modify: `src/app/AppShell.tsx` (swap builder pane placeholder)
- Test: `src/builder/builder.test.tsx`

**Interfaces:**
- Consumes: ui kit (Task 2), `AppShell` + `archive` (Task 4), template registry + `arcaneTemplate` (Task 5), `mountApp`/`setInput` helpers.
- Produces:
  - `FormRenderer(props: { fields: readonly FieldSpec[]; data: CardData; onField: (key: string, value: FieldValue) => void; imageSlot?: (spec: Extract<FieldSpec, { kind: 'image' }>) => ReactNode })` — image fields render `imageSlot(spec)` if given, else a dim note (Task 8 supplies the real slot)
  - `class BuilderView extends Component` with fields `templateId: string`, `data: CardData`, `holo: boolean`, `savedId?: string`, `savedNote: string`, `libraryImages: StoredImage[]`, `libraryUrls: Record<string, string>`, `portraitKey?: string`, `shell?: AppShell`, `previewEl: HTMLElement | null`; getters `template: CardTemplate`, `resolved: CardData`; methods `setField(key: string, value: FieldValue): void`, `pickTemplate(id: string): void`, `saveCard(): Promise<void>`, `loadCard(card: StoredCard): void`. (`libraryImages`/`libraryUrls`/`portraitKey` sit unused until Task 8; `shell` mirror wiring lands in Task 8's `mount()`; Task 10 adds the `pendingCard` watcher.)

- [ ] **Step 1: Write the failing tests**

`src/builder/builder.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { click, mountApp, setInput, tick } from '../../test/util'

describe('BuilderView', () => {
  it('renders the arcane form from its schema with defaults applied', async () => {
    const { container, unmount } = await mountApp()
    const text = container.textContent ?? ''
    for (const label of ['Name', 'Essence', 'Cost', 'Portrait', 'Type line', 'Ability', 'Flavor text', 'Might', 'Ward', 'Rarity']) {
      expect(text).toContain(label)
    }
    // Preview shows the default card
    expect(text).toContain('Nyra, Ember Sage')
    unmount()
  })

  it('live-updates the preview as the name field is typed', async () => {
    const { container, unmount } = await mountApp()
    const nameInput = container.querySelector('aside input[type="text"]')
    await setInput(nameInput, 'Zara the Bold')
    // input value is not textContent, so this asserts the *preview* re-rendered
    expect(container.textContent).toContain('Zara the Bold')
    unmount()
  })

  it('toggles holo foil on the preview', async () => {
    const { container, unmount } = await mountApp()
    expect(container.querySelector('[data-holo="true"]')).toBeNull()
    const holoButton = Array.from(container.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').startsWith('Holo'),
    )
    await click(holoButton ?? null)
    expect(container.querySelector('[data-holo="true"]')).not.toBeNull()
    unmount()
  })

  it('saves the current card into the archive', async () => {
    const { container, shell, unmount } = await mountApp()
    await vi.waitFor(() => {
      expect(shell.archive.ready).toBe(true)
    })
    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save to gallery',
    )
    await click(saveButton ?? null)
    await vi.waitFor(() => {
      expect(shell.archive.cards).toHaveLength(1)
    })
    expect(shell.archive.cards[0]?.name).toBe('Nyra, Ember Sage')
    expect(shell.archive.cards[0]?.templateId).toBe('arcane-hero')
    unmount()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test`. Expected: FAIL — the builder pane still shows "Builder arrives in Task 6."; form labels are absent.

- [ ] **Step 3: Implement FormRenderer**

`src/builder/FormRenderer.tsx`:

```tsx
import type { ReactNode } from 'react'
import type { CardData, FieldSpec, FieldValue } from '../cards/types'
import { FieldRow, NumberInput, SelectInput, TextAreaInput, TextInput } from '../ui'

type ImageSpec = Extract<FieldSpec, { kind: 'image' }>

export function FormRenderer(props: {
  fields: readonly FieldSpec[]
  data: CardData
  onField: (key: string, value: FieldValue) => void
  imageSlot?: (spec: ImageSpec) => ReactNode
}) {
  return (
    <div className="flex flex-col gap-3">
      {props.fields.map((spec) => (
        <FieldRow key={spec.key} label={spec.label}>
          <FieldControl spec={spec} data={props.data} onField={props.onField} imageSlot={props.imageSlot} />
        </FieldRow>
      ))}
    </div>
  )
}

function FieldControl(props: {
  spec: FieldSpec
  data: CardData
  onField: (key: string, value: FieldValue) => void
  imageSlot?: (spec: ImageSpec) => ReactNode
}) {
  const { spec, data, onField } = props
  const raw = data[spec.key]
  switch (spec.kind) {
    case 'text':
      return (
        <TextInput
          value={String(raw ?? '')}
          onValue={(v) => onField(spec.key, v)}
          placeholder={spec.placeholder}
          maxLength={spec.maxLength}
        />
      )
    case 'textarea':
      return (
        <TextAreaInput
          value={String(raw ?? '')}
          onValue={(v) => onField(spec.key, v)}
          rows={spec.rows}
          placeholder={spec.placeholder}
        />
      )
    case 'number':
      return (
        <NumberInput
          value={Number(raw ?? spec.min)}
          onValue={(v) => onField(spec.key, v)}
          min={spec.min}
          max={spec.max}
        />
      )
    case 'select':
      return (
        <SelectInput
          value={String(raw ?? spec.options[0]?.value ?? '')}
          onValue={(v) => onField(spec.key, v)}
          options={spec.options}
        />
      )
    case 'image':
      return props.imageSlot ? (
        <>{props.imageSlot(spec)}</>
      ) : (
        <p className="text-xs text-ink-dim">Portrait tools arrive with the image pipeline.</p>
      )
  }
}
```

- [ ] **Step 4: Implement BuilderView**

`src/builder/BuilderView.tsx`:

```tsx
import { Component } from '@expressive/react'
// Value import of AppShell is a deliberate module cycle (AppShell renders BuilderView).
// Safe: neither module touches the other's binding during module evaluation — only
// inside method bodies at runtime, which ESM live bindings resolve correctly.
import { AppShell } from '../app/AppShell'
import { getTemplate, listTemplates } from '../cards/registry'
import type { CardData, CardTemplate, FieldValue } from '../cards/types'
import type { StoredCard } from '../storage/CardArchive'
import type { StoredImage } from '../storage/ImageLibrary'
import { Button, Panel, SelectInput } from '../ui'
import { FormRenderer } from './FormRenderer'

export class BuilderView extends Component {
  templateId = ''
  data: CardData = {}
  holo = false
  savedId?: string = undefined
  savedNote = ''
  /** Mirrored from AppShell.library in Task 8; consumed by `resolved` and the portrait slot. */
  libraryImages: StoredImage[] = []
  libraryUrls: Record<string, string> = {}
  portraitKey?: string = undefined
  shell?: AppShell = undefined
  previewEl: HTMLElement | null = null

  protected new() {
    const first = listTemplates()[0]
    if (first) this.pickTemplate(first.id)
  }

  get template(): CardTemplate {
    return getTemplate(this.templateId)
  }

  /** Card data with image references resolved to displayable URLs. */
  get resolved(): CardData {
    const out: CardData = { ...this.data }
    for (const field of this.template.fields) {
      if (field.kind !== 'image') continue
      const raw = out[field.key]
      const id = typeof raw === 'string' ? raw : ''
      out[field.key] =
        this.libraryUrls[id] ?? (id.startsWith('blob:') || id.startsWith('data:') ? id : undefined)
    }
    return out
  }

  setField(key: string, value: FieldValue) {
    this.data = { ...this.data, [key]: value }
  }

  pickTemplate(id: string) {
    this.templateId = id
    this.data = { ...getTemplate(id).defaults }
    this.savedId = undefined
    this.savedNote = ''
  }

  loadCard(card: StoredCard) {
    this.templateId = card.templateId
    this.data = { ...card.data }
    this.holo = card.holo
    this.savedId = card.id
    this.savedNote = ''
  }

  async saveCard() {
    const shell = this.shell ?? this.get(AppShell)
    const saved = await shell.archive.saveCard({
      id: this.savedId,
      name: String(this.data.name ?? 'Untitled'),
      templateId: this.templateId,
      data: this.data,
      holo: this.holo,
    })
    this.savedId = saved.id
    this.savedNote = `Saved “${saved.name}” to the gallery.`
  }

  Form() {
    return (
      <aside className="flex w-96 shrink-0 flex-col gap-4 overflow-y-auto border-r border-edge p-4">
        <Panel title="Template">
          <SelectInput
            value={this.templateId}
            onValue={(id) => this.pickTemplate(id)}
            options={listTemplates().map((t) => ({ value: t.id, label: t.name }))}
          />
          <p className="mt-2 text-xs text-ink-dim">{this.template.description}</p>
        </Panel>
        <Panel title="Details">
          <FormRenderer fields={this.template.fields} data={this.data} onField={this.setField} />
        </Panel>
        <div className="flex items-center gap-3">
          <Button onClick={() => void this.saveCard()}>Save to gallery</Button>
          {this.savedNote ? <span className="text-xs text-ink-dim">{this.savedNote}</span> : null}
        </div>
      </aside>
    )
  }

  Preview() {
    const Render = this.template.Render
    return (
      <section className="flex min-w-0 flex-1 items-center justify-center overflow-auto p-6">
        <div className="flex flex-col items-center gap-4">
          <div
            ref={(el) => {
              this.previewEl = el
            }}
          >
            <Render data={this.resolved} holo={this.holo} />
          </div>
          <div className="flex items-center gap-3">
            <Button
              tone="ghost"
              onClick={() => {
                this.holo = !this.holo
              }}
            >
              {this.holo ? 'Holo: on' : 'Holo: off'}
            </Button>
          </div>
        </div>
      </section>
    )
  }

  render() {
    return (
      <div className="flex h-full">
        <this.Form />
        <this.Preview />
      </div>
    )
  }
}
```

Notes on the class above: `setField` is passed directly as a prop (`onField={this.setField}`) — expressive auto-binds methods, so no arrow wrapper is needed. Task 8 adds an `imageSlot` prop to that `FormRenderer` usage and wires `this.shell` in `mount()`; until then `saveCard` falls back to the `this.get(AppShell)` context lookup.

- [ ] **Step 5: Mount it in the shell**

In `src/app/AppShell.tsx`:

```tsx
import { BuilderView } from '../builder/BuilderView'
```

and replace the builder pane:

```tsx
          <Pane active={this.view === 'builder'}>
            <BuilderView />
          </Pane>
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun run test`. Expected: PASS — 4 new builder tests; AppShell test unchanged and green.

- [ ] **Step 7: Verify live in the browser**

Run `bun run dev`, open http://localhost:5173: form on the left with all ten labeled controls, ember-framed Arcane card on the right; typing a name updates the card **as you type**; switching essence recolors the frame; Holo toggle shimmers. This is the app's core loop — actually look at it.

- [ ] **Step 8: Commit**

```bash
bun run check && bun run verify
git add -A
git commit -m "feat: add static builder with schema-driven form and live card preview"
```

---

### Task 7: Image Providers (Stub + Replicate Client) and the Image Lab

The AI image subsystem, spec'd as its own composable components: an `ImageProvider` interface, an **offline stub** (canvas stylization — the default, per "you can stub the images for now"), a thin client for the Replicate bridge endpoint (server half lands in Task 13; until then provider selection gracefully falls back to stub), webcam capture, and the isolated Image Lab tab.

**Files:**
- Create: `src/images/codec.ts`, `src/images/prompt.ts`, `src/images/provider.ts`, `src/images/stub.ts`, `src/images/replicate.ts`, `src/images/CameraCapture.tsx`, `src/images/ImageLabView.tsx`
- Modify: `src/app/AppShell.tsx` (swap images pane)
- Test: `src/images/images.test.tsx`

**Interfaces:**
- Consumes: `AppShell.library` (Task 4), `listTemplates`/`getTemplate` (Task 5), ui kit.
- Produces:
  - `codec.ts`: `bytesToDataUrl(bytes: ArrayBuffer, type: string): string`; `dataUrlToBytes(dataUrl: string): { bytes: ArrayBuffer; type: string }` — environment-neutral (also imported by the Task 13 server bridge)
  - `prompt.ts`: `interface Persona { age?: string; gender?: string; detail?: string; hobby?: string }`; `buildPortraitPrompt(stylePrompt: string, persona: Persona): string`
  - `provider.ts`: `interface GenerationInput { sourceBytes: ArrayBuffer; sourceType: string; prompt: string; styleId: string }`; `interface GenerationOutput { bytes: ArrayBuffer; type: string }`; `interface ImageProvider { readonly id: 'stub' | 'replicate'; generate(input: GenerationInput): Promise<GenerationOutput> }`; `selectImageProvider(fetchImpl?: typeof fetch): Promise<ImageProvider>`
  - `stub.ts`: `interface StubStyle { hue: number; label: string }`; `stubStyleFor(styleId: string): StubStyle` (deterministic); `type PaintFn = (input: GenerationInput, style: StubStyle) => Promise<GenerationOutput>`; `paintStylizedFrame: PaintFn` (canvas; browser-only); `createStubProvider(paint?: PaintFn): ImageProvider`; `stubProvider: ImageProvider`
  - `replicate.ts`: `replicateProvider: ImageProvider` (+ `createReplicateProvider(fetchImpl?: typeof fetch): ImageProvider` for tests)
  - `CameraCapture.tsx`: `class CameraCapture extends Component` with fields `onFrame?: (bytes: ArrayBuffer, type: string) => void`, `error: string`
  - `ImageLabView.tsx`: `class ImageLabView extends Component` with fields `prompt`, `styleId`, `sourceBytes?`, `sourceType`, `sourcePreview`, `useCamera`, `busy`, `note`, `images: StoredImage[]`, `imageUrls: Record<string, string>`, `shell?: AppShell`; getter `fullPrompt: string`; methods `acceptSource(bytes: ArrayBuffer, type: string): void`, `generate(provider?: ImageProvider): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`src/images/images.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { mount, tick } from '../../test/util'
import type { AppShell } from '../app/AppShell'
import { ImageLibrary } from '../storage/ImageLibrary'
import { CameraCapture } from './CameraCapture'
import { bytesToDataUrl, dataUrlToBytes } from './codec'
import { ImageLabView } from './ImageLabView'
import { buildPortraitPrompt } from './prompt'
import { selectImageProvider } from './provider'
import type { GenerationInput, ImageProvider } from './provider'
import { createStubProvider, stubStyleFor } from './stub'

const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer

describe('codec', () => {
  it('round-trips bytes through a data url', () => {
    const original = bytesOf('hello cartis')
    const url = bytesToDataUrl(original, 'image/png')
    expect(url.startsWith('data:image/png;base64,')).toBe(true)
    const back = dataUrlToBytes(url)
    expect(back.type).toBe('image/png')
    expect(new TextDecoder().decode(back.bytes)).toBe('hello cartis')
  })
})

describe('buildPortraitPrompt', () => {
  it('folds persona details into the style prompt, skipping blanks', () => {
    const prompt = buildPortraitPrompt('oil painting portrait', {
      age: '34',
      gender: '',
      detail: 'wears a silver pendant',
      hobby: 'baking sourdough',
    })
    expect(prompt).toContain('oil painting portrait')
    expect(prompt).toContain('34')
    expect(prompt).toContain('silver pendant')
    expect(prompt).toContain('baking sourdough')
    expect(prompt).not.toContain('undefined')
  })
})

describe('stub provider', () => {
  it('derives a deterministic style per styleId', () => {
    expect(stubStyleFor('arcane-hero')).toEqual(stubStyleFor('arcane-hero'))
    expect(stubStyleFor('a').hue).not.toBe(stubStyleFor('b').hue)
  })

  it('paints via the injected paint fn and falls back to the source on paint failure', async () => {
    const painted = { bytes: bytesOf('painted'), type: 'image/png' }
    const provider = createStubProvider(async () => painted)
    const input: GenerationInput = { sourceBytes: bytesOf('src'), sourceType: 'image/jpeg', prompt: 'p', styleId: 's' }
    expect(await provider.generate(input)).toBe(painted)

    const failing = createStubProvider(async () => {
      throw new Error('no canvas here')
    })
    const fallback = await failing.generate(input)
    expect(fallback.type).toBe('image/jpeg')
    expect(new TextDecoder().decode(fallback.bytes)).toBe('src')
  })
})

describe('selectImageProvider', () => {
  it('picks replicate when the bridge reports it', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ image: 'replicate' }))) as unknown as typeof fetch
    expect((await selectImageProvider(fetchImpl)).id).toBe('replicate')
  })

  it('falls back to stub when the bridge is absent', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('no server')
    }) as unknown as typeof fetch
    expect((await selectImageProvider(fetchImpl)).id).toBe('stub')
  })
})

describe('CameraCapture', () => {
  it('reports camera unavailability in environments without getUserMedia', async () => {
    const { container, unmount } = mount(<CameraCapture />)
    await tick()
    expect(container.textContent).toContain('Camera unavailable')
    unmount()
  })
})

describe('ImageLabView (headless)', () => {
  it('requires a source photo before generating', async () => {
    const lab = ImageLabView.new()
    await lab.generate()
    expect(lab.note).toContain('photo first')
    lab.set(null)
  })

  it('generates via the given provider and stores the result in the library', async () => {
    const lab = ImageLabView.new()
    const library = ImageLibrary.new()
    await vi.waitFor(() => {
      expect(library.ready).toBe(true)
    })
    lab.shell = { library } as unknown as AppShell
    lab.acceptSource(bytesOf('face'), 'image/jpeg')
    lab.prompt = 'as a noble knight'
    const provider: ImageProvider = {
      id: 'stub',
      generate: vi.fn(async () => ({ bytes: bytesOf('styled'), type: 'image/png' })),
    }
    await lab.generate(provider)
    expect(provider.generate).toHaveBeenCalledOnce()
    expect(library.images).toHaveLength(1)
    expect(library.images[0]?.kind).toBe('generated')
    expect(library.images[0]?.prompt).toContain('noble knight')
    expect(lab.note).toContain('stub')
    lab.set(null)
    library.set(null)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test`. Expected: FAIL — `src/images/*` modules do not exist.

- [ ] **Step 3: Implement codec, prompt, provider, stub, replicate**

`src/images/codec.ts`:

```ts
/** Environment-neutral (browser + node/bun): used by the UI and the dev-server bridge. */

export function bytesToDataUrl(bytes: ArrayBuffer, type: string): string {
  const view = new Uint8Array(bytes)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < view.length; i += chunk) {
    binary += String.fromCharCode(...view.subarray(i, i + chunk))
  }
  return `data:${type};base64,${btoa(binary)}`
}

export function dataUrlToBytes(dataUrl: string): { bytes: ArrayBuffer; type: string } {
  const match = /^data:([^;,]+);base64,(.*)$/.exec(dataUrl)
  if (!match) throw new Error('not a base64 data url')
  const [, type = 'application/octet-stream', payload = ''] = match
  const binary = atob(payload)
  const view = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i)
  return { bytes: view.buffer, type }
}
```

`src/images/prompt.ts`:

```ts
export interface Persona {
  age?: string
  gender?: string
  detail?: string
  hobby?: string
}

/** Compose the template's art-style prompt with optional person details. */
export function buildPortraitPrompt(stylePrompt: string, persona: Persona): string {
  const clauses = [
    stylePrompt,
    persona.age?.trim() ? `age ${persona.age.trim()}` : '',
    persona.gender?.trim() ?? '',
    persona.detail?.trim() ? `notable detail: ${persona.detail.trim()}` : '',
    persona.hobby?.trim() ? `styled around their hobby of ${persona.hobby.trim()}` : '',
    'keep the face recognizably the same person',
  ]
  return clauses.filter((c) => c.length > 0).join(', ')
}
```

`src/images/provider.ts`:

```ts
import { createReplicateProvider } from './replicate'
import { stubProvider } from './stub'

export interface GenerationInput {
  sourceBytes: ArrayBuffer
  sourceType: string
  prompt: string
  styleId: string
}

export interface GenerationOutput {
  bytes: ArrayBuffer
  type: string
}

export interface ImageProvider {
  readonly id: 'stub' | 'replicate'
  generate(input: GenerationInput): Promise<GenerationOutput>
}

/** Ask the dev-server bridge which provider is live; without a bridge, stub. */
export async function selectImageProvider(fetchImpl: typeof fetch = fetch): Promise<ImageProvider> {
  try {
    const res = await fetchImpl('/api/status')
    const body = (await res.json()) as { image?: string }
    if (body.image === 'replicate') return createReplicateProvider(fetchImpl)
  } catch {
    // no bridge running (tests, vite preview) — offline stub it is
  }
  return stubProvider
}
```

`src/images/stub.ts`:

```ts
import type { GenerationInput, GenerationOutput, ImageProvider } from './provider'

export interface StubStyle {
  hue: number
  label: string
}

/** Deterministic pseudo-style from the styleId so repeated runs look consistent. */
export function stubStyleFor(styleId: string): StubStyle {
  let hash = 7
  for (const ch of styleId) hash = (hash * 31 + ch.charCodeAt(0)) % 360
  return { hue: hash, label: `stubbed ${styleId}` }
}

export type PaintFn = (input: GenerationInput, style: StubStyle) => Promise<GenerationOutput>

/** Browser-only: tint + vignette the source photo on a canvas as a fake "AI style". */
export const paintStylizedFrame: PaintFn = async (input, style) => {
  const bitmap = await createImageBitmap(new Blob([input.sourceBytes], { type: input.sourceType }))
  const size = 768
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d unavailable')
  // cover-crop the bitmap into a square
  const scale = Math.max(size / bitmap.width, size / bitmap.height)
  const w = bitmap.width * scale
  const h = bitmap.height * scale
  ctx.filter = 'saturate(1.4) contrast(1.15)'
  ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h)
  ctx.filter = 'none'
  ctx.globalCompositeOperation = 'overlay'
  ctx.fillStyle = `hsla(${String(style.hue)}, 70%, 50%, 0.35)`
  ctx.fillRect(0, 0, size, size)
  ctx.globalCompositeOperation = 'source-over'
  const vignette = ctx.createRadialGradient(size / 2, size / 2, size * 0.35, size / 2, size / 2, size * 0.72)
  vignette.addColorStop(0, 'rgba(0,0,0,0)')
  vignette.addColorStop(1, 'rgba(0,0,0,0.55)')
  ctx.fillStyle = vignette
  ctx.fillRect(0, 0, size, size)
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
  })
  return { bytes: await blob.arrayBuffer(), type: 'image/png' }
}

export function createStubProvider(paint: PaintFn = paintStylizedFrame): ImageProvider {
  return {
    id: 'stub',
    async generate(input) {
      try {
        return await paint(input, stubStyleFor(input.styleId))
      } catch {
        // canvas unavailable (tests) or decode failure: pass the source through
        return { bytes: input.sourceBytes, type: input.sourceType }
      }
    },
  }
}

export const stubProvider: ImageProvider = createStubProvider()
```

`src/images/replicate.ts`:

```ts
import { bytesToDataUrl, dataUrlToBytes } from './codec'
import type { GenerationOutput, ImageProvider } from './provider'

/** Talks to the local bridge (Task 13), which holds the REPLICATE_API_TOKEN server-side. */
export function createReplicateProvider(fetchImpl: typeof fetch = fetch): ImageProvider {
  return {
    id: 'replicate',
    async generate(input) {
      const res = await fetchImpl('/api/image/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: input.prompt,
          imageDataUrl: bytesToDataUrl(input.sourceBytes, input.sourceType),
        }),
      })
      const body = (await res.json()) as { dataUrl?: string; error?: string }
      if (!res.ok || !body.dataUrl) {
        throw new Error(body.error ?? `image bridge failed (${String(res.status)})`)
      }
      const out: GenerationOutput = dataUrlToBytes(body.dataUrl)
      return out
    },
  }
}

export const replicateProvider: ImageProvider = createReplicateProvider()
```

- [ ] **Step 4: Implement CameraCapture**

`src/images/CameraCapture.tsx`:

```tsx
import { Component } from '@expressive/react'

/** "Lock on to a webcam, take a pic" — stream starts on mount, stops on unmount. */
export class CameraCapture extends Component {
  onFrame?: (bytes: ArrayBuffer, type: string) => void = undefined
  error = ''
  #video: HTMLVideoElement | null = null
  #stream: MediaStream | undefined

  mount() {
    const media = navigator.mediaDevices
    if (!media?.getUserMedia) {
      this.error = 'Camera unavailable in this environment.'
      return
    }
    media
      .getUserMedia({ video: { facingMode: 'user' }, audio: false })
      .then((stream) => {
        this.#stream = stream
        if (this.#video) this.#video.srcObject = stream
      })
      .catch((cause: unknown) => {
        this.error = `Camera unavailable: ${cause instanceof Error ? cause.message : String(cause)}`
      })
    return () => {
      for (const track of this.#stream?.getTracks() ?? []) track.stop()
    }
  }

  async capture() {
    const video = this.#video
    if (!video || video.videoWidth === 0) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d')?.drawImage(video, 0, 0)
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/png')
    })
    if (blob) this.onFrame?.(await blob.arrayBuffer(), 'image/png')
  }

  render() {
    if (this.error) {
      return <p className="rounded border border-edge p-3 text-xs text-ink-dim">{this.error}</p>
    }
    return (
      <div className="flex flex-col gap-2">
        <video
          autoPlay
          muted
          playsInline
          className="aspect-video w-full rounded border border-edge bg-black object-cover"
          ref={(el) => {
            this.#video = el
            if (el && this.#stream) el.srcObject = this.#stream
          }}
        />
        <button
          type="button"
          onClick={() => void this.capture()}
          className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-surface hover:brightness-110"
        >
          Take photo
        </button>
      </div>
    )
  }
}
```

- [ ] **Step 5: Implement ImageLabView and mount it**

`src/images/ImageLabView.tsx`:

```tsx
import { Component } from '@expressive/react'
import { AppShell } from '../app/AppShell'
import { getTemplate, listTemplates } from '../cards/registry'
import type { StoredImage } from '../storage/ImageLibrary'
import { Button, EmptyState, FieldRow, Panel, SelectInput, TextAreaInput } from '../ui'
import { CameraCapture } from './CameraCapture'
import { bytesToDataUrl } from './codec'
import { selectImageProvider } from './provider'
import type { ImageProvider } from './provider'

export class ImageLabView extends Component {
  prompt = ''
  styleId = 'freestyle'
  sourceBytes?: ArrayBuffer = undefined
  sourceType = ''
  sourcePreview = ''
  useCamera = false
  busy = false
  note = ''
  images: StoredImage[] = []
  imageUrls: Record<string, string> = {}
  shell?: AppShell = undefined

  mount() {
    const shell = this.get(AppShell)
    this.shell = shell
    return shell.library.get((current) => {
      this.images = current.images
      this.imageUrls = current.urls
    })
  }

  get fullPrompt(): string {
    const base =
      this.styleId === 'freestyle'
        ? ''
        : (() => {
            const t = getTemplate(this.styleId)
            return t.artStylePrompt(t.defaults)
          })()
    return [base, this.prompt.trim()].filter((s) => s.length > 0).join(', ')
  }

  acceptSource(bytes: ArrayBuffer, type: string) {
    this.sourceBytes = bytes
    this.sourceType = type
    this.sourcePreview = bytesToDataUrl(bytes, type)
    this.note = ''
  }

  async generate(provider?: ImageProvider) {
    if (this.busy) return
    const source = this.sourceBytes
    if (!source) {
      this.note = 'Capture or upload a photo first.'
      return
    }
    this.busy = true
    this.note = 'Generating…'
    try {
      const chosen = provider ?? (await selectImageProvider())
      const prompt = this.fullPrompt
      const out = await chosen.generate({
        sourceBytes: source,
        sourceType: this.sourceType,
        prompt,
        styleId: this.styleId,
      })
      const shell = this.shell
      if (!shell) throw new Error('image library unavailable')
      await shell.library.add({ kind: 'generated', prompt, styleId: this.styleId, bytes: out.bytes, type: out.type })
      this.note = `Done — generated via ${chosen.id}.`
    } catch (cause) {
      this.note = cause instanceof Error ? cause.message : String(cause)
    } finally {
      this.busy = false
    }
  }

  Source() {
    return (
      <Panel title="Source photo">
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <Button tone={this.useCamera ? 'ghost' : 'accent'} onClick={() => { this.useCamera = false }}>
              Upload
            </Button>
            <Button tone={this.useCamera ? 'accent' : 'ghost'} onClick={() => { this.useCamera = true }}>
              Webcam
            </Button>
          </div>
          {this.useCamera ? (
            <CameraCapture onFrame={(bytes, type) => this.acceptSource(bytes, type)} />
          ) : (
            <input
              type="file"
              accept="image/*"
              className="text-xs text-ink-dim file:mr-3 file:rounded file:border-0 file:bg-accent file:px-3 file:py-1.5 file:text-surface"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (!file) return
                void file.arrayBuffer().then((bytes) => this.acceptSource(bytes, file.type || 'image/png'))
              }}
            />
          )}
          {this.sourcePreview ? (
            <img src={this.sourcePreview} alt="source" className="h-28 w-28 rounded object-cover" />
          ) : null}
        </div>
      </Panel>
    )
  }

  Controls() {
    const styleOptions = [
      { value: 'freestyle', label: 'Freestyle prompt' },
      ...listTemplates().map((t) => ({ value: t.id, label: `${t.name} style` })),
    ]
    return (
      <Panel title="Generation">
        <div className="flex flex-col gap-3">
          <FieldRow label="Style">
            <SelectInput value={this.styleId} onValue={(v) => { this.styleId = v }} options={styleOptions} />
          </FieldRow>
          <FieldRow label="Prompt">
            <TextAreaInput
              value={this.prompt}
              onValue={(v) => { this.prompt = v }}
              rows={3}
              placeholder="as a storm mage atop a cliff…"
            />
          </FieldRow>
          <div className="flex items-center gap-3">
            <Button disabled={this.busy} onClick={() => void this.generate()}>
              {this.busy ? 'Generating…' : 'Generate'}
            </Button>
            {this.note ? <span className="text-xs text-ink-dim">{this.note}</span> : null}
          </div>
        </div>
      </Panel>
    )
  }

  Results() {
    const generated = this.images.filter((i) => i.kind === 'generated')
    if (generated.length === 0) {
      return <EmptyState message="No generations yet." hint="Results land here and in the Gallery." />
    }
    return (
      <div className="grid grid-cols-3 gap-3 overflow-y-auto p-1 xl:grid-cols-4">
        {generated.map((image) => (
          <figure key={image.id} className="flex flex-col gap-1">
            <img
              src={this.imageUrls[image.id]}
              alt={image.prompt ?? 'generated'}
              className="aspect-square w-full rounded border border-edge object-cover"
            />
            <figcaption className="truncate text-[11px] text-ink-dim">{image.prompt}</figcaption>
          </figure>
        ))}
      </div>
    )
  }

  render() {
    return (
      <div className="flex h-full">
        <aside className="flex w-96 shrink-0 flex-col gap-4 overflow-y-auto border-r border-edge p-4">
          <this.Source />
          <this.Controls />
        </aside>
        <section className="min-w-0 flex-1 overflow-y-auto p-4">
          <this.Results />
        </section>
      </div>
    )
  }
}
```

In `src/app/AppShell.tsx`, import `ImageLabView` and swap the images pane:

```tsx
import { ImageLabView } from '../images/ImageLabView'
```

```tsx
          <Pane active={this.view === 'images'}>
            <ImageLabView />
          </Pane>
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun run test`. Expected: PASS — 9 new image tests, all suites green.

- [ ] **Step 7: Verify in the browser**

`bun run dev` → Image Lab tab: upload a photo (or webcam + Take photo), pick "Arcane Hero style", Generate → a tinted/vignetted square appears in the results grid (stub provider, fully offline).

- [ ] **Step 8: Commit**

```bash
bun run check && bun run verify
git add -A
git commit -m "feat: add image provider pipeline with offline stub, webcam capture, and image lab"
```

---

### Task 8: Builder Portrait Section (Webcam → AI Portrait → Card)

The "sub view for the AI generated image portion" of static mode: an image field in the form opens portrait tools — webcam or upload or pick-from-library, persona details (age / gender / small detail / hobby) that shape the prompt, generate in the template's art style, and the result lands both in the shared ImageLibrary and on the card.

**Files:**
- Create: `src/builder/PortraitSection.tsx`
- Modify: `src/builder/BuilderView.tsx` (add `mount()`, `PortraitSlot` subcomponent, pass `imageSlot` to FormRenderer)
- Test: `src/builder/portrait.test.tsx`

**Interfaces:**
- Consumes: `BuilderView` fields (Task 6: `libraryImages`, `libraryUrls`, `portraitKey`, `setField`, `template`, `data`), `CameraCapture`/`selectImageProvider`/`buildPortraitPrompt`/`bytesToDataUrl` (Task 7), `AppShell.library` (Task 4).
- Produces: `class PortraitSection extends Component` with fields `fieldKey: string`, `source: 'upload' | 'camera' | 'library'`, `persona: Persona`, `pendingBytes?: ArrayBuffer`, `pendingType: string`, `pendingPreview: string`, `busy: boolean`, `note: string`, `builder?: BuilderView`, `shell?: AppShell`; methods `acceptSource(bytes: ArrayBuffer, type: string): void`, `setPersona(key: keyof Persona, value: string): void`, `generate(provider?: ImageProvider): Promise<void>`, `useLibraryImage(id: string): void`. `BuilderView` gains `mount()` (shell + library mirror) and `PortraitSlot(props: { fieldKey: string })`.

- [ ] **Step 1: Write the failing tests**

`src/builder/portrait.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { click, mountApp, tick } from '../../test/util'
import type { AppShell } from '../app/AppShell'
import { ImageLibrary } from '../storage/ImageLibrary'
import type { ImageProvider } from '../images/provider'
import { BuilderView } from './BuilderView'
import { PortraitSection } from './PortraitSection'

const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer

describe('PortraitSection (headless)', () => {
  it('generates with the template style + persona prompt and assigns the image id to the card', async () => {
    const library = ImageLibrary.new()
    await vi.waitFor(() => {
      expect(library.ready).toBe(true)
    })
    const builder = BuilderView.new()
    const section = PortraitSection.new({ fieldKey: 'art' })
    section.builder = builder
    section.shell = { library } as unknown as AppShell

    section.acceptSource(bytesOf('face'), 'image/png')
    section.setPersona('age', '29')
    section.setPersona('hobby', 'chess')

    const provider: ImageProvider = {
      id: 'stub',
      generate: vi.fn(async (input) => {
        expect(input.prompt).toContain('oil painting')       // template style
        expect(input.prompt).toContain('29')                  // persona
        expect(input.prompt).toContain('chess')
        expect(input.styleId).toBe('arcane-hero')
        return { bytes: bytesOf('styled'), type: 'image/png' }
      }),
    }
    await section.generate(provider)

    expect(library.images).toHaveLength(1)
    const stored = library.images[0]
    expect(builder.data.art).toBe(stored?.id)
    expect(builder.resolved.art).toBeUndefined() // builder.libraryUrls not mirrored headless — fine

    section.set(null)
    builder.set(null)
    library.set(null)
  })

  it('refuses to generate without a source image', async () => {
    const section = PortraitSection.new({ fieldKey: 'art' })
    await section.generate()
    expect(section.note).toContain('photo first')
    section.set(null)
  })
})

describe('Builder portrait slot (mounted)', () => {
  it('opens portrait tools from the image field', async () => {
    const { container, unmount } = await mountApp()
    const openButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Portrait tools',
    )
    expect(openButton).toBeDefined()
    await click(openButton ?? null)
    await tick()
    const text = container.textContent ?? ''
    for (const label of ['Age', 'Gender', 'Small detail', 'Hobby']) {
      expect(text).toContain(label)
    }
    expect(text).toContain('Generate portrait')
    unmount()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test`. Expected: FAIL — `PortraitSection` does not exist; no "Portrait tools" button renders.

- [ ] **Step 3: Implement PortraitSection**

`src/builder/PortraitSection.tsx`:

```tsx
import { Component } from '@expressive/react'
import { AppShell } from '../app/AppShell'
import { CameraCapture } from '../images/CameraCapture'
import { bytesToDataUrl } from '../images/codec'
import { buildPortraitPrompt } from '../images/prompt'
import type { Persona } from '../images/prompt'
import { selectImageProvider } from '../images/provider'
import type { ImageProvider } from '../images/provider'
import { Button, FieldRow, Panel, TextInput } from '../ui'
import { BuilderView } from './BuilderView'

const SOURCES = [
  { id: 'upload', label: 'Upload' },
  { id: 'camera', label: 'Webcam' },
  { id: 'library', label: 'Library' },
] as const

export class PortraitSection extends Component {
  fieldKey = ''
  source: 'upload' | 'camera' | 'library' = 'upload'
  persona: Persona = {}
  pendingBytes?: ArrayBuffer = undefined
  pendingType = ''
  pendingPreview = ''
  busy = false
  note = ''
  builder?: BuilderView = undefined
  shell?: AppShell = undefined

  mount() {
    this.builder = this.get(BuilderView)
    this.shell = this.get(AppShell)
  }

  acceptSource(bytes: ArrayBuffer, type: string) {
    this.pendingBytes = bytes
    this.pendingType = type
    this.pendingPreview = bytesToDataUrl(bytes, type)
    this.note = ''
  }

  setPersona(key: keyof Persona, value: string) {
    this.persona = { ...this.persona, [key]: value }
  }

  useLibraryImage(id: string) {
    this.builder?.setField(this.fieldKey, id)
    this.note = 'Applied from library.'
  }

  async generate(provider?: ImageProvider) {
    if (this.busy) return
    const builder = this.builder
    const shell = this.shell
    const bytes = this.pendingBytes
    if (!builder) {
      this.note = 'Builder unavailable.'
      return
    }
    if (!bytes) {
      this.note = 'Capture or upload a photo first.'
      return
    }
    this.busy = true
    this.note = 'Generating portrait…'
    try {
      const chosen = provider ?? (await selectImageProvider())
      const prompt = buildPortraitPrompt(builder.template.artStylePrompt(builder.data), this.persona)
      const out = await chosen.generate({
        sourceBytes: bytes,
        sourceType: this.pendingType,
        prompt,
        styleId: builder.templateId,
      })
      if (!shell) throw new Error('image library unavailable')
      const stored = await shell.library.add({
        kind: 'generated',
        prompt,
        styleId: builder.templateId,
        bytes: out.bytes,
        type: out.type,
      })
      builder.setField(this.fieldKey, stored.id)
      this.note = `Portrait applied (via ${chosen.id}).`
    } catch (cause) {
      this.note = cause instanceof Error ? cause.message : String(cause)
    } finally {
      this.busy = false
    }
  }

  SourcePicker() {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex gap-1.5">
          {SOURCES.map((s) => (
            <Button
              key={s.id}
              tone={this.source === s.id ? 'accent' : 'ghost'}
              onClick={() => {
                this.source = s.id
              }}
            >
              {s.label}
            </Button>
          ))}
        </div>
        {this.source === 'upload' ? (
          <input
            type="file"
            accept="image/*"
            className="text-xs text-ink-dim file:mr-3 file:rounded file:border-0 file:bg-accent file:px-3 file:py-1.5 file:text-surface"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (!file) return
              void file.arrayBuffer().then((b) => this.acceptSource(b, file.type || 'image/png'))
            }}
          />
        ) : null}
        {this.source === 'camera' ? (
          <CameraCapture onFrame={(bytes, type) => this.acceptSource(bytes, type)} />
        ) : null}
        {this.source === 'library' ? (
          <div className="grid max-h-40 grid-cols-4 gap-1.5 overflow-y-auto">
            {(this.builder?.libraryImages ?? [])
              .filter((i) => i.kind === 'generated')
              .map((image) => (
                <button
                  key={image.id}
                  type="button"
                  onClick={() => this.useLibraryImage(image.id)}
                  className="overflow-hidden rounded border border-edge hover:border-accent"
                >
                  <img
                    src={this.builder?.libraryUrls[image.id]}
                    alt={image.prompt ?? 'library'}
                    className="aspect-square w-full object-cover"
                  />
                </button>
              ))}
          </div>
        ) : null}
        {this.pendingPreview && this.source !== 'library' ? (
          <img src={this.pendingPreview} alt="pending source" className="h-20 w-20 rounded object-cover" />
        ) : null}
      </div>
    )
  }

  PersonaForm() {
    const fields: readonly { key: keyof Persona; label: string; placeholder: string }[] = [
      { key: 'age', label: 'Age', placeholder: '34' },
      { key: 'gender', label: 'Gender', placeholder: 'optional' },
      { key: 'detail', label: 'Small detail', placeholder: 'always wears red glasses' },
      { key: 'hobby', label: 'Hobby', placeholder: 'sourdough baking' },
    ]
    return (
      <div className="grid grid-cols-2 gap-2">
        {fields.map((f) => (
          <FieldRow key={f.key} label={f.label}>
            <TextInput
              value={this.persona[f.key] ?? ''}
              onValue={(v) => this.setPersona(f.key, v)}
              placeholder={f.placeholder}
            />
          </FieldRow>
        ))}
      </div>
    )
  }

  render() {
    return (
      <Panel title="Portrait" className="border-accent-soft">
        <div className="flex flex-col gap-3">
          <this.SourcePicker />
          <this.PersonaForm />
          <div className="flex items-center gap-3">
            <Button disabled={this.busy} onClick={() => void this.generate()}>
              {this.busy ? 'Generating…' : 'Generate portrait'}
            </Button>
          </div>
          {this.note ? <p className="text-xs text-ink-dim">{this.note}</p> : null}
        </div>
      </Panel>
    )
  }
}
```

- [ ] **Step 4: Wire it into BuilderView**

In `src/builder/BuilderView.tsx`:

Add import:

```tsx
import { PortraitSection } from './PortraitSection'
```

Add `mount()` right after `protected new()` (mirrors the shared library so `resolved` and the portrait slot stay live):

```tsx
  mount() {
    const shell = this.get(AppShell)
    this.shell = shell
    return shell.library.get((current) => {
      this.libraryImages = current.images
      this.libraryUrls = current.urls
    })
  }
```

Add the `PortraitSlot` subcomponent method (between `saveCard` and `Form`):

```tsx
  PortraitSlot(props: { fieldKey: string }) {
    const current = this.data[props.fieldKey]
    const url = this.libraryUrls[typeof current === 'string' ? current : '']
    const open = this.portraitKey === props.fieldKey
    return (
      <div className="flex items-center gap-3">
        {url ? (
          <img src={url} alt="portrait" className="h-14 w-14 rounded object-cover" />
        ) : (
          <div className="flex h-14 w-14 items-center justify-center rounded bg-surface text-ink-dim">✶</div>
        )}
        <Button
          tone="ghost"
          onClick={() => {
            this.portraitKey = open ? undefined : props.fieldKey
          }}
        >
          {open ? 'Close portrait tools' : 'Portrait tools'}
        </Button>
      </div>
    )
  }
```

Update the `Form()` details panel to pass the slot and render the open section beneath the form:

```tsx
        <Panel title="Details">
          <FormRenderer
            fields={this.template.fields}
            data={this.data}
            onField={this.setField}
            imageSlot={(spec) => <this.PortraitSlot fieldKey={spec.key} />}
          />
        </Panel>
        {this.portraitKey ? <PortraitSection fieldKey={this.portraitKey} /> : null}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run test`. Expected: PASS — 3 new portrait tests; Task 6 builder tests still green.

- [ ] **Step 6: Verify in the browser**

`bun run dev` → Builder: click "Portrait tools" on the Portrait field → Webcam → Take photo → fill Age/Hobby → "Generate portrait" → the stubbed stylized photo appears **in the card's art window** live, and also in Image Lab results + (later) Gallery.

- [ ] **Step 7: Commit**

```bash
bun run check && bun run verify
git add -A
git commit -m "feat: add builder portrait section with persona prompt and library picker"
```

---

### Task 9: Export Pipeline — Print-Quality PNG / WebP / JPEG

**Files:**
- Create: `src/export/exportCard.ts`, `src/export/ExportBar.tsx`
- Modify: `src/builder/BuilderView.tsx` (add ExportBar under the preview)
- Test: `src/export/export.test.tsx`

**Interfaces:**
- Consumes: `ExportFormat`/`CardArchive.saveExport` (Task 4), `CARD_WIDTH` (Task 3), `AppShell` (Task 4), `BuilderView.previewEl` (Task 6), html-to-image.
- Produces:
  - `exportCard.ts`: `CARD_EXPORT_WIDTH = 750`; `FORMAT_MIME: Record<ExportFormat, string>`; `exportPixelRatio(nodeWidth: number): number`; `exportFileName(name: string, format: ExportFormat): string`; `renderCardBlob(node: HTMLElement, format: ExportFormat, quality?: number): Promise<Blob>`; `downloadBlob(blob: Blob, fileName: string): void`
  - `ExportBar.tsx`: `class ExportBar extends Component` with fields `cardName: string`, `target?: () => HTMLElement | null`, `note: string`, `shell?: AppShell`; method `exportAs(format: ExportFormat): Promise<void>` — downloads the file **and** records it in `CardArchive`

- [ ] **Step 1: Write the failing tests**

`src/export/export.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import type { AppShell } from '../app/AppShell'
import { CardArchive } from '../storage/CardArchive'
import { ExportBar } from './ExportBar'
import { CARD_EXPORT_WIDTH, exportFileName, exportPixelRatio, FORMAT_MIME, renderCardBlob } from './exportCard'

vi.mock('html-to-image', () => ({
  toCanvas: vi.fn(async () => {
    const fake = {
      toBlob(cb: (b: Blob | null) => void, type?: string) {
        cb(new Blob(['fake-image'], { type: type ?? 'image/png' }))
      },
    }
    return fake as unknown as HTMLCanvasElement
  }),
}))

describe('export math and naming', () => {
  it('doubles the 375px preview to 750px (300 DPI at 2.5 inches)', () => {
    expect(CARD_EXPORT_WIDTH).toBe(750)
    expect(exportPixelRatio(375)).toBe(2)
    expect(exportPixelRatio(0)).toBe(2) // guards divide-by-zero via CARD_WIDTH fallback
  })

  it('slugifies file names per format', () => {
    expect(exportFileName('Nyra, Ember Sage!', 'png')).toBe('nyra-ember-sage.png')
    expect(exportFileName('  ', 'webp')).toBe('card.webp')
    expect(FORMAT_MIME.jpeg).toBe('image/jpeg')
  })
})

describe('renderCardBlob', () => {
  it('renders the node through html-to-image and converts to the requested mime', async () => {
    const node = document.createElement('div')
    const blob = await renderCardBlob(node, 'webp')
    expect(blob.type).toBe('image/webp')
    const { toCanvas } = await import('html-to-image')
    expect(vi.mocked(toCanvas)).toHaveBeenCalledWith(node, expect.objectContaining({ pixelRatio: 2 }))
  })
})

describe('ExportBar', () => {
  it('exports the target node and records it in the archive', async () => {
    const archive = CardArchive.new()
    await vi.waitFor(() => {
      expect(archive.ready).toBe(true)
    })
    const node = document.createElement('div')
    const bar = ExportBar.new({ cardName: 'Nyra', target: () => node })
    bar.shell = { archive } as unknown as AppShell
    await bar.exportAs('png')
    expect(archive.exports).toHaveLength(1)
    expect(archive.exports[0]?.name).toBe('nyra.png')
    expect(archive.exports[0]?.format).toBe('png')
    expect(bar.note).toContain('nyra.png')
    bar.set(null)
    archive.set(null)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test`. Expected: FAIL — `src/export/*` modules do not exist.

- [ ] **Step 3: Implement exportCard.ts**

`src/export/exportCard.ts`:

```ts
import { toCanvas } from 'html-to-image'
import { CARD_WIDTH } from '../cards/base/CardSurface'
import type { ExportFormat } from '../storage/CardArchive'

/** 2.5" × 300 DPI. Height follows the node's aspect (525 → 1050). */
export const CARD_EXPORT_WIDTH = 750

export const FORMAT_MIME: Record<ExportFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

export function exportPixelRatio(nodeWidth: number): number {
  const width = nodeWidth > 0 ? nodeWidth : CARD_WIDTH
  return CARD_EXPORT_WIDTH / width
}

export function exportFileName(name: string, format: ExportFormat): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug.length > 0 ? slug : 'card'}.${format}`
}

/** Rasterize a card DOM node at print resolution and encode to the requested format. */
export async function renderCardBlob(
  node: HTMLElement,
  format: ExportFormat,
  quality = 0.95,
): Promise<Blob> {
  const canvas = await toCanvas(node, { pixelRatio: exportPixelRatio(node.offsetWidth) })
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(`could not encode ${format}`))),
      FORMAT_MIME[format],
      quality,
    )
  })
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
```

- [ ] **Step 4: Implement ExportBar and mount it in the Builder**

`src/export/ExportBar.tsx`:

```tsx
import { Component } from '@expressive/react'
import { AppShell } from '../app/AppShell'
import type { ExportFormat } from '../storage/CardArchive'
import { Button } from '../ui'
import { downloadBlob, exportFileName, renderCardBlob } from './exportCard'

const FORMATS: readonly ExportFormat[] = ['png', 'webp', 'jpeg']

/** Export buttons for any card preview: downloads the file and archives the render. */
export class ExportBar extends Component {
  cardName = ''
  target?: () => HTMLElement | null = undefined
  note = ''
  shell?: AppShell = undefined

  mount() {
    this.shell = this.get(AppShell)
  }

  async exportAs(format: ExportFormat) {
    const node = this.target?.()
    if (!node) {
      this.note = 'Nothing to export yet.'
      return
    }
    this.note = 'Rendering…'
    try {
      const blob = await renderCardBlob(node, format)
      const fileName = exportFileName(this.cardName, format)
      downloadBlob(blob, fileName)
      const shell = this.shell
      if (shell) {
        await shell.archive.saveExport({
          name: fileName,
          format,
          bytes: await blob.arrayBuffer(),
          type: blob.type,
        })
      }
      this.note = `Exported ${fileName} — saved to Gallery.`
    } catch (cause) {
      this.note = cause instanceof Error ? cause.message : String(cause)
    }
  }

  render() {
    return (
      <div className="flex flex-col items-center gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-ink-dim">Export</span>
          {FORMATS.map((format) => (
            <Button key={format} tone="ghost" onClick={() => void this.exportAs(format)}>
              {format.toUpperCase()}
            </Button>
          ))}
        </div>
        {this.note ? <p className="text-xs text-ink-dim">{this.note}</p> : null}
      </div>
    )
  }
}
```

In `src/builder/BuilderView.tsx`, import it:

```tsx
import { ExportBar } from '../export/ExportBar'
```

and in `Preview()`, after the Holo toggle's `</div>`, add:

```tsx
          <ExportBar
            cardName={String(this.data.name ?? 'card')}
            target={() => this.previewEl}
          />
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run test`. Expected: PASS — 4 new export tests. (The mounted builder tests keep passing: the html-to-image mock is file-local, and the real module is only invoked on click.)

- [ ] **Step 6: Verify in the browser**

`bun run dev` → Builder → PNG: browser downloads `nyra-ember-sage.png` at 750×1050. Open it — full card, holo sheen included if toggled. Try WEBP and JPEG too. Print note: 750×1050 prints exactly 2.5"×3.5" at 300 DPI; holographic-look prints come from printing on holo/foil sticker paper.

- [ ] **Step 7: Commit**

```bash
bun run check && bun run verify
git add -A
git commit -m "feat: add print-resolution card export with archive recording"
```

---

### Task 10: Gallery — Past Renders, Generations, and Saved Cards

**Files:**
- Create: `src/gallery/GalleryView.tsx`
- Modify: `src/app/AppShell.tsx` (swap gallery pane), `src/builder/BuilderView.tsx` (consume `pendingCard` in `mount()`)
- Test: `src/gallery/gallery.test.tsx`

**Interfaces:**
- Consumes: `AppShell.archive`/`AppShell.library`/`AppShell.pendingCard` (Task 4), `BuilderView.loadCard` (Task 6), `downloadBlob` (Task 9), ui kit.
- Produces: `class GalleryView extends Component` with fields `section: 'exports' | 'images' | 'cards'`, mirrors `cards: StoredCard[]`, `exports: StoredExport[]`, `exportUrls: Record<string, string>`, `images: StoredImage[]`, `imageUrls: Record<string, string>`, `shell?: AppShell`; method `openCard(card: StoredCard): void` (hands the card to the Builder via `shell.pendingCard` and switches view).

- [ ] **Step 1: Write the failing tests**

`src/gallery/gallery.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { click, mountApp, tick } from '../../test/util'

const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer

describe('GalleryView', () => {
  it('lists saved cards, exports, and generations from the stores', async () => {
    const { container, shell, unmount } = await mountApp()
    await vi.waitFor(() => {
      expect(shell.archive.ready && shell.library.ready).toBe(true)
    })
    await shell.archive.saveCard({ name: 'Stored Hero', templateId: 'arcane-hero', data: { name: 'Stored Hero' }, holo: false })
    await shell.archive.saveExport({ name: 'stored-hero.png', format: 'png', bytes: bytesOf('x'), type: 'image/png' })
    await shell.library.add({ kind: 'generated', prompt: 'a knight', bytes: bytesOf('y'), type: 'image/png' })

    shell.view = 'gallery'
    await tick()
    expect(container.textContent).toContain('stored-hero.png')

    const tabs = Array.from(container.querySelectorAll('button'))
    await click(tabs.find((b) => b.textContent === 'Generations') ?? null)
    expect(container.textContent).toContain('a knight')

    await click(Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Saved cards') ?? null)
    expect(container.textContent).toContain('Stored Hero')
    unmount()
  })

  it('opens a saved card back into the builder', async () => {
    const { container, shell, unmount } = await mountApp()
    await vi.waitFor(() => {
      expect(shell.archive.ready).toBe(true)
    })
    await shell.archive.saveCard({
      name: 'Round Trip',
      templateId: 'arcane-hero',
      data: { name: 'Round Trip', essence: 'tide', ability: 'Draw a card.' },
      holo: true,
    })
    shell.view = 'gallery'
    await tick()
    await click(Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Saved cards') ?? null)
    await click(Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Open in builder') ?? null)
    await tick()
    expect(shell.view).toBe('builder')
    expect(shell.pendingCard).toBeUndefined() // consumed by BuilderView
    expect(container.querySelector('[data-holo="true"]')).not.toBeNull()
    expect(container.textContent).toContain('Round Trip')
    unmount()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test`. Expected: FAIL — gallery pane still shows the Task 2 placeholder.

- [ ] **Step 3: Implement GalleryView**

`src/gallery/GalleryView.tsx`:

```tsx
import { Component } from '@expressive/react'
import { AppShell } from '../app/AppShell'
import { downloadBlob } from '../export/exportCard'
import type { StoredCard, StoredExport } from '../storage/CardArchive'
import type { StoredImage } from '../storage/ImageLibrary'
import { Button, EmptyState, TabBar } from '../ui'

const SECTIONS = [
  { id: 'exports', label: 'Renders' },
  { id: 'images', label: 'Generations' },
  { id: 'cards', label: 'Saved cards' },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

export class GalleryView extends Component {
  section: SectionId = 'exports'
  cards: StoredCard[] = []
  exports: StoredExport[] = []
  exportUrls: Record<string, string> = {}
  images: StoredImage[] = []
  imageUrls: Record<string, string> = {}
  shell?: AppShell = undefined

  mount() {
    const shell = this.get(AppShell)
    this.shell = shell
    const stopArchive = shell.archive.get((current) => {
      this.cards = current.cards
      this.exports = current.exports
      this.exportUrls = current.exportUrls
    })
    const stopLibrary = shell.library.get((current) => {
      this.images = current.images
      this.imageUrls = current.urls
    })
    return () => {
      stopArchive()
      stopLibrary()
    }
  }

  openCard(card: StoredCard) {
    const shell = this.shell
    if (!shell) return
    shell.pendingCard = card
    shell.view = 'builder'
  }

  Exports() {
    if (this.exports.length === 0) return <EmptyState message="No exported renders yet." hint="Export from the Builder or Code Lab." />
    return (
      <div className="grid grid-cols-3 gap-4 xl:grid-cols-5">
        {this.exports.map((item) => (
          <figure key={item.id} className="flex flex-col gap-1.5">
            <img src={this.exportUrls[item.id]} alt={item.name} className="w-full rounded-lg border border-edge" />
            <figcaption className="truncate text-[11px] text-ink-dim">{item.name}</figcaption>
            <div className="flex gap-1.5">
              <Button tone="ghost" onClick={() => downloadBlob(new Blob([item.bytes], { type: item.type }), item.name)}>
                Download
              </Button>
              <Button tone="danger" onClick={() => void this.shell?.archive.deleteExport(item.id)}>
                Delete
              </Button>
            </div>
          </figure>
        ))}
      </div>
    )
  }

  Images() {
    const generated = this.images.filter((i) => i.kind === 'generated')
    if (generated.length === 0) return <EmptyState message="No image generations yet." hint="Create some in the Image Lab." />
    return (
      <div className="grid grid-cols-3 gap-4 xl:grid-cols-5">
        {generated.map((image) => (
          <figure key={image.id} className="flex flex-col gap-1.5">
            <img src={this.imageUrls[image.id]} alt={image.prompt ?? 'generated'} className="aspect-square w-full rounded-lg border border-edge object-cover" />
            <figcaption className="truncate text-[11px] text-ink-dim">{image.prompt}</figcaption>
            <div className="flex gap-1.5">
              <Button tone="danger" onClick={() => void this.shell?.library.remove(image.id)}>
                Delete
              </Button>
            </div>
          </figure>
        ))}
      </div>
    )
  }

  Cards() {
    if (this.cards.length === 0) return <EmptyState message="No saved cards yet." hint="Save from the Builder's form panel." />
    return (
      <ul className="flex flex-col gap-2">
        {this.cards.map((card) => (
          <li key={card.id} className="flex items-center justify-between rounded-lg border border-edge bg-panel px-4 py-2.5">
            <div className="min-w-0">
              <p className="truncate font-display text-sm">{card.name}</p>
              <p className="text-[11px] text-ink-dim">
                {card.templateId} · {new Date(card.updatedAt).toLocaleString()}
              </p>
            </div>
            <div className="flex shrink-0 gap-1.5">
              <Button tone="ghost" onClick={() => this.openCard(card)}>
                Open in builder
              </Button>
              <Button tone="danger" onClick={() => void this.shell?.archive.deleteCard(card.id)}>
                Delete
              </Button>
            </div>
          </li>
        ))}
      </ul>
    )
  }

  render() {
    return (
      <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
        <TabBar
          tabs={SECTIONS}
          active={this.section}
          onSelect={(id) => {
            this.section = id as SectionId
          }}
        />
        {this.section === 'exports' ? <this.Exports /> : null}
        {this.section === 'images' ? <this.Images /> : null}
        {this.section === 'cards' ? <this.Cards /> : null}
      </div>
    )
  }
}
```

In `src/app/AppShell.tsx`, import `GalleryView` and swap the gallery pane:

```tsx
import { GalleryView } from '../gallery/GalleryView'
```

```tsx
          <Pane active={this.view === 'gallery'}>
            <GalleryView />
          </Pane>
```

- [ ] **Step 4: Consume `pendingCard` in BuilderView**

Replace `BuilderView.mount()` (from Task 8) with this version — same library mirror plus the hand-off watcher:

```tsx
  mount() {
    const shell = this.get(AppShell)
    this.shell = shell
    const stopLibrary = shell.library.get((current) => {
      this.libraryImages = current.images
      this.libraryUrls = current.urls
    })
    const consumePending = () => {
      const card = shell.pendingCard
      if (card) {
        this.loadCard(card)
        shell.pendingCard = undefined
      }
    }
    consumePending() // a card may already be waiting when the builder mounts
    const stopPending = shell.set('pendingCard', consumePending)
    return () => {
      stopLibrary()
      stopPending()
    }
  }
```

(The watcher re-fires when it clears `pendingCard` back to `undefined`; the `if (card)` guard makes that second pass a no-op.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run test`. Expected: PASS — 2 new gallery tests; builder suites unaffected.

- [ ] **Step 6: Verify in the browser**

`bun run dev`: save a card, export it, generate an image → Gallery shows all three sections; "Open in builder" restores the exact card (template, fields, holo).

- [ ] **Step 7: Commit**

```bash
bun run check && bun run verify
git add -A
git commit -m "feat: add gallery with render history, generations, and saved-card round-trip"
```

---

### Task 11: In-Browser TSX Compilation for the Code Lab

User-typed TSX → a live component, entirely client-side: sucrase strips types and compiles JSX to CommonJS, then the module is evaluated with a fixed `require` map exposing exactly the card library, the ui kit, expressive, and the JSX runtime. Not a security sandbox (it's the user's own machine and code) — just a controlled import surface with good error messages.

**Files:**
- Create: `src/editor/compile.ts`, `src/editor/starter.ts`
- Test: `src/editor/compile.test.tsx`

**Interfaces:**
- Consumes: `src/cards/index.ts` barrel (Task 5), `src/ui/index.ts` barrel (Task 2).
- Produces:
  - `compile.ts`: `type CompiledCard = ComponentType<Record<string, unknown>>`; `type CompileResult = { ok: true; Card: CompiledCard } | { ok: false; error: string }`; `compileCardSource(source: string): CompileResult`; `AVAILABLE_MODULES: readonly string[]`
  - `starter.ts`: `STARTER_CARD_SOURCE: string`

- [ ] **Step 1: Write the failing tests**

`src/editor/compile.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { mount, tick } from '../../test/util'
import { compileCardSource } from './compile'
import { STARTER_CARD_SOURCE } from './starter'

describe('compileCardSource', () => {
  it('compiles plain TSX with typescript annotations and a default export', () => {
    const result = compileCardSource(`
      const title: string = 'Hand Rolled'
      export default function Card() {
        return <p>{title}</p>
      }
    `)
    if (!result.ok) throw new Error(result.error)
    const { container, unmount } = mount(<result.Card />)
    return tick().then(() => {
      expect(container.textContent).toContain('Hand Rolled')
      unmount()
    })
  })

  it('resolves imports from cartis/cards and @expressive/react', () => {
    const result = compileCardSource(`
      import { ArcaneCard, arcaneTemplate } from 'cartis/cards'
      export default function Card() {
        return <ArcaneCard data={arcaneTemplate.defaults} />
      }
    `)
    expect(result.ok).toBe(true)
  })

  it('compiles the starter source', () => {
    expect(compileCardSource(STARTER_CARD_SOURCE).ok).toBe(true)
  })

  it('reports syntax errors as messages, not throws', () => {
    const result = compileCardSource('export default function Card() { return <p> }')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0)
  })

  it('rejects imports outside the allowed module map', () => {
    const result = compileCardSource(`
      import fs from 'node:fs'
      export default function Card() { return null }
    `)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('node:fs')
  })

  it('rejects modules without a component default export', () => {
    const result = compileCardSource('export const nope = 1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('default export')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test`. Expected: FAIL — `./compile` and `./starter` do not exist.

- [ ] **Step 3: Implement compile.ts**

`src/editor/compile.ts`:

```tsx
import * as Expressive from '@expressive/react'
// Sanctioned react namespace imports: they exist solely to feed the Code Lab's
// module map so user TSX can resolve its JSX runtime (see Global Constraints).
import * as React from 'react'
import * as JsxDevRuntime from 'react/jsx-dev-runtime'
import * as JsxRuntime from 'react/jsx-runtime'
import { transform } from 'sucrase'
import * as Cards from '../cards'
import * as Ui from '../ui'
import type { ComponentType } from 'react'

export type CompiledCard = ComponentType<Record<string, unknown>>

export type CompileResult = { ok: true; Card: CompiledCard } | { ok: false; error: string }

/** Namespace objects lack __esModule, which breaks sucrase's default-import interop; add it. */
function asCjsModule(namespace: object): Record<string, unknown> {
  return { __esModule: true, ...namespace }
}

const MODULE_MAP: Record<string, Record<string, unknown>> = {
  react: asCjsModule(React),
  'react/jsx-runtime': asCjsModule(JsxRuntime),
  'react/jsx-dev-runtime': asCjsModule(JsxDevRuntime),
  '@expressive/react': asCjsModule(Expressive),
  'cartis/cards': asCjsModule(Cards),
  'cartis/ui': asCjsModule(Ui),
}

export const AVAILABLE_MODULES: readonly string[] = Object.keys(MODULE_MAP).filter(
  (name) => !name.includes('jsx'),
)

function sandboxRequire(name: string): Record<string, unknown> {
  const found = MODULE_MAP[name]
  if (!found) {
    throw new Error(`Cannot import "${name}" — available modules: ${AVAILABLE_MODULES.join(', ')}`)
  }
  return found
}

export function compileCardSource(source: string): CompileResult {
  let code: string
  try {
    code = transform(source, {
      transforms: ['typescript', 'jsx', 'imports'],
      jsxRuntime: 'automatic',
      production: true,
    }).code
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }

  const moduleShim: { exports: Record<string, unknown> } = { exports: {} }
  try {
    // Deliberate dynamic evaluation of the user's own code (local tool, not a security boundary).
    const run = new Function('require', 'module', 'exports', code) as (
      require: typeof sandboxRequire,
      module: typeof moduleShim,
      exports: typeof moduleShim.exports,
    ) => void
    run(sandboxRequire, moduleShim, moduleShim.exports)
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }

  const candidate = moduleShim.exports.default
  if (typeof candidate !== 'function') {
    return { ok: false, error: 'Module needs a component default export (export default function …)' }
  }
  return { ok: true, Card: candidate as CompiledCard }
}
```

Note: biome's `noExplicitAny` stays satisfied; if biome flags `new Function` (`security/noGlobalEval` covers only `eval`), no suppression is needed. If a future rule complains, add a targeted `// biome-ignore` with the reason "user-authored code evaluation is this feature".

- [ ] **Step 4: Implement the starter source**

`src/editor/starter.ts`:

```ts
/** First contents of the Code Lab buffer: a compiling, editable example. */
export const STARTER_CARD_SOURCE = `import { ArcaneCard } from 'cartis/cards'

// Free-edit mode: compose card kit parts however you like.
// Available imports: cartis/cards, cartis/ui, @expressive/react
// The default export is rendered live on the right.

const data = {
  name: 'Custom Hero',
  essence: 'tide',
  cost: 4,
  typeLine: 'Hero — Inventor',
  ability: 'When Custom Hero enters play, draw a card.',
  flavor: '"Built, not born."',
  might: 3,
  ward: 4,
  rarity: 'mythic',
}

export default function MyCard() {
  return <ArcaneCard data={data} holo />
}

// Want a different frame? Subclass and override any part:
// class MyFrame extends ArcaneCard { TitleBar = () => <div>...</div> }
`
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run test`. Expected: PASS — 6 new compile tests.

- [ ] **Step 6: Commit**

```bash
bun run check && bun run verify
git add -A
git commit -m "feat: add in-browser tsx compile pipeline with scoped module map"
```

---

### Task 12: Code Lab — CodeMirror Editor with Live Sandboxed Preview

**Files:**
- Create: `src/editor/CodePane.tsx`, `src/editor/Sandbox.tsx`, `src/editor/EditorView.tsx`
- Modify: `src/app/AppShell.tsx` (swap editor pane)
- Test: `src/editor/editor.test.tsx`

**Interfaces:**
- Consumes: `compileCardSource`/`CompiledCard`/`STARTER_CARD_SOURCE` (Task 11), `ExportBar` (Task 9), ui kit, codemirror.
- Produces:
  - `CodePane.tsx`: `class CodePane extends Component` with fields `source: string`, `onSource?: (source: string) => void` — CodeMirror 6 instance created in `mount()`; external `source` prop changes are pushed into the CM doc (guarded against echo loops)
  - `Sandbox.tsx`: `class Sandbox extends Component` with field `card?: CompiledCard` — renders the compiled card inside expressive's `catch()` error boundary; stays in fallback until a new `card` arrives
  - `EditorView.tsx`: `class EditorView extends Component` with fields `source: string`, `card?: CompiledCard`, `compileError: string`, `debounceMs: number`, `previewEl: HTMLElement | null` and methods `queueCompile(): void`, `compileNow(): void`. (Task 13 adds the agent fields/panel.)

- [ ] **Step 1: Write the failing tests**

`src/editor/editor.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { mount, tick } from '../../test/util'
import { compileCardSource } from './compile'
import { EditorView } from './EditorView'
import { Sandbox } from './Sandbox'

describe('EditorView (headless)', () => {
  it('compiles the starter source on activation', async () => {
    const editor = EditorView.new()
    await vi.waitFor(() => {
      expect(editor.card).toBeDefined()
    })
    expect(editor.compileError).toBe('')
    editor.set(null)
  })

  it('recompiles on source change and surfaces errors', async () => {
    const editor = EditorView.new({ debounceMs: 0 })
    await vi.waitFor(() => {
      expect(editor.card).toBeDefined()
    })
    editor.source = 'export default function Broken() { return <p> }'
    await vi.waitFor(() => {
      expect(editor.compileError.length).toBeGreaterThan(0)
    })
    editor.source = 'export default function Fixed() { return <p>fixed</p> }'
    await vi.waitFor(() => {
      expect(editor.compileError).toBe('')
    })
    editor.set(null)
  })
})

describe('Sandbox', () => {
  it('renders the compiled card', async () => {
    const result = compileCardSource('export default function C() { return <p>sandboxed</p> }')
    if (!result.ok) throw new Error(result.error)
    const { container, unmount } = mount(<Sandbox card={result.Card} />)
    await tick()
    expect(container.textContent).toContain('sandboxed')
    unmount()
  })

  it('catches render-time crashes and shows the error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = compileCardSource(
      'export default function Boom() { throw new Error("kaboom"); return null }',
    )
    if (!result.ok) throw new Error(result.error)
    const { container, unmount } = mount(<Sandbox card={result.Card} />)
    await tick(20)
    expect(container.textContent).toContain('kaboom')
    unmount()
    spy.mockRestore()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test`. Expected: FAIL — `./EditorView` and `./Sandbox` do not exist.

- [ ] **Step 3: Implement Sandbox**

`src/editor/Sandbox.tsx`:

```tsx
import { Component } from '@expressive/react'
import { EmptyState } from '../ui'
import type { CompiledCard } from './compile'

/** Renders user-compiled cards behind expressive's built-in error boundary. */
export class Sandbox extends Component {
  card?: CompiledCard = undefined

  async catch(error: Error) {
    this.fallback = (
      <div className="max-w-[375px] rounded-lg border border-red-900 bg-red-950/60 p-4 text-sm text-red-200">
        <p className="font-semibold">Card crashed while rendering</p>
        <pre className="mt-2 whitespace-pre-wrap text-xs">{String(error)}</pre>
      </div>
    )
    // Stay in fallback until a new compile hands us a different card, then retry.
    await new Promise<void>((resolve) => {
      const stop = this.set('card', () => {
        stop()
        resolve()
      })
    })
  }

  render() {
    const UserCard = this.card
    if (!UserCard) {
      return <EmptyState message="Nothing compiled yet." hint="Fix the code on the left to see a card." />
    }
    return <UserCard />
  }
}
```

- [ ] **Step 4: Implement CodePane**

`src/editor/CodePane.tsx`:

```tsx
import { javascript } from '@codemirror/lang-javascript'
import { Component } from '@expressive/react'
import { EditorView as CmView, basicSetup } from 'codemirror'

/** Thin CodeMirror 6 wrapper. Not unit-tested (CM needs real layout); exercised via dev server. */
export class CodePane extends Component {
  source = ''
  onSource?: (source: string) => void = undefined
  #host: HTMLElement | null = null
  #cm: CmView | undefined

  mount() {
    const host = this.#host
    if (!host) return
    const cm = new CmView({
      parent: host,
      doc: this.source,
      extensions: [
        basicSetup,
        javascript({ jsx: true, typescript: true }),
        CmView.updateListener.of((update) => {
          if (update.docChanged) this.onSource?.(update.state.doc.toString())
        }),
        CmView.theme(
          {
            '&': { height: '100%', fontSize: '13px', backgroundColor: '#0d0f16' },
            '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
            '.cm-gutters': { backgroundColor: '#0d0f16', border: 'none' },
          },
          { dark: true },
        ),
      ],
    })
    this.#cm = cm
    // Push external source changes (agent rewrites, resets) into the editor without echo loops.
    const stopWatching = this.set('source', () => {
      const current = cm.state.doc.toString()
      if (current !== this.source) {
        cm.dispatch({ changes: { from: 0, to: current.length, insert: this.source } })
      }
    })
    return () => {
      stopWatching()
      cm.destroy()
    }
  }

  render() {
    return (
      <div
        className="h-full min-h-0 overflow-hidden [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto"
        ref={(el) => {
          this.#host = el
        }}
      />
    )
  }
}
```

- [ ] **Step 5: Implement EditorView and mount it**

`src/editor/EditorView.tsx`:

```tsx
import { Component } from '@expressive/react'
import { ExportBar } from '../export/ExportBar'
import { compileCardSource } from './compile'
import type { CompiledCard } from './compile'
import { CodePane } from './CodePane'
import { Sandbox } from './Sandbox'
import { STARTER_CARD_SOURCE } from './starter'

export class EditorView extends Component {
  source = STARTER_CARD_SOURCE
  card?: CompiledCard = undefined
  compileError = ''
  debounceMs = 250
  previewEl: HTMLElement | null = null
  #timer: ReturnType<typeof setTimeout> | undefined

  protected new() {
    this.compileNow()
    const stopWatching = this.set('source', () => {
      this.queueCompile()
    })
    return () => {
      clearTimeout(this.#timer)
      stopWatching()
    }
  }

  queueCompile() {
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => this.compileNow(), this.debounceMs)
  }

  compileNow() {
    const result = compileCardSource(this.source)
    if (result.ok) {
      this.card = result.Card
      this.compileError = ''
    } else {
      this.compileError = result.error
    }
  }

  render() {
    return (
      <div className="flex h-full">
        <section className="flex min-w-0 flex-1 flex-col border-r border-edge">
          <CodePane
            source={this.source}
            onSource={(next) => {
              this.source = next
            }}
          />
          {this.compileError ? (
            <p className="border-t border-red-900 bg-red-950/60 px-3 py-2 font-mono text-xs text-red-200">
              {this.compileError}
            </p>
          ) : null}
        </section>
        <section className="flex w-[440px] shrink-0 flex-col items-center gap-4 overflow-y-auto p-5">
          <div
            ref={(el) => {
              this.previewEl = el
            }}
          >
            <Sandbox card={this.card} />
          </div>
          <ExportBar cardName="code-lab-card" target={() => this.previewEl} />
        </section>
      </div>
    )
  }
}
```

In `src/app/AppShell.tsx`, import `EditorView` and swap the editor pane:

```tsx
import { EditorView } from '../editor/EditorView'
```

```tsx
          <Pane active={this.view === 'editor'}>
            <EditorView />
          </Pane>
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun run test`. Expected: PASS — 4 new editor tests. (`EditorView.new({ debounceMs: 0 })` works because `State.new(...)` accepts initial values merged before `new()` runs.)

- [ ] **Step 7: Verify in the browser**

`bun run dev` → Code Lab tab: starter card renders holo-tide on the right; edit the name string → preview updates after the debounce; break the JSX → red error bar, card stays; `throw new Error('x')` inside the component → sandbox fallback with the message; fix it → recovers. Export buttons produce files.

- [ ] **Step 8: Commit**

```bash
bun run check && bun run verify
git add -A
git commit -m "feat: add code lab with codemirror editing and sandboxed live preview"
```

---

### Task 13: Dev-Server Bridge — opencode Agent + Replicate Endpoint + Agent Panel

The AI half of the Code Lab and real image generation. A Vite plugin (`configureServer` middleware, runs in bun/node — the opencode SDK spawns a local server process and Replicate needs a secret, neither can live in the browser) exposes three JSON endpoints:

- `GET /api/status` → `{ image: 'replicate' | 'stub' }` (Task 7's `selectImageProvider` already consumes this)
- `POST /api/agent/card` `{ prompt, code }` → `{ code }` — opencode session writes new card TSX (structured output)
- `POST /api/image/generate` `{ prompt, imageDataUrl }` → `{ dataUrl }` — flux-kontext-pro via Replicate's HTTP API (no SDK dependency)

All logic lives in exported pure-ish functions with injected clients so it unit-tests without opencode installed or network.

**Files:**
- Create: `src/server/agentBridge.ts`
- Modify: `vite.config.ts` (register plugin), `src/editor/EditorView.tsx` (agent fields + panel)
- Test: `src/server/agentBridge.test.ts`, append to `src/editor/editor.test.tsx`

**Interfaces:**
- Consumes: `bytesToDataUrl` (Task 7 codec), `AVAILABLE_MODULES` semantics (guide text mirrors Task 11's map), `EditorView` (Task 12).
- Produces:
  - `agentBridge.ts`: `CARD_API_GUIDE: string`; `buildAgentPrompt(userPrompt: string, currentCode: string): string`; `extractCode(result: unknown): string | undefined`; `interface AgentClient { session: { create(input: { body: { title: string } }): Promise<unknown>; prompt(input: unknown): Promise<unknown> } }`; `runCardAgent(client: AgentClient, userPrompt: string, currentCode: string): Promise<string>`; `generateWithReplicate(token: string, prompt: string, imageDataUrl: string, fetchImpl?: typeof fetch): Promise<string>`; `readJson(req: { on(event: string, cb: (chunk?: unknown) => void): unknown }): Promise<unknown>`; `cartisBridge(): Plugin`
  - `EditorView` gains fields `prompt: string`, `agentBusy: boolean`, `agentNote: string`, method `runAgent(fetchImpl?: typeof fetch): Promise<void>`, subcomponent `AgentPanel()`

- [ ] **Step 1: Write the failing tests**

`src/server/agentBridge.test.ts`:

```ts
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  buildAgentPrompt,
  extractCode,
  generateWithReplicate,
  readJson,
  runCardAgent,
} from './agentBridge'
import type { AgentClient } from './agentBridge'

describe('buildAgentPrompt', () => {
  it('embeds the guide, the user request, and the current code', () => {
    const prompt = buildAgentPrompt('make it spooky', 'export default function C() { return null }')
    expect(prompt).toContain('cartis/cards')
    expect(prompt).toContain('make it spooky')
    expect(prompt).toContain('export default function C()')
    expect(prompt).toContain('default export')
  })
})

describe('extractCode', () => {
  it('prefers structured output', () => {
    const result = { data: { info: { structured_output: { code: 'export default 1' } } } }
    expect(extractCode(result)).toBe('export default 1')
  })

  it('falls back to the last tsx code fence in text parts', () => {
    const result = {
      data: {
        parts: [
          { type: 'text', text: 'Here you go:\n```tsx\nexport default function A() { return null }\n```' },
          { type: 'text', text: 'refined:\n```tsx\nexport default function B() { return null }\n```' },
        ],
      },
    }
    expect(extractCode(result)).toContain('function B')
  })

  it('returns undefined when nothing code-like exists', () => {
    expect(extractCode({ data: { parts: [{ type: 'text', text: 'no code' }] } })).toBeUndefined()
    expect(extractCode(undefined)).toBeUndefined()
  })
})

describe('runCardAgent', () => {
  it('creates a session, prompts with structured format, and returns the code', async () => {
    const promptSpy = vi.fn(async () => ({
      data: { info: { structured_output: { code: 'export default function X() { return null }' } } },
    }))
    const client: AgentClient = {
      session: {
        create: vi.fn(async () => ({ data: { id: 'session-1' } })),
        prompt: promptSpy,
      },
    }
    const code = await runCardAgent(client, 'do a thing', 'old code')
    expect(code).toContain('function X')
    const call = promptSpy.mock.calls[0]?.[0] as { path: { id: string } } | undefined
    expect(call?.path.id).toBe('session-1')
  })

  it('throws a clear error when the session has no id', async () => {
    const client: AgentClient = {
      session: { create: vi.fn(async () => ({})), prompt: vi.fn(async () => ({})) },
    }
    await expect(runCardAgent(client, 'p', 'c')).rejects.toThrow(/session/i)
  })
})

describe('generateWithReplicate', () => {
  it('POSTs the model, waits, and returns the fetched image as a data url', async () => {
    const imageBytes = new TextEncoder().encode('img').buffer as ArrayBuffer
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('predictions')) {
        expect(init?.method).toBe('POST')
        const headers = init?.headers as Record<string, string>
        expect(headers.Authorization).toBe('Bearer tok')
        expect(headers.Prefer).toBe('wait')
        const body = JSON.parse(String(init?.body)) as { input: { prompt: string; input_image: string } }
        expect(body.input.prompt).toBe('stylize me')
        expect(body.input.input_image.startsWith('data:')).toBe(true)
        return new Response(JSON.stringify({ status: 'succeeded', output: 'https://img.example/out.png' }))
      }
      return new Response(imageBytes, { headers: { 'content-type': 'image/png' } })
    }) as unknown as typeof fetch
    const dataUrl = await generateWithReplicate('tok', 'stylize me', 'data:image/png;base64,QQ==', fetchImpl)
    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('surfaces replicate errors with status detail', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
    await expect(generateWithReplicate('bad', 'p', 'data:image/png;base64,QQ==', fetchImpl)).rejects.toThrow(/401/)
  })
})

describe('readJson', () => {
  it('parses a streamed JSON body', async () => {
    const stream = new PassThrough()
    const parsed = readJson(stream)
    stream.end(JSON.stringify({ hello: 'cartis' }))
    await expect(parsed).resolves.toEqual({ hello: 'cartis' })
  })
})
```

Append to `src/editor/editor.test.tsx`:

```tsx
describe('EditorView agent', () => {
  it('applies agent-returned code to the buffer and recompiles', async () => {
    const editor = EditorView.new({ debounceMs: 0 })
    editor.prompt = 'a spooky umbral card'
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ code: 'export default function Spooky() { return <p>boo</p> }' })),
    ) as unknown as typeof fetch
    await editor.runAgent(fetchImpl)
    expect(editor.source).toContain('Spooky')
    await vi.waitFor(() => {
      expect(editor.compileError).toBe('')
      expect(editor.card).toBeDefined()
    })
    expect(editor.agentNote).toContain('Applied')
    editor.set(null)
  })

  it('surfaces agent errors without touching the buffer', async () => {
    const editor = EditorView.new({ debounceMs: 0 })
    const before = editor.source
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'opencode is not running' }), { status: 500 }),
    ) as unknown as typeof fetch
    await editor.runAgent(fetchImpl)
    expect(editor.source).toBe(before)
    expect(editor.agentNote).toContain('opencode is not running')
    editor.set(null)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test`. Expected: FAIL — `src/server/agentBridge.ts` does not exist; `EditorView` has no `runAgent`.

- [ ] **Step 3: Implement the bridge**

`src/server/agentBridge.ts` (runs only inside the Vite dev server — bun/node context):

```ts
import type { ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { bytesToDataUrl } from '../images/codec'

// ---------- agent prompt ----------

export const CARD_API_GUIDE = `You write TSX modules for Cartis, a trading-card builder.
Rules:
- Output a COMPLETE module whose default export is a card component.
- Allowed imports ONLY: 'cartis/cards', 'cartis/ui', '@expressive/react'.
- 'cartis/cards' exports: ArcaneCard (props: data, holo), CardSurface (375x525 surface, props: holo, frameClass),
  HoloFoil, parts ArcaneTitleBar/ArcaneArtWindow/ArcaneTypeLine/ArcaneRulesBox/ArcaneStatBadge/ArcaneCostPips
  (each takes a palette from paletteFor(essenceId)), paletteFor, ESSENCES, arcaneTemplate.
- Card data keys for ArcaneCard: name, essence (ember|tide|verdant|radiant|umbral|relic), cost (0-9),
  typeLine, ability, flavor, might, ward, rarity (common|uncommon|rare|mythic), art (image url, optional).
- Style with tailwind utility classNames. Do not use React hooks; expressive Component classes may be subclassed
  (capital-letter methods of ArcaneCard are overridable subcomponents).
- No placeholder comments; the module must compile standalone.`

export function buildAgentPrompt(userPrompt: string, currentCode: string): string {
  return [
    CARD_API_GUIDE,
    'Current module source:',
    '```tsx',
    currentCode,
    '```',
    'User request:',
    userPrompt,
    'Respond via the structured output schema with the full revised module in `code`.',
  ].join('\n\n')
}

// ---------- opencode ----------

export interface AgentClient {
  session: {
    create(input: { body: { title: string } }): Promise<unknown>
    prompt(input: unknown): Promise<unknown>
  }
}

const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined

export function extractCode(result: unknown): string | undefined {
  const data = rec(rec(result)?.data) ?? rec(result)
  const structured = rec(rec(data?.info)?.structured_output) ?? rec(data?.structured_output)
  if (typeof structured?.code === 'string' && structured.code.trim().length > 0) {
    return structured.code
  }
  const parts = data?.parts
  if (Array.isArray(parts)) {
    let text = ''
    for (const part of parts) {
      const p = rec(part)
      if (p?.type === 'text' && typeof p.text === 'string') text += `\n${p.text}`
    }
    const fences = [...text.matchAll(/```(?:tsx|jsx|typescript|ts)?\n([\s\S]*?)```/g)]
    const last = fences[fences.length - 1]?.[1]
    if (last && last.trim().length > 0) return last.trim()
  }
  return undefined
}

export async function runCardAgent(
  client: AgentClient,
  userPrompt: string,
  currentCode: string,
): Promise<string> {
  const created = await client.session.create({ body: { title: 'cartis card edit' } })
  const createdData = rec(rec(created)?.data) ?? rec(created)
  const id = typeof createdData?.id === 'string' ? createdData.id : undefined
  if (!id) throw new Error('opencode session did not return an id')
  const result = await client.session.prompt({
    path: { id },
    body: {
      parts: [{ type: 'text', text: buildAgentPrompt(userPrompt, currentCode) }],
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: { code: { type: 'string', description: 'Complete TSX module source' } },
          required: ['code'],
        },
      },
    },
  })
  const code = extractCode(result)
  if (!code) throw new Error('agent returned no code')
  return code
}

let agentClient: Promise<AgentClient> | undefined

/** Lazy singleton: spawns `opencode` on first use so `bun run dev` stays fast without it. */
function getAgentClient(): Promise<AgentClient> {
  agentClient ??= (async () => {
    const sdk = await import('@opencode-ai/sdk')
    const model = process.env.OPENCODE_MODEL
    const { client } = await sdk.createOpencode({ config: model ? { model } : {} })
    return client as unknown as AgentClient
  })()
  return agentClient
}

// ---------- replicate ----------

const REPLICATE_URL =
  'https://api.replicate.com/v1/models/black-forest-labs/flux-kontext-pro/predictions'

export async function generateWithReplicate(
  token: string,
  prompt: string,
  imageDataUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const started = await fetchImpl(REPLICATE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'wait' },
    body: JSON.stringify({ input: { prompt, input_image: imageDataUrl, output_format: 'png' } }),
  })
  if (!started.ok) {
    throw new Error(`replicate error ${String(started.status)}: ${await started.text()}`)
  }
  const prediction = rec(await started.json())
  const output = prediction?.output
  const url =
    typeof output === 'string'
      ? output
      : Array.isArray(output) && typeof output[0] === 'string'
        ? output[0]
        : undefined
  if (!url) {
    throw new Error(`replicate returned no output (status ${String(prediction?.status)})`)
  }
  const image = await fetchImpl(url)
  const bytes = await image.arrayBuffer()
  return bytesToDataUrl(bytes, image.headers.get('content-type') ?? 'image/png')
}

// ---------- http plumbing ----------

export function readJson(req: {
  on(event: string, cb: (chunk?: unknown) => void): unknown
}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += String(chunk)
    })
    req.on('end', () => {
      try {
        resolve(body.length > 0 ? JSON.parse(body) : {})
      } catch (cause) {
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      }
    })
    req.on('error', (cause) => reject(cause instanceof Error ? cause : new Error(String(cause))))
  })
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(value))
}

async function respondWith(res: ServerResponse, work: () => Promise<unknown>): Promise<void> {
  try {
    sendJson(res, 200, await work())
  } catch (cause) {
    sendJson(res, 500, { error: cause instanceof Error ? cause.message : String(cause) })
  }
}

export function cartisBridge(): Plugin {
  return {
    name: 'cartis-bridge',
    configureServer(server) {
      server.middlewares.use('/api/status', (_req, res) => {
        sendJson(res as ServerResponse, 200, {
          image: process.env.REPLICATE_API_TOKEN ? 'replicate' : 'stub',
        })
      })
      server.middlewares.use('/api/agent/card', (req, res) => {
        if (req.method !== 'POST') return sendJson(res as ServerResponse, 405, { error: 'POST only' })
        void respondWith(res as ServerResponse, async () => {
          const body = rec(await readJson(req)) ?? {}
          const code = await runCardAgent(
            await getAgentClient(),
            String(body.prompt ?? ''),
            String(body.code ?? ''),
          )
          return { code }
        })
      })
      server.middlewares.use('/api/image/generate', (req, res) => {
        if (req.method !== 'POST') return sendJson(res as ServerResponse, 405, { error: 'POST only' })
        const token = process.env.REPLICATE_API_TOKEN
        if (!token) {
          return sendJson(res as ServerResponse, 503, { error: 'REPLICATE_API_TOKEN not set — using stub locally' })
        }
        void respondWith(res as ServerResponse, async () => {
          const body = rec(await readJson(req)) ?? {}
          const dataUrl = await generateWithReplicate(
            token,
            String(body.prompt ?? ''),
            String(body.imageDataUrl ?? ''),
          )
          return { dataUrl }
        })
      })
    },
  }
}
```

Implementation caveat: after `bun install`, open `node_modules/@opencode-ai/sdk` types and confirm `createOpencode` / `session.create` / `session.prompt` shapes match the structural `AgentClient`; the docs at https://opencode.ai/docs/sdk/ are the source of truth. `extractCode` is deliberately tolerant of both `result.data.info.structured_output` and text-fence replies.

- [ ] **Step 4: Register the plugin**

`vite.config.ts` becomes:

```ts
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { cartisBridge } from './src/server/agentBridge'

export default defineConfig({
  plugins: [react(), tailwindcss(), cartisBridge()],
})
```

- [ ] **Step 5: Add the Agent panel to EditorView**

In `src/editor/EditorView.tsx`, add fields after `previewEl`:

```tsx
  prompt = ''
  agentBusy = false
  agentNote = ''
```

Add methods after `compileNow()`:

```tsx
  async runAgent(fetchImpl: typeof fetch = fetch) {
    if (this.agentBusy || this.prompt.trim().length === 0) return
    this.agentBusy = true
    this.agentNote = 'Asking the agent…'
    try {
      const res = await fetchImpl('/api/agent/card', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: this.prompt, code: this.source }),
      })
      const body = (await res.json()) as { code?: string; error?: string }
      if (!res.ok || !body.code) {
        throw new Error(body.error ?? `agent request failed (${String(res.status)})`)
      }
      this.source = body.code // CodePane picks this up; the source watcher recompiles
      this.agentNote = 'Applied — the code is yours to edit.'
    } catch (cause) {
      this.agentNote = cause instanceof Error ? cause.message : String(cause)
    } finally {
      this.agentBusy = false
    }
  }

  AgentPanel() {
    return (
      <div className="flex flex-col gap-2 border-t border-edge p-3">
        <TextAreaInput
          value={this.prompt}
          onValue={(v) => {
            this.prompt = v
          }}
          rows={2}
          placeholder="Describe the card: “a mythic umbral librarian who trades memories…”"
        />
        <div className="flex items-center gap-3">
          <Button disabled={this.agentBusy} onClick={() => void this.runAgent()}>
            {this.agentBusy ? 'Generating…' : 'Generate with AI'}
          </Button>
          {this.agentNote ? <span className="text-xs text-ink-dim">{this.agentNote}</span> : null}
        </div>
      </div>
    )
  }
```

Add the import `import { Button, TextAreaInput } from '../ui'` and render `<this.AgentPanel />` in the left section, between `<CodePane …/>` and the compile-error bar.

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun run test`. Expected: PASS — 8 new bridge tests + 2 new editor-agent tests. None of them touch the network or spawn opencode (injected fakes only).

- [ ] **Step 7: Verify live (optional paths)**

- Offline: `bun run dev` → Code Lab → prompt + "Generate with AI" → clear error note (bridge reports opencode failure) — buffer untouched. Image Lab still stubs.
- With opencode installed/authed (`opencode auth login`, optionally `OPENCODE_MODEL=anthropic/claude-fable-5`): the prompt rewrites the buffer and the preview re-renders.
- With `REPLICATE_API_TOKEN=… bun run dev`: Image Lab/Portrait generate through flux-kontext-pro.

- [ ] **Step 8: Commit**

```bash
bun run check && bun run verify
git add -A
git commit -m "feat: add opencode agent bridge, replicate endpoint, and code lab agent panel"
```

---

### Task 14: README, Extension Recipe, and Final Verification

**Files:**
- Create: `README.md`
- Test: none new — this task's gate is the full `bun run verify` plus the manual checklist.

**Interfaces:**
- Consumes: everything.
- Produces: the documented, verified v0.1.

- [ ] **Step 1: Write README.md**

```markdown
# Cartis — Card Studio

A local app for building custom trading cards: pick a template and fill a form
(Builder), free-code a card in TSX with an optional AI agent (Code Lab), turn a
photo of a person into stylized card art (Image Lab), and export print-ready
files. Everything runs on your machine; nothing is pushed anywhere.

## Run

```bash
bun install
bun run dev        # http://localhost:5173
```

Quality gates (run automatically before every commit in this repo):

```bash
bun run verify     # biome ci + tsc --noEmit + vitest
bun run check      # auto-format + lint fixes
```

## Optional AI integrations (both off by default; the app is fully offline without them)

- **Real image generation** — flux-kontext-pro via Replicate:
  `REPLICATE_API_TOKEN=r8_… bun run dev`. Without it, a local canvas "stub
  stylizer" fakes the effect.
- **Code Lab agent** — [opencode](https://opencode.ai) writes card TSX:
  install opencode, run `opencode auth login` once, then optionally pick a
  model with `OPENCODE_MODEL=anthropic/claude-fable-5 bun run dev`.

## Vocabulary

- **Kit** — a style library of composable card part components (`src/cards/arcane`).
- **Template** — a registered card definition: form schema + defaults + art
  style prompt + renderer. The Builder's dropdown lists all registered templates.

## Adding a new card style

1. Create `src/cards/<kit>/` with your parts and a `Component` card
   (see `arcane/` — capital-letter methods are overridable subcomponents).
2. Define a `CardTemplate` (`fields`, `defaults`, `artStylePrompt`, `Render`).
3. Register it in `registerBuiltinTemplates()` (`src/cards/index.ts`) and
   export your parts from the barrel so the Code Lab can import them.
4. Done — the Builder dropdown, portrait styling, Image Lab style list, and
   Code Lab imports all pick it up from the registry.

## Printing

Exports are 750×1050 px = 2.5"×3.5" at 300 DPI (standard trading-card size).
Print at 100% scale on cardstock; for the holographic look, enable the Holo
toggle and print on holo/foil sticker paper.

## State architecture

Expressive-mvc only (no React idioms): views are `Component` classes, shared
stores (`ImageLibrary`, `CardArchive`) hang off `AppShell`, and persistence is
IndexedDB. See `docs/superpowers/plans/2026-07-31-cartis-card-studio.md`.
```

(Adjust the nested code fences when writing the real file — outer fence must differ from inner ones or use indentation.)

- [ ] **Step 2: Full verification sweep**

Run each and confirm output:

```bash
bun run check      # expect: no fixes left to apply
bun run verify     # expect: biome ci clean, tsc clean, ~60 tests passing
bun run build      # expect: vite production build succeeds
```

- [ ] **Step 3: Manual checklist against the spec (dev server)**

`bun run dev`, then walk through — every line maps to a spec requirement:

1. Builder default view; four tabs switch without losing form state. ✓ main view = card builder, switchable modes
2. Type in form → card updates live; essence recolors; template dropdown lists Arcane Hero. ✓ static mode
3. Portrait tools: webcam capture, upload, library pick; persona fields shape the prompt; generated image lands on the card. ✓ AI-image sub-view + webcam flow
4. Image Lab standalone tab generates without card context. ✓ isolated mode
5. Code Lab: starter card renders; editing recompiles; crash shows recoverable error; agent prompt rewrites code (or errors cleanly offline). ✓ AI+free-edit mode
6. Export PNG/WebP/JPEG at 750×1050; files download and appear in Gallery. ✓ render/export
7. Gallery: renders, generations, saved cards; "Open in builder" round-trips. ✓ history
8. Holo toggle shimmers on screen and rasterizes into exports. ✓ holographic

If any line fails, fix it (superpowers:systematic-debugging) before the final commit.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: add README with setup, extension recipe, and print guidance"
```

Do **not** push; the repo stays local by design.

---

## Post-Plan Notes for the Executor

- **Expressive is the framework.** When something feels like it needs `useState`, the answer is a field on the nearest `Component`/`State` class. When a view needs another model's data inside `render()`, mirror it via `model.get(effect)` in `mount()` (see GalleryView) — do not read foreign instances directly in `render()`.
- **Version drift**: exact versions in Task 1 were current on 2026-07-31; `bun add` caret ranges may pull newer patches. If an API mismatch appears (most likely: `@opencode-ai/sdk` response shapes, biome schema keys), trust the installed package's types over this plan and adjust minimally.
- **happy-dom limits are designed around**: no canvas (stub provider falls back to source bytes — tested), no camera (CameraCapture error path — tested), CodeMirror untested in unit tests (thin wrapper, exercised via dev server).
- Commit messages use conventional prefixes (`feat:`/`docs:`); every commit is preceded by a green `bun run verify`.
