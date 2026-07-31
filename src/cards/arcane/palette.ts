export type EssenceId = 'ember' | 'tide' | 'verdant' | 'radiant' | 'umbral' | 'relic';

export interface EssencePalette {
  id: EssenceId;
  label: string;
  /** Outer frame gradient + border. */
  frame: string;
  /** Parchment plate behind title/type/rules text. */
  plate: string;
  plateText: string;
  /** Inner border around the art window. */
  artEdge: string;
  /** Cost pip chip. */
  pip: string;
  /** Feeds artStylePrompt for AI portrait generation. */
  artFlavor: string;
}

export const ESSENCES: readonly EssencePalette[] = [
  {
    id: 'ember',
    label: 'Ember',
    frame: 'bg-gradient-to-b from-[#4a1a10] via-[#8a3018] to-[#2a0d08] border-2 border-[#c96a3a]',
    plate: 'bg-[#f3ddba] border border-[#8a4a2a]',
    plateText: 'text-[#3a1a0d]',
    artEdge: 'border-[3px] border-[#c96a3a]',
    pip: 'bg-[#e0512d] text-[#ffe9d6]',
    artFlavor: 'warm ember tones, volcanic glow, sparks in the air',
  },
  {
    id: 'tide',
    label: 'Tide',
    frame: 'bg-gradient-to-b from-[#0e2a4a] via-[#1c4a7a] to-[#081828] border-2 border-[#4a8ac0]',
    plate: 'bg-[#dbe8f3] border border-[#2a5a8a]',
    plateText: 'text-[#0d2036]',
    artEdge: 'border-[3px] border-[#4a8ac0]',
    pip: 'bg-[#2d7ac0] text-[#dff0ff]',
    artFlavor: 'cool aquamarine light, mist and deep water reflections',
  },
  {
    id: 'verdant',
    label: 'Verdant',
    frame: 'bg-gradient-to-b from-[#12300f] via-[#2a5a20] to-[#0a1c08] border-2 border-[#6aa04a]',
    plate: 'bg-[#e2ecd2] border border-[#3a6a2a]',
    plateText: 'text-[#14300d]',
    artEdge: 'border-[3px] border-[#6aa04a]',
    pip: 'bg-[#4a8a2d] text-[#e8ffd6]',
    artFlavor: 'lush forest greens, dappled sunlight through leaves',
  },
  {
    id: 'radiant',
    label: 'Radiant',
    frame: 'bg-gradient-to-b from-[#5a5030] via-[#9a8a50] to-[#3a3018] border-2 border-[#e0d090]',
    plate: 'bg-[#f8f2dc] border border-[#8a7a4a]',
    plateText: 'text-[#3a300d]',
    artEdge: 'border-[3px] border-[#e0d090]',
    pip: 'bg-[#d8c060] text-[#3a300d]',
    artFlavor: 'golden dawn light, halos and soft radiance',
  },
  {
    id: 'umbral',
    label: 'Umbral',
    frame: 'bg-gradient-to-b from-[#241430] via-[#3a2050] to-[#120818] border-2 border-[#7a5aa0]',
    plate: 'bg-[#e0d8ea] border border-[#4a3a6a]',
    plateText: 'text-[#1c0d30]',
    artEdge: 'border-[3px] border-[#7a5aa0]',
    pip: 'bg-[#5a3a8a] text-[#eadfff]',
    artFlavor: 'violet shadows, moonlit gloom, drifting wisps',
  },
  {
    id: 'relic',
    label: 'Relic',
    frame: 'bg-gradient-to-b from-[#3a3a40] via-[#6a6a72] to-[#222228] border-2 border-[#a8a8b0]',
    plate: 'bg-[#ecece8] border border-[#5a5a62]',
    plateText: 'text-[#26262c]',
    artEdge: 'border-[3px] border-[#a8a8b0]',
    pip: 'bg-[#8a8a92] text-[#f4f4f0]',
    artFlavor: 'weathered stone and antique metal, museum lighting',
  },
];

export function paletteFor(id: string): EssencePalette {
  return ESSENCES.find((p) => p.id === id) ?? (ESSENCES[ESSENCES.length - 1] as EssencePalette);
}
