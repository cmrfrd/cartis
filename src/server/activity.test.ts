import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetActivityForTests,
  activityHistory,
  emitActivity,
  subscribeActivity,
} from './activity';

describe('activity bus', () => {
  beforeEach(() => {
    __resetActivityForTests();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('records history and notifies subscribers', () => {
    const seen: string[] = [];
    const stop = subscribeActivity((e) => seen.push(e.message));
    emitActivity('image', 'prediction created');
    emitActivity('agent', 'session created');
    expect(activityHistory().map((e) => e.message)).toEqual([
      'prediction created',
      'session created',
    ]);
    expect(seen).toEqual(['prediction created', 'session created']);
    stop();
    emitActivity('bridge', 'after unsubscribe');
    expect(seen).toHaveLength(2);
  });

  it('caps history at 200 events', () => {
    for (let i = 0; i < 230; i++) emitActivity('bridge', `event ${i}`);
    expect(activityHistory()).toHaveLength(200);
    expect(activityHistory()[0]?.message).toBe('event 30');
  });
});
