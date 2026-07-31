import type { CardTemplate } from '../types';
import { ArcaneCard } from './ArcaneCard';
import { ArcaneFullArtCard } from './ArcaneFullArtCard';
import { ESSENCES, paletteFor } from './palette';
import { RARITIES } from './parts';

export const arcaneTemplate: CardTemplate = {
  id: 'arcane-hero',
  kitId: 'arcane',
  name: 'Arcane Hero',
  description:
    'Cartis take on a classic fantasy trading card: essence frame, ability box, might/ward.',
  fields: [
    { kind: 'text', key: 'name', label: 'Name', placeholder: 'Nyra, Ember Sage', maxLength: 28 },
    {
      kind: 'select',
      key: 'essence',
      label: 'Essence',
      options: ESSENCES.map((e) => ({ value: e.id, label: e.label })),
    },
    { kind: 'number', key: 'cost', label: 'Cost', min: 0, max: 9 },
    { kind: 'image', key: 'art', label: 'Portrait' },
    { kind: 'text', key: 'typeLine', label: 'Type line', placeholder: 'Hero — Baker' },
    { kind: 'textarea', key: 'ability', label: 'Ability', rows: 3 },
    { kind: 'textarea', key: 'flavor', label: 'Flavor text', rows: 2 },
    { kind: 'toggle', key: 'showStats', label: 'Might / Ward' },
    {
      kind: 'number',
      key: 'might',
      label: 'Might',
      min: 0,
      max: 20,
      showIf: { key: 'showStats', equals: true },
    },
    {
      kind: 'number',
      key: 'ward',
      label: 'Ward',
      min: 0,
      max: 20,
      showIf: { key: 'showStats', equals: true },
    },
    { kind: 'select', key: 'rarity', label: 'Rarity', options: RARITIES },
    {
      kind: 'select',
      key: 'foilStyle',
      label: 'Foil style',
      options: [
        { value: 'full', label: 'Full gloss' },
        { value: 'etched', label: 'Etched' },
      ],
    },
    { kind: 'text', key: 'collector', label: 'Collector line', maxLength: 40 },
  ],
  defaults: {
    name: 'Nyra, Ember Sage',
    essence: 'ember',
    cost: 3,
    typeLine: 'Hero — Pyromancer',
    ability: 'When Nyra enters play, deal 2 damage to any target.',
    flavor: '“The spark was always hers to keep.”',
    showStats: true,
    might: 2,
    ward: 3,
    rarity: 'rare',
    foilStyle: 'full',
    collector: '001/001 · Cartis Original',
  },
  artStylePrompt: (data) =>
    [
      'Fantasy oil painting portrait of the person, head and shoulders',
      paletteFor(String(data.essence ?? 'relic')).artFlavor,
      'dramatic lighting, visible canvas texture, painterly oil brushwork',
      'ornate trading card illustration',
    ].join(', '),
  Render: ArcaneCard,
};

/** Showcase variant: same fields and data, art fills the whole card. */
export const arcaneFullArtTemplate: CardTemplate = {
  ...arcaneTemplate,
  id: 'arcane-hero-fullart',
  name: 'Arcane Hero — Full Art',
  description: 'Showcase frame: the portrait fills the card, plates float translucent above it.',
  defaults: { ...arcaneTemplate.defaults, name: 'Nyra, Unbound', flavor: '' },
  Render: ArcaneFullArtCard,
};
