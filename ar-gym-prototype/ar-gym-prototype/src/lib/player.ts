/**
 * The one audio player for the whole app.
 *
 * - Only one tip plays at a time: starting another stops the first.
 * - Nothing ever plays by itself. `play` is only called from a tap, which is
 *   also what iPhone Safari requires before it will make any sound.
 * - A tip with a sound file plays that file. A tip without one (text posted
 *   with "Type it and I will read it aloud", or a starting clip whose mp3 has
 *   not been generated yet) is read out by the phone's own speech voice.
 * - How much was actually listened to is reported when playback ends, for the
 *   behavior log.
 */
import { useSyncExternalStore } from 'react';
import type { Breadcrumb } from '../../shared/types';

export type PlayMode = 'file' | 'speech';

export interface PlayerState {
  /** The tip that is loaded (playing or paused), or null. */
  id: string | null;
  playing: boolean;
  mode: PlayMode;
  /** Seconds played and total seconds (an estimate while the phone is reading text aloud). */
  elapsed: number;
  duration: number;
  /** Set when a tip could not be played at all. */
  failedId: string | null;
}

export interface PlaybackReport {
  id: string;
  mode: PlayMode;
  listened_ms: number;
  completed: boolean;
  reason: 'ended' | 'paused' | 'switched' | 'closed' | 'error';
}

const IDLE: PlayerState = { id: null, playing: false, mode: 'file', elapsed: 0, duration: 0, failedId: null };
/** Reading speed used to estimate how long the speech voice will take. */
const SPEECH_CHARS_PER_SECOND = 14;

let state: PlayerState = IDLE;
const listeners = new Set<() => void>();
let element: HTMLAudioElement | null = null;
let current: Breadcrumb | null = null;
let onReport: (report: PlaybackReport) => void = () => undefined;

// Listening time: the clock only runs while sound is coming out.
let listenedMs = 0;
let runningSince: number | null = null;
let speechTimer: number | null = null;
let speechToken = 0;

/** Which sound files are known to exist. Checked ahead of time so a tap can go straight to speech. */
const available = new Map<string, boolean>();

function set(next: Partial<PlayerState>): void {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

function startClock(): void {
  if (runningSince === null) runningSince = performance.now();
}
function stopClock(): void {
  if (runningSince !== null) listenedMs += performance.now() - runningSince;
  runningSince = null;
}

export function canSpeak(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
}

/** Will this tip be read by the phone's voice rather than played from a file? */
export function usesSpeech(crumb: Breadcrumb): boolean {
  return !crumb.audio_url || available.get(crumb.audio_url) === false;
}

/**
 * Find out which sound files exist before anyone taps play. A missing file is
 * answered either with 404 or with the app's own HTML page, so the content
 * type is checked too.
 */
export async function checkAudioFiles(urls: string[]): Promise<void> {
  await Promise.all(
    urls
      .filter((url) => !available.has(url))
      .map(async (url) => {
        try {
          const response = await fetch(url, { method: 'HEAD' });
          const type = response.headers.get('content-type') ?? '';
          available.set(
            url,
            response.ok && (type.startsWith('audio/') || type.startsWith('video/') || type === 'application/octet-stream'),
          );
        } catch {
          /* offline: leave it unknown and let playback decide */
        }
      }),
  );
  listeners.forEach((listener) => listener());
}

function finish(reason: PlaybackReport['reason'], completed = false): void {
  if (!current) return;
  stopClock();
  const report: PlaybackReport = { id: current.id, mode: state.mode, listened_ms: Math.round(listenedMs), completed, reason };
  current = null;
  listenedMs = 0;
  if (speechTimer !== null) window.clearInterval(speechTimer);
  speechTimer = null;
  speechToken += 1;
  if (report.listened_ms > 0 || completed) onReport(report);
}

function audio(): HTMLAudioElement {
  if (element) return element;
  const el = new Audio();
  el.preload = 'none';
  el.addEventListener('timeupdate', () => {
    if (!current || state.mode !== 'file') return;
    const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : (current.audio_seconds ?? 0);
    set({ elapsed: el.currentTime, duration: Math.max(duration, el.currentTime) });
  });
  el.addEventListener('playing', () => {
    startClock();
    set({ playing: true });
  });
  el.addEventListener('pause', () => {
    stopClock();
    if (current && !el.ended) set({ playing: false });
  });
  el.addEventListener('ended', () => {
    if (!current) return;
    finish('ended', true);
    set({ ...IDLE });
  });
  el.addEventListener('error', () => {
    const crumb = current;
    if (!crumb || state.mode !== 'file') return;
    // The file is missing or this phone cannot decode it: read the words instead, if there are any.
    if (crumb.audio_url) available.set(crumb.audio_url, false);
    finish('error');
    if (crumb.body && canSpeak()) speak(crumb);
    else set({ ...IDLE, failedId: crumb.id });
  });
  element = el;
  return el;
}

function speak(crumb: Breadcrumb): void {
  const synth = window.speechSynthesis;
  synth.cancel();
  const token = ++speechToken;
  current = crumb;
  listenedMs = 0;
  const estimate = Math.max(2, crumb.body.length / SPEECH_CHARS_PER_SECOND);
  set({ id: crumb.id, playing: true, mode: 'speech', elapsed: 0, duration: estimate, failedId: null });

  const utterance = new SpeechSynthesisUtterance(crumb.body);
  utterance.lang = 'en-US';
  utterance.rate = 1;
  utterance.onstart = () => {
    if (token === speechToken) startClock();
  };
  // Where the voice has got to, when the browser reports it (not every browser does).
  utterance.onboundary = (event) => {
    if (token !== speechToken || !crumb.body.length) return;
    set({ elapsed: Math.min(estimate, (event.charIndex / crumb.body.length) * estimate) });
  };
  utterance.onend = () => {
    if (token !== speechToken) return;
    finish('ended', true);
    set({ ...IDLE });
  };
  utterance.onerror = () => {
    if (token !== speechToken) return;
    finish('error');
    set({ ...IDLE, failedId: crumb.id });
  };
  // A steady tick so the bar moves even without boundary events.
  speechTimer = window.setInterval(() => {
    if (token !== speechToken || runningSince === null) return;
    const heard = (listenedMs + performance.now() - runningSince) / 1000;
    if (heard > state.elapsed) set({ elapsed: Math.min(estimate, heard) });
  }, 250);
  synth.speak(utterance);
}

/** Start (or resume) a tip. Call this from a tap. */
export function play(crumb: Breadcrumb): void {
  if (state.id === crumb.id && state.mode === 'file' && element && !state.playing) {
    void element.play().catch(() => undefined);
    return;
  }
  stop('switched');
  if (usesSpeech(crumb)) {
    if (crumb.body && canSpeak()) speak(crumb);
    else set({ ...IDLE, failedId: crumb.id });
    return;
  }
  const el = audio();
  current = crumb;
  listenedMs = 0;
  set({ id: crumb.id, playing: true, mode: 'file', elapsed: 0, duration: crumb.audio_seconds ?? 0, failedId: null });
  el.src = crumb.audio_url as string;
  el.currentTime = 0;
  void el.play().catch((error: unknown) => {
    // A refused play() (not a missing file, which arrives as an "error" event) leaves the tip paused.
    if (current?.id === crumb.id && error instanceof DOMException && error.name === 'NotAllowedError') set({ playing: false });
  });
}

/** Pause a playing file. Speech cannot be paused reliably on phones, so it stops. */
export function pause(): void {
  if (!current) return;
  if (state.mode === 'speech') {
    stop('paused');
    return;
  }
  element?.pause();
}

/** Stop whatever is playing (the panel closed, the tab changed, another tip started). */
export function stop(reason: PlaybackReport['reason'] = 'closed'): void {
  if (!current) {
    if (state.id || state.failedId) set({ ...IDLE });
    return;
  }
  const wasSpeech = state.mode === 'speech';
  finish(reason);
  if (wasSpeech) window.speechSynthesis.cancel();
  else if (element) {
    element.pause();
    element.removeAttribute('src');
    element.load();
  }
  set({ ...IDLE });
}

/** Read a draft aloud once, outside the tip list (the "hear it" button while typing). */
export function previewSpeech(text: string, onEnd: () => void): boolean {
  if (!canSpeak() || !text.trim()) return false;
  stop('switched');
  const utterance = new SpeechSynthesisUtterance(text.trim());
  utterance.lang = 'en-US';
  utterance.onend = onEnd;
  utterance.onerror = onEnd;
  window.speechSynthesis.speak(utterance);
  return true;
}

export function cancelPreviewSpeech(): void {
  if (canSpeak()) window.speechSynthesis.cancel();
}

export function setPlaybackReporter(reporter: (report: PlaybackReport) => void): void {
  onReport = reporter;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Live player state for a component. */
export function usePlayer(): PlayerState {
  return useSyncExternalStore(subscribe, () => state);
}
