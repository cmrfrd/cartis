import type { FieldSpec, Theme } from '@/cards/types';
import { LayoutId, ThemeId } from '@/contracts/ids';
import { ArcaneCard } from './ArcaneCard';
import { ArcaneCardBack } from './ArcaneCardBack';
import { ArcaneFullArtCard } from './ArcaneFullArtCard';
import { ESSENCES, paletteFor } from './palette';
import { RARITIES } from './parts';

/** Shared argument list for every Arcane layout (code reuse per spec §Layouts). */
export const arcaneFields: readonly FieldSpec[] = [
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
];

const arcaneDefaults = {
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
} as const;

export const arcaneTheme: Theme = {
  id: ThemeId.make('arcane'),
  name: 'Arcane',
  description:
    'Cartis take on a classic fantasy trading card: essence frame, ability box, might/ward.',
  lookAndFeel:
    'Fantasy oil painting, head-and-shoulders portrait subjects, dramatic lighting, ' +
    'visible canvas texture, painterly oil brushwork, ornate trading card illustration.',
  CardBack: ArcaneCardBack,
  artFlavor: (data) => paletteFor(String(data.essence ?? 'relic')).artFlavor,
  layouts: [
    {
      id: LayoutId.make('classic'),
      name: 'Arcane Hero',
      description:
        'Cartis take on a classic fantasy trading card: essence frame, ability box, might/ward.',
      fields: arcaneFields,
      defaults: { ...arcaneDefaults },
      artAspect: '3:2',
      Render: ArcaneCard,
    },
    {
      id: LayoutId.make('fullart'),
      name: 'Arcane Hero — Full Art',
      description:
        'Showcase frame: the portrait fills the card, plates float translucent above it.',
      fields: arcaneFields,
      defaults: { ...arcaneDefaults, name: 'Nyra, Unbound', flavor: '' },
      artAspect: '3:4',
      Render: ArcaneFullArtCard,
    },
  ],
};
