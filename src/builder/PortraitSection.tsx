import { Component, get } from '@expressive/react';
import { Effect, Exit } from 'effect';
import { AppShell } from '../app/AppShell';
import { runAppExit } from '../app/runtime';
import { noteFromCause } from '../contracts/errors';
import { CameraCapture } from '../images/CameraCapture';
import { bytesToDataUrl } from '../images/codec';
import { ImageProvider } from '../images/ImageProvider';
import { PhotoPicker } from '../images/PhotoPicker';
import type { Persona } from '../images/prompt';
import { buildPortraitPrompt } from '../images/prompt';
import type { ImageLibrary } from '../storage/ImageLibrary';
import { Button, FieldRow, Panel, TextInput } from '../ui';
// Deliberate module cycle with BuilderView (it renders PortraitSection) — benign, see BuilderView.tsx.
import { BuilderView } from './BuilderView';

const SOURCES = [
  { id: 'upload', label: 'Upload' },
  { id: 'camera', label: 'Webcam' },
  { id: 'library', label: 'Library' },
] as const;

export class PortraitSection extends Component {
  builder = get(BuilderView, false);
  shell = get(AppShell, false);
  fieldKey = '';
  source: 'upload' | 'camera' | 'library' = 'upload';
  persona: Persona = {};
  pendingBytes?: ArrayBuffer = undefined;
  pendingType = '';
  pendingPreview = '';
  busy = false;
  note = '';

  acceptSource(bytes: ArrayBuffer, type: string) {
    this.pendingBytes = bytes;
    this.pendingType = type;
    this.pendingPreview = bytesToDataUrl(bytes, type);
    this.note = '';
  }

  setPersona(key: keyof Persona, value: string) {
    this.persona = { ...this.persona, [key]: value };
  }

  applyLibraryImage(id: string) {
    this.builder?.setField(this.fieldKey, id);
    this.note = 'Applied from library.';
  }

  /** `deps` is the DI seam for headless tests; context supplies the defaults. */
  async generate(deps: { builder?: BuilderView; library?: ImageLibrary } = {}) {
    if (this.busy) return;
    const bytes = this.pendingBytes;
    if (!bytes) {
      this.note = 'Capture or upload a photo first.';
      return;
    }
    const builder = deps.builder ?? this.builder;
    if (!builder) {
      this.note = 'Builder unavailable.';
      return;
    }
    const library = deps.library ?? this.shell?.library;
    if (!library) {
      this.note = 'Image library unavailable.';
      return;
    }
    // Snapshot reactive fields before building the effect (snapshot rule).
    const sourceType = this.pendingType;
    const fieldKey = this.fieldKey;
    const themeArt = [builder.theme.lookAndFeel, builder.theme.artFlavor?.(builder.data) ?? '']
      .filter((s) => s.length > 0)
      .join(', ');
    const prompt = buildPortraitPrompt(themeArt, this.persona);
    const styleId = builder.themeId;
    const aspectRatio = builder.layout.artAspect ?? 'match_input_image';
    const name = `${String(builder.data.name ?? 'card')} portrait`;
    this.busy = true;
    this.note = 'Generating portrait…';
    try {
      const exit = await runAppExit(
        Effect.flatMap(ImageProvider, (p) =>
          p.generate({ sourceBytes: bytes, sourceType, prompt, styleId, aspectRatio }),
        ),
      );
      if (Exit.isFailure(exit)) {
        this.note = noteFromCause(exit.cause);
        return;
      }
      const out = exit.value;
      const stored = await library.add({
        name,
        kind: 'generated',
        prompt,
        styleId,
        bytes: out.bytes,
        type: out.type,
      });
      builder.setField(fieldKey, stored.id);
      this.note = `Portrait applied (via ${out.via}).`;
    } catch (cause) {
      this.note = cause instanceof Error ? cause.message : String(cause);
    } finally {
      this.busy = false;
    }
  }

  render() {
    const { busy, note } = this;
    return (
      <Panel title="Portrait" className="border-accent-soft">
        <div className="flex flex-col gap-3">
          <PortraitSourcePicker />
          <PortraitPersonaForm />
          <div className="flex items-center gap-3">
            <Button disabled={busy} onClick={() => void this.generate()}>
              {busy ? 'Generating…' : 'Generate portrait'}
            </Button>
          </div>
          {note && <p className="text-xs text-ink-dim">{note}</p>}
        </div>
      </Panel>
    );
  }
}

function PortraitSourcePicker() {
  const { is: section, source, pendingPreview, shell } = PortraitSection.get();
  const library = shell?.library;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1.5">
        {SOURCES.map((s) => (
          <Button
            key={s.id}
            tone={source === s.id ? 'accent' : 'ghost'}
            onClick={() => {
              section.source = s.id;
            }}
          >
            {s.label}
          </Button>
        ))}
      </div>
      {source === 'upload' && (
        <PhotoPicker onPhoto={(bytes, type) => section.acceptSource(bytes, type)} />
      )}
      {source === 'camera' && (
        <CameraCapture onFrame={(bytes, type) => section.acceptSource(bytes, type)} />
      )}
      {source === 'library' && (
        <div className="grid max-h-40 grid-cols-4 gap-1.5 overflow-y-auto">
          {(library?.images ?? [])
            .filter((i) => i.kind === 'generated')
            .map((image) => (
              <button
                key={image.id}
                type="button"
                onClick={() => section.applyLibraryImage(image.id)}
                className="overflow-hidden rounded border border-edge hover:border-accent"
              >
                <img
                  src={library?.urls[image.id]}
                  alt={image.prompt ?? 'library'}
                  className="aspect-square w-full object-cover"
                />
              </button>
            ))}
        </div>
      )}
      {pendingPreview && source !== 'library' && (
        <img src={pendingPreview} alt="pending source" className="h-20 w-20 rounded object-cover" />
      )}
    </div>
  );
}

function PortraitPersonaForm() {
  const { is: section, persona } = PortraitSection.get();
  const fields: readonly { key: keyof Persona; label: string; placeholder: string }[] = [
    { key: 'age', label: 'Age', placeholder: '34' },
    { key: 'gender', label: 'Gender', placeholder: 'optional' },
    { key: 'detail', label: 'Small detail', placeholder: 'always wears red glasses' },
    { key: 'hobby', label: 'Hobby', placeholder: 'sourdough baking' },
  ];
  return (
    <div className="grid grid-cols-2 gap-2">
      {fields.map((f) => (
        <FieldRow key={f.key} label={f.label}>
          <TextInput
            value={persona[f.key] ?? ''}
            onValue={(v) => section.setPersona(f.key, v)}
            placeholder={f.placeholder}
          />
        </FieldRow>
      ))}
    </div>
  );
}
