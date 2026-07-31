import State from '@expressive/react';

export interface ActivityEvent {
  at: number;
  source: 'agent' | 'image' | 'bridge';
  message: string;
}

const FEED_LIMIT = 200;

/** Live AI activity from the bridge's /api/activity SSE stream. */
export class ActivityFeed extends State {
  events: ActivityEvent[] = [];
  connected = false;

  get latest(): ActivityEvent | undefined {
    return this.events[this.events.length - 1];
  }

  protected new() {
    // SSE only exists in a real browser against the dev server; tests push() directly.
    if (typeof EventSource === 'undefined') return;
    const source = new EventSource('/api/activity');
    source.onopen = () => {
      this.connected = true;
    };
    source.onerror = () => {
      this.connected = false;
    };
    source.onmessage = (e) => {
      try {
        this.push(JSON.parse(e.data) as ActivityEvent);
      } catch {
        // malformed frame — ignore
      }
    };
    return () => source.close();
  }

  push(event: ActivityEvent) {
    this.events = [...this.events, event].slice(-FEED_LIMIT);
  }
}
