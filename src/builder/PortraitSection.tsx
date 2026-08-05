import { Component, get } from '@expressive/react';
import { Effect, Exit, Schema } from 'effect';
import { AppShell } from '@/app/AppShell';
import { runAppExit } from '@/app/runtime';
import { noteFromCause } from '@/contracts/errors';
import { AspectRatio, type AspectRatioT } from '@/contracts/fields';
import { CameraCapture } from '@/images/CameraCapture';
import { bytesToDataUrl } from '@/images/codec';
import { ImageProvider } from '@/images/ImageProvider';
import { PhotoPicker } from '@/images/PhotoPicker';
import type { ImageLibrary } from '@/storage/ImageLibrary';
import { Button, FieldRow, Panel, SelectInput, TextInput } from '@/ui';
// Deliberate module cycle with BuilderView (it renders PortraitSection) — benign, see BuilderView.tsx.
import { BuilderView } from './BuilderView';

const SOURCES = [
  { id: 'upload', label: 'Upload' },
  { id: 'camera', label: 'Webcam' },
  { id: 'library', label: 'Library' },
] as const;

/** The select's values are our own options — decode keeps the closed union honest. */
const decodeAspect = Schema.decodeUnknownSync(AspectRatio);

/** Selector labels for every AspectRatio member, auto first (the default mode). */
const ASPECT_OPTIONS: readonly { value: AspectRatioT; label: string }[] = [
  { value: 'auto', label: 'Auto (AI picks)' },
  { value: '1:1', label: 'Square 1:1' },
  { value: '4:5', label: 'Portrait 4:5' },
  { value: '3:4', label: 'Portrait 3:4' },
  { value: '2:3', label: 'Portrait 2:3' },
  { value: '9:16', label: 'Tall 9:16' },
  { value: '5:4', label: 'Landscape 5:4' },
  { value: '4:3', label: 'Landscape 4:3' },
  { value: '3:2', label: 'Landscape 3:2' },
  { value: '16:9', label: 'Wide 16:9' },
];

/**
 * Text-first art tools (spec §Builder): the default path composes art purely
 * from the layout's argument values + theme context (empty art placeholder
 * until asked); attaching a photo is the optional steering variant.
 */
export class PortraitSection extends Component {
  builder = get(BuilderView, false);
  shell = get(AppShell, false);
  fieldKey = '';
  /** 'none' = text-first (no photo attach open). */
  source: 'none' | 'upload' | 'camera' | 'library' = 'none';
  /** Optional emphasis folded into the LLM prompt composition. */
  brief = '';
  pendingBytes?: ArrayBuffer = undefined;
  pendingType = '';
  pendingPreview = '';
  busy = false;
  note = '';

  attachPhoto(bytes: ArrayBuffer, type: string) {
    this.pendingBytes = bytes;
    this.pendingType = type;
    this.pendingPreview = bytesToDataUrl(bytes, type);
    this.note = '';
  }

  applyLibraryImage(id: string) {
    this.builder?.setField(this.fieldKey, id);
    this.note = 'Applied from library.';
  }

  /** `deps` is the DI seam for headless tests; context supplies the defaults. */
  async generateArt(deps: { builder?: BuilderView; library?: ImageLibrary } = {}) {
    if (this.busy) return;
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
    const fieldKey = this.fieldKey;
    const brief = this.brief.trim();
    const bytes = this.pendingBytes;
    const sourceType = this.pendingType;
    const theme = builder.theme;
    const layout = builder.layout;
    const argumentValues: Record<string, string> = {};
    for (const field of layout.fields) {
      if (field.kind === 'image') continue;
      const v = builder.data[field.key];
      if (v !== undefined && v !== '') argumentValues[field.key] = String(v);
    }
    const themeContext = {
      lookAndFeel: theme.lookAndFeel,
      palette: theme.artFlavor?.(builder.data) ?? '',
      argumentSummary: layout.fields
        .filter((f) => f.kind !== 'image')
        .map((f) => f.key)
        .join(', '),
    };
    const styleId = builder.themeId;
    const aspectRatio = builder.resolvedArtAspect();
    const name = `${String(builder.data.name ?? 'card')} art`;
    this.busy = true;
    this.note = 'Generating art…';
    try {
      const exit = await runAppExit(
        Effect.flatMap(ImageProvider, (p) =>
          p.generate({
            sourceBytes: bytes ?? new ArrayBuffer(0),
            sourceType: bytes ? sourceType : 'application/octet-stream',
            prompt: theme.lookAndFeel,
            styleId,
            aspectRatio,
            themeContext,
            argumentValues,
            brief: brief.length > 0 ? brief : undefined,
          }),
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
        prompt: brief.length > 0 ? brief : theme.lookAndFeel,
        styleId,
        bytes: out.bytes,
        type: out.type,
      });
      builder.setField(fieldKey, stored.id);
      this.note = `Art applied (via ${out.via}).`;
    } catch (cause) {
      this.note = cause instanceof Error ? cause.message : String(cause);
    } finally {
      this.busy = false;
    }
  }

  render() {
    const { busy, note } = this;
    return (
      <Panel title="Art" className="border-accent-soft">
        <div className="flex flex-col gap-3">
          <FieldRow label="Art brief (optional)">
            <TextInput
              value={this.brief}
              onValue={(v) => {
                this.brief = v;
              }}
              placeholder="a phoenix over her shoulder"
            />
          </FieldRow>
          <FieldRow label="Aspect">
            <SelectInput
              value={this.builder?.resolvedArtAspect() ?? 'auto'}
              onValue={(v) => this.builder?.setArtAspect(decodeAspect(v))}
              options={ASPECT_OPTIONS}
            />
          </FieldRow>
          <div className="flex items-center gap-3">
            <Button disabled={busy} onClick={() => void this.generateArt()}>
              {busy ? 'Generating…' : 'Generate art'}
            </Button>
          </div>
          <ArtSourcePicker />
          {note && <p className="text-xs text-ink-dim">{note}</p>}
        </div>
      </Panel>
    );
  }
}

/** Secondary affordance: attach a photo (upload/camera) to steer, or pick from the library. */
function ArtSourcePicker() {
  const { is: section, source, pendingPreview, shell } = PortraitSection.get();
  const library = shell?.library;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] text-ink-dim uppercase tracking-wide">Attach photo (optional)</p>
      <div className="flex gap-1.5">
        {SOURCES.map((s) => (
          <Button
            key={s.id}
            tone={source === s.id ? 'accent' : 'ghost'}
            onClick={() => {
              section.source = section.source === s.id ? 'none' : s.id;
            }}
          >
            {s.label}
          </Button>
        ))}
      </div>
      {source === 'upload' && (
        <PhotoPicker onPhoto={(bytes, type) => section.attachPhoto(bytes, type)} />
      )}
      {source === 'camera' && (
        <CameraCapture onFrame={(bytes, type) => section.attachPhoto(bytes, type)} />
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
