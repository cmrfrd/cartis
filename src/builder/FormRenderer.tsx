import type { FieldSpec } from '../cards/types';
import { FieldRow, NumberInput, SelectInput, TextAreaInput, TextInput } from '../ui';
// Deliberate module cycle (BuilderView renders FormRenderer) — benign, see BuilderView.tsx.
import { BuilderView, PortraitSlot } from './BuilderView';

/**
 * Schema-driven form for the active template. Contextual per the expressive
 * skills: reads BuilderView via .get() and writes through it directly —
 * no drilled data/callback props.
 */
export function FormRenderer() {
  const { template } = BuilderView.get();
  return (
    <div className="flex flex-col gap-3">
      {template.fields.map((spec) => (
        <FieldRow key={spec.key} label={spec.label}>
          <FieldControl spec={spec} />
        </FieldRow>
      ))}
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
  }
}
