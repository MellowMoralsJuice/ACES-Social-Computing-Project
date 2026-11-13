-- Gym Glasses breadcrumb prototype — complete schema.
-- uuid primary keys, timestamptz everywhere, cascading foreign keys,
-- an index on every foreign key, and indexes on the ranking / decay columns.

create table stations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  code        text not null unique              -- matches the QR code
);

-- Anonymous participant record. There are no accounts or logins.
create table sessions (
  id                  uuid primary key default gen_random_uuid(),
  -- Optional tag from the link (?group=novice). Nobody picks a role in the app.
  group_tag           text check (group_tag is null or group_tag ~ '^[a-z0-9_-]{1,24}$'),
  prototype_version   text not null check (prototype_version in ('session_1', 'session_2')),
  baseline_mode       boolean not null default false,
  created_at          timestamptz not null default now(),
  completed_at        timestamptz,                         -- survey submitted
  clock_skip_seconds  integer not null default 0,          -- scripted per-phone "One week later"
  override_active     boolean not null default false       -- an admin override was live during this session
);
create index sessions_created_idx on sessions (created_at desc);

-- Seeded authors, plus one row per participant: everyone can post, under a friendly made-up name ("Guest 4").
create table contributors (
  id              uuid primary key default gen_random_uuid(),
  display_name    text not null,
  has_loaf_badge  boolean not null default false,
  is_seeded       boolean not null default false,
  session_id      uuid unique references sessions (id) on delete cascade,
  created_at      timestamptz not null default now()
);
-- Numbers the guests. Starts after the seeded "Guest 3".
create sequence guest_number_seq start 4;

-- Recorded audio when no Supabase Storage bucket is configured (local dev, tests): the clip itself.
-- With Storage configured this table stays empty and breadcrumbs.audio_url points at the bucket.
create table audio_clips (
  id          uuid primary key default gen_random_uuid(),
  mime        text not null check (mime in ('audio/mp4', 'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/aac')),
  bytes       bytea not null check (octet_length(bytes) between 1 and 1048576),   -- 1 MB cap
  created_at  timestamptz not null default now()
);

-- One breadcrumb = one short tip at a station: written (text) or spoken (audio).
create table breadcrumbs (
  id                   uuid primary key default gen_random_uuid(),
  station_id           uuid not null references stations (id) on delete cascade,
  kind                 text not null check (kind in ('text', 'audio')),
  -- The tip. For audio this is the transcript; a recorded clip may have none.
  body                 text not null check (char_length(body) <= 400),
  -- Where the sound is. null = no file: an audio tip with no file is read aloud from `body` on the phone.
  audio_url            text,
  audio_seconds        double precision check (audio_seconds is null or audio_seconds between 0 and 60),
  contributor_id       uuid not null references contributors (id) on delete cascade,
  base_freshness       double precision not null default 100 check (base_freshness between 0 and 100),
  last_interaction_at  timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  is_verified          boolean not null default false,
  is_flagged           boolean not null default false,
  helped_count         integer not null default 0 check (helped_count >= 0),
  useful_count         integer not null default 0 check (useful_count >= 0),
  not_useful_count     integer not null default 0 check (not_useful_count >= 0),
  rank_score           double precision not null default 0,   -- stored, refreshed whenever a vote lands
  tags                 text[] not null default '{}',
  text_hash            text not null,                         -- hash of normalized text (duplicate merging)
  pin_state            text not null default 'none' check (pin_state in ('none', 'keep_fresh', 'force_stale')),
  duplicate_count      integer not null default 1,            -- "N people left this tip"
  is_seeded            boolean not null default false,
  check (kind = 'audio' or (audio_url is null and audio_seconds is null)),
  check (kind = 'audio' or char_length(body) >= 1),              -- a text tip needs words
  check (audio_url is not null or char_length(body) >= 1)        -- an audio tip needs a file or words to read
);
-- Top-N per tab is an index scan with LIMIT, never an in-memory sort of everything.
create index breadcrumbs_rank_idx on breadcrumbs (station_id, kind, rank_score desc);
-- Duplicate merge is one lookup.
create index breadcrumbs_hash_idx on breadcrumbs (station_id, kind, text_hash);
-- Decay column.
create index breadcrumbs_last_interaction_idx on breadcrumbs (last_interaction_at);
create index breadcrumbs_contributor_idx on breadcrumbs (contributor_id);

create table votes (
  id             uuid primary key default gen_random_uuid(),
  breadcrumb_id  uuid not null references breadcrumbs (id) on delete cascade,
  session_id     uuid not null references sessions (id) on delete cascade,
  value          text not null check (value in ('useful', 'not_useful')),
  created_at     timestamptz not null default now(),
  unique (breadcrumb_id, session_id)            -- one vote per participant per breadcrumb
);
create index votes_session_idx on votes (session_id);

-- Backs the "Helped me" button, and the optional short thank-you note that can go with it.
create table helped_marks (
  id             uuid primary key default gen_random_uuid(),
  breadcrumb_id  uuid not null references breadcrumbs (id) on delete cascade,
  session_id     uuid not null references sessions (id) on delete cascade,
  note           text check (note is null or char_length(note) between 1 and 80),
  created_at     timestamptz not null default now(),
  unique (breadcrumb_id, session_id)
);
create index helped_marks_session_idx on helped_marks (session_id);

-- Exactly one row. The time-skip shifts virtual_clock_offset_seconds here
-- instead of rewriting breadcrumb rows.
create table settings (
  id                            boolean primary key default true check (id),
  virtual_clock_offset_seconds  integer not null default 0,
  gym_busyness                  text not null default 'normal' check (gym_busyness in ('quiet', 'normal', 'packed')),
  decay_multiplier              double precision not null default 1,
  auto_skip_enabled             boolean not null default true,
  session_epoch                 integer not null default 0,
  survey_nonce                  integer not null default 0,
  survey_session_id             uuid references sessions (id) on delete set null,
  prototype_version             text not null default 'session_1' check (prototype_version in ('session_1', 'session_2')),
  content_rev                   integer not null default 0,
  updated_at                    timestamptz not null default now()
);
create index settings_survey_session_idx on settings (survey_session_id);

-- One row per answer, so questions can change between sessions without a schema change.
create table survey_responses (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references sessions (id) on delete cascade,
  question_key  text not null,
  answer        text not null,
  created_at    timestamptz not null default now(),
  unique (session_id, question_key)             -- resubmitting replaces, never duplicates
);

create table behavior_events (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references sessions (id) on delete cascade,
  event_type     text not null,
  breadcrumb_id  uuid references breadcrumbs (id) on delete set null,
  metadata       jsonb not null default '{}',
  created_at     timestamptz not null default now()
);
create index behavior_events_session_idx on behavior_events (session_id, created_at);
create index behavior_events_breadcrumb_idx on behavior_events (breadcrumb_id);

-- Every manual override and time-skip, so hand-steered moments can be told from automatic ones.
create table admin_actions (
  id           uuid primary key default gen_random_uuid(),
  action_type  text not null,
  payload      jsonb not null default '{}',
  created_at   timestamptz not null default now()
);
create index admin_actions_created_idx on admin_actions (created_at desc);

-- Supabase: turn on Row Level Security with no policies, so the public anon
-- key cannot read or write tables directly. All data goes through /api, which
-- connects with the server-side database URL. (Harmless on plain Postgres.)
alter table stations          enable row level security;
alter table sessions          enable row level security;
alter table contributors      enable row level security;
alter table audio_clips       enable row level security;
alter table breadcrumbs       enable row level security;
alter table votes             enable row level security;
alter table helped_marks      enable row level security;
alter table settings          enable row level security;
alter table survey_responses  enable row level security;
alter table behavior_events   enable row level security;
alter table admin_actions     enable row level security;
