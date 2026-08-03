import { describe, expect, it } from 'vitest';
import { attachmentPolicy, MAX_ATTACHMENT_BYTES } from '@/chat/attachments';

describe('attachmentPolicy', () => {
  it.each([
    ['photo.png', 'image/png', 1024, 'image/png'],
    ['notes.md', '', 1024, 'text/markdown'], // empty-mime inference (browsers give .md no mime)
    ['lore.txt', 'text/plain', 1024, 'text/plain'],
    ['stats.json', 'application/json', 1024, 'application/json'],
  ])('accepts %s as %s', (name, mime, size, expectedMime) => {
    expect(attachmentPolicy(name, mime, size)).toEqual({ ok: true, mime: expectedMime });
  });

  it('rejects unsupported types with a naming note', () => {
    expect(attachmentPolicy('art.psd', '', 10)).toEqual({
      ok: false,
      note: 'unsupported attachment type: art.psd',
    });
    expect(attachmentPolicy('bundle.zip', 'application/zip', 10)).toEqual({
      ok: false,
      note: 'unsupported attachment type: bundle.zip',
    });
  });

  it('rejects oversized files (even accepted types)', () => {
    expect(attachmentPolicy('big.png', 'image/png', MAX_ATTACHMENT_BYTES + 1)).toEqual({
      ok: false,
      note: 'attachment too large: big.png (max 8 MB)',
    });
  });
});
