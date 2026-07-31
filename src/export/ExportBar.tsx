import { Component, get } from '@expressive/react';
import { AppShell } from '../app/AppShell';
import type { CardArchive, ExportFormat } from '../storage/CardArchive';
import { Button } from '../ui';
import { downloadBlob, exportFileName, renderCardBlob } from './exportCard';

const FORMATS: readonly ExportFormat[] = ['png', 'webp', 'jpeg'];

/** Export buttons for any card preview: downloads the file and archives the render. */
export class ExportBar extends Component {
  shell = get(AppShell, false);
  cardName = '';
  target?: () => HTMLElement | null = undefined;
  note = '';

  /** `intoArchive` is the DI seam for headless tests; context supplies the default. */
  async exportAs(format: ExportFormat, intoArchive?: CardArchive) {
    const node = this.target?.();
    if (!node) {
      this.note = 'Nothing to export yet.';
      return;
    }
    this.note = 'Rendering…';
    try {
      const blob = await renderCardBlob(node, format);
      const fileName = exportFileName(this.cardName, format);
      downloadBlob(blob, fileName);
      const archive = intoArchive ?? this.shell?.archive;
      if (archive) {
        await archive.saveExport({
          name: fileName,
          format,
          bytes: await blob.arrayBuffer(),
          type: blob.type,
        });
      }
      this.note = `Exported ${fileName} — saved to Gallery.`;
    } catch (cause) {
      this.note = cause instanceof Error ? cause.message : String(cause);
    }
  }

  render() {
    const { note } = this;
    return (
      <div className="flex flex-col items-center gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-ink-dim">Export</span>
          {FORMATS.map((format) => (
            <Button key={format} tone="ghost" onClick={() => void this.exportAs(format)}>
              {format.toUpperCase()}
            </Button>
          ))}
        </div>
        {note && <p className="text-xs text-ink-dim">{note}</p>}
      </div>
    );
  }
}
