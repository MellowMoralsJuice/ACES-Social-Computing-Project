# Changelog

## Glasses redesign: text and audio breadcrumbs, no roles

The phone held sideways now looks like a pair of smart glasses, and the whole participant experience happens inside that view. Breadcrumbs come in two kinds, text and audio. Everyone can read, vote, thank and add.

### What works (run here)

- **The glasses.** Dark welcome with one button, "Put on the glasses"; a one-line explanation before the camera prompt; a one-second power-on. The rear camera shows through one wide rounded lens in a dark frame (thicker on top, nose-bridge notch, temple areas), with a soft vignette, a faint glare, a slight cool tint and a thin edge highlight. The center is clear. A tiny status strip shows a camera dot, battery and clock.
- **Closed state.** Station label ("Seated dumbbell shoulder press"), a Breadcrumbs button with a loaf icon and a count, and Finish. Nothing else.
- **Portrait.** Not blocked. Full-screen camera, the same button, the panel as a bottom sheet with swipe-down to close, and a dismissible "Turn your phone sideways for the glasses view" hint.
- **Breadcrumbs panel.** Slides in from the right at 45% of the lens. Text and Audio tabs with counts (neither is preselected), filter chips, top 3 per tab with See more, near-duplicate merging with a count, and an Add button that is always visible.
- **Text card and audio card.** Author, Loaf chip, Verified check, freshness bar, Helped count, Useful, Not useful, Helped me. The audio card adds a large play button, a progress bar, the duration and Show transcript. One clip at a time; playback stops when the panel closes or the tab changes; nothing autoplays.
- **Loaf.** A labeled chip with a one-time hint. Freshness is a bar only.
- **Flagged tip.** Warning label, lower rank, never deleted.
- **Helped me.** Counts at once and opens a one-tap thank-you (3 starters, or a note up to 80 characters). Authors see thank-yous on their own tips.
- **Decay.** Derived at read time from the virtual clock; stale tips dim, blur, then leave the list (hidden, not deleted). The unit tests are kept and extended to the audio seeds.
- **Adding, for anyone.** Text (starters, 140 characters). Audio with MediaRecorder: countdown from 20 seconds, listen back, re-record, post; the format is chosen at run time. The server checks type, file header, 1 MB, 20 seconds and rate. Microphone denied or unsupported falls back to "Type it and I will read it aloud".
- **Live.** A new breadcrumb reached a second phone without a reload (through the 2-second polling fallback here).
- **No roles.** Anonymous sessions named "Guest 4", "Guest 5", ... An optional `?group=novice` / `?group=expert` link tags the session silently. The survey asks "How experienced are you in a gym?".
- **Seed.** Exactly six: Coach Priya (text, Loaf, verified, 12 helped), Big Rick (text, 9 helped, flagged with the trainer warning), an ignored old guest tip (gone after a one-week skip), a middling tip (dims after a week, gone after a month), Maya (audio, Loaf, verified, fresh), Dev (audio, old, 0 helped, fading). Each audio seed stores its script as the transcript.
- **Baseline.** A static card with three text tips. No glasses, camera, panel, voting, audio or decay.
- **Admin panel (plain).** PIN, Fast-forward (+1 day / week / month), Reset time and restore, Keep fresh / Make stale, Loaf toggle, session reset, action log, group links and QR codes.
- **Survey (HUD panels over the dimmed camera, one per screen).** 13 or 14 screens, about 4 minutes: gym comfort, experience, first tab and why, whether the glasses view felt natural, what a faded tip means (asked before anything about time), the time-skip, trust and why, Loaf badge or warning, Helped count, the most confusing moment, one change. Follow-ups depend on behavior: posted or not, played audio or not.
- **Behavior log.** Tab opened first, seconds per tab, tips viewed, audio plays and seconds listened, clips finished, transcripts opened, votes, thank-yous, tips added and of which kind, and whether an admin override was active. All in the results view and the CSV.
- **Checks.** 110 automated tests; 91 browser checks in landscape (844 x 390) and portrait (390 x 844), plus layout at 667 x 375, 932 x 430 and 375 x 667; typecheck, lint, production build, clean-folder install.

### What could not be verified

- **The two edge-tts clips do not exist.** `scripts/generate-audio.sh` was written and run as asked. It failed because this build environment cannot reach the Microsoft speech service (`speech.platform.bing.com` did not resolve). No mp3 was produced, so none is committed. Until you run `npm run audio:generate`, the app reads Maya's and Dev's transcripts aloud with the phone's own `speechSynthesis` voice as a temporary fallback, and labels those cards "Read aloud by this phone".
- **Speech was never heard.** The headless browser has no speech voices. The read-aloud logic was exercised with a stand-in speech engine; real `speechSynthesis` returned an error there, which the app handles by saying the clip could not be played.
- **File playback of the seed clips** was exercised with two test tones under the real file names, then deleted.
- **Recording** used the browser's fake microphone and produced WebM/Opus. iPhone Safari's MP4/AAC was checked only on the server, with a stand-in file header.
- **Supabase Storage has never run.** Locally, recordings are kept in the database and served by `/api/audio`. The bucket upload code path is untested.
- A real Vercel deployment, Supabase Realtime ("live" here means the 2-second polling fallback), and any real phone: camera and microphone prompts, whether the microphone interrupts the camera on iPhone, audio with the ring switch off, cross-phone playback of recordings, and how the glasses frame looks on a real screen.

### What was removed

- The four tappable hotspot dots and everything about hotspots (markers, per-spot panels, the spot picker in the add flow).
- The Novice / Expert picker, roles, and the experts-only rule for posting.
- The full-screen "turn your phone sideways" block. Portrait now works.
- Leftovers of feedback mode in the admin panel and its tests.
- Still gone from the previous build: the hologram layer, ghost clips, the silhouette, Follow along, Rewind / Pause, pose tracking, scripted form colors, the kill switch and Flip camera.
- **Database:** no `ghosts` table, no `layer` column, no `hotspot` column, no `role` column. The schema is one clean migration again (`001_init.sql`); `002_breadcrumbs_only.sql` is deleted. A database from an older build is rebuilt with `npm run db:reset -- --yes` rather than upgraded; the local dev database rebuilds itself.
- **Survey:** the questions about spots and the role-specific questions. (Ghost, hologram, color and camera-flip questions were already gone.)
- **API and types:** `Role`, `HotspotKey`, `HOTSPOTS`, the `hotspot` request field, and the role fields in sessions, events, results and the CSV.

### Changed without being asked

- The panel opens with neither tab selected, because the survey asks which tab people opened first; a default tab would have answered it for them.
- The seeded "ignored old" tip now reads "I set the bench back one notch from fully upright." (a dumbbell bench has no seat pin), and the middling tip's votes were adjusted so it is gone, not merely stale, after a month.
- Nobody can thank their own tip (previously only voting on it was blocked in the interface).
- Vercel functions: 12 route files, exactly the Hobby limit (`/api/audio` is the new one).
