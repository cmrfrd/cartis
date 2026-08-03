# xulux ChatGPT demo — vendored reference

`chatgpt.tsx` is copied verbatim from `xulux-chatgpt-demo.zip`
(`components/examples/chatgpt.tsx`), the ChatGPT-clone example built on
`@assistant-ui/react` primitives. It is the visual/UX reference for the
chat-panel maturity work (spec:
`docs/superpowers/specs/2026-08-03-chat-panel-maturity-design.md`) — cartis
ports its STRUCTURE onto the expressive ThreadState, not its runtime. Nothing
in here is imported by the app; it exists so line-level references in the spec
and plan stay resolvable.

Files from the demo that were deliberately NOT vendored: the thread-list rail
(`clone-thread-shell.tsx`, `thread-list.tsx` — cartis chat is
session-per-card, no thread list), the AI-SDK runtime provider, and the shadcn
ui primitives (cartis has its own vendored set).
