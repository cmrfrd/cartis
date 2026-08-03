import { Component, ref } from '@expressive/react';
import { Effect, Exit } from 'effect';
import { runAppExit } from '@/app/runtime';
import { MediaError, noteFromCause } from '@/contracts/errors';

/** "Lock on to a webcam, take a pic" — stream starts on mount, stops on unmount. */
export class CameraCapture extends Component {
  onFrame?: (bytes: ArrayBuffer, type: string) => void = undefined;
  error = '';
  /** DI seam for tests; defaults to the browser's device API. */
  getMedia: () => MediaDevices | undefined = () => navigator.mediaDevices;
  /** ref() callback wires the stream whenever the element attaches. */
  video = ref<HTMLVideoElement>((el) => {
    if (this.#stream) el.srcObject = this.#stream;
  });
  #stream: MediaStream | undefined;

  mount() {
    const media = this.getMedia();
    if (!media?.getUserMedia) {
      this.error = 'Camera unavailable in this environment.';
      return;
    }
    // Snapshot getMedia result before async (snapshot rule).
    const getUserMedia = media.getUserMedia.bind(media);
    void runAppExit(
      Effect.tryPromise({
        try: () => getUserMedia({ video: { facingMode: 'user' }, audio: false }),
        catch: (cause) =>
          new MediaError({
            detail: `Camera unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      }),
    ).then((exit) => {
      if (Exit.isSuccess(exit)) {
        this.#stream = exit.value;
        const el = this.video.current;
        if (el) el.srcObject = exit.value;
      } else {
        this.error = noteFromCause(exit.cause);
      }
    });
    return () => {
      for (const track of this.#stream?.getTracks() ?? []) track.stop();
    };
  }

  async capture() {
    const video = this.video.current;
    if (!video || video.videoWidth === 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/png');
    });
    if (blob) this.onFrame?.(await blob.arrayBuffer(), 'image/png');
  }

  render() {
    const { error } = this;
    if (error) {
      return <p className="rounded border border-edge p-3 text-xs text-ink-dim">{error}</p>;
    }
    return (
      <div className="flex flex-col gap-2">
        <video
          autoPlay
          muted
          playsInline
          className="aspect-video w-full rounded border border-edge bg-black object-cover"
          ref={this.video}
        />
        <button
          type="button"
          onClick={() => void this.capture()}
          className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-surface hover:brightness-110"
        >
          Take photo
        </button>
      </div>
    );
  }
}
