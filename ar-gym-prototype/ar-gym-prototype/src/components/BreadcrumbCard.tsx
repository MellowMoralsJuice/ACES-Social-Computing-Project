/**
 * One breadcrumb card.
 *
 * Text card: the tip, who left it, the Loaf chip, the Verified check, a
 * freshness bar, how many people it helped, and the three reactions
 * (Useful, Not useful, Helped me).
 *
 * Audio card: a large play button, a progress bar, the duration and a
 * Show transcript toggle, plus everything the text card has. Audio never
 * starts by itself; only one clip plays at a time (see lib/player).
 *
 * The card itself shows how stale it is: as freshness drops it dims, loses
 * color and blurs slightly, then collapses out of the list when it passes the
 * "gone" threshold (hidden, never deleted).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FLAG_WARNING } from '../../shared/seed';
import { THANKS_MAX_LENGTH, THANKS_STARTERS } from '../../shared/text';
import type { VoteValue } from '../../shared/types';
import { clockLabel, type CrumbView } from '../lib/crumbs';
import { buzz } from '../lib/feedback';
import { usePlayer, usesSpeech } from '../lib/player';
import {
  IconCheck,
  IconChevron,
  IconHeart,
  IconLoaf,
  IconPause,
  IconPlay,
  IconThumbDown,
  IconThumbUp,
  IconVerified,
  IconWarning,
} from './Icons';

interface Props {
  view: CrumbView;
  highlighted: boolean;
  onVote: (value: VoteValue) => void;
  /** Helped me, optionally with a note (also used to add a note after a thanks). */
  onHelped: (note?: string) => void;
  onPlayToggle: () => void;
  onTranscript: (open: boolean) => void;
  onNotesSeen: () => void;
}

/** A number that gives a small tick when it changes (and only then, not every time the card appears). */
function Tick({ value, className, children }: { value: number; className: string; children: ReactNode }) {
  const previous = useRef(value);
  const [ticking, setTicking] = useState(false);
  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    setTicking(true);
    const timer = window.setTimeout(() => setTicking(false), 400);
    return () => window.clearTimeout(timer);
  }, [value]);
  return <b className={`${className}${ticking ? ' tick' : ''}`}>{children}</b>;
}

/**
 * Freshness is a bar and nothing else: no word, no picture. Its length is the
 * freshness, so it does not depend on color. When a vote or a thank-you moves
 * the value the bar gives a short bump (up) or dip (down), so the link between
 * reacting and freshness is shown rather than explained.
 */
export function FreshnessBar({ freshness, state }: { freshness: number; state: CrumbView['state'] }) {
  const previous = useRef(freshness);
  const [nudge, setNudge] = useState<'up' | 'down' | null>(null);

  useEffect(() => {
    const change = freshness - previous.current;
    previous.current = freshness;
    // Slow decay moves the value by fractions; only a real jump (a vote, a time-skip) animates.
    if (Math.abs(change) < 3) return;
    setNudge(change > 0 ? 'up' : 'down');
    const timer = window.setTimeout(() => setNudge(null), 900);
    return () => window.clearTimeout(timer);
  }, [freshness]);

  return (
    <span
      className={`freshness freshness-${state}${nudge ? ` is-${nudge}` : ''}`}
      role="meter"
      aria-label="Freshness"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(freshness)}
    >
      <span className="freshness-bar" aria-hidden="true">
        <span style={{ width: `${Math.max(4, Math.round(freshness))}%` }} />
      </span>
    </span>
  );
}

export function AuthorLine({ view }: { view: CrumbView }) {
  const { crumb } = view;
  return (
    <div className="crumb-meta">
      <span className="author">{crumb.contributor.display_name}</span>
      {crumb.contributor.has_loaf_badge && (
        <span className="pill pill-loaf">
          <IconLoaf size={14} />
          Loaf<span className="sr-only"> badge, trusted contributor</span>
        </span>
      )}
      {crumb.is_verified && (
        <span className="pill pill-verified">
          <IconVerified size={14} />
          Verified
        </span>
      )}
      {crumb.thanks_notes !== null && <span className="pill pill-mine">Your tip</span>}
      {view.isNew && crumb.thanks_notes === null && <span className="pill pill-new">New</span>}
    </div>
  );
}

function helpedText(count: number): string {
  if (count === 0) return 'Helped 0 people so far';
  return `Helped ${count} ${count === 1 ? 'person' : 'people'}`;
}

/**
 * After "Helped me": a one-tap thank-you. Each starter phrase sends with a
 * single tap; a few typed words are optional.
 */
function ThanksNote({ onSend, onSkip }: { onSend: (note: string) => void; onSkip: () => void }) {
  const [note, setNote] = useState('');
  const trimmed = note.trim();
  return (
    <div className="thanks-note">
      <p className="field-label">Send a thank-you? One tap:</p>
      <div className="starter-list">
        {THANKS_STARTERS.map((phrase) => (
          <button key={phrase} type="button" className="chip chip-starter" onClick={() => (buzz(18), onSend(phrase))}>
            {phrase}
          </button>
        ))}
      </div>
      <div className="note-row">
        <label className="note-field">
          <span className="sr-only">Your own thank-you note (optional)</span>
          <input
            type="text"
            value={note}
            maxLength={THANKS_MAX_LENGTH}
            placeholder="Or write your own (optional)"
            enterKeyHint="send"
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && trimmed) onSend(trimmed);
            }}
          />
          <span className="field-count">
            {note.length}/{THANKS_MAX_LENGTH}
          </span>
        </label>
        {trimmed ? (
          <button type="button" className="btn btn-primary btn-small" onClick={() => (buzz(18), onSend(trimmed))}>
            Send
          </button>
        ) : (
          <button type="button" className="btn btn-quiet btn-small" onClick={() => (buzz(), onSkip())}>
            No note
          </button>
        )}
      </div>
    </div>
  );
}

/** The player row of an audio card. */
function AudioRow({ view, onPlayToggle }: { view: CrumbView; onPlayToggle: () => void }) {
  const { crumb } = view;
  const player = usePlayer();
  const loaded = player.id === crumb.id;
  const playing = loaded && player.playing;
  const total = loaded && player.duration > 0 ? player.duration : (crumb.audio_seconds ?? Math.max(2, crumb.body.length / 14));
  const elapsed = loaded ? player.elapsed : 0;
  const failed = player.failedId === crumb.id;
  const speech = usesSpeech(crumb);

  return (
    <div className="audio-row">
      <button
        type="button"
        className={`play${playing ? ' is-playing' : ''}`}
        aria-label={playing ? 'Pause' : 'Play'}
        tabIndex={view.state === 'gone' ? -1 : 0}
        onClick={() => (buzz(18), onPlayToggle())}
      >
        {playing ? <IconPause size={26} /> : <IconPlay size={26} />}
      </button>
      <div className="audio-main">
        <div
          className="audio-bar"
          role="progressbar"
          aria-label="Playback"
          aria-valuemin={0}
          aria-valuemax={Math.round(total)}
          aria-valuenow={Math.round(elapsed)}
        >
          <span style={{ width: `${total > 0 ? Math.min(100, (elapsed / total) * 100) : 0}%` }} />
        </div>
        <div className="audio-times">
          <span>{failed ? 'Could not play this one' : loaded ? `${clockLabel(elapsed)} / ${clockLabel(total)}` : clockLabel(total)}</span>
          {speech && !failed && <span className="audio-voice">Read aloud by this phone</span>}
        </div>
      </div>
    </div>
  );
}

export function BreadcrumbCard({ view, highlighted, onVote, onHelped, onPlayToggle, onTranscript, onNotesSeen }: Props) {
  const { crumb, state, freshness } = view;
  const isAudio = crumb.kind === 'audio';
  const classes = ['crumb', `crumb-${state}`, isAudio ? 'crumb-audio' : 'crumb-text', highlighted ? 'is-highlighted' : ''].join(' ');
  const ref = useRef<HTMLElement>(null);
  // The thank-you box shows right after this participant taps Helped me, until they send or skip.
  const [noteOpen, setNoteOpen] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const mine = crumb.thanks_notes !== null;
  const notes = crumb.thanks_notes ?? [];
  const hidden = state === 'gone';

  // A card that a fresh post points at scrolls into view by itself.
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [highlighted]);

  const tap = (fn: () => void) => () => {
    buzz();
    fn();
  };
  const tabIndex = hidden ? -1 : 0;

  return (
    <article
      ref={ref}
      className={classes}
      // --fresh drives the continuous dimming between the named states.
      style={{ ['--fresh' as string]: (freshness / 100).toFixed(3) }}
      aria-hidden={hidden}
      data-crumb={crumb.id}
      data-kind={crumb.kind}
    >
      <AuthorLine view={view} />

      {isAudio ? (
        <>
          <AudioRow view={view} onPlayToggle={onPlayToggle} />
          {crumb.body && (
            <>
              <button
                type="button"
                className={`transcript-toggle${transcriptOpen ? ' is-open' : ''}`}
                aria-expanded={transcriptOpen}
                tabIndex={tabIndex}
                onClick={tap(() => {
                  setTranscriptOpen(!transcriptOpen);
                  onTranscript(!transcriptOpen);
                })}
              >
                <span>{transcriptOpen ? 'Hide transcript' : 'Show transcript'}</span>
                <IconChevron size={16} />
              </button>
              {transcriptOpen && <p className="crumb-body crumb-transcript">{crumb.body}</p>}
            </>
          )}
        </>
      ) : (
        <p className="crumb-body">{crumb.body}</p>
      )}

      {crumb.is_flagged && (
        <p className="crumb-warning">
          <IconWarning size={16} />
          <span>{FLAG_WARNING}</span>
        </p>
      )}

      <div className="crumb-foot">
        <FreshnessBar freshness={freshness} state={state} />
        <Tick value={crumb.helped_count} className="helped">
          {helpedText(crumb.helped_count)}
        </Tick>
      </div>
      {crumb.duplicate_count > 1 && <p className="crumb-dupes">{crumb.duplicate_count} people left this tip</p>}

      {mine ? (
        // Your own tip: no reacting to yourself. Thank-you notes from other people show up here.
        <div className="thanks-list">
          {notes.length === 0 ? (
            <p className="thanks-empty">Thank-you notes from other people will show up here.</p>
          ) : (
            <>
              <button
                type="button"
                className={`transcript-toggle${notesOpen ? ' is-open' : ''}`}
                aria-expanded={notesOpen}
                tabIndex={tabIndex}
                onClick={tap(() => {
                  setNotesOpen(!notesOpen);
                  if (!notesOpen) onNotesSeen();
                })}
              >
                <IconHeart size={16} />
                <span>
                  {notes.length} thank-you {notes.length === 1 ? 'note' : 'notes'}
                </span>
                <IconChevron size={16} />
              </button>
              {notesOpen &&
                notes.map((text, index) => (
                  <p key={index} className="thanks-item">
                    “{text}”
                  </p>
                ))}
            </>
          )}
        </div>
      ) : (
        <>
          <div className="vote-row">
            <button
              type="button"
              className={`btn btn-vote${crumb.my_vote === 'useful' ? ' is-on' : ''}`}
              aria-pressed={crumb.my_vote === 'useful'}
              tabIndex={tabIndex}
              onClick={tap(() => onVote('useful'))}
            >
              <IconThumbUp size={16} />
              <span>Useful</span>
              <Tick value={crumb.useful_count} className="count">
                {crumb.useful_count}
              </Tick>
            </button>
            <button
              type="button"
              className={`btn btn-vote${crumb.my_vote === 'not_useful' ? ' is-on' : ''}`}
              aria-pressed={crumb.my_vote === 'not_useful'}
              tabIndex={tabIndex}
              onClick={tap(() => onVote('not_useful'))}
            >
              <IconThumbDown size={16} />
              <span>Not useful</span>
            </button>
            <button
              type="button"
              className={`btn btn-vote btn-helped${crumb.my_helped ? ' is-on' : ''}`}
              aria-pressed={crumb.my_helped}
              disabled={crumb.my_helped}
              tabIndex={tabIndex}
              onClick={tap(() => {
                onHelped();
                setNoteOpen(true);
              })}
            >
              <IconHeart size={16} />
              <span>{crumb.my_helped ? 'Thanked' : 'Helped me'}</span>
            </button>
          </div>
          {crumb.my_helped && noteOpen && !crumb.my_note && (
            <ThanksNote
              onSend={(note) => {
                onHelped(note);
                setNoteOpen(false);
              }}
              onSkip={() => setNoteOpen(false)}
            />
          )}
          {crumb.my_note && (
            <p className="note-sent">
              <IconCheck size={16} />
              <span>You said: “{crumb.my_note}”</span>
            </p>
          )}
        </>
      )}
    </article>
  );
}
