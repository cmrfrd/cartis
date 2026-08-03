import { Match } from 'effect';
import type { FieldSpec } from '@/cards/types';
import { FieldRow, NumberInput, SelectInput, TextAreaInput, TextInput, ToggleInput } from '@/ui';
// Deliberate module cycle (BuilderView renders FormRenderer) — benign, see BuilderView.tsx.
import { BuilderView, PortraitSlot } from './BuilderView';

/**
 * Schema-driven form for the active layout's arguments. Contextual per the
 * expressive skills: reads BuilderView via .get() and writes through it directly.
 * Toggle fields render as optional-section groups: fields whose showIf points
 * at the toggle nest inside it and appear only while it is on.
 */
export function FormRenderer() {
  const { layout, data } = BuilderView.get();
  const toggleKeys = new Set(
    layout.fields.filter((spec) => spec.kind === 'toggle').map((spec) => spec.key),
  );
  const dependentsOf = (key: string) => layout.fields.filter((spec) => spec.showIf?.key === key);
  return (
    <div className="flex flex-col gap-3">
      {layout.fields.map((spec) => {
        // dependents of a toggle render inside their section, not in the main flow
        if (spec.showIf && toggleKeys.has(spec.showIf.key)) return null;
        // non-toggle conditions keep plain visibility semantics
        if (spec.showIf && data[spec.showIf.key] !== spec.showIf.equals) return null;
        if (spec.kind === 'toggle') {
          return <ToggleSection key={spec.key} spec={spec} dependents={dependentsOf(spec.key)} />;
        }
        return (
          <FieldRow key={spec.key} label={spec.label}>
            <FieldControl spec={spec} />
          </FieldRow>
        );
      })}
    </div>
  );
}

/** Bordered optional-section: header row with the switch, gated fields nested inside. */
function ToggleSection(props: {
  spec: Extract<FieldSpec, { kind: 'toggle' }>;
  dependents: FieldSpec[];
}) {
  const { is: builder, data } = BuilderView.get();
  const on = data[props.spec.key] !== false;
  return (
    <div
      data-testid="toggle-section"
      className="rounded-base border-2 border-border bg-secondary-background shadow-shadow"
    >
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <span className="font-base text-foreground text-xs uppercase tracking-wide">
          {props.spec.label}
        </span>
        <ToggleInput value={on} onValue={(v) => builder.setField(props.spec.key, v)} />
      </div>
      {on && props.dependents.length > 0 && (
        <div className="grid grid-cols-2 gap-2 border-border border-t-2 px-3 py-2.5">
          {props.dependents.map((spec) => (
            <FieldRow key={spec.key} label={spec.label}>
              <FieldControl spec={spec} />
            </FieldRow>
          ))}
        </div>
      )}
    </div>
  );
}

function FieldControl(props: { spec: FieldSpec }) {
  const { is: builder, data } = BuilderView.get();
  const { spec } = props;
  const raw = data[spec.key];
  // Discriminator match on `kind`, Match.exhaustive (spec §Match): a new
  // field kind fails tsc here instead of silently rendering nothing.
  return Match.value(spec).pipe(
    Match.discriminators('kind')({
      text: (s) => (
        <TextInput
          value={String(raw ?? '')}
          onValue={(v) => builder.setField(s.key, v)}
          placeholder={s.placeholder}
          maxLength={s.maxLength}
        />
      ),
      textarea: (s) => (
        <TextAreaInput
          value={String(raw ?? '')}
          onValue={(v) => builder.setField(s.key, v)}
          rows={s.rows}
          placeholder={s.placeholder}
        />
      ),
      number: (s) => (
        <NumberInput
          value={Number(raw ?? s.min)}
          onValue={(v) => builder.setField(s.key, v)}
          min={s.min}
          max={s.max}
        />
      ),
      select: (s) => (
        <SelectInput
          value={String(raw ?? s.options[0]?.value ?? '')}
          onValue={(v) => builder.setField(s.key, v)}
          options={s.options}
        />
      ),
      image: (s) => <PortraitSlot fieldKey={s.key} />,
      toggle: (s) => (
        <ToggleInput value={raw !== false} onValue={(v) => builder.setField(s.key, v)} />
      ),
    }),
    Match.exhaustive,
  );
}
