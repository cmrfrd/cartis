import type { CardTemplate } from '../types';
import { ArcaneCard } from './ArcaneCard';
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
    { kind: 'number', key: 'might', label: 'Might', min: 0, max: 20 },
    { kind: 'number', key: 'ward', label: 'Ward', min: 0, max: 20 },
    { kind: 'select', key: 'rarity', label: 'Rarity', options: RARITIES },
  ],
  defaults: {
    name: 'Nyra, Ember Sage',
    essence: 'ember',
    cost: 3,
    typeLine: 'Hero — Pyromancer',
    ability: 'When Nyra enters play, deal 2 damage to any target.',
    flavor: '“The spark was always hers to keep.”',
    might: 2,
    ward: 3,
    rarity: 'rare',
  },
  artStylePrompt: (data) =>
    [
      'Fantasy oil painting portrait of the person, head and shoulders',
      paletteFor(String(data.essence ?? 'relic')).artFlavor,
      'dramatic lighting, painterly brushwork, ornate trading card illustration',
    ].join(', '),
  Render: ArcaneCard,
};
