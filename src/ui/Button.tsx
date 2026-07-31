import type { Component } from '@expressive/react';

const TONES = {
  accent: 'bg-accent text-surface hover:brightness-110',
  ghost: 'border border-edge text-ink hover:border-accent hover:text-accent',
  danger: 'border border-red-900 text-red-300 hover:bg-red-950',
} as const;

export type ButtonTone = keyof typeof TONES;

export function Button(props: {
  onClick: () => void;
  children?: Component.Node;
  tone?: ButtonTone;
  disabled?: boolean;
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
  );
}
