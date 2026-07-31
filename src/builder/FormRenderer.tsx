import type { ReactNode } from 'react';
import type { CardData, FieldSpec, FieldValue } from '../cards/types';
import { FieldRow, NumberInput, SelectInput, TextAreaInput, TextInput } from '../ui';

type ImageSpec = Extract<FieldSpec, { kind: 'image' }>;

export function FormRenderer(props: {
  fields: readonly FieldSpec[];
  data: CardData;
  onField: (key: string, value: FieldValue) => void;
  imageSlot?: (spec: ImageSpec) => ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      {props.fields.map((spec) => (
        <FieldRow key={spec.key} label={spec.label}>
          <FieldControl
            spec={spec}
            data={props.data}
            onField={props.onField}
            imageSlot={props.imageSlot}
          />
        </FieldRow>
      ))}
    </div>
  );
}

function FieldControl(props: {
  spec: FieldSpec;
  data: CardData;
  onField: (key: string, value: FieldValue) => void;
  imageSlot?: (spec: ImageSpec) => ReactNode;
}) {
  const { spec, data, onField } = props;
  const raw = data[spec.key];
  switch (spec.kind) {
    case 'text':
      return (
        <TextInput
          value={String(raw ?? '')}
          onValue={(v) => onField(spec.key, v)}
          placeholder={spec.placeholder}
          maxLength={spec.maxLength}
        />
      );
    case 'textarea':
      return (
        <TextAreaInput
          value={String(raw ?? '')}
          onValue={(v) => onField(spec.key, v)}
          rows={spec.rows}
          placeholder={spec.placeholder}
        />
      );
    case 'number':
      return (
        <NumberInput
          value={Number(raw ?? spec.min)}
          onValue={(v) => onField(spec.key, v)}
          min={spec.min}
          max={spec.max}
        />
      );
    case 'select':
      return (
        <SelectInput
          value={String(raw ?? spec.options[0]?.value ?? '')}
          onValue={(v) => onField(spec.key, v)}
          options={spec.options}
        />
      );
    case 'image':
      return props.imageSlot ? (
        <>{props.imageSlot(spec)}</>
      ) : (
        <p className="text-xs text-ink-dim">Portrait tools arrive with the image pipeline.</p>
      );
  }
}
