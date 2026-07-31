/**
 * Bridge activity bus: every AI action (agent, image gen) emits here, the
 * browser subscribes via SSE (/api/activity), and everything mirrors to the
 * dev-server terminal. In-memory only — history dies with the server.
 */

export type ActivitySource = 'agent' | 'image' | 'bridge';

export interface ActivityEvent {
  at: number;
  source: ActivitySource;
  message: string;
}

const HISTORY_LIMIT = 200;
const history: ActivityEvent[] = [];
const subscribers = new Set<(event: ActivityEvent) => void>();

export function emitActivity(source: ActivitySource, message: string): void {
  const event: ActivityEvent = { at: Date.now(), source, message };
  history.push(event);
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
  console.log(`[cartis:${source}] ${message}`);
  for (const notify of subscribers) notify(event);
}

export function activityHistory(): readonly ActivityEvent[] {
  return history;
}

export function subscribeActivity(notify: (event: ActivityEvent) => void): () => void {
  subscribers.add(notify);
  return () => subscribers.delete(notify);
}

export function __resetActivityForTests(): void {
  history.length = 0;
  subscribers.clear();
}
