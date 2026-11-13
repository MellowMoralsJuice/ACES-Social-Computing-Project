/**
 * Folds one participant's raw behavior_events into the summary shown in the
 * results view and the CSV export. Pure, single pass, O(events).
 */
import type { BehaviorSummary } from './types.js';

export interface RawEvent {
  event_type: string;
  breadcrumb_id: string | null;
  metadata: Record<string, unknown>;
}

export function summarizeBehavior(events: RawEvent[]): BehaviorSummary {
  const s: BehaviorSummary = {
    first_tab: null,
    tabs_opened: [],
    tab_view_ms: {},
    tips_viewed: 0,
    audio_plays: 0,
    audio_listened_seconds: 0,
    audio_completed: 0,
    transcripts_opened: 0,
    votes_cast: 0,
    thanks_sent: 0,
    thanks_notes_sent: 0,
    see_more_used: false,
    filter_used: false,
    tips_added: 0,
    added_kinds: [],
    reacted_to_loaf: false,
    reacted_to_flagged: false,
    time_skip_seen: false,
    faded_breadcrumbs: [],
  };
  const faded = new Set<string>();
  const viewed = new Set<string>();
  let listenedMs = 0;

  for (const e of events) {
    const m = e.metadata ?? {};
    const tab = typeof m.tab === 'string' ? m.tab : null;
    switch (e.event_type) {
      case 'tab_opened':
        if (tab) {
          if (!s.first_tab) s.first_tab = tab;
          if (!s.tabs_opened.includes(tab)) s.tabs_opened.push(tab);
        }
        break;
      case 'tab_closed':
        if (tab && typeof m.duration_ms === 'number') s.tab_view_ms[tab] = (s.tab_view_ms[tab] ?? 0) + Math.max(0, m.duration_ms);
        break;
      case 'tip_viewed':
        if (e.breadcrumb_id) viewed.add(e.breadcrumb_id);
        break;
      case 'audio_started':
        s.audio_plays += 1;
        break;
      case 'audio_stopped':
        if (typeof m.listened_ms === 'number') listenedMs += Math.max(0, m.listened_ms);
        if (m.completed === true) s.audio_completed += 1;
        break;
      case 'transcript_opened':
        s.transcripts_opened += 1;
        break;
      case 'vote_cast':
      case 'helped_marked':
        if (e.event_type === 'vote_cast') s.votes_cast += 1;
        else s.thanks_sent += 1;
        if (m.loaf === true) s.reacted_to_loaf = true;
        if (m.flagged === true) s.reacted_to_flagged = true;
        break;
      case 'thanks_note_sent':
        s.thanks_notes_sent += 1;
        break;
      case 'see_more_opened':
        s.see_more_used = true;
        break;
      case 'filter_used':
        if (m.tag !== 'all') s.filter_used = true;
        break;
      case 'breadcrumb_added':
        s.tips_added += 1;
        if (typeof m.kind === 'string' && !s.added_kinds.includes(m.kind)) s.added_kinds.push(m.kind);
        break;
      case 'time_skip_seen':
        s.time_skip_seen = true;
        break;
      case 'breadcrumb_faded':
        if (e.breadcrumb_id) faded.add(typeof m.label === 'string' ? m.label : e.breadcrumb_id);
        break;
      default:
        break;
    }
  }

  s.tips_viewed = viewed.size;
  s.audio_listened_seconds = Math.round(listenedMs / 1000);
  s.faded_breadcrumbs = [...faded];
  return s;
}
