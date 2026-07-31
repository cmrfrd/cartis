import { Component } from '@expressive/react';
import { Spinner } from '../ui';

/**
 * File input for source photos with visible read feedback — large phone
 * photos take a beat to load, and silence reads as "nothing happened".
 */
export class PhotoPicker extends Component {
  onPhoto?: (bytes: ArrayBuffer, type: string) => void = undefined;
  reading = false;
  note = '';

  async accept(file: File) {
    this.reading = true;
    this.note = '';
    try {
      const bytes = await file.arrayBuffer();
      this.onPhoto?.(bytes, file.type || 'image/png');
    } catch (cause) {
      this.note = cause instanceof Error ? cause.message : String(cause);
    } finally {
      this.reading = false;
    }
  }

  render() {
    const { reading, note } = this;
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2.5">
          <input
            type="file"
            accept="image/*"
            disabled={reading}
            className="text-xs text-ink-dim file:mr-3 file:rounded file:border-0 file:bg-accent file:px-3 file:py-1.5 file:text-surface disabled:opacity-50"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void this.accept(file);
            }}
          />
          {reading && (
            <span className="flex items-center gap-1.5 text-xs text-ink-dim">
              <Spinner data-testid="photo-spinner" />
              Loading photo…
            </span>
          )}
        </div>
        {note && <p className="text-xs text-red-300">{note}</p>}
      </div>
    );
  }
}
