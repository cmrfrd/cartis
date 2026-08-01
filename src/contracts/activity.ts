/**
 * Schema contracts for the activity-feed event shape.
 *
 * Mirrored from:
 *   - src/server/activity.ts:7-13   (ActivitySource, ActivityEvent)
 *   - src/app/ActivityFeed.ts:3-7   (ActivityEvent — identical shape)
 */

import { Schema } from 'effect';

// ---------------------------------------------------------------------------
// ActivitySource
// ---------------------------------------------------------------------------

export const ActivitySource = Schema.Literal('agent', 'image', 'bridge');
export type ActivitySourceT = typeof ActivitySource.Type;

// ---------------------------------------------------------------------------
// ActivityEvent
// ---------------------------------------------------------------------------

export const ActivityEvent = Schema.Struct({
  at: Schema.Number,
  source: ActivitySource,
  message: Schema.String,
});
export type ActivityEventT = typeof ActivityEvent.Type;

// ---------------------------------------------------------------------------
// ActivityEventJson
//
// One codec used by both SSE encode and decode later.
// Schema.parseJson wraps a schema so it decodes string → struct and encodes
// struct → string in one step.
// ---------------------------------------------------------------------------

export const ActivityEventJson = Schema.parseJson(ActivityEvent);
export type ActivityEventJsonT = typeof ActivityEventJson.Type;
