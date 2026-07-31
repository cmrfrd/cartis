import type { FieldSpec } from '../cards/types';
import { FieldRow, NumberInput, SelectInput, TextAreaInput, TextInput, ToggleInput } from '../ui';
// Deliberate module cycle (BuilderView renders FormRenderer) — benign, see BuilderView.tsx.
import { BuilderView, PortraitSlot } from './BuilderView';

/**
 * Schema-driven form for the active template. Contextual per the expressive
 * skills: reads BuilderView via .get() and writes through it directly.
 * Toggle fields render as optional-section groups: fields whose showIf points
 * at the toggle nest inside it and appear only while it is on.
 */
export function FormRenderer() {
  const { template, data } = BuilderView.get();
  const toggleKeys = new Set(
    template.fields.filter((spec) => spec.kind === 'toggle').map((spec) => spec.key),
  );
  const dependentsOf = (key: string) => template.fields.filter((spec) => spec.showIf?.key === key);
  return (
    <div className="flex flex-col gap-3">
      {template.fields.map((spec) => {
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
  switch (spec.kind) {
    case 'text':
      return (
        <TextInput
          value={String(raw ?? '')}
          onValue={(v) => builder.setField(spec.key, v)}
          placeholder={spec.placeholder}
          maxLength={spec.maxLength}
        />
      );
    case 'textarea':
      return (
        <TextAreaInput
          value={String(raw ?? '')}
          onValue={(v) => builder.setField(spec.key, v)}
          rows={spec.rows}
          placeholder={spec.placeholder}
        />
      );
    case 'number':
      return (
        <NumberInput
          value={Number(raw ?? spec.min)}
          onValue={(v) => builder.setField(spec.key, v)}
          min={spec.min}
          max={spec.max}
        />
      );
    case 'select':
      return (
        <SelectInput
          value={String(raw ?? spec.options[0]?.value ?? '')}
          onValue={(v) => builder.setField(spec.key, v)}
          options={spec.options}
        />
      );
    case 'image':
      return <PortraitSlot fieldKey={spec.key} />;
    case 'toggle':
      return <ToggleInput value={raw !== false} onValue={(v) => builder.setField(spec.key, v)} />;
  }
}
