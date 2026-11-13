/**
 * Leaving a breadcrumb. Anyone can.
 *
 *   1. choose Text or Audio
 *   2. Text:  tap a starter phrase or type (140 characters at most), then Post
 *      Audio: tap Record (20 seconds at most, with a countdown), listen back,
 *             re-record if you like, then Post
 *
 * If the microphone is blocked, or this browser cannot record, the audio path
 * falls back to "Type it and I will read it aloud": the words are saved and
 * every phone speaks them with its own voice.
 *
 * A recording stays on this phone until Post is tapped.
 */
import { useEffect, useRef, useState } from 'react';
import { AUDIO_MAX_SECONDS, STARTER_PHRASES, TAGS, TIP_MAX_LENGTH, TIP_MIN_LENGTH } from '../../shared/text';
import type { CreateBreadcrumbResponse } from '../../shared/types';
import { ApiFailure } from '../lib/api';
import { clockLabel } from '../lib/crumbs';
import { buzz } from '../lib/feedback';
import { canSpeak, cancelPreviewSpeech, previewSpeech } from '../lib/player';
import { canRecord, clipToBase64, startRecording, type ActiveRecording, type Clip, type RecorderFailure } from '../lib/recorder';
import { track } from '../lib/tracker';
import type { NewBreadcrumb } from '../lib/useGym';
import { IconBack, IconCheck, IconMic, IconPause, IconPlay, IconRewind, IconSound, IconStop, IconText } from './Icons';

interface Props {
  authorName: string;
  onPost: (input: NewBreadcrumb) => Promise<CreateBreadcrumbResponse>;
  onPosted: (result: CreateBreadcrumbResponse) => void;
}

type Step = 'choose' | 'text' | 'audio' | 'spoken';
type RecordState = 'idle' | 'asking' | 'recording' | 'preview';

const FAILURE_TEXT: Record<RecorderFailure, string> = {
  denied: 'The microphone is blocked on this phone.',
  unsupported: 'This browser cannot record audio.',
  failed: 'That recording did not work.',
};

function TagPicker({ tags, onToggle }: { tags: string[]; onToggle: (key: string) => void }) {
  return (
    <>
      <p className="field-label field-label-quiet">Good for (optional)</p>
      <div className="chip-row chip-wrap">
        {TAGS.map((tag) => (
          <button
            key={tag.key}
            type="button"
            className={`chip${tags.includes(tag.key) ? ' is-on' : ''}`}
            aria-pressed={tags.includes(tag.key)}
            onClick={() => (buzz(), onToggle(tag.key))}
          >
            {tag.label}
          </button>
        ))}
      </div>
    </>
  );
}

export function AddBreadcrumb({ authorName, onPost, onPosted }: Props) {
  const [step, setStep] = useState<Step>('choose');
  const [body, setBody] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Recording
  const [recordState, setRecordState] = useState<RecordState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [clip, setClip] = useState<Clip | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  const [hearing, setHearing] = useState(false);
  const active = useRef<ActiveRecording | null>(null);
  const previewAudio = useRef<HTMLAudioElement | null>(null);
  const clipRef = useRef<Clip | null>(null);

  // Leaving the form (panel closed, posted) releases the microphone and the preview.
  useEffect(
    () => () => {
      active.current?.cancel();
      previewAudio.current?.pause();
      cancelPreviewSpeech();
      if (clipRef.current) URL.revokeObjectURL(clipRef.current.url);
    },
    [],
  );

  const trimmed = body.trim();
  const toggleTag = (key: string) => setTags((current) => (current.includes(key) ? current.filter((t) => t !== key) : [...current, key]));

  const send = async (input: NewBreadcrumb) => {
    if (busy) return;
    buzz(18);
    setBusy(true);
    setError(null);
    try {
      onPosted(await onPost(input));
    } catch (failure) {
      setError(failure instanceof ApiFailure ? failure.message : 'That did not post. Please try again.');
      setBusy(false);
    }
  };

  const fallBack = (reason: RecorderFailure) => {
    track('record_unavailable', { reason });
    setFallbackReason(FAILURE_TEXT[reason]);
    setRecordState('idle');
    setStep('spoken');
  };

  const chooseAudio = () => {
    buzz();
    setError(null);
    if (canRecord()) setStep('audio');
    else fallBack('unsupported');
  };

  const discardClip = () => {
    previewAudio.current?.pause();
    setPreviewing(false);
    if (clipRef.current) URL.revokeObjectURL(clipRef.current.url);
    clipRef.current = null;
    setClip(null);
  };

  const record = async () => {
    buzz(20);
    setError(null);
    discardClip();
    setElapsed(0);
    setRecordState('asking');
    try {
      const recording = await startRecording(setElapsed);
      active.current = recording;
      setRecordState('recording');
      track('record_started', {});
      const result = await recording.done;
      active.current = null;
      clipRef.current = result;
      setClip(result);
      setRecordState('preview');
    } catch (failure) {
      active.current = null;
      const reason = (typeof failure === 'string' ? failure : 'failed') as RecorderFailure;
      if (reason === 'failed') {
        setRecordState('idle');
        setError('That recording did not work. Try once more.');
      } else fallBack(reason);
    }
  };

  const togglePreview = () => {
    if (!clip) return;
    buzz();
    let el = previewAudio.current;
    if (!el) {
      el = new Audio();
      el.addEventListener('ended', () => setPreviewing(false));
      el.addEventListener('pause', () => setPreviewing(false));
      el.addEventListener('playing', () => setPreviewing(true));
      previewAudio.current = el;
    }
    if (previewing) {
      el.pause();
      return;
    }
    if (el.src !== clip.url) el.src = clip.url;
    el.currentTime = 0;
    void el.play().catch(() => setPreviewing(false));
  };

  const postClip = async () => {
    if (!clip) return;
    previewAudio.current?.pause();
    let data: string;
    try {
      data = await clipToBase64(clip.blob);
    } catch {
      setError('That recording could not be read. Try recording again.');
      return;
    }
    await send({ kind: 'audio', tags, audio: { data, mime: clip.mime, seconds: Math.max(0.1, clip.seconds) } });
  };

  const hear = () => {
    buzz();
    if (hearing) {
      cancelPreviewSpeech();
      setHearing(false);
      return;
    }
    if (previewSpeech(trimmed, () => setHearing(false))) setHearing(true);
  };

  const back = (
    <button
      type="button"
      className="btn btn-quiet btn-small add-back"
      onClick={() => {
        buzz();
        active.current?.cancel();
        discardClip();
        cancelPreviewSpeech();
        setHearing(false);
        setRecordState('idle');
        setError(null);
        setStep('choose');
      }}
    >
      <IconBack size={16} />
      <span>Text or audio</span>
    </button>
  );

  const errorLine = error && (
    <p className="error" role="alert">
      {error}
    </p>
  );
  const postingAs = <p className="fine center">Posting as {authorName}. No real names are stored.</p>;

  // ---- 1. Text or Audio ---------------------------------------------------------------------
  if (step === 'choose') {
    return (
      <div className="add">
        <p className="field-label">How do you want to leave it?</p>
        <div className="kind-pick">
          <button type="button" className="kind-option" onClick={() => (buzz(), setError(null), setStep('text'))}>
            <IconText size={26} />
            <strong>Text</strong>
            <span>Type a short tip</span>
          </button>
          <button type="button" className="kind-option" onClick={chooseAudio}>
            <IconMic size={26} />
            <strong>Audio</strong>
            <span>Say it, up to {AUDIO_MAX_SECONDS} seconds</span>
          </button>
        </div>
        {postingAs}
      </div>
    );
  }

  // ---- 2a. A typed tip, or text that phones will read aloud -----------------------------------
  if (step === 'text' || step === 'spoken') {
    const spoken = step === 'spoken';
    const canPost = !busy && trimmed.length >= TIP_MIN_LENGTH;
    return (
      <div className="add">
        {back}
        {spoken && (
          <p className="add-note">
            {fallbackReason ? `${fallbackReason} ` : ''}
            Type it and I will read it aloud.
          </p>
        )}
        <label className="field">
          <span className="field-label">{spoken ? 'What should the tip say?' : 'Your tip'}</span>
          <textarea
            value={body}
            maxLength={TIP_MAX_LENGTH}
            rows={2}
            placeholder="One short tip a newcomer can use"
            onChange={(event) => setBody(event.target.value)}
          />
          <span className="field-count">
            {body.length}/{TIP_MAX_LENGTH}
          </span>
        </label>
        <p className="field-label field-label-quiet">Or tap a starter</p>
        <div className="starter-list">
          {STARTER_PHRASES.map((phrase) => (
            <button key={phrase} type="button" className="chip chip-starter" onClick={() => (buzz(), setBody(phrase))}>
              {phrase}
            </button>
          ))}
        </div>
        <TagPicker tags={tags} onToggle={toggleTag} />
        {errorLine}
        <div className="add-actions">
          {spoken && canSpeak() && (
            <button type="button" className="btn btn-glass" disabled={trimmed.length < TIP_MIN_LENGTH} onClick={hear}>
              {hearing ? <IconStop size={18} /> : <IconSound size={18} />}
              <span>{hearing ? 'Stop' : 'Hear it'}</span>
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary btn-grow"
            disabled={!canPost}
            onClick={() => {
              cancelPreviewSpeech();
              setHearing(false);
              void send({ kind: spoken ? 'audio' : 'text', body: trimmed, tags });
            }}
          >
            <IconCheck size={18} />
            <span>{busy ? 'Posting…' : 'Post'}</span>
          </button>
        </div>
        {postingAs}
      </div>
    );
  }

  // ---- 2b. A recording ------------------------------------------------------------------------
  const remaining = Math.max(0, Math.ceil(AUDIO_MAX_SECONDS - elapsed));
  return (
    <div className="add">
      {back}

      {recordState === 'idle' && (
        <div className="record">
          <button type="button" className="record-button" onClick={() => void record()}>
            <IconMic size={30} />
            <span>Record</span>
          </button>
          <p className="fine center">
            Up to {AUDIO_MAX_SECONDS} seconds. Your phone will ask to use the microphone. Nothing is saved until you tap Post.
          </p>
          <button type="button" className="btn btn-quiet btn-small" onClick={() => (buzz(), setFallbackReason(null), setStep('spoken'))}>
            No microphone? Type it and I will read it aloud
          </button>
        </div>
      )}

      {recordState === 'asking' && (
        <div className="record">
          <p className="record-wait">Waiting for the microphone…</p>
        </div>
      )}

      {recordState === 'recording' && (
        <div className="record">
          <p className="record-countdown" role="timer" aria-live="off">
            <b>{remaining}</b>
            <span>seconds left</span>
          </p>
          <div className="record-bar" aria-hidden="true">
            <span style={{ width: `${Math.min(100, (elapsed / AUDIO_MAX_SECONDS) * 100)}%` }} />
          </div>
          <button type="button" className="record-button is-recording" onClick={() => (buzz(20), active.current?.stop())}>
            <IconStop size={30} />
            <span>Stop</span>
          </button>
        </div>
      )}

      {recordState === 'preview' && clip && (
        <div className="record">
          <div className="audio-row preview-row">
            <button
              type="button"
              className={`play${previewing ? ' is-playing' : ''}`}
              aria-label={previewing ? 'Pause' : 'Play it back'}
              onClick={togglePreview}
            >
              {previewing ? <IconPause size={26} /> : <IconPlay size={26} />}
            </button>
            <div className="audio-main">
              <p className="preview-title">Your recording</p>
              <p className="audio-times">
                <span>{clockLabel(clip.seconds)} · tap to listen back</span>
              </p>
            </div>
          </div>
          <TagPicker tags={tags} onToggle={toggleTag} />
          {errorLine}
          <div className="add-actions">
            <button type="button" className="btn btn-glass" disabled={busy} onClick={() => void record()}>
              <IconRewind size={18} />
              <span>Re-record</span>
            </button>
            <button type="button" className="btn btn-primary btn-grow" disabled={busy} onClick={() => void postClip()}>
              <IconCheck size={18} />
              <span>{busy ? 'Posting…' : 'Post'}</span>
            </button>
          </div>
        </div>
      )}

      {recordState !== 'preview' && errorLine}
      {postingAs}
    </div>
  );
}
