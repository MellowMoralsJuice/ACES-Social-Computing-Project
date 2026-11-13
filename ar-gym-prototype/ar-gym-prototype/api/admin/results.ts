/**
 * GET /api/admin/results               -> JSON for the team results view
 * GET /api/admin/results?format=csv    -> one row per participant: survey answers + logged behavior
 * GET /api/admin/results?format=csv&kind=events     -> the raw behavior log
 * GET /api/admin/results?format=csv&kind=responses  -> one row per answer (long format)
 */
import { z } from 'zod';
import { summarizeBehavior, type RawEvent } from '../../shared/behavior.js';
import { SURVEY_KEYS } from '../../shared/survey.js';
import type { ResultsResponse, ResultsSession } from '../../shared/types.js';
import { requireAdmin } from '../_lib/auth.js';
import { getDb, type Db } from '../_lib/db.js';
import { RawResponse, route } from '../_lib/http.js';

/** Byte-order mark so Excel reads the CSV as UTF-8. */
const BOM = String.fromCharCode(0xfeff);
const MAX_SESSIONS = 1000;
const MAX_EVENTS = 50_000;

/** Quote a CSV cell, and defuse cells a spreadsheet would run as a formula. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = Array.isArray(value) ? value.join('; ') : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

async function loadResults(db: Db): Promise<ResultsResponse> {
  const sessionRows = await db.query(
    `select id, group_tag, prototype_version, baseline_mode, created_at, completed_at, override_active
       from sessions order by created_at desc limit $1`,
    [MAX_SESSIONS],
  );
  const answerRows = await db.query('select session_id, question_key, answer from survey_responses');
  // Ordered by the (session_id, created_at) index, so each session's events arrive together and in order.
  const eventRows = await db.query(
    `select session_id, event_type, breadcrumb_id, metadata from behavior_events
      order by session_id, created_at limit $1`,
    [MAX_EVENTS],
  );

  const answers = new Map<string, Record<string, string>>();
  for (const r of answerRows) {
    const id = String(r.session_id);
    if (!answers.has(id)) answers.set(id, {});
    answers.get(id)![String(r.question_key)] = String(r.answer);
  }
  const events = new Map<string, RawEvent[]>();
  for (const r of eventRows) {
    const id = String(r.session_id);
    if (!events.has(id)) events.set(id, []);
    events.get(id)!.push({
      event_type: String(r.event_type),
      breadcrumb_id: (r.breadcrumb_id as string | null) ?? null,
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
    });
  }

  const sessions: ResultsSession[] = sessionRows.map((r) => {
    const id = String(r.id);
    return {
      id,
      group: (r.group_tag as string | null) ?? null,
      prototype_version: r.prototype_version as ResultsSession['prototype_version'],
      baseline_mode: Boolean(r.baseline_mode),
      created_at: new Date(r.created_at as string).toISOString(),
      completed_at: r.completed_at ? new Date(r.completed_at as string).toISOString() : null,
      override_active: Boolean(r.override_active),
      answers: answers.get(id) ?? {},
      behavior: summarizeBehavior(events.get(id) ?? []),
    };
  });
  return { sessions };
}

function sessionsCsv(results: ResultsResponse): string {
  const header = [
    'session_id',
    'created_at',
    'survey_completed_at',
    'group',
    'prototype_version',
    'baseline_mode',
    'admin_override_active',
    'first_tab_opened',
    'tabs_opened',
    'text_tab_seconds',
    'audio_tab_seconds',
    'tips_viewed',
    'audio_plays',
    'audio_seconds_listened',
    'audio_clips_finished',
    'transcripts_opened',
    'votes_cast',
    'thanks_sent',
    'thanks_notes_sent',
    'see_more_used',
    'filter_used',
    'tips_added',
    'added_kinds',
    'reacted_to_loaf_tip',
    'reacted_to_flagged_tip',
    'time_skip_seen',
    'faded_breadcrumbs',
    ...SURVEY_KEYS,
  ];
  const rows = results.sessions.map((s) => {
    const b = s.behavior;
    return [
      s.id,
      s.created_at,
      s.completed_at,
      s.group ?? '',
      s.prototype_version,
      s.baseline_mode,
      s.override_active,
      b.first_tab,
      b.tabs_opened,
      Math.round((b.tab_view_ms.text ?? 0) / 1000),
      Math.round((b.tab_view_ms.audio ?? 0) / 1000),
      b.tips_viewed,
      b.audio_plays,
      b.audio_listened_seconds,
      b.audio_completed,
      b.transcripts_opened,
      b.votes_cast,
      b.thanks_sent,
      b.thanks_notes_sent,
      b.see_more_used,
      b.filter_used,
      b.tips_added,
      b.added_kinds,
      b.reacted_to_loaf,
      b.reacted_to_flagged,
      b.time_skip_seen,
      b.faded_breadcrumbs,
      ...SURVEY_KEYS.map((key) => s.answers[key] ?? ''),
    ];
  });
  return toCsv(header, rows);
}

async function eventsCsv(db: Db): Promise<string> {
  const rows = await db.query(
    `select e.created_at, e.session_id, s.group_tag, s.prototype_version, s.baseline_mode, e.event_type,
            e.breadcrumb_id, e.metadata
       from behavior_events e join sessions s on s.id = e.session_id
      order by e.session_id, e.created_at limit $1`,
    [MAX_EVENTS],
  );
  return toCsv(
    ['created_at', 'session_id', 'group', 'prototype_version', 'baseline_mode', 'event_type', 'breadcrumb_id', 'metadata'],
    rows.map((r) => [
      new Date(r.created_at as string).toISOString(),
      r.session_id,
      r.group_tag ?? '',
      r.prototype_version,
      r.baseline_mode,
      r.event_type,
      r.breadcrumb_id,
      r.metadata,
    ]),
  );
}

async function responsesCsv(db: Db): Promise<string> {
  const rows = await db.query(
    `select r.created_at, r.session_id, s.group_tag, s.prototype_version, s.baseline_mode, s.override_active,
            r.question_key, r.answer
       from survey_responses r join sessions s on s.id = r.session_id
      order by r.session_id, r.created_at limit $1`,
    [MAX_EVENTS],
  );
  return toCsv(
    ['created_at', 'session_id', 'group', 'prototype_version', 'baseline_mode', 'admin_override_active', 'question_key', 'answer'],
    rows.map((r) => [
      new Date(r.created_at as string).toISOString(),
      r.session_id,
      r.group_tag ?? '',
      r.prototype_version,
      r.baseline_mode,
      r.override_active,
      r.question_key,
      r.answer,
    ]),
  );
}

export default route('admin-results', {
  GET: async (ctx) => {
    requireAdmin(ctx);
    const db = getDb();
    const format = z.enum(['json', 'csv']).parse(ctx.query.get('format') ?? 'json');
    if (format === 'json') return loadResults(db);

    const kind = z.enum(['sessions', 'events', 'responses']).parse(ctx.query.get('kind') ?? 'sessions');
    const body =
      kind === 'events' ? await eventsCsv(db) : kind === 'responses' ? await responsesCsv(db) : sessionsCsv(await loadResults(db));
    const stamp = new Date().toISOString().slice(0, 10);
    return new RawResponse('text/csv; charset=utf-8', `${BOM}${body}`, {
      'Content-Disposition': `attachment; filename="ar-gym-${kind}-${stamp}.csv"`,
    });
  },
});
