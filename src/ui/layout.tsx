import type { ReactNode } from 'react';

export function FieldRow(props: { label: string; children?: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is nested via children (implicit association)
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-ink-dim">
        {props.label}
      </span>
      {props.children}
    </label>
  );
}

export function Panel(props: { title?: string; children?: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-edge bg-panel p-4 ${props.className ?? ''}`}>
      {props.title && (
        <h2 className="mb-3 font-display text-sm uppercase tracking-widest text-accent">
          {props.title}
        </h2>
      )}
      {props.children}
    </section>
  );
}

export function TabBar(props: {
  tabs: readonly { id: string; label: string }[];
  active: string;
  onSelect: (id: string) => void;
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
  );
}

export function EmptyState(props: { message: string; hint?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center">
      <p className="text-sm text-ink-dim">{props.message}</p>
      {props.hint && <p className="text-xs text-ink-dim/70">{props.hint}</p>}
    </div>
  );
}
