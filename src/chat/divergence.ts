/**
 * Pure branch-divergence computation (maturity spec §2 step 3). The revert
 * marker cannot place the fork point reliably (it does not survive a resend),
 * so the ‹ n/m › arrows anchor on the FIRST message where some sibling's
 * history stops matching the current one, compared by (role, joined text).
 */

import { Option } from 'effect';
import type { MessageIdT } from '@/contracts/ids';
import type { ThreadMessageT } from '@/contracts/thread';

const keyOf = (m: ThreadMessageT): string =>
  `${m.role}:${m.parts.map((p) => (p._tag === 'Text' ? p.text : '')).join('')}`;

export function divergencePoint(
  current: readonly ThreadMessageT[],
  siblings: ReadonlyArray<readonly ThreadMessageT[]>,
): Option.Option<MessageIdT> {
  let earliest = -1;
  for (const sibling of siblings) {
    for (let k = 0; k < current.length; k++) {
      const a = current[k];
      const b = sibling[k];
      if (a === undefined) break;
      if (b === undefined || keyOf(a) !== keyOf(b)) {
        if (earliest < 0 || k < earliest) earliest = k;
        break;
      }
    }
  }
  const hit = earliest >= 0 ? current[earliest] : undefined;
  return hit !== undefined ? Option.some(hit.id) : Option.none();
}
