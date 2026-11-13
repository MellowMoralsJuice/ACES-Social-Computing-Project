/**
 * Participant app: welcome -> (camera permission) -> the glasses view -> survey -> thank you.
 *
 * Everything a participant sees sits inside the glasses (see Glasses.tsx): the
 * welcome, the main view, adding a breadcrumb, the survey and the thank-you.
 * Turned sideways the phone looks like a pair of smart glasses; upright it is a
 * plain full-screen camera with the same controls.
 *
 * There are no accounts and no roles. Starting creates an anonymous session on
 * the server, which also hands out a friendly made-up name ("Guest 4"). Its id
 * is kept in this browser so a refresh does not lose the participant's place.
 *
 * Links the team can hand out (also shown as QR codes in the admin panel):
 *   /                       the full experience
 *   /?group=novice          the same, silently tagged for analysis (any short word works)
 *   /?group=expert
 *   /?baseline=1            the plain-text baseline version
 *   /?s=shoulder-press      the station QR code
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SurveyFacts } from '../shared/survey';
import { STATION } from '../shared/seed';
import type { SessionInfo } from '../shared/types';
import { Baseline } from './components/Baseline';
import { Camera, type CameraStatus } from './components/Camera';
import { Glasses } from './components/Glasses';
import { IconArrow } from './components/Icons';
import { Scene, type SurveyFact } from './components/Scene';
import { Survey } from './components/Survey';
import { ApiFailure, api } from './lib/api';
import { useIsPortrait, useWakeLock } from './lib/device';
import { buzz } from './lib/feedback';
import { KEYS, loadJson, removeKey, saveJson, surveyKey } from './lib/storage';
import { flush, setTrackerSession, track } from './lib/tracker';
import { useGym } from './lib/useGym';

type Stage = 'welcome' | 'scene' | 'survey' | 'thanks';

/** A saved session is resumed after a refresh only if it started within this window. */
const RESUME_WINDOW_MS = 2 * 60 * 60 * 1000;
/** The power-on animation after "Put on the glasses". */
const BOOT_MS = 1100;
const NO_FACTS: SurveyFacts = { posted: false, playedAudio: false };

interface SavedSession {
  session: SessionInfo;
  stage: Stage;
  epoch: number | null;
  camera: boolean;
  facts: SurveyFacts;
}

function readParams() {
  const params = new URLSearchParams(window.location.search);
  const group = (params.get('group') ?? '').trim().toLowerCase();
  const station = params.get('s');
  return {
    // A silent tag for analysis. Anything that is not a short plain word is ignored.
    group: /^[a-z0-9_-]{1,24}$/.test(group) ? group : null,
    baseline: params.get('baseline') === '1',
    // There is one station; an unknown code in the link falls back to it instead of an empty screen.
    stationCode: station === STATION.code ? station : null,
  };
}

export function App() {
  const params = useMemo(readParams, []);
  const saved = useMemo(() => {
    const stored = loadJson<SavedSession>(KEYS.session);
    if (!stored?.session) return null;
    // Resume only a session that matches this link and is recent. A phone handed from the
    // full version to the baseline link (or from one group's link to another) must start clean.
    const age = Date.now() - new Date(stored.session.created_at).getTime();
    const mismatch = params.group !== (stored.session.group ?? null) || params.baseline !== stored.session.baseline_mode;
    if (mismatch || !(age >= 0 && age < RESUME_WINDOW_MS)) {
      removeKey(KEYS.session);
      removeKey(surveyKey(stored.session.id));
      return null;
    }
    return stored;
  }, [params]);
  const [session, setSession] = useState<SessionInfo | null>(saved?.session ?? null);
  const [stage, setStage] = useState<Stage>(saved?.session ? saved.stage : 'welcome');
  const [facts, setFacts] = useState<SurveyFacts>(saved?.facts ?? NO_FACTS);
  const [busy, setBusy] = useState(false);
  const [booting, setBooting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [cameraOn, setCameraOn] = useState(Boolean(saved?.camera && saved.session && saved.stage !== 'welcome'));
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>('idle');
  const [cameraKey, setCameraKey] = useState(0);
  const portrait = useIsPortrait();

  const gym = useGym(session, params.stationCode ?? STATION.code);
  const epochAtStart = useRef<number | null>(saved?.epoch ?? null);
  const surveyNonceAtStart = useRef<number | null>(null);

  useEffect(() => {
    setTrackerSession(session?.id ?? null);
  }, [session?.id]);

  // Remember where this participant is.
  useEffect(() => {
    if (session) saveJson(KEYS.session, { session, stage, epoch: epochAtStart.current, camera: cameraOn, facts } satisfies SavedSession);
  }, [session, stage, cameraOn, facts]);

  const reset = useCallback(() => {
    void flush();
    removeKey(KEYS.session);
    if (session) removeKey(surveyKey(session.id));
    setSession(null);
    setStage('welcome');
    setFacts(NO_FACTS);
    setCameraOn(false);
    setBooting(false);
    setError(null);
    epochAtStart.current = null;
    surveyNonceAtStart.current = null;
  }, [session]);

  // Admin "New participant" (session epoch bump), or a session the server no longer knows: start over.
  useEffect(() => {
    if (!gym.synced || !session) return;
    if (epochAtStart.current === null) epochAtStart.current = gym.settings.session_epoch;
    if (gym.sessionLost || gym.settings.session_epoch !== epochAtStart.current) reset();
  }, [gym.synced, gym.sessionLost, gym.settings.session_epoch, session, reset]);

  // Admin "Start survey" (for everyone, or for this phone only).
  useEffect(() => {
    if (!gym.synced || !session) return;
    const nonce = gym.settings.survey_nonce;
    if (surveyNonceAtStart.current === null) {
      surveyNonceAtStart.current = nonce;
      return;
    }
    if (nonce !== surveyNonceAtStart.current) {
      surveyNonceAtStart.current = nonce;
      const target = gym.settings.survey_session_id;
      if ((!target || target === session.id) && stage === 'scene') setStage('survey');
    }
  }, [gym.synced, gym.settings.survey_nonce, gym.settings.survey_session_id, session, stage]);

  /** "Put on the glasses": start the session, ask for the camera, play the power-on. */
  const start = async () => {
    if (busy) return;
    buzz(20);
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<SessionInfo>('/api/sessions', { group: params.group, baseline: params.baseline });
      epochAtStart.current = gym.synced ? gym.settings.session_epoch : null;
      surveyNonceAtStart.current = gym.synced ? gym.settings.survey_nonce : null;
      setTrackerSession(created.id);
      setSession(created);
      setFacts(NO_FACTS);
      setStage('scene');
      // The baseline is a plain card: it never asks for the camera and has no glasses to put on.
      if (!created.baseline_mode) {
        setCameraOn(true); // this is what makes the phone ask for permission
        setBooting(true);
        window.setTimeout(() => setBooting(false), BOOT_MS);
        track('glasses_on', { orientation: window.matchMedia('(orientation: portrait)').matches ? 'portrait' : 'landscape' });
      }
    } catch (failure) {
      setError(failure instanceof ApiFailure ? failure.message : 'Could not start. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const onCameraStatus = useCallback((status: CameraStatus) => {
    setCameraStatus(status);
    if (status === 'live') track('camera_ready', {});
    if (status === 'denied' || status === 'unavailable') track('camera_denied', { status });
  }, []);

  const retryCamera = useCallback(() => {
    setCameraOn(true);
    setCameraKey((k) => k + 1);
  }, []);

  // Log every turn of the phone, so time spent in each orientation can be seen in the data.
  useEffect(() => {
    if (session) track('orientation_changed', { orientation: portrait ? 'portrait' : 'landscape' });
  }, [portrait, session]);

  const goSurvey = useCallback(() => {
    track('survey_started', {});
    void flush();
    setStage('survey');
  }, []);

  const onFact = useCallback((fact: SurveyFact) => setFacts((current) => (current[fact] ? current : { ...current, [fact]: true })), []);

  const baseline = session ? session.baseline_mode : params.baseline;
  // The camera stays on behind the survey and the thank-you (dimmed), so the glasses never "come off".
  const showCamera = cameraOn && !baseline && stage !== 'welcome';
  const cameraLive = showCamera && cameraStatus === 'live';
  // Nobody touches the phone while reading or listening to a tip, so keep the screen from dimming or locking.
  useWakeLock(stage === 'scene');

  // ---- The plain-text baseline: no glasses, no camera ---------------------------------------
  if (baseline) {
    return (
      <div className="app app-plain">
        {stage === 'welcome' && (
          <main className="screen">
            <section className="panel plain-card">
              <p className="eyebrow">Gym tips</p>
              <h1>A few tips for one gym station.</h1>
              <p className="fine">Read them, try the movement, then answer a few questions.</p>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <button type="button" className="btn btn-primary btn-xl btn-wide" disabled={busy} onClick={() => void start()}>
                <span>{busy ? 'Starting…' : 'Start'}</span>
                <IconArrow />
              </button>
            </section>
          </main>
        )}
        {stage === 'scene' && session && <Baseline station={gym.station} breadcrumbs={gym.breadcrumbs} onFinish={goSurvey} />}
        {stage === 'survey' && session && <Survey key={session.id} session={session} facts={facts} onDone={() => setStage('thanks')} />}
        {stage === 'thanks' && (
          <main className="screen">
            <section className="panel plain-card">
              <p className="eyebrow">All done</p>
              <h1>Thank you. That helps a lot.</h1>
              <p className="fine">Please hand the phone back to the team.</p>
              <button type="button" className="btn btn-primary btn-xl btn-wide" onClick={() => (buzz(), reset())}>
                <span>Start over for the next person</span>
                <IconArrow />
              </button>
            </section>
          </main>
        )}
      </div>
    );
  }

  // ---- The glasses ---------------------------------------------------------------------------
  return (
    <div className="app">
      <Camera key={cameraKey} enabled={showCamera} onStatus={onCameraStatus} />

      <Glasses off={stage === 'welcome'} booting={booting} dim={stage === 'survey' || stage === 'thanks'} cameraLive={cameraLive}>
        {stage === 'welcome' && (
          <main className="hud-center">
            <section className="welcome">
              <p className="eyebrow">Gym Glasses</p>
              <h1>For today, this phone is a pair of smart glasses.</h1>
              {/* The one-line explanation comes before the phone's own permission prompt. */}
              <p className="fine">
                Your phone will ask to use its camera so you can see the room through them. Nothing is recorded or saved.
              </p>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <button type="button" className="btn btn-primary btn-xl" disabled={busy} onClick={() => void start()}>
                <span>{busy ? 'Starting…' : 'Put on the glasses'}</span>
                {!busy && <IconArrow />}
              </button>
            </section>
          </main>
        )}

        {stage === 'scene' && session && (
          <Scene
            key={session.id}
            session={session}
            gym={gym}
            portrait={portrait}
            camera={{ on: cameraOn, status: cameraStatus }}
            onCameraRetry={retryCamera}
            onFinish={goSurvey}
            onFact={onFact}
          />
        )}

        {stage === 'survey' && session && <Survey key={session.id} session={session} facts={facts} onDone={() => setStage('thanks')} />}

        {stage === 'thanks' && (
          <main className="hud-center">
            <section className="hud-panel thanks">
              <p className="eyebrow">All done</p>
              <h1>Thank you. That helps a lot.</h1>
              {/* The debrief, in plain words: what was real and what was not. */}
              <p className="fine">
                Good to know: the starting tips and their counts were written for this study, the glasses were a picture on your phone, and
                "later" was simulated. Please hand the phone back to the team.
              </p>
              <button type="button" className="btn btn-primary btn-xl" onClick={() => (buzz(), reset())}>
                <span>Start over for the next person</span>
                <IconArrow />
              </button>
            </section>
          </main>
        )}
      </Glasses>
    </div>
  );
}
