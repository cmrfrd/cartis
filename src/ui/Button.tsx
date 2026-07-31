import type { Component } from '@expressive/react';
import { Button as NbButton } from '@/components/ui/button';

/** Cartis tones mapped onto neobrutalism variants. */
const TONE_VARIANT = {
  accent: 'default',
  ghost: 'neutral',
  danger: 'neutral',
} as const;

export type ButtonTone = keyof typeof TONE_VARIANT;

export function Button(props: {
  onClick: () => void;
  children?: Component.Node;
  tone?: ButtonTone;
  disabled?: boolean;
}) {
  const tone = props.tone ?? 'accent';
  return (
    <NbButton
      size="sm"
      variant={TONE_VARIANT[tone]}
      disabled={props.disabled === true}
      onClick={props.onClick}
      className={tone === 'danger' ? 'text-red-400' : undefined}
    >
      {props.children}
    </NbButton>
  );
}
