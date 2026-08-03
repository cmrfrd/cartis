import { Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { divergencePoint } from '@/chat/divergence';
import { MessageId } from '@/contracts/ids';
import type { ThreadMessageT } from '@/contracts/thread';

const msg = (id: string, role: 'user' | 'assistant', text: string): ThreadMessageT => ({
  id: MessageId.make(id),
  role,
  status: 'complete',
  parts: [{ _tag: 'Text', text }],
});

const base = [
  msg('u1', 'user', 'hi'),
  msg('a1', 'assistant', 'hello'),
  msg('u2', 'user', 'edit me'),
];

describe('divergencePoint', () => {
  it('identical histories → none', () => {
    expect(divergencePoint(base, [base])).toEqual(Option.none());
  });

  it('empty current → none', () => {
    expect(divergencePoint([], [base])).toEqual(Option.none());
  });

  it('sibling text differs at k → id of current[k]', () => {
    const sibling = [
      base[0] as ThreadMessageT,
      base[1] as ThreadMessageT,
      msg('u2b', 'user', 'other text'),
    ];
    expect(divergencePoint(base, [sibling])).toEqual(Option.some(MessageId.make('u2')));
  });

  it('sibling ends early at k → id of current[k]', () => {
    const sibling = [base[0] as ThreadMessageT];
    expect(divergencePoint(base, [sibling])).toEqual(Option.some(MessageId.make('a1')));
  });

  it('role differs at k → id of current[k]', () => {
    const sibling = [
      base[0] as ThreadMessageT,
      msg('x', 'user', 'hello'),
      base[2] as ThreadMessageT,
    ];
    expect(divergencePoint(base, [sibling])).toEqual(Option.some(MessageId.make('a1')));
  });

  it('multiple siblings → earliest divergence wins', () => {
    const late = [base[0] as ThreadMessageT, base[1] as ThreadMessageT, msg('y', 'user', 'zz')];
    const early = [msg('z', 'user', 'different opener')];
    expect(divergencePoint(base, [late, early])).toEqual(Option.some(MessageId.make('u1')));
  });
});
