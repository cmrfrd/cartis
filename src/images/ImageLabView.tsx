import { Component, get } from '@expressive/react';
import { Effect, Exit } from 'effect';
import { AppShell } from '../app/AppShell';
import { runAppExit } from '../app/runtime';
import { getTemplate, listTemplates } from '../cards/registry';
import { noteFromCause } from '../contracts/errors';
import type { ImageLibrary } from '../storage/ImageLibrary';
import { Button, EmptyState, FieldRow, Panel, SelectInput, TextAreaInput, TextInput } from '../ui';
import { CameraCapture } from './CameraCapture';
import { bytesToDataUrl } from './codec';
import { ImageProvider } from './ImageProvider';
import { PhotoPicker } from './PhotoPicker';
import { suggestImageName } from './prompt';

const ASPECT_OPTIONS = [
  { value: 'match_input_image', label: 'Match input' },
  { value: '1:1', label: 'Square 1:1' },
  { value: '3:2', label: 'Landscape 3:2' },
  { value: '2:3', label: 'Portrait 2:3' },
  { value: '4:3', label: 'Landscape 4:3' },
  { value: '3:4', label: 'Portrait 3:4' },
  { value: '16:9', label: 'Wide 16:9' },
  { value: '9:16', label: 'Tall 9:16' },
  { value: '4:5', label: 'Portrait 4:5' },
  { value: '5:4', label: 'Landscape 5:4' },
  { value: '2:1', label: 'Panorama 2:1' },
  { value: '1:2', label: 'Tower 1:2' },
  { value: '21:9', label: 'Cinema 21:9' },
  { value: '9:21', label: 'Sliver 9:21' },
];

export class ImageLabView extends Component {
  shell = get(AppShell, false);
  prompt = '';
  imageName = '';
  aspectRatio = 'match_input_image';
  styleId = 'freestyle';
  sourceBytes?: ArrayBuffer = undefined;
  sourceType = '';
  sourcePreview = '';
  useCamera = false;
  busy = false;
  note = '';

  get fullPrompt(): string {
    const base =
      this.styleId === 'freestyle'
        ? ''
        : (() => {
            const t = getTemplate(this.styleId);
            return t.artStylePrompt(t.defaults);
          })();
    return [base, this.prompt.trim()].filter((s) => s.length > 0).join(', ');
  }

  acceptSource(bytes: ArrayBuffer, type: string) {
    this.sourceBytes = bytes;
    this.sourceType = type;
    this.sourcePreview = bytesToDataUrl(bytes, type);
    this.note = '';
  }

  /** `intoLibrary` is the DI seam for headless tests; context supplies the default. */
  async generate(intoLibrary?: ImageLibrary) {
    if (this.busy) return;
    const source = this.sourceBytes;
    if (!source) {
      this.note = 'Capture or upload a photo first.';
      return;
    }
    const library = intoLibrary ?? this.shell?.library;
    if (!library) {
      this.note = 'Image library unavailable.';
      return;
    }
    // Snapshot reactive fields before building the effect (snapshot rule).
    const sourceType = this.sourceType;
    const styleId = this.styleId;
    const aspectRatio = this.aspectRatio;
    const imageName = this.imageName;
    const prompt = this.fullPrompt;
    this.busy = true;
    this.note = 'Generating…';
    try {
      const exit = await runAppExit(
        Effect.flatMap(ImageProvider, (p) =>
          p.generate({ sourceBytes: source, sourceType, prompt, styleId, aspectRatio }),
        ),
      );
      if (Exit.isFailure(exit)) {
        this.note = noteFromCause(exit.cause);
        return;
      }
      const out = exit.value;
      await library.add({
        name: imageName.trim() || suggestImageName(prompt),
        kind: 'generated',
        prompt,
        styleId,
        bytes: out.bytes,
        type: out.type,
      });
      this.note = `Done — generated via ${out.via}.`;
    } catch (cause) {
      this.note = cause instanceof Error ? cause.message : String(cause);
    } finally {
      this.busy = false;
    }
  }

  render() {
    return (
      <div className="flex h-full">
        <aside className="flex w-96 shrink-0 flex-col gap-4 overflow-y-auto border-r border-edge p-4">
          <LabSource />
          <LabControls />
        </aside>
        <section className="min-w-0 flex-1 overflow-y-auto p-4">
          <LabResults />
        </section>
      </div>
    );
  }
}

function LabSource() {
  const { is: lab, useCamera, sourcePreview } = ImageLabView.get();
  return (
    <Panel title="Source photo">
      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          <Button
            tone={useCamera ? 'ghost' : 'accent'}
            onClick={() => {
              lab.useCamera = false;
            }}
          >
            Upload
          </Button>
          <Button
            tone={useCamera ? 'accent' : 'ghost'}
            onClick={() => {
              lab.useCamera = true;
            }}
          >
            Webcam
          </Button>
        </div>
        {useCamera ? (
          <CameraCapture onFrame={(bytes, type) => lab.acceptSource(bytes, type)} />
        ) : (
          <PhotoPicker onPhoto={(bytes, type) => lab.acceptSource(bytes, type)} />
        )}
        {sourcePreview && (
          <img src={sourcePreview} alt="source" className="h-28 w-28 rounded object-cover" />
        )}
      </div>
    </Panel>
  );
}

function LabControls() {
  const { is: lab, styleId, prompt, imageName, aspectRatio, busy, note } = ImageLabView.get();
  const styleOptions = [
    { value: 'freestyle', label: 'Freestyle prompt' },
    ...listTemplates().map((t) => ({ value: t.id, label: `${t.name} style` })),
  ];
  return (
    <Panel title="Generation">
      <div className="flex flex-col gap-3">
        <FieldRow label="Style">
          <SelectInput
            value={styleId}
            onValue={(v) => {
              lab.styleId = v;
              if (v !== 'freestyle') {
                const aspect = getTemplate(v).artAspect;
                if (aspect) lab.aspectRatio = aspect;
              }
            }}
            options={styleOptions}
          />
        </FieldRow>
        <FieldRow label="Dimensions">
          <SelectInput
            value={aspectRatio}
            onValue={(v) => {
              lab.aspectRatio = v;
            }}
            options={ASPECT_OPTIONS}
          />
        </FieldRow>
        <FieldRow label="Image name">
          <TextInput
            value={imageName}
            onValue={(v) => {
              lab.imageName = v;
            }}
            placeholder="auto from prompt"
          />
        </FieldRow>
        <FieldRow label="Prompt">
          <TextAreaInput
            value={prompt}
            onValue={(v) => {
              lab.prompt = v;
            }}
            rows={3}
            placeholder="as a storm mage atop a cliff…"
          />
        </FieldRow>
        <div className="flex items-center gap-3">
          <Button disabled={busy} onClick={() => void lab.generate()}>
            {busy ? 'Generating…' : 'Generate'}
          </Button>
          {note && <span className="text-xs text-ink-dim">{note}</span>}
        </div>
      </div>
    </Panel>
  );
}

function LabResults() {
  const { shell } = ImageLabView.get();
  const generated = (shell?.library.images ?? []).filter((i) => i.kind === 'generated');
  const urls = shell?.library.urls ?? {};
  if (generated.length === 0) {
    return (
      <EmptyState message="No generations yet." hint="Results land here and in the Gallery." />
    );
  }
  return (
    <div className="grid grid-cols-3 gap-3 overflow-y-auto p-1 xl:grid-cols-4">
      {generated.map((image) => (
        <figure key={image.id} className="flex flex-col gap-1">
          <img
            src={urls[image.id]}
            alt={image.prompt ?? 'generated'}
            className="aspect-square w-full rounded border border-edge object-cover"
          />
          <figcaption className="truncate text-[11px] text-foreground/70" title={image.prompt}>
            {image.name}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
