# Gym Glasses: the breadcrumb prototype

A mobile-first web app that makes a phone feel like a pair of smart glasses for gym newcomers. Held sideways, the rear camera shows through one wide lens inside a dark glasses frame, and the whole participant experience happens inside that view, from the first screen to the last.

Breadcrumbs are the whole product: short tips other people left at one station (the seated dumbbell shoulder press).

- **Two kinds of breadcrumb: text and audio.** Each has an author, a Loaf chip (trusted contributor), a Verified check, a Helped count and a freshness bar. They visibly go stale and drop out of view unless people keep finding them useful.
- **Everyone can read, vote, thank and add.** There are no roles and no picker: the app goes straight into the experience. Each session is anonymous and gets a made-up name like "Guest 4".
- **Useful / Not useful** votes and a **Helped me** button that opens a one-tap thank-you the tip's author can read.
- **Adding:** type a tip, or record up to 20 seconds of audio. If the microphone is blocked, "Type it and I will read it aloud" saves the words and phones speak them.
- A **survey** (HUD panels over the dimmed camera), **behavior log**, **results view** and **CSV export** for the class write-up, a **plain-text baseline** for comparison, and a hidden **admin panel** for the Fast-forward (time-skip) control.

The glasses are a picture on the phone: one continuous view, no optics, and nothing in the camera picture is recognized. There is no hologram, ghost, form feedback, pose tracking, hotspot or role in this version.

Stack: TypeScript everywhere, React + Vite, Vercel serverless functions in `/api`, Postgres on Supabase, Supabase Realtime with a 2-second polling fallback, Supabase Storage for recordings, Zod validation, Vitest.

---

## 1. Run it locally (one install, one start)

Requires Node.js 20 or newer.

```bash
npm install
npm run dev
```

Open http://localhost:5173. That is all: with no `.env.local`, the dev server starts a built-in local Postgres (PGlite, stored in `.localdb/`), runs the migrations and loads the seed automatically. The admin PIN is **2468** in this mode.

| What            | Where                               |
| --------------- | ----------------------------------- |
| Participant app | http://localhost:5173/              |
| Admin panel     | http://localhost:5173/admin         |
| Results and CSV | http://localhost:5173/admin/results |

**Testing on a real phone before deploying.** Phone cameras and microphones only work over HTTPS. Hold the phone sideways for the glasses view; upright works too, without the frame:

```bash
npm run dev:https
```

This serves on your LAN with a self-signed certificate. Open the `https://192.168.x.x:5173` address it prints on a phone on the same wifi and accept the certificate warning once.

### The two starting audio clips (edge-tts, build time only)

The seed has two audio tips, Maya and Dev. Their sound files are generated once with [edge-tts](https://github.com/rany2/edge-tts) (Microsoft's online voices) and committed. **The app never calls edge-tts or Microsoft at run time**; it only plays the two mp3 files.

```bash
npm run audio:generate     # runs scripts/generate-audio.sh
```

The script runs `pip install edge-tts`, then writes `public/audio/maya.mp3` (voice `en-US-AriaNeural`) and `public/audio/dev.mp3` (voice `en-US-GuyNeural`). Commit both files. The words it speaks are the same two scripts stored as the transcripts in `shared/seed.ts`; a unit test fails if they drift apart. If your Mac's Python refuses a plain `pip install`, run `pipx install edge-tts` once and then run the two `edge-tts` lines from the script by hand.

**The two mp3 files are not in this zip.** The environment this was built in could not reach the Microsoft speech service (`speech.platform.bing.com` did not resolve), so the script was written and run but produced nothing. Until you run it, the app reads the two transcripts aloud with the phone's own speech voice (`speechSynthesis`) and marks those cards "Read aloud by this phone". That is a temporary fallback, not the intended voices. Once the files exist the app uses them automatically; nothing else needs to change.

Other commands:

| Command                           | What it does                                                       |
| --------------------------------- | ------------------------------------------------------------------ |
| `npm test`                        | Unit and API tests (decay, ranking, voting rules, every API route) |
| `npm run typecheck`               | Strict TypeScript check, front end and back end                    |
| `npm run lint` / `npm run format` | ESLint / Prettier                                                  |
| `npm run build`                   | Production build of the front end                                  |
| `npm run db:setup`                | Migrate + seed the database in `DATABASE_URL`                      |
| `npm run db:reseed`               | Restore every seeded breadcrumb to its starting state              |
| `npm run db:reset -- --yes`       | Drop and rebuild every table (needed once on an older database)    |
| `npm run audio:generate`          | Generate the two starting audio clips with edge-tts (see below)    |
| `npm run db:backup`               | Dump every table to `backups/<timestamp>.json`                     |
| `npm run db:local:reset`          | Delete the built-in local database                                 |

---

## 2. Deploy to production (Vercel + Supabase, both free)

### Step 1. Create the database

1. Create a project at supabase.com (free tier). Save the database password.
2. In the project, click **Connect** and copy the **Transaction pooler** connection string (port 6543). This is `DATABASE_URL`.
3. In **Project Settings > API** copy the project URL, the anon (publishable) key and the service role (secret) key.
4. In **Realtime > Settings**, leave "Allow public access" on (the default). The app uses one public broadcast channel that carries no data.

### Step 2. Create the tables and seed

```bash
cp .env.example .env.local      # then paste your values into .env.local
npm run db:setup
```

You should see `Applied: 001_init.sql` and a seed line ending `6 breadcrumbs (4 text, 2 audio)`. It is safe to run again.

**If the database was created by an earlier version of this prototype** (hologram, hotspots or roles), `db:setup` stops and says so. The breadcrumb model changed too much to patch in place, so rebuild it: export the CSV or run `npm run db:backup` if you want the old data, then `npm run db:reset -- --yes`. The built-in local database rebuilds itself automatically.

**Recordings.** When `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set, recorded audio tips go to a public Supabase Storage bucket named `breadcrumb-audio`. The API creates it on the first upload with a 1 MB file limit and an audio-only type list; you can also create it yourself in the dashboard (Storage > New bucket, public, 1 MB limit). Without those variables (local dev) recordings are kept in the database and served by `/api/audio`.

### Step 3. Deploy

1. Push this folder to a new GitHub repository.
2. At vercel.com choose **Add New > Project**, import the repository. The framework is detected as Vite; `vercel.json` already sets the build and the page routing.
3. Before the first deploy, add the environment variables below under **Settings > Environment Variables** (Production and Preview).
4. Deploy. Every later `git push` redeploys the whole app (front end and API together).

### Environment variables

| Variable                    | Where it is used | Value                                              |
| --------------------------- | ---------------- | -------------------------------------------------- |
| `DATABASE_URL`              | server           | Supabase **pooled** connection string (port 6543)  |
| `SUPABASE_URL`              | server           | `https://<ref>.supabase.co` (Realtime and Storage) |
| `SUPABASE_SERVICE_ROLE_KEY` | server, secret   | service role / secret key                          |
| `VITE_SUPABASE_URL`         | browser, public  | same URL as above                                  |
| `VITE_SUPABASE_ANON_KEY`    | browser, public  | anon / publishable key                             |
| `ADMIN_PIN`                 | server, secret   | the team PIN for `/admin`                          |
| `ADMIN_TOKEN_SECRET`        | server, optional | any long random string                             |

The two `VITE_` variables are baked in at build time, so **redeploy after changing them**. If the Supabase variables are missing, the app still works and simply polls every 2 seconds.

### Step 4. Check the deployment

- Open `/admin`, enter the PIN. The header says "Live (Supabase Realtime)" when Realtime is connected, or "Live (2-second polling)" when it is not.
- Open the app on a phone, start a session, and press **+1 week** in the admin panel. The phone should show "One week later" within a second or two.
- Record a short audio tip on one phone and play it on another. This is the one path that has never run against real Supabase Storage (see section 8).

---

## 3. Admin panel

- URL: `/admin` (not linked from the participant app). Results: `/admin/results`.
- PIN: the `ADMIN_PIN` environment variable (local dev default **2468**). The PIN is exchanged for a signed token that lasts 2 hours, then the panel asks again.
- It works on a phone or a laptop. Teammates open it on their own devices.

The participant experience runs start to finish if the panel is never opened. Controls:

| Control                            | Effect                                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Fast-forward +1 day / week / month | Shifts the virtual clock for every phone. The decay rule decides what fades. Nothing is deleted.                 |
| Reset time and restore             | Clock back to now, pins cleared, every seeded breadcrumb back to its starting state, votes on them cleared.      |
| Scripted time-skip on / off        | When on, each phone plays its own "One week later" after about 20 seconds of reading tips.                       |
| Keep fresh / Make stale (per tip)  | Keep fresh holds a tip at full freshness. Make stale makes it fade out at the next fast-forward, never mid-read. |
| Loaf (per tip's author)            | Switches the author's Loaf badge, which also moves their tips up or down the ranking.                            |
| Remove participant-added tips      | Deletes tips added during sessions; the seed stays. Clips in a Supabase Storage bucket are left there.           |
| Participants and session reset     | Start survey (one phone or all), Reset session (all phones back to welcome), who has submitted.                  |
| Links and QR codes                 | Station, two tagged-group links and the plain-text baseline; tag new sessions as session 1 or 2.                 |
| Action log                         | Every action with a timestamp.                                                                                   |

The panel is deliberately plain. It lists every breadcrumb (text, then audio) with its live freshness, votes, and any thank-you notes. There are no feedback-mode controls any more. A banner appears whenever hand-steering is active (time fast-forwarded, or a pin), and sessions running at that time are flagged in the results.

### Participant links

| Link                                 | Use                                                                 |
| ------------------------------------ | ------------------------------------------------------------------- |
| `/`                                  | The full experience. No picker: it goes straight in.                |
| `/?group=novice` or `/?group=expert` | The same experience, with the session silently tagged for analysis. |
| `/?s=shoulder-press`                 | Station QR code                                                     |
| `/?baseline=1`                       | Plain-text baseline (one static tip card)                           |

`group` can be any short word (lowercase letters, digits, `-`, `_`, up to 24 characters). The participant never sees it and it changes nothing they can do; it shows up in the admin panel, the results view and the CSV. The survey also asks everyone "How experienced are you in a gym?", so you get self-reported experience whether or not you use tagged links.

A phone picks up where it left off after a refresh (including mid-survey), but only if the link still matches and the session started in the last 2 hours. Opening a different link on the same phone, for example switching it from the full version to the baseline, always starts clean.

---

## 4. Export survey data

Open `/admin/results`, enter the PIN.

- **Download CSV**: one row per participant with the group tag, prototype version, baseline flag, the admin-override flag, the logged behavior (tab opened first, tabs opened, seconds per tab, tips viewed, audio plays, seconds of audio listened to, clips finished, transcripts opened, votes cast, thanks sent, thank-you notes sent, See more used, filter used, tips added and of which kind, reacted to a Loaf-badged tip, reacted to a flagged tip, time-skip seen, which breadcrumbs faded) and one column per survey question.
- **Answers, long format**: one row per answer.
- **Raw behavior log**: every event with its timestamp and metadata.

The page also shows average scores per question (everyone, each group tag that appears in the data, baseline), counts for pick-one questions, free-text answers in a list, and a behavior table that highlights when the tab someone said they opened first differs from what the log shows.

Responses are anonymous: a session id, an optional group tag, a version, timestamps. No names or contact details are collected.

### Back up before and after each session

```bash
npm run db:backup          # writes backups/ar-gym-<timestamp>.json
```

For a full SQL dump, use Supabase's direct connection string: `pg_dump "<direct url>" > backup.sql`.

---

## 5. How decay works

Freshness is never stored as a live value and nothing loops over rows. Each breadcrumb stores `base_freshness` and `last_interaction_at`, and the current value is derived in O(1) whenever it is read (`shared/decay.ts`, used by both the server and the browser):

```
freshness = base_freshness * 0.5 ^ (elapsed / halfLife)
halfLife  = busyness half-life (quiet 14 d, normal 7 d, packed 3.5 d)
            * (1 + log2(1 + support)) / decay speed
support   = max(0, useful - not useful) + helped
```

- Useful +12, Not useful -15, Helped me +8, someone else leaving the same tip +8. Each re-bases the score and restarts the clock.
- States: **fresh** 60 and up, **fading** 35 to 60 (dimmer), **stale** 15 to 35 (grey, blurred, dashed, smaller), **gone** under 15 (collapses out of the list; still in the database).
- `elapsed` runs on the virtual clock: real time + `settings.virtual_clock_offset_seconds`. Fast-forward changes that one number.
- Pins are applied in the same calculation: `keep_fresh` reads as 100; `force_stale` reads as aged-out once any skip is in effect.
- Ranking (`rank_score`, stored and refreshed whenever a vote lands, indexed with station and kind): freshness + votes + thanks, +10 verified, +5 Loaf, -15 flagged. A flagged tip keeps its warning label and drops down the list; it is never deleted.
- Crowd control: each tab shows its top 3; **See more** reveals the rest; near-duplicate typed tips of the same kind merge into one card with "N people left this tip" (two recordings are never merged); filter chips narrow by tag. A tip posted in the last few minutes floats to the top of everyone's list.
- Audio tips decay, rank, and take votes and thanks exactly like text tips.

### The seed, and what each time-skip does to it (normal busyness)

Exactly six breadcrumbs: four text, two audio. Rehearse with this table.

| Breadcrumb                                                                  | Tab   | Start     | +1 day    | +1 week       | +1 month  |
| --------------------------------------------------------------------------- | ----- | --------- | --------- | ------------- | --------- |
| Coach Priya, "Stack your wrists right over your elbows..." (Loaf, verified) | Text  | 100 fresh | 98 fresh  | 88 fresh      | 59 fading |
| Big Rick, "Lock your elbows out hard..." (popular, flagged with a warning)  | Text  | 98 fresh  | 96 fresh  | 86 fresh      | 55 fading |
| Tomás, "Start lighter than you think..." (middling, a few votes)            | Text  | 62 fresh  | 59 fading | **44 fading** | **gone**  |
| Guest 3, "I set the bench back one notch..." (ignored and old, 0 votes)     | Text  | 28 stale  | 25 stale  | **gone**      | gone      |
| Maya, audio (Loaf, verified, fresh)                                         | Audio | 100 fresh | 98 fresh  | 88 fresh      | 59 fading |
| Dev, audio (old, 0 helped)                                                  | Audio | 45 fading | 41 fading | **23 stale**  | **gone**  |

So the Breadcrumbs button reads 6 at the start (Text 4, Audio 2); after one week Text drops to 3; after one month Text is 2 and Audio is 1. Numbers drift down slightly the longer it has been since the seed was applied (Tomás's tip starts only just "fresh"), so press **Reset time and restore** before each participant.

**The scripted skip.** After a participant has had tips on screen for 20 seconds, their phone shows "One week later" and the tips re-read against the new time. This skip belongs to that phone only, so several participants can run at once. Turn it off in the admin panel under Scripted time-skip. **Reset time and restore** also clears it on phones that are mid-session.

**Nothing on screen explains why tips fade.** The survey asks participants what they think a faded tip means, so the app shows the fading, the freshness bar (a bar only, no word) and the time passing, and stops there. The banner says only "One week later" and the list says "1 tip faded away". The one-time Loaf hint says only that Loaf "marks a trusted contributor". Keep it that way if you edit the copy, or that survey question stops measuring anything.

---

## 6. What is built

**The glasses (phone sideways)**

- **Welcome.** Dark and minimal, one button: "Put on the glasses". A one-line explanation comes first ("Your phone will ask to use its camera so you can see the room through them. Nothing is recorded or saved."), then the phone's own permission prompt, then a one-second power-on: the picture opens from a bright line, the frame fades in and the HUD boots.
- **Field of view.** The rear camera fills one wide rounded lens. Around it is a dark frame that is slightly thicker along the top, with a nose-bridge notch at the bottom center and darker temple areas left and right. One continuous view, not two lenses. Rear camera only; there is no flip.
- **Lens effects, all subtle:** a soft vignette at the rim, a faint diagonal glare, a very slight cool tint, and a thin highlight where the lens meets the frame. The middle of the view is not darkened or blurred.
- **HUD.** Translucent dark glass panels with a soft shadow and a faint glow, rounded corners, small type, little chrome. A tiny status strip in the top right corner shows a camera dot, a battery icon and the clock (the battery is the phone's real level where the browser shares it; iPhone Safari does not, so it shows full there).
- **Closed state.** Only the station label top left, a labeled **Breadcrumbs** button on the right with a loaf icon and a count, and **Finish**. The center is clear.
- **The same frame holds everything:** welcome, camera permission, the main view, adding a breadcrumb, the survey (HUD panels over the dimmed live camera, one question per screen) and the thank-you.

**Phone upright**

- No glasses frame, but everything works: full-screen camera, the same Breadcrumbs button, the panel as a bottom sheet (swipe it down or tap Close), and a small dismissible hint, "Turn your phone sideways for the glasses view". Portrait is never blocked. Turning the phone mid-session keeps your place.

**The Breadcrumbs panel**

- Sideways it slides in from the right and takes 45% of the lens, so the room stays visible on the left. A Close button is always there; tapping the room also closes it.
- Two tabs, **Text** and **Audio**, each with a count. The panel opens with neither chosen, so which tab a participant goes to first is their own choice (it is logged, and the survey asks about it).
- Filter chips (All, For beginners, Fixing my wrist), the top 3 per tab, See more, a line saying how many tips faded away, and a floating **Add** button that is always visible.
- **Text card:** tip, author, Loaf chip, Verified check, freshness bar, Helped count, Useful, Not useful, Helped me.
- **Audio card:** a large play button, a progress bar, the duration, a Show transcript toggle, plus everything the text card has. Only one clip plays at a time. Playback stops when the panel closes or the tab changes. Nothing ever plays by itself (iPhone Safari needs a tap anyway).
- **Loaf** is a labeled chip (the word plus a small loaf icon). The first time one is on screen a one-time hint explains it. Freshness is a bar only, with no loaf icon.
- **Flagged tips** carry a warning label and rank lower; they are never deleted. One is seeded (Big Rick).
- **Helped me** counts at once and opens a one-tap thank-you: three starter phrases that send with a single tap, or an optional note of up to 80 characters. Authors see the thank-yous on their own tips ("Your tip"), nobody else does, and nobody can vote on or thank their own tip.
- **Decay you can see:** a fading card dims and loses color, a stale one is grey and blurred, and a gone one collapses out of the list (hidden, not deleted).

**Adding a breadcrumb (anyone)**

- Add, then choose **Text** or **Audio**.
- Text: tappable starter phrases and a text box (140 characters), then Post.
- Audio: a big Record button (MediaRecorder), a visible countdown from 20 seconds, then listen back, Re-record, or Post. The format is picked at run time: MP4/AAC where the browser offers it (iPhone Safari), otherwise WebM/Opus (Chrome).
- The upload is checked on the server: an audio type from a short list, the first bytes of the file must really be that type, 1 MB at most, 20 seconds at most, three recordings a minute and five per session.
- Microphone blocked or recording unsupported: "Type it and I will read it aloud". The words are saved as an audio tip and every phone speaks them with browser `speechSynthesis`.
- A new breadcrumb appears at the top of everyone's panel without a reload, the Breadcrumbs button pulses and its count ticks up.

**Also built:** the plain-text baseline (a static card with three seeded text tips; no glasses, camera, panel, voting, audio or decay), the survey, the behavior log, the results view and CSV, and the admin panel.

**Removed in this version:** the hologram layer, ghost clips, the silhouette, Follow along, Rewind / Pause, pose tracking, scripted form colors, the kill switch and the flip-camera button (gone since the previous build); and now the four tappable hotspot dots, the Novice / Expert picker and roles themselves, the full-screen "turn your phone" block, and the feedback-mode leftovers in the admin panel. In the database: no `ghosts` table, no `layer`, `hotspot` or `role` column.

**Not built:** real AR anchoring, accounts, more stations, moderation of recordings, a service worker (offline support is a browser cache of the last content plus a bundled copy of the seed). The audio is two generated clips plus whatever participants record: a prototype, not an audio pipeline.

---

## 7. Choices worth knowing about

- **Realtime uses Broadcast, not table subscriptions.** After a write, the API sends one HTTP request to Supabase's Realtime broadcast endpoint; phones receive a "something changed" signal and refetch through `/api`. Row Level Security is on with no policies, so the public anon key cannot read or write any table. While Realtime is connected the phone still polls every 6 seconds as a safety net; when it is not, every 2 seconds.
- **Data model.** `breadcrumbs.kind` is `text` or `audio`. `body` is the tip, or the transcript of an audio tip. `audio_url` points at the sound file; an audio tip with no `audio_url` is read aloud from its `body`. `audio_seconds` is the clip length. `sessions.group_tag` holds the optional link tag. `audio_clips` holds recordings when no Storage bucket is configured. Check constraints enforce all of it (kind, lengths, the 1 MB cap, the type list). Other columns beyond the brief's schema, each backing a stated requirement: `sessions.completed_at`, `clock_skip_seconds`, `override_active`; `contributors.session_id`; `breadcrumbs.duplicate_count`, `is_seeded`; `helped_marks.note`; `settings.auto_skip_enabled`, `session_epoch`, `survey_*`, `prototype_version`, `content_rev`. Gym busyness and decay speed are still inputs to the decay rule (and are unit-tested) but are fixed at normal and 1x.
- **Guest names.** Every session gets a contributor row named from a database sequence ("Guest 4", "Guest 5", ...), so tips never carry a real identity. Seeded "Guest 3" is the ignored old tip.
- **Recordings are the one piece of media that leaves the phone**, and only when Post is tapped. The camera picture is still never recorded, analyzed or uploaded. A recording is a participant's voice: tell participants before the session that an audio tip can be played by everyone in the room, and empty the `breadcrumb-audio` bucket (and press "Remove participant-added breadcrumbs") when the study ends.
- **Read-aloud voices differ by phone.** `speechSynthesis` uses whatever voice the phone has, so the same read-aloud tip sounds different on an iPhone and an Android phone, and its progress bar is an estimate.
- **Thank-you notes are private to the author.** The query only returns a tip's notes when the session asking is the one that wrote it; the admin panel sees all of them.
- **No in-place upgrade from older builds.** The breadcrumb model changed (no hotspots, no roles, audio added), so an old database is rebuilt with `npm run db:reset -- --yes` instead of migrated. `db:setup` refuses to touch an old schema and says so.
- **Twelve functions.** `/api` has 12 route files, which is exactly the limit of Vercel's Hobby plan. Adding another route means merging two first.
- **Rate limiting is per function instance** (in memory): a brake on runaway clients, sized for a classroom. Durable rules are in the database: one vote and one thanks per participant per breadcrumb (unique constraints), at most 12 breadcrumbs and 5 recordings per session.
- **Local database.** PGlite is real Postgres compiled to WebAssembly, used only for `npm run dev` without a `DATABASE_URL` and for tests. Production uses postgres.js over the pooled connection.
- **Tagging session 2.** In the admin panel, under Links and QR codes, press "Tag new sessions as session 2" before the week-10 session.

---

## 8. What was tested, and what was not

Tested here:

- **110 automated tests pass** (`npm test`): the decay math and the seed table above, pins, ranking, top-3 / See more / filters / new tips on top / faded tips, duplicate hashing, the survey rules and its behavior-based branches, the behavior summary (tabs, audio plays and seconds listened), and every API route: the six seeds and their transcripts, anonymous sessions with guest names and optional group tags, one vote and one thanks per participant, thank-you notes (length cap, set once, visible only to the author, none on your own tip), posting text, uploading a recording (type list, file-header check, 1 MB cap, 20-second cap, rate limit, per-session cap), playing it back whole and in byte ranges, the read-aloud audio tip, input validation, PIN auth, time-skip without row rewrites, admin actions, results and CSV, and the refusal to run on an old schema.
- **91 checks in a headless phone-sized browser, with no console errors**, using a stand-in camera picture and the browser's fake microphone:
  - **Landscape (844 x 390):** welcome, "Put on the glasses", the power-on, the closed state (station label, Breadcrumbs button with count, Finish, nothing else), the panel at 45% of the lens with no tab preselected, both tabs, top 3 and See more, the flagged warning, voting, Helped me and a one-tap thank-you, adding a text tip, recording, listening back, re-recording and posting an audio tip, playing the stored recording, a second phone seeing the new tip arrive without a reload, the author seeing a thank-you, the scripted "One week later" after 20 seconds, Finish, the whole survey with the right follow-ups, and the thank-you screen.
  - **Portrait (390 x 844):** not blocked, full-screen camera, no frame, the dismissible "turn your phone" hint, the bottom sheet, swipe down to close, recording and posting, the survey, and turning to landscape mid-survey without losing the place.
  - **Admin and the rest:** wrong PIN refused, +1 week and +1 month reaching the phone, Reset time and restore, Keep fresh and Make stale, the Loaf toggle, the action log, session reset, the results page, the baseline (no glasses, no camera request), and camera permission denied.
  - **Five sizes** (667 x 375, 844 x 390, 932 x 430, 375 x 667, 390 x 844): 13 screens each, every control inside the view and at least 30 px, and a refresh mid-survey resuming on the same question. On the smallest sideways phone the panel takes about half the lens instead of 45%.
- **A real Postgres 16** (local, not Supabase): `db:setup`, the refusal on an old-schema database, `db:reset -- --yes`, and the landscape browser run including uploading a recording and playing it back in byte ranges.
- Typecheck, lint and the production build pass, and the zip installs, tests and builds from a clean folder.

**Tested only with stand-ins, so treat as unproven:**

- **Read-aloud speech.** The headless browser has no speech voices, so the real `speechSynthesis` call returned an error there (the card then says "Could not play this one", which is the intended handling). The read-aloud path (play, progress, stop, one at a time, "Hear it") was exercised with a stand-in speech engine. No speech was actually heard.
- **Playing the two starting clips from files.** Exercised with two plain test tones saved under the real file names, then deleted. The real mp3s have never existed (see section 1).
- **Recording.** The browser's fake microphone recorded WebM/Opus. The MP4/AAC that iPhone Safari records was only checked on the server with a stand-in file header.

**Not tested at all, so check these first:**

- **edge-tts.** The Microsoft service was unreachable from the build environment. The generation script is shipped and was run; it failed at the network step. Run `npm run audio:generate` on your Mac and listen to both clips.
- An actual Vercel deployment and a real Supabase project. Supabase Realtime was not exercised; local runs used the polling fallback (2 seconds). **Supabase Storage uploads have never run**: locally recordings go to the database instead. Record on one phone and play on another as the first thing after deploying.
- Real iPhone and Android hardware: the rear camera, the camera and microphone permission prompts, whether asking for the microphone interrupts the camera on iPhone (the app restarts the camera if it does), Safari audio with the ring switch off, whether a clip recorded in Chrome plays on an iPhone and the other way round, the notch side, and how the frame and the HUD read over a real room.
- How the glasses look on a real screen. The frame, vignette, glare and tint were judged from screenshots only.

---

## 9. Test-day checklist

1. **The day before:** open the Supabase project (free projects pause after about a week idle), open the deployed app, run `npm run db:backup`.
2. Test on the exact phones participants will use, iPhone and Android. Grant camera permission ahead of time.
3. In `/admin`: no pins, scripted time-skip on (or off if you will fast-forward by hand), then **Reset time and restore**.
4. Run `npm run audio:generate` once beforehand and redeploy, so Maya and Dev have their real voices. Check the phone is not on silent: iPhones mute web audio with the ring switch off.
5. Participants hold the phone sideways and point it at the bench. Nothing needs to line up.
6. Between participants: the thank-you screen has "Start over for the next person"; use **Reset time and restore** to undo votes on the seed.
7. If the wifi fails, the app shows saved content and says "Offline". Keep screenshots or a screen recording as a fallback.
8. Afterwards: `npm run db:backup`, then download the CSV.

**Facilitator script (same words for everyone):** "Imagine you are wearing AR glasses in a gym. For today, this phone is your glasses. Hold it sideways and point it at the bench. People before you left tips here, and you can leave one too. There are no wrong answers; we are testing the design, not you." Stay quiet, note hesitations, step in only after about 30 seconds stuck. Do not explain why tips fade until after the survey. Debrief: say plainly that the starting tips and counts were written for the study, the two starting voices were computer-generated, the glasses were a picture on the phone, and time was simulated.

---

## 10. Repository layout

```
api/            Vercel serverless functions, one file per route (12 total)
  _lib/         db, http wrapper (validation, rate limit, errors), auth, realtime, queries, seed, audio (validation + storage)
  admin/        login, actions (overrides + overview), results (JSON + CSV)
  audio.ts      plays back recordings kept in the database (local dev), with byte ranges for iPhone Safari
db/             migrations/001_init.sql (the whole schema), migrate.ts, seed.ts, reset.ts
shared/         types, decay + ranking, seed data + the two audio scripts, survey, behavior summary, text + audio limits
src/            React app: App.tsx (flow), components/ (Glasses, Scene, cards, add flow, survey), lib/ (player, recorder, ...), admin/
public/audio/   maya.mp3 and dev.mp3 go here (generated, see section 1)
scripts/        generate-audio.sh (edge-tts, build time), local-db.ts (PGlite for dev and tests), backup.ts
tests/          decay.test.ts, shared.test.ts, api.test.ts
```

Where to change things for week 10:

- Survey questions: `shared/survey.ts` (no schema change needed).
- Seed tips and the two audio scripts: `shared/seed.ts` (if you change a script, change it in `scripts/generate-audio.sh` too and regenerate). Starter phrases and limits: `shared/text.ts`. Decay numbers: the `DECAY` constant in `shared/decay.ts` (re-run `npm test`; the seed table is asserted there).
- The look of the glasses: the "The glasses" block in `src/styles.css` (frame thickness, lens radius, vignette, glare, tint are each one rule).

## Notes for the write-up

- The touch screen stands in for in-air taps; testing real air-tap interaction is future work.
- The glasses frame is a visual stand-in. It does not model field of view, focus or brightness of real AR glasses.
- Phone details handled for test day: the screen is kept awake during the main view, the camera restarts when the browser returns from the background, and the layout stays above the on-screen keyboard.
- Privacy: the camera picture is only shown, never recorded, analyzed or uploaded. Sessions are anonymous (an optional group tag, a version, timestamps), everyone posts under a made-up guest name, and thank-you notes are shown only to the tip's author. Voice recordings are stored only when a participant taps Post, and can be played by everyone using the app.
