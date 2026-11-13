/**
 * Admin panel (hidden route /admin, behind the team PIN).
 *
 * This is an optional override layer: the participant experience runs start
 * to finish if this page is never opened. Every button here is logged on the
 * server with a timestamp, and steering actions flag the sessions in progress.
 */
import qrcode from 'qrcode-generator';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { TIME_SKIPS, virtualNowMs, type DecayClock } from '../../shared/decay';
import type { AdminOverview, Breadcrumb } from '../../shared/types';
import { api } from '../lib/api';
import { STATE_LABEL, offsetLabel, viewOf } from '../lib/crumbs';
import { startRealtime } from '../lib/realtime';
import { isUnauthorized, logout } from './adminApi';
import { PinGate } from './PinGate';

const REFRESH_MS = 3000;

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="admin-card">
      <h2>{title}</h2>
      {note && <p className="admin-note">{note}</p>}
      {children}
    </section>
  );
}

function Toggle({ label, on, onClick, tone }: { label: string; on: boolean; onClick: () => void; tone?: string }) {
  return (
    <button type="button" className={`abtn${on ? ' is-on' : ''}${tone ? ` abtn-${tone}` : ''}`} aria-pressed={on} onClick={onClick}>
      {label}
    </button>
  );
}

function Qr({ url, label }: { url: string; label: string }) {
  const src = useMemo(() => {
    const code = qrcode(0, 'M');
    code.addData(url);
    code.make();
    return code.createDataURL(4, 8);
  }, [url]);
  return (
    <figure className="qr">
      <img src={src} alt={`QR code for ${label}`} width={132} height={132} />
      <figcaption>
        <strong>{label}</strong>
        <a href={url}>{url.replace(/^https?:\/\//, '')}</a>
      </figcaption>
    </figure>
  );
}

function Panel({ token, signOut }: { token: string; signOut: () => void }) {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [realtime, setRealtime] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const skew = useRef(0);

  const receive = useCallback((overview: AdminOverview) => {
    skew.current = new Date(overview.server_now).getTime() - Date.now();
    setData(overview);
    setError(null);
  }, []);

  const fail = useCallback(
    (failure: unknown) => {
      if (isUnauthorized(failure)) {
        logout();
        signOut();
        return;
      }
      setError(failure instanceof Error ? failure.message : 'Something went wrong.');
    },
    [signOut],
  );

  const refresh = useCallback(async () => {
    try {
      receive(await api.get<AdminOverview>('/api/admin/actions', token));
    } catch (failure) {
      fail(failure);
    }
  }, [token, receive, fail]);

  useEffect(() => {
    void refresh();
    const handle = startRealtime(() => void refresh(), setRealtime);
    const poll = window.setInterval(() => void refresh(), REFRESH_MS);
    const tick = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => {
      handle.stop();
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
  }, [refresh]);

  const act = async (body: Record<string, unknown>, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    try {
      receive(await api.post<AdminOverview>('/api/admin/actions', body, token));
    } catch (failure) {
      fail(failure);
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <main className="admin">{error ? <p className="error">{error}</p> : <p className="loading">Loading…</p>}</main>;

  const s = data.settings;
  const clock: DecayClock = {
    nowMs: virtualNowMs(nowMs + skew.current, s.virtual_clock_offset_seconds),
    busyness: s.gym_busyness,
    multiplier: s.decay_multiplier,
    skipActive: s.virtual_clock_offset_seconds > 0,
  };
  const origin = window.location.origin;
  const pinned = data.breadcrumbs.filter((b) => b.pin_state !== 'none').length;

  return (
    <main className="admin" aria-busy={busy}>
      <header className="admin-header">
        <div>
          <h1>Admin panel</h1>
          <p className="admin-note">
            {realtime ? 'Live (Supabase Realtime)' : 'Live (2-second polling)'} · {s.prototype_version.replace('_', ' ')} ·{' '}
            {offsetLabel(s.virtual_clock_offset_seconds) ?? 'real time'}
          </p>
        </div>
        <div className="admin-actions">
          <a className="abtn" href="/admin/results">
            Results and CSV
          </a>
          <button
            type="button"
            className="abtn"
            onClick={() => {
              logout();
              signOut();
            }}
          >
            Lock
          </button>
        </div>
      </header>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {(pinned > 0 || s.virtual_clock_offset_seconds > 0) && (
        <p className="admin-alert" role="status">
          Hand-steering is active:{' '}
          {[
            s.virtual_clock_offset_seconds > 0 && `time fast-forwarded (${offsetLabel(s.virtual_clock_offset_seconds)})`,
            pinned > 0 && `${pinned} pinned breadcrumb(s)`,
          ]
            .filter(Boolean)
            .join(', ')}
          . Sessions running now are flagged in the results.
        </p>
      )}

      <div className="admin-grid">
        <Section
          title="Fast-forward time"
          note="Shifts the virtual clock for every phone. The real decay rule decides what fades; nothing is deleted."
        >
          <div className="abtn-row">
            {TIME_SKIPS.map((skip) => (
              <button
                key={skip.key}
                type="button"
                className="abtn abtn-strong"
                onClick={() => void act({ type: 'time_skip', seconds: skip.seconds })}
              >
                {skip.label}
              </button>
            ))}
          </div>
          <div className="abtn-row">
            <button
              type="button"
              className="abtn"
              onClick={() =>
                void act({ type: 'reset_time' }, 'Reset time and restore every seeded breadcrumb (votes on them are cleared)?')
              }
            >
              Reset time and restore
            </button>
          </div>
          <p className="admin-note">Now: {offsetLabel(s.virtual_clock_offset_seconds) ?? 'no skip applied'}</p>
        </Section>

        <Section
          title="Scripted time-skip"
          note='When on, each phone plays its own "One week later" after about 20 seconds of reading tips, so a participant sees tips fade with nobody steering. Turn it off to control time only from here.'
        >
          <div className="abtn-row">
            <Toggle
              label={`Scripted "One week later" on each phone: ${s.auto_skip_enabled ? 'on' : 'off'}`}
              on={s.auto_skip_enabled}
              onClick={() => void act({ type: 'set_auto_skip', value: !s.auto_skip_enabled })}
            />
          </div>
        </Section>
      </div>

      <Section
        title="Breadcrumbs"
        note="Text first, then audio, best first within each. Freshness is computed live from the decay rule. Keep fresh holds a tip at full freshness. Make stale makes it fade out at the next fast-forward (never mid-read). Loaf switches the author's badge."
      >
        <div className="crumb-table">
          {data.breadcrumbs.map((b) => (
            <CrumbRow key={b.id} crumb={b} clock={clock} act={act} />
          ))}
        </div>
        <div className="abtn-row">
          <button
            type="button"
            className="abtn"
            onClick={() => void act({ type: 'clear_added' }, 'Delete every breadcrumb added by participants?')}
          >
            Remove participant-added breadcrumbs
          </button>
        </div>
      </Section>

      <div className="admin-grid">
        <Section
          title="Participants and session reset"
          note="Newest first. Flagged = an override (time-skip, pin, Loaf change) was live during that session."
        >
          <div className="abtn-row">
            <button
              type="button"
              className="abtn abtn-strong"
              onClick={() => void act({ type: 'start_survey', session_id: null }, 'Start the survey on every phone now?')}
            >
              Start survey on all phones
            </button>
            <button
              type="button"
              className="abtn abtn-warn"
              onClick={() => void act({ type: 'new_participant' }, 'Send every phone back to the welcome screen for a new participant?')}
            >
              Reset session (all phones to welcome)
            </button>
          </div>
          <ul className="session-list">
            {data.sessions.length === 0 && <li>No participants yet.</li>}
            {data.sessions.map((p) => (
              <li key={p.id}>
                <span>
                  <strong>{p.guest_name ?? 'Guest'}</strong>
                  {p.group ? ` · group ${p.group}` : ''}
                  {p.baseline_mode ? ' · baseline' : ''} ·{' '}
                  {new Date(p.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  {p.override_active && <em className="flag"> · flagged</em>}
                </span>
                <span className={p.completed_at ? 'ok' : ''}>
                  {p.completed_at ? 'Survey submitted' : p.answers > 0 ? `In survey (${p.answers})` : 'In session'}
                </span>
                {!p.completed_at && (
                  <button type="button" className="abtn" onClick={() => void act({ type: 'start_survey', session_id: p.id })}>
                    Start survey
                  </button>
                )}
              </li>
            ))}
          </ul>
        </Section>

        <Section
          title="Links and QR codes"
          note="Hand these out, or print them. Everyone gets the same experience; a group link only tags the session for analysis, and the participant never sees the tag."
        >
          <div className="qr-grid">
            <Qr url={`${origin}/?s=shoulder-press`} label="Station: shoulder press" />
            <Qr url={`${origin}/?group=novice`} label="Tagged group: novice" />
            <Qr url={`${origin}/?group=expert`} label="Tagged group: expert" />
            <Qr url={`${origin}/?baseline=1`} label="Plain-text baseline" />
          </div>
          <div className="abtn-row">
            {(['session_1', 'session_2'] as const).map((version) => (
              <Toggle
                key={version}
                label={`Tag new sessions as ${version.replace('_', ' ')}`}
                on={s.prototype_version === version}
                onClick={() => void act({ type: 'set_prototype_version', version })}
              />
            ))}
          </div>
        </Section>
      </div>

      <Section title="Action log" note="Every override and time-skip, newest first.">
        <ol className="log">
          {data.actions.length === 0 && <li>Nothing yet. The app has been running on its own.</li>}
          {data.actions.map((a) => (
            <li key={a.id}>
              <time>{new Date(a.created_at).toLocaleTimeString()}</time>
              <strong>{a.action_type}</strong>
              <code>{Object.keys(a.payload).length ? JSON.stringify(a.payload) : ''}</code>
            </li>
          ))}
        </ol>
      </Section>
    </main>
  );
}

function CrumbRow({
  crumb,
  clock,
  act,
}: {
  crumb: Breadcrumb;
  clock: DecayClock;
  act: (body: Record<string, unknown>, confirmText?: string) => Promise<void>;
}) {
  const view = viewOf(crumb, clock);
  return (
    <div className={`crumb-admin state-${view.state}`}>
      <div className="crumb-admin-main">
        <p>
          <span className="layer-tag">{crumb.kind === 'audio' ? (crumb.audio_url ? 'Audio' : 'Audio, read aloud') : 'Text'}</span>{' '}
          {crumb.body || 'Voice recording (no transcript)'}
        </p>
        <p className="admin-note">
          {crumb.contributor.display_name}
          {crumb.contributor.has_loaf_badge ? ' (Loaf)' : ''} · useful {crumb.useful_count} / not {crumb.not_useful_count} · helped{' '}
          {crumb.helped_count}
          {crumb.duplicate_count > 1 ? ` · left by ${crumb.duplicate_count}` : ''}
          {crumb.is_verified ? ' · verified' : ''}
          {crumb.is_flagged ? ' · flagged (warning label)' : ''}
        </p>
        {(crumb.thanks_notes ?? []).length > 0 && (
          <p className="admin-note">Thank-you notes: {(crumb.thanks_notes ?? []).map((n) => `“${n}”`).join(' ')}</p>
        )}
      </div>
      <div className="fresh-cell">
        <strong>{Math.round(view.freshness)}</strong>
        <span>{STATE_LABEL[view.state]}</span>
        {crumb.pin_state !== 'none' && <em className="flag">{crumb.pin_state === 'keep_fresh' ? 'PINNED FRESH' : 'FORCED STALE'}</em>}
      </div>
      <div className="abtn-row">
        <Toggle
          label="Loaf"
          on={crumb.contributor.has_loaf_badge}
          onClick={() => void act({ type: 'set_loaf', contributor_id: crumb.contributor_id, value: !crumb.contributor.has_loaf_badge })}
        />
        <Toggle
          label="Keep fresh"
          on={crumb.pin_state === 'keep_fresh'}
          tone="warn"
          onClick={() =>
            void act({ type: 'set_pin', breadcrumb_id: crumb.id, pin_state: crumb.pin_state === 'keep_fresh' ? 'none' : 'keep_fresh' })
          }
        />
        <Toggle
          label="Make stale"
          on={crumb.pin_state === 'force_stale'}
          tone="warn"
          onClick={() =>
            void act({ type: 'set_pin', breadcrumb_id: crumb.id, pin_state: crumb.pin_state === 'force_stale' ? 'none' : 'force_stale' })
          }
        />
      </div>
    </div>
  );
}

export default function Admin() {
  return <PinGate title="Admin panel">{(token, signOut) => <Panel token={token} signOut={signOut} />}</PinGate>;
}
