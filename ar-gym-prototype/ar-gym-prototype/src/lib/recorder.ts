/**
 * Recording a short voice tip with the browser's MediaRecorder.
 *
 * Phones do not agree on a format: iPhone Safari records MP4/AAC, Chrome
 * records WebM/Opus. The format is picked at run time from what this browser
 * says it supports. The recording stays on the phone until Post is tapped.
 */
import { AUDIO_MAX_BYTES, AUDIO_MAX_SECONDS } from '../../shared/text';

// MP4 with AAC first (what iPhone Safari records, and every phone can play it back), then
// WebM with Opus (what Chrome and Android record), then whatever else the browser offers.
const CANDIDATES = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/webm;codecs=opus',
  'audio/mp4',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/aac',
];

export function pickMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return null;
  return CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

export function canRecord(): boolean {
  return Boolean(navigator.mediaDevices?.getUserMedia) && pickMimeType() !== null;
}

export interface Clip {
  blob: Blob;
  /** The type the recorder actually produced (may carry a codecs suffix). */
  mime: string;
  seconds: number;
  /** A local address for the preview player. Revoke it when done. */
  url: string;
}

export type RecorderFailure = 'denied' | 'unsupported' | 'failed';

export interface ActiveRecording {
  /** Stop early. The result arrives through `done`. */
  stop: () => void;
  /** Throw the recording away (the panel closed). */
  cancel: () => void;
  done: Promise<Clip>;
}

/** Ask for the microphone and start recording. Rejects with a RecorderFailure string. */
export async function startRecording(onSecond: (elapsed: number) => void): Promise<ActiveRecording> {
  const mime = pickMimeType();
  if (!mime || !navigator.mediaDevices?.getUserMedia) throw 'unsupported' satisfies RecorderFailure;

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    throw (name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unsupported') satisfies RecorderFailure;
  }

  let recorder: MediaRecorder;
  try {
    // A modest bitrate keeps 20 seconds far below the 1 MB limit.
    recorder = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 48_000 });
  } catch {
    stream.getTracks().forEach((track) => track.stop());
    throw 'unsupported' satisfies RecorderFailure;
  }

  const chunks: Blob[] = [];
  const startedAt = performance.now();
  let cancelled = false;
  let ticker: number | null = null;

  const done = new Promise<Clip>((resolve, reject) => {
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener('error', () => reject('failed' satisfies RecorderFailure));
    recorder.addEventListener('stop', () => {
      if (ticker !== null) window.clearInterval(ticker);
      stream.getTracks().forEach((track) => track.stop());
      if (cancelled) return reject('failed' satisfies RecorderFailure);
      const seconds = Math.min(AUDIO_MAX_SECONDS, (performance.now() - startedAt) / 1000);
      const type = recorder.mimeType || mime;
      const blob = new Blob(chunks, { type });
      if (blob.size === 0 || blob.size > AUDIO_MAX_BYTES) return reject('failed' satisfies RecorderFailure);
      resolve({ blob, mime: type, seconds, url: URL.createObjectURL(blob) });
    });
  });
  // The caller may never await a cancelled recording.
  done.catch(() => undefined);

  const stop = () => {
    if (recorder.state !== 'inactive') recorder.stop();
  };
  recorder.start();
  ticker = window.setInterval(() => {
    const elapsed = (performance.now() - startedAt) / 1000;
    onSecond(elapsed);
    if (elapsed >= AUDIO_MAX_SECONDS) stop();
  }, 200);

  return {
    stop,
    cancel: () => {
      cancelled = true;
      stop();
    },
    done,
  };
}

/** The clip as base64 (no "data:" prefix), ready to send as JSON. */
export function clipToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read failed'));
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}
