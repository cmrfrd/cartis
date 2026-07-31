const INPUT_CLASS =
  'w-full rounded border border-edge bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-dim focus:border-accent focus:outline-none';

export function TextInput(props: {
  value: string;
  onValue: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
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
  );
}

export function TextAreaInput(props: {
  value: string;
  onValue: (v: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <textarea
      className={`${INPUT_CLASS} resize-none`}
      value={props.value}
      rows={props.rows ?? 3}
      placeholder={props.placeholder}
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
    <input
      type="number"
      className={INPUT_CLASS}
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

export function SelectInput(props: {
  value: string;
  onValue: (v: string) => void;
  options: readonly { value: string; label: string }[];
}) {
  return (
    <select
      className={INPUT_CLASS}
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
