import { Component } from '@expressive/react';
import { Effect, Exit } from 'effect';
import { runAppExit } from '@/app/runtime';
import { MediaError, noteFromCause } from '@/contracts/errors';
import { Spinner } from '@/ui';

/**
 * File input for source photos with visible read feedback — large phone
 * photos take a beat to load, and silence reads as "nothing happened".
 */
export class PhotoPicker extends Component {
  onPhoto?: (bytes: ArrayBuffer, type: string) => void = undefined;
  reading = false;
  note = '';

  async accept(file: File) {
    // Snapshot reactive fields before building the effect (snapshot rule).
    const onPhoto = this.onPhoto;
    const type = file.type || 'image/png';
    this.reading = true;
    this.note = '';
    const exit = await runAppExit(
      Effect.tryPromise({
        try: () => file.arrayBuffer(),
        catch: (cause) =>
          new MediaError({
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
      }),
    );
    if (Exit.isSuccess(exit)) {
      onPhoto?.(exit.value, type);
    } else {
      this.note = noteFromCause(exit.cause);
    }
    this.reading = false;
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
        {note && <p className="text-xs text-danger">{note}</p>}
      </div>
    );
  }
}
