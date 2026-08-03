/**
 * Pure attachment gate (spec 2026-08-03 chat-panel-maturity §1): mime/extension
 * allowlist, size cap, and empty-mime inference — browsers report NO mime for
 * `.md` (and some `.txt`) files, and the branded MimeType rejects an empty
 * string, so the accepted mime is always inferred here before minting.
 */

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENTS = 6;

const EXTENSION_MIMES: Record<string, string> = { md: 'text/markdown', txt: 'text/plain' };

export function attachmentPolicy(
  name: string,
  mime: string,
  size: number,
): { ok: true; mime: string } | { ok: false; note: string } {
  if (size > MAX_ATTACHMENT_BYTES) {
    return { ok: false, note: `attachment too large: ${name} (max 8 MB)` };
  }
  const inferred =
    mime.length > 0 ? mime : (EXTENSION_MIMES[name.split('.').pop()?.toLowerCase() ?? ''] ?? '');
  const accepted =
    inferred.startsWith('image/') ||
    inferred.startsWith('text/') ||
    inferred === 'application/json';
  return accepted
    ? { ok: true, mime: inferred }
    : { ok: false, note: `unsupported attachment type: ${name}` };
}

/** The `accept` attribute for the composer's hidden file input (same allowlist). */
export const ATTACHMENT_ACCEPT = 'image/*,text/*,application/json,.md';

/** FileReader-to-data-URL (the data-URL doubles as the thumbnail src). */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'));
    reader.readAsDataURL(file);
  });
}
