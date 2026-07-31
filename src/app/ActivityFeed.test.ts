import { describe, expect, it } from 'vitest';
import { ActivityFeed } from './ActivityFeed';

describe('ActivityFeed', () => {
  it('appends events, exposes the latest, and caps the feed', () => {
    const feed = ActivityFeed.new();
    feed.push({ at: 1, source: 'image', message: 'prediction created' });
    feed.push({ at: 2, source: 'agent', message: 'session created' });
    expect(feed.events).toHaveLength(2);
    expect(feed.latest?.message).toBe('session created');
    for (let i = 0; i < 210; i++) feed.push({ at: i, source: 'bridge', message: `e${i}` });
    expect(feed.events).toHaveLength(200);
    feed.set(null);
  });
});
