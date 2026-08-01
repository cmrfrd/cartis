export interface Persona {
  age?: string;
  gender?: string;
  detail?: string;
  hobby?: string;
}

const STOPWORDS = new Set(
  'a an the of in on at as with and or for to from into by is are was be this that person portrait keep face recognizably same their'.split(
    ' ',
  ),
);

/** Deterministic "AI-ish" image name from a prompt: first significant words. */
export function suggestImageName(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  const picked = words.slice(0, 4);
  if (picked.length === 0) return 'generated image';
  return picked.join(' ');
}

/** Compose the template's art-style prompt with optional person details. */
export function buildPortraitPrompt(stylePrompt: string, persona: Persona): string {
  const clauses = [
    stylePrompt,
    persona.age?.trim() ? `age ${persona.age.trim()}` : '',
    persona.gender?.trim() ?? '',
    persona.detail?.trim() ? `notable detail: ${persona.detail.trim()}` : '',
    persona.hobby?.trim() ? `styled around their hobby of ${persona.hobby.trim()}` : '',
    'keep the face recognizably the same person',
  ];
  return clauses.filter((c) => c.length > 0).join(', ');
}
