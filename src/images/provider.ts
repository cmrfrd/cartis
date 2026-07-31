import { createReplicateProvider } from './replicate';
import { stubProvider } from './stub';

export interface GenerationInput {
  sourceBytes: ArrayBuffer;
  sourceType: string;
  prompt: string;
  styleId: string;
}

export interface GenerationOutput {
  bytes: ArrayBuffer;
  type: string;
}

export interface ImageProvider {
  readonly id: 'stub' | 'replicate';
  generate(input: GenerationInput): Promise<GenerationOutput>;
}

/** Ask the dev-server bridge which provider is live; without a bridge, stub. */
export async function selectImageProvider(fetchImpl: typeof fetch = fetch): Promise<ImageProvider> {
  try {
    const res = await fetchImpl('/api/status');
    const body = (await res.json()) as { image?: string };
    if (body.image === 'replicate') return createReplicateProvider(fetchImpl);
  } catch {
    // no bridge running (tests, vite preview) — offline stub it is
  }
  return stubProvider;
}
