export interface Persona {
  age?: string;
  gender?: string;
  detail?: string;
  hobby?: string;
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
