/**
 * Types shared by the React app (/src) and the serverless API (/api).
 * Both sides import from here so the API contract cannot drift.
 */

export type PrototypeVersion = 'session_1' | 'session_2';
export type VoteValue = 'useful' | 'not_useful';
export type PinState = 'none' | 'keep_fresh' | 'force_stale';
export type Busyness = 'quiet' | 'normal' | 'packed';

/** There are two kinds of breadcrumb: a short written tip, or a short spoken one. */
export type BreadcrumbKind = 'text' | 'audio';

export interface Station {
  id: string;
  name: string;
  code: string;
}

export interface Contributor {
  id: string;
  display_name: string;
  has_loaf_badge: boolean;
  is_seeded: boolean;
}

/** The fields the decay and ranking functions need. */
export interface DecayFields {
  base_freshness: number;
  last_interaction_at: string;
  useful_count: number;
  not_useful_count: number;
  helped_count: number;
  pin_state: PinState;
}

/** One breadcrumb: a short tip, written or spoken, left at the station. */
export interface Breadcrumb extends DecayFields {
  id: string;
  station_id: string;
  kind: BreadcrumbKind;
  /** The tip itself. For an audio breadcrumb this is the transcript (it may be empty for a recorded clip). */
  body: string;
  /**
   * Where the sound is. null on a text tip, and on an audio tip that was typed to be read aloud:
   * those are spoken by the phone's own voice from `body`.
   */
  audio_url: string | null;
  /** Length of the clip in seconds (an estimate for read-aloud tips). */
  audio_seconds: number | null;
  contributor_id: string;
  created_at: string;
  is_verified: boolean;
  is_flagged: boolean;
  rank_score: number;
  tags: string[];
  text_hash: string;
  /** How many people left this same tip (near-duplicates merge into one card). */
  duplicate_count: number;
  contributor: Contributor;
  /** This participant's own vote / thanks, if any. */
  my_vote: VoteValue | null;
  my_helped: boolean;
  /** The thank-you note this participant attached, if any. */
  my_note: string | null;
  /**
   * Thank-you notes left on this tip, newest first. Only filled in for the participant who wrote the
   * tip (and for the admin panel); null for everyone else.
   */
  thanks_notes: string[] | null;
}

export interface Settings {
  virtual_clock_offset_seconds: number;
  gym_busyness: Busyness;
  /** Decay speed. 1 = normal. */
  decay_multiplier: number;
  /** Play the scripted "One week later" skip on each phone by itself. */
  auto_skip_enabled: boolean;
  /** Bumped by "New participant": every phone returns to the welcome screen. */
  session_epoch: number;
  survey_nonce: number;
  /** null = start the survey on every phone. */
  survey_session_id: string | null;
  prototype_version: PrototypeVersion;
  /** Bumped on every breadcrumb change so clients know when to refetch. */
  content_rev: number;
}

export interface SessionInfo {
  id: string;
  /** Optional tag from the link (?group=novice), so the team can split the room without a picker in the app. */
  group: string | null;
  prototype_version: PrototypeVersion;
  baseline_mode: boolean;
  created_at: string;
  /** Seconds of scripted (per-phone) time-skip this participant has seen. */
  clock_skip_seconds: number;
  /** The friendly made-up name this participant posts under ("Guest 4"). Everyone gets one. */
  contributor: Contributor;
}

/** GET /api/state — the one lightweight endpoint polled as the Realtime fallback. */
export interface StateResponse {
  settings: Settings;
  server_now: string;
  clock_skip_seconds: number;
  session_found: boolean;
}

export interface BreadcrumbsResponse {
  breadcrumbs: Breadcrumb[];
  content_rev: number;
}

export interface CreateBreadcrumbResponse {
  breadcrumb: Breadcrumb;
  /** True when the tip matched an existing one and was merged into it. */
  merged: boolean;
}

export interface BehaviorEventInput {
  event_type: string;
  breadcrumb_id?: string | null;
  metadata?: Record<string, unknown>;
  /** Client timestamp (ms since epoch); stored in metadata for ordering. */
  at?: number;
}

export interface AdminActionRow {
  id: string;
  action_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface AdminSessionRow {
  id: string;
  group: string | null;
  guest_name: string | null;
  prototype_version: PrototypeVersion;
  baseline_mode: boolean;
  created_at: string;
  completed_at: string | null;
  override_active: boolean;
  answers: number;
}

export interface AdminOverview {
  settings: Settings;
  server_now: string;
  breadcrumbs: Breadcrumb[];
  sessions: AdminSessionRow[];
  actions: AdminActionRow[];
}

/** One participant's behavior, folded from the raw event log. */
export interface BehaviorSummary {
  /** The tab (text or audio) they opened first, and every tab they opened, in order. */
  first_tab: string | null;
  tabs_opened: string[];
  /** Milliseconds each tab was on screen. */
  tab_view_ms: Record<string, number>;
  /** Distinct tips that were in their list. */
  tips_viewed: number;
  /** Times they pressed play, how many seconds they actually listened, and clips heard to the end. */
  audio_plays: number;
  audio_listened_seconds: number;
  audio_completed: number;
  transcripts_opened: number;
  votes_cast: number;
  thanks_sent: number;
  thanks_notes_sent: number;
  see_more_used: boolean;
  filter_used: boolean;
  /** Tips this participant posted, and of which kind ('text', 'audio'). */
  tips_added: number;
  added_kinds: string[];
  /** Did they vote on or thank a Loaf-badged tip, a flagged tip? */
  reacted_to_loaf: boolean;
  reacted_to_flagged: boolean;
  time_skip_seen: boolean;
  faded_breadcrumbs: string[];
}

export interface ResultsSession {
  id: string;
  group: string | null;
  prototype_version: PrototypeVersion;
  baseline_mode: boolean;
  created_at: string;
  completed_at: string | null;
  override_active: boolean;
  answers: Record<string, string>;
  behavior: BehaviorSummary;
}

export interface ResultsResponse {
  sessions: ResultsSession[];
}

export interface ApiError {
  error: { code: string; message: string };
}
