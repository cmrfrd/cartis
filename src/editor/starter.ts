/** First contents of the Code Lab buffer: a compiling, editable example. */
export const STARTER_CARD_SOURCE = `import { ArcaneCard } from 'cartis/cards'

// Free-edit mode: compose card kit parts however you like.
// Available imports: cartis/cards, cartis/ui, @expressive/react
// The default export is rendered live on the right.

const data = {
  name: 'Custom Hero',
  essence: 'tide',
  cost: 4,
  typeLine: 'Hero — Inventor',
  ability: 'When Custom Hero enters play, draw a card.',
  flavor: '"Built, not born."',
  might: 3,
  ward: 4,
  rarity: 'mythic',
}

export default function MyCard() {
  return <ArcaneCard data={data} holo />
}

// Want a different frame? Subclass and override any part:
// class MyFrame extends ArcaneCard { TitleBar = () => <div>...</div> }
`;
