import type { Scenario } from '../types.ts';
import { docPowers } from './doc-powers.ts';
import { persistenceReload } from './persistence-reload.ts';
import { photoCard } from './photo-card.ts';
import { smoke } from './smoke.ts';

export const scenarios: readonly Scenario[] = [smoke, photoCard, docPowers, persistenceReload];
