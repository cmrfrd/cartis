import { describe, expect, it, vi } from 'vitest';
import { mount, tick } from '../../test/util';
import { PhotoPicker } from './PhotoPicker';

const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

/** File stand-in with a controllable read so the mid-read state is observable. */
function deferredFile(type: string) {
  let release: (bytes: ArrayBuffer) => void = () => {};
  const file = {
    type,
    arrayBuffer: () =>
      new Promise<ArrayBuffer>((resolve) => {
        release = resolve;
      }),
  } as unknown as File;
  return { file, release: (bytes: ArrayBuffer) => release(bytes) };
}

describe('PhotoPicker', () => {
  it('reports reading while the file loads, then delivers bytes and type', async () => {
    const onPhoto = vi.fn();
    const picker = PhotoPicker.new({ onPhoto });
    const { file, release } = deferredFile('image/jpeg');

    const pending = picker.accept(file);
    expect(picker.reading).toBe(true);
    expect(onPhoto).not.toHaveBeenCalled();

    release(bytesOf('photo'));
    await pending;
    expect(picker.reading).toBe(false);
    expect(onPhoto).toHaveBeenCalledWith(expect.any(ArrayBuffer), 'image/jpeg');
    picker.set(null);
  });

  it('clears reading and surfaces a note when the read fails', async () => {
    const onPhoto = vi.fn();
    const picker = PhotoPicker.new({ onPhoto });
    const file = {
      type: 'image/png',
      arrayBuffer: () => Promise.reject(new Error('disk hiccup')),
    } as unknown as File;

    await picker.accept(file);
    expect(picker.reading).toBe(false);
    expect(picker.note).toContain('disk hiccup');
    expect(onPhoto).not.toHaveBeenCalled();
    picker.set(null);
  });

  it('shows a spinner only while reading', async () => {
    let picker: PhotoPicker | undefined;
    const { container, unmount } = mount(
      <PhotoPicker
        is={(instance: PhotoPicker) => {
          picker = instance;
        }}
      />,
    );
    await tick();
    expect(container.querySelector('input[type="file"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="photo-spinner"]')).toBeNull();

    const { file, release } = deferredFile('image/png');
    const pending = picker?.accept(file);
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="photo-spinner"]')).not.toBeNull();
    });
    release(bytesOf('x'));
    await pending;
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="photo-spinner"]')).toBeNull();
    });
    unmount();
  });
});
