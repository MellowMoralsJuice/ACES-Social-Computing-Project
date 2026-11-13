/**
 * Behavior event names. The client may only send CLIENT_EVENT_TYPES; the
 * server writes the rest itself inside the routes that make them true
 * (a vote_cast event exists only if a vote really landed).
 */
export const CLIENT_EVENT_TYPES = [
  'glasses_on',
  'panel_opened',
  'panel_closed',
  'tab_opened',
  'tab_closed',
  'tip_viewed',
  'see_more_opened',
  'filter_used',
  'audio_started',
  'audio_stopped',
  'transcript_opened',
  'add_opened',
  'add_cancelled',
  'record_started',
  'record_unavailable',
  'thanks_notes_viewed',
  'loaf_hint_seen',
  'time_skip_seen',
  'breadcrumb_faded',
  'orientation_changed',
  'camera_ready',
  'camera_denied',
  'survey_started',
  'baseline_viewed',
] as const;

export const SERVER_EVENT_TYPES = [
  'session_started',
  'vote_cast',
  'helped_marked',
  'thanks_note_sent',
  'breadcrumb_added',
  'survey_submitted',
] as const;

export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];
export type ServerEventType = (typeof SERVER_EVENT_TYPES)[number];

/** Supabase Realtime channel + event used as the "something changed, refetch" signal. */
export const REALTIME_CHANNEL = 'ar-gym';
export const REALTIME_EVENT = 'changed';
