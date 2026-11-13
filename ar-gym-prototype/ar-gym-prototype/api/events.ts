/**
 * POST /api/events  { session_id, events: [{ event_type, breadcrumb_id?, metadata?, at? }] }
 *
 * Behavior logging. The phone batches events and flushes every few seconds.
 * Only client-observable event types are accepted here; events that assert a
 * server fact (a vote landed, a tip was added) are written by those routes.
 * The participant's group tag (if their link had one) is read from the session row and stamped on each event.
 */
import { z } from 'zod';
import { CLIENT_EVENT_TYPES } from '../shared/events.js';
import { getDb } from './_lib/db.js';
import { rateLimit, route } from './_lib/http.js';
import { requireSession, uuid } from './_lib/repo.js';

const MAX_METADATA_BYTES = 1200;

const Body = z.object({
  session_id: uuid,
  events: z
    .array(
      z.object({
        event_type: z.enum(CLIENT_EVENT_TYPES),
        breadcrumb_id: uuid.nullable().optional(),
        metadata: z.record(z.string(), z.unknown()).optional().default({}),
        at: z.number().optional(),
      }),
    )
    .min(1)
    .max(40),
});

export default route('events', {
  POST: async (ctx) => {
    const input = Body.parse(ctx.body);
    const db = getDb();
    const session = await requireSession(db, input.session_id);
    rateLimit(`events:${session.id}`, 60, 60_000);

    // One multi-row insert for the whole batch.
    const payload = input.events.map((event) => {
      let metadata: Record<string, unknown> = { ...event.metadata, group: session.group };
      if (typeof event.at === 'number') metadata.client_at = event.at;
      if (JSON.stringify(metadata).length > MAX_METADATA_BYTES) metadata = { group: session.group, truncated: true };
      return { event_type: event.event_type, breadcrumb_id: event.breadcrumb_id ?? null, metadata };
    });
    await db.query(
      `insert into behavior_events (session_id, event_type, breadcrumb_id, metadata, created_at)
       select $1::uuid, e->>'event_type',
              (select b.id from breadcrumbs b where b.id = (e->>'breadcrumb_id')::uuid),
              e->'metadata',
              now() + (ordinality * interval '1 microsecond')
         from jsonb_array_elements(($2::text)::jsonb) with ordinality as t(e, ordinality)`,
      [session.id, JSON.stringify(payload)],
    );
    return { saved: payload.length };
  },
});
