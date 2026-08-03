import { Component, get } from '@expressive/react';
import { Exit } from 'effect';
import { AppShell } from '../app/AppShell';
import { runAppExit } from '../app/runtime';
import { noteFromCause } from '../contracts/errors';
import type { CardIdT } from '../contracts/ids';
import type { CardArchive, ExportFormat } from '../storage/CardArchive';
import { Button, SelectInput } from '../ui';
import type { ExportDpi } from './exportCard';
import { downloadBlob, exportFileName, renderCardBlob, renderSheetBlob } from './exportCard';

const FORMATS: readonly ExportFormat[] = ['png', 'webp', 'jpeg'];

/** Export buttons for any card preview: downloads the file and archives the render. */
export class ExportBar extends Component {
  shell = get(AppShell, false);
  cardName = '';
  /** The saved card this preview belongs to — links renders to their card. */
  cardId?: CardIdT = undefined;
  /** The preview's ref() object — expressive data flow instead of a fetch closure. */
  target?: { current: HTMLElement | null } = undefined;
  note = '';
  dpi: ExportDpi = 300;
  bleed = false;

  async #deliver(blob: Blob, fileName: string, format: ExportFormat, intoArchive?: CardArchive) {
    downloadBlob(blob, fileName);
    const archive = intoArchive ?? this.shell?.archive;
    if (archive) {
      await archive.saveExport({
        name: fileName,
        format,
        bytes: await blob.arrayBuffer(),
        type: blob.type,
        cardId: this.cardId,
      });
    }
    this.note = `Exported ${fileName} — saved to Gallery.`;
  }

  /** `intoArchive` is the DI seam for headless tests; context supplies the default. */
  async exportAs(format: ExportFormat, intoArchive?: CardArchive) {
    const node = this.target?.current ?? null;
    if (!node) {
      this.note = 'Nothing to export yet.';
      return;
    }
    // Snapshot reactive fields before building the effect (snapshot rule).
    const cardName = this.cardName;
    const dpi = this.dpi;
    const bleed = this.bleed;
    this.note = 'Rendering…';
    const exit = await runAppExit(renderCardBlob(node, format, { dpi, bleed }));
    if (Exit.isFailure(exit)) {
      this.note = noteFromCause(exit.cause);
      return;
    }
    const blob = exit.value;
    const suffix = `${dpi === 600 ? '-600dpi' : ''}${bleed ? '-bleed' : ''}`;
    try {
      await this.#deliver(blob, exportFileName(cardName + suffix, format), format, intoArchive);
    } catch (cause) {
      this.note = cause instanceof Error ? cause.message : String(cause);
    }
  }

  /** 3×3 cut sheet on A4 at 300 DPI. */
  async exportSheet(intoArchive?: CardArchive) {
    const node = this.target?.current ?? null;
    if (!node) {
      this.note = 'Nothing to export yet.';
      return;
    }
    // Snapshot reactive fields before building the effect (snapshot rule).
    const cardName = this.cardName;
    this.note = 'Rendering sheet…';
    const exit = await runAppExit(renderSheetBlob(node));
    if (Exit.isFailure(exit)) {
      this.note = noteFromCause(exit.cause);
      return;
    }
    const blob = exit.value;
    try {
      await this.#deliver(blob, exportFileName(`${cardName}-sheet`, 'png'), 'png', intoArchive);
    } catch (cause) {
      this.note = cause instanceof Error ? cause.message : String(cause);
    }
  }

  render() {
    const { note, dpi, bleed } = this;
    return (
      <div className="flex flex-col items-center gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-ink-dim">Export</span>
          {FORMATS.map((format) => (
            <Button key={format} tone="ghost" onClick={() => void this.exportAs(format)}>
              {format.toUpperCase()}
            </Button>
          ))}
          <Button tone="ghost" onClick={() => void this.exportSheet()}>
            Sheet 3×3
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-28">
            <SelectInput
              value={String(dpi)}
              onValue={(v) => {
                this.dpi = v === '600' ? 600 : 300;
              }}
              options={[
                { value: '300', label: '300 DPI' },
                { value: '600', label: '600 DPI' },
              ]}
            />
          </div>
          <Button
            tone={bleed ? 'accent' : 'ghost'}
            onClick={() => {
              this.bleed = !this.bleed;
            }}
          >
            {bleed ? 'Bleed + marks: on' : 'Bleed + marks: off'}
          </Button>
        </div>
        {note && <p className="text-xs text-ink-dim">{note}</p>}
      </div>
    );
  }
}
