/**
 * Team results view (/admin/results, behind the PIN): average score per
 * rating question, answer counts for pick-one questions, free-text answers in
 * a list, the logged behavior per participant, and CSV export.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SURVEY_QUESTIONS, type SurveyQuestion } from '../../shared/survey';
import type { ResultsResponse, ResultsSession } from '../../shared/types';
import { api } from '../lib/api';
import { downloadCsv, isUnauthorized, logout } from './adminApi';
import { PinGate } from './PinGate';

/** 'all', or a tag carried by the participant's link (?group=novice). */
function inGroup(session: ResultsSession, group: string): boolean {
  return group === 'all' || session.group === group;
}

const WHEN_NOTE: Record<NonNullable<SurveyQuestion['when']>, string> = {
  posted: 'Asked only of people who posted a tip',
  not_posted: 'Asked only of people who did not post',
  played_audio: 'Asked only of people who played an audio tip',
  no_audio: 'Asked only of people who played no audio',
};

function who(session: ResultsSession): string {
  return session.baseline_mode ? 'baseline' : (session.group ?? 'no tag');
}

function average(sessions: ResultsSession[], key: string): { mean: number | null; n: number } {
  const values = sessions.map((s) => Number(s.answers[key])).filter((n) => Number.isFinite(n) && n >= 1 && n <= 5);
  if (values.length === 0) return { mean: null, n: 0 };
  return { mean: values.reduce((a, b) => a + b, 0) / values.length, n: values.length };
}

function Bar({ value }: { value: number | null }) {
  return (
    <span className="score-bar" aria-hidden="true">
      <span style={{ width: `${value === null ? 0 : (value / 5) * 100}%` }} />
    </span>
  );
}

function yes(value: boolean | null): string {
  return value === null ? '-' : value ? 'yes' : 'no';
}

function View({ token, signOut }: { token: string; signOut: () => void }) {
  const [data, setData] = useState<ResultsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<'all' | 'session_1' | 'session_2'>('all');
  const [hideSteered, setHideSteered] = useState(false);
  const [hideEmpty, setHideEmpty] = useState(true);

  const load = useCallback(async () => {
    try {
      setData(await api.get<ResultsResponse>('/api/admin/results', token));
      setError(null);
    } catch (failure) {
      if (isUnauthorized(failure)) {
        logout();
        signOut();
        return;
      }
      setError(failure instanceof Error ? failure.message : 'Could not load results.');
    }
  }, [token, signOut]);

  useEffect(() => {
    void load();
  }, [load]);

  const sessions = useMemo(
    () =>
      (data?.sessions ?? []).filter(
        (s) =>
          (version === 'all' || s.prototype_version === version) &&
          !(hideSteered && s.override_active) &&
          !(hideEmpty && Object.keys(s.answers).length === 0),
      ),
    [data, version, hideSteered, hideEmpty],
  );
  const full = sessions.filter((s) => !s.baseline_mode);
  const baseline = sessions.filter((s) => s.baseline_mode);
  // One column for everyone, then one per group tag that actually appears in the data.
  const groups = ['all', ...Array.from(new Set(full.map((s) => s.group).filter((g): g is string => Boolean(g)))).sort()];

  const exportCsv = async (kind: 'sessions' | 'events' | 'responses') => {
    try {
      await downloadCsv(kind, token);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Export failed.');
    }
  };

  if (!data) return <main className="admin">{error ? <p className="error">{error}</p> : <p className="loading">Loading…</p>}</main>;

  const ratings = SURVEY_QUESTIONS.filter((q) => q.type === 'rating');
  const choices = SURVEY_QUESTIONS.filter((q) => q.type === 'choice');
  const textKeys: Array<{ key: string; prompt: string }> = SURVEY_QUESTIONS.flatMap((q: SurveyQuestion) => [
    ...(q.type === 'text' ? [{ key: q.key, prompt: q.prompt }] : []),
    ...(q.followUp ? [{ key: `${q.key}_why`, prompt: `${q.prompt} — ${q.followUp}` }] : []),
  ]);

  return (
    <main className="admin">
      <header className="admin-header">
        <div>
          <h1>Results</h1>
          <p className="admin-note">
            {sessions.length} participant{sessions.length === 1 ? '' : 's'} shown ({full.length} full experience, {baseline.length}{' '}
            plain-text baseline)
          </p>
        </div>
        <div className="admin-actions">
          <a className="abtn" href="/admin">
            Admin panel
          </a>
          <button type="button" className="abtn" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </header>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <section className="admin-card">
        <h2>Export</h2>
        <p className="admin-note">CSV files open in Excel, Numbers or Google Sheets.</p>
        <div className="abtn-row">
          <button type="button" className="abtn abtn-strong" onClick={() => void exportCsv('sessions')}>
            Download CSV (one row per participant: survey + behavior)
          </button>
          <button type="button" className="abtn" onClick={() => void exportCsv('responses')}>
            Answers, long format
          </button>
          <button type="button" className="abtn" onClick={() => void exportCsv('events')}>
            Raw behavior log
          </button>
        </div>
        <div className="abtn-row">
          {(['all', 'session_1', 'session_2'] as const).map((v) => (
            <button
              key={v}
              type="button"
              className={`abtn${version === v ? ' is-on' : ''}`}
              aria-pressed={version === v}
              onClick={() => setVersion(v)}
            >
              {v === 'all' ? 'Both sessions' : v.replace('_', ' ')}
            </button>
          ))}
          <button
            type="button"
            className={`abtn${hideSteered ? ' is-on' : ''}`}
            aria-pressed={hideSteered}
            onClick={() => setHideSteered(!hideSteered)}
          >
            Hide hand-steered sessions
          </button>
          <button
            type="button"
            className={`abtn${hideEmpty ? ' is-on' : ''}`}
            aria-pressed={hideEmpty}
            onClick={() => setHideEmpty(!hideEmpty)}
          >
            Hide sessions with no answers
          </button>
        </div>
      </section>

      <section className="admin-card">
        <h2>Average scores (1 to 5)</h2>
        <div className="table-wrap">
          <table className="results-table">
            <thead>
              <tr>
                <th>Question</th>
                {groups.map((group) => (
                  <th key={group}>{group === 'all' ? 'All (full version)' : `Group: ${group}`}</th>
                ))}
                <th>Baseline</th>
              </tr>
            </thead>
            <tbody>
              {ratings.map((q) => (
                <tr key={q.key}>
                  <td>{q.prompt}</td>
                  {groups.map((group) => {
                    const { mean, n } = average(
                      full.filter((s) => inGroup(s, group)),
                      q.key,
                    );
                    return (
                      <td key={group}>
                        <strong>{mean === null ? '-' : mean.toFixed(1)}</strong> <small>n={n}</small>
                        <Bar value={mean} />
                      </td>
                    );
                  })}
                  <td>
                    {(() => {
                      const { mean, n } = average(baseline, q.key);
                      return (
                        <>
                          <strong>{mean === null ? '-' : mean.toFixed(1)}</strong> <small>n={n}</small>
                        </>
                      );
                    })()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="admin-card">
        <h2>Pick-one answers</h2>
        <div className="choice-grid">
          {choices.map((q) => {
            const answered = sessions.filter((s) => s.answers[q.key]);
            return (
              <div key={q.key} className="choice-block">
                <h3>{q.prompt}</h3>
                {q.when && <p className="admin-note">{WHEN_NOTE[q.when]}</p>}
                {q.options?.map((option) => {
                  const count = answered.filter((s) => s.answers[q.key] === option.value).length;
                  return (
                    <p key={option.value} className="choice-line">
                      <span>{option.label}</span>
                      <Bar value={answered.length ? (count / answered.length) * 5 : 0} />
                      <strong>{count}</strong>
                    </p>
                  );
                })}
              </div>
            );
          })}
        </div>
      </section>

      <section className="admin-card">
        <h2>Free-text answers</h2>
        {textKeys.map(({ key, prompt }) => {
          const rows = sessions.filter((s) => s.answers[key]);
          if (rows.length === 0) return null;
          return (
            <div key={key} className="text-block">
              <h3>{prompt}</h3>
              <ul>
                {rows.map((s) => (
                  <li key={s.id}>
                    <span className="layer-tag">{who(s)}</span> {s.answers[key]}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {sessions.every((s) => textKeys.every(({ key }) => !s.answers[key])) && <p className="admin-note">No free-text answers yet.</p>}
      </section>

      <section className="admin-card">
        <h2>Logged behavior</h2>
        <p className="admin-note">What people did, to compare with what they said. Differences are worth flagging in the write-up.</p>
        <div className="table-wrap">
          <table className="results-table behavior-table">
            <thead>
              <tr>
                <th>Participant</th>
                <th>Said first tab</th>
                <th>Opened first</th>
                <th>Seconds per tab</th>
                <th>Tips viewed</th>
                <th>Audio plays (seconds heard, finished)</th>
                <th>Transcripts</th>
                <th>Votes</th>
                <th>Thanks (notes)</th>
                <th>See more / filter</th>
                <th>Tips added</th>
                <th>Reacted to Loaf / flagged</th>
                <th>Skip seen</th>
                <th>Faded for them</th>
                <th>Steered</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const b = s.behavior;
                const said = s.answers.first_tab;
                const mismatch = said && b.first_tab && said !== 'not_sure' && said !== b.first_tab;
                return (
                  <tr key={s.id}>
                    <td>
                      {who(s)}
                      <br />
                      <small>
                        {s.prototype_version.replace('_', ' ')} ·{' '}
                        {new Date(s.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </small>
                    </td>
                    <td className={mismatch ? 'mismatch' : ''}>{said ? said.replace('_', ' ') : '-'}</td>
                    <td className={mismatch ? 'mismatch' : ''}>{b.first_tab ?? '-'}</td>
                    <td>{b.tabs_opened.map((key) => `${key} ${Math.round((b.tab_view_ms[key] ?? 0) / 1000)}`).join(', ') || '-'}</td>
                    <td>{b.tips_viewed}</td>
                    <td>{b.audio_plays ? `${b.audio_plays} (${b.audio_listened_seconds} s, ${b.audio_completed})` : 'none'}</td>
                    <td>{b.transcripts_opened}</td>
                    <td>{b.votes_cast}</td>
                    <td>
                      {b.thanks_sent} ({b.thanks_notes_sent})
                    </td>
                    <td>
                      {yes(b.see_more_used)} / {yes(b.filter_used)}
                    </td>
                    <td>{b.tips_added ? `${b.tips_added} (${b.added_kinds.join(', ')})` : 'no'}</td>
                    <td>
                      {yes(b.reacted_to_loaf)} / {yes(b.reacted_to_flagged)}
                    </td>
                    <td>{yes(b.time_skip_seen)}</td>
                    <td>{b.faded_breadcrumbs.join('; ') || '-'}</td>
                    <td>{s.override_active ? <em className="flag">yes</em> : 'no'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

export default function Results() {
  return <PinGate title="Results">{(token, signOut) => <View token={token} signOut={signOut} />}</PinGate>;
}
