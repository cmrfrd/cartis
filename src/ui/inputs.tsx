import { Input as NbInput } from '@/components/ui/input';
import { Switch as NbSwitch } from '@/components/ui/switch';
import { Textarea as NbTextarea } from '@/components/ui/textarea';

export function TextInput(props: {
  value: string;
  onValue: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
}) {
  return (
    <NbInput
      type="text"
      value={props.value}
      placeholder={props.placeholder}
      maxLength={props.maxLength}
      onChange={(e) => props.onValue(e.target.value)}
    />
  );
}

export function TextAreaInput(props: {
  value: string;
  onValue: (v: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <NbTextarea
      value={props.value}
      rows={props.rows ?? 3}
      placeholder={props.placeholder}
      className="resize-none"
      onChange={(e) => props.onValue(e.target.value)}
    />
  );
}

export function NumberInput(props: {
  value: number;
  onValue: (v: number) => void;
  min: number;
  max: number;
}) {
  return (
    <NbInput
      type="number"
      value={props.value}
      min={props.min}
      max={props.max}
      onChange={(e) => {
        const n = Number(e.target.value);
        const safe = Number.isFinite(n) ? n : props.min;
        props.onValue(Math.min(props.max, Math.max(props.min, safe)));
      }}
    />
  );
}

/** Native select restyled neobrutalist — keeps tests and keyboard UX simple. */
export function SelectInput(props: {
  value: string;
  onValue: (v: string) => void;
  options: readonly { value: string; label: string }[];
}) {
  return (
    <select
      className="w-full rounded-base border-2 border-border bg-secondary-background px-2.5 py-1.5 font-base text-foreground text-sm shadow-shadow focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      value={props.value}
      onChange={(e) => props.onValue(e.target.value)}
    >
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function ToggleInput(props: { value: boolean; onValue: (v: boolean) => void }) {
  return <NbSwitch checked={props.value} onCheckedChange={props.onValue} />;
}
