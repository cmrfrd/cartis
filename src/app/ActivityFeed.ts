import State from '@expressive/react';
import { Effect, Fiber, Stream } from 'effect';
import { ActivityClient, FeedSignal } from './ActivityClient';
import { forkApp } from './runtime';

export interface ActivityEvent {
  at: number;
  source: 'agent' | 'image' | 'bridge';
  message: string;
}

const FEED_LIMIT = 200;

const matchSignal = FeedSignal.$match;

/** Live AI activity from the bridge's /api/activity SSE stream. */
export class ActivityFeed extends State {
  events: ActivityEvent[] = [];
  connected = false;

  get latest(): ActivityEvent | undefined {
    return this.events[this.events.length - 1];
  }

  protected new() {
    // Consume the ActivityClient stream on the app runtime. The Effect.sync
    // callback mirrors today's onopen/onerror/onmessage — event-handler-style
    // writes to `this` are the sanctioned exception to the snapshot rule.
    const fiber = forkApp(
      Effect.flatMap(ActivityClient, (client) =>
        Stream.runForEach(client.signals, (signal) =>
          Effect.sync(() => {
            matchSignal(signal, {
              Connected: () => {
                this.connected = true;
              },
              Disconnected: () => {
                this.connected = false;
              },
              Event: ({ event }) => {
                this.push(event);
              },
            });
          }),
        ),
      ),
    );
    return () => void forkApp(Fiber.interrupt(fiber));
  }

  push(event: ActivityEvent) {
    this.events = [...this.events, event].slice(-FEED_LIMIT);
  }
}
