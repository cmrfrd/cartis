import { bytesToDataUrl, dataUrlToBytes } from './codec';
import type { GenerationOutput, ImageProvider } from './provider';

/** Talks to the local bridge (dev server), which holds the REPLICATE_API_TOKEN server-side. */
export function createReplicateProvider(fetchImpl: typeof fetch = fetch): ImageProvider {
  return {
    id: 'replicate',
    async generate(input) {
      const res = await fetchImpl('/api/image/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: input.prompt,
          imageDataUrl: bytesToDataUrl(input.sourceBytes, input.sourceType),
        }),
      });
      const body = (await res.json()) as { dataUrl?: string; error?: string };
      if (!res.ok || !body.dataUrl) {
        throw new Error(body.error ?? `image bridge failed (${String(res.status)})`);
      }
      const out: GenerationOutput = dataUrlToBytes(body.dataUrl);
      return out;
    },
  };
}

export const replicateProvider: ImageProvider = createReplicateProvider();
