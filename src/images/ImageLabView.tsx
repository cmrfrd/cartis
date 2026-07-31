import { Component, get } from '@expressive/react';
import { AppShell } from '../app/AppShell';
import { getTemplate, listTemplates } from '../cards/registry';
import type { ImageLibrary } from '../storage/ImageLibrary';
import { Button, EmptyState, FieldRow, Panel, SelectInput, TextAreaInput } from '../ui';
import { CameraCapture } from './CameraCapture';
import { bytesToDataUrl } from './codec';
import type { ImageProvider } from './provider';
import { selectImageProvider } from './provider';

export class ImageLabView extends Component {
  shell = get(AppShell, false);
  prompt = '';
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

  /** Trailing params are the DI seam for headless tests; context supplies the defaults. */
  async generate(provider?: ImageProvider, intoLibrary?: ImageLibrary) {
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
    this.busy = true;
    this.note = 'Generating…';
    try {
      const chosen = provider ?? (await selectImageProvider());
      const prompt = this.fullPrompt;
      const out = await chosen.generate({
        sourceBytes: source,
        sourceType: this.sourceType,
        prompt,
        styleId: this.styleId,
      });
      await library.add({
        kind: 'generated',
        prompt,
        styleId: this.styleId,
        bytes: out.bytes,
        type: out.type,
      });
      this.note = `Done — generated via ${chosen.id}.`;
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
          <input
            type="file"
            accept="image/*"
            className="text-xs text-ink-dim file:mr-3 file:rounded file:border-0 file:bg-accent file:px-3 file:py-1.5 file:text-surface"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              void file
                .arrayBuffer()
                .then((bytes) => lab.acceptSource(bytes, file.type || 'image/png'));
            }}
          />
        )}
        {sourcePreview && (
          <img src={sourcePreview} alt="source" className="h-28 w-28 rounded object-cover" />
        )}
      </div>
    </Panel>
  );
}

function LabControls() {
  const { is: lab, styleId, prompt, busy, note } = ImageLabView.get();
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
            }}
            options={styleOptions}
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
          <figcaption className="truncate text-[11px] text-ink-dim">{image.prompt}</figcaption>
        </figure>
      ))}
    </div>
  );
}
