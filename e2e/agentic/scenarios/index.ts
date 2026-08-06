import type { Scenario } from '../types.ts';
import { artStub } from './art-stub.ts';
import { cleanBreakSeed } from './clean-break-seed.ts';
import { docPowers } from './doc-powers.ts';
import { handEditsWin } from './hand-edits-win.ts';
import { persistenceReload } from './persistence-reload.ts';
import { photoCard } from './photo-card.ts';
import { smoke } from './smoke.ts';

export const scenarios: readonly Scenario[] = [
  smoke,
  photoCard,
  docPowers,
  persistenceReload,
  artStub,
  handEditsWin,
  cleanBreakSeed,
];
