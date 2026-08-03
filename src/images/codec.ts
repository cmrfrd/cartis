/** Environment-neutral (browser + node/bun): used by the UI and the dev-server bridge. */

import { DataUrl, type DataUrlT } from '../contracts/ids';

/**
 * Encode bytes as a BRANDED data URL. Throws on empty bytes — an empty
 * payload is not a valid DataUrl (callers with maybe-empty sources must
 * branch and omit instead; that is the point of the brand).
 */
export function bytesToDataUrl(bytes: ArrayBuffer, type: string): DataUrlT {
  const view = new Uint8Array(bytes);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < view.length; i += chunk) {
    binary += String.fromCharCode(...view.subarray(i, i + chunk));
  }
  return DataUrl.make(`data:${type};base64,${btoa(binary)}`);
}

export function dataUrlToBytes(dataUrl: string): { bytes: ArrayBuffer; type: string } {
  const match = /^data:([^;,]+);base64,(.*)$/.exec(dataUrl);
  if (!match) throw new Error('not a base64 data url');
  const [, type = 'application/octet-stream', payload = ''] = match;
  const binary = atob(payload);
  const view = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
  return { bytes: view.buffer, type };
}
