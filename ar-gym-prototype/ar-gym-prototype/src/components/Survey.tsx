/**
 * Post-session survey: one question per screen, shown as a HUD panel over the
 * dimmed camera inside the glasses. A progress bar, large tap targets, and
 * every free-text question can be skipped. Each answer is saved as soon as it
 * is given, so nothing is lost if the phone is put down early.
 *
 * A few follow-ups depend on what this participant actually did: people who
 * posted are asked what made them post, people who did not are asked what
 * stopped them, and likewise for playing audio.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { SURVEY_ANSWER_MAX_LENGTH, questionsFor, type SurveyFacts, type SurveyQuestion } from '../../shared/survey';
import type { SessionInfo } from '../../shared/types';
import { api } from '../lib/api';
import { buzz } from '../lib/feedback';
import { loadJson, removeKey, saveJson, surveyKey } from '../lib/storage';
import { IconArrow, IconBack } from './Icons';

interface Props {
  session: SessionInfo;
  /** What this participant did, which decides the follow-up questions. */
  facts: SurveyFacts;
  onDone: () => void;
}

type Answers = Record<string, string>;

export function Survey({ session, facts, onDone }: Props) {
  // Fixed when the survey opens, so the list cannot change under someone part-way through.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const questions = useMemo(() => questionsFor(session.baseline_mode, facts), [session.baseline_mode]);
  // Progress is kept in this browser, so an accidental refresh mid-survey resumes where it left off.
  const saved = useMemo(() => loadJson<{ index: number; answers: Answers }>(surveyKey(session.id)), [session.id]);
  const [index, setIndex] = useState(() => Math.min(Math.max(0, saved?.index ?? 0), questions.length - 1));
  const [answers, setAnswers] = useState<Answers>(saved?.answers ?? {});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answersRef = useRef<Answers>(saved?.answers ?? {});
  useEffect(() => {
    saveJson(surveyKey(session.id), { index, answers });
  }, [session.id, index, answers]);

  const question = questions[index];
  const isLast = index === questions.length - 1;
  const main = answers[question.key] ?? '';
  const why = answers[`${question.key}_why`] ?? '';

  const setAnswer = (key: string, value: string) => {
    answersRef.current = { ...answersRef.current, [key]: value };
    setAnswers(answersRef.current);
  };

  /** Save one question's answers in the background; the final submit re-sends everything. */
  const saveQuietly = (q: SurveyQuestion) => {
    const batch = [q.key, `${q.key}_why`]
      .filter((key) => answersRef.current[key]?.trim())
      .map((key) => ({ key, answer: answersRef.current[key].trim() }));
    if (batch.length === 0) return;
    void api.post('/api/survey', { session_id: session.id, answers: batch }).catch(() => undefined);
  };

  const finish = async () => {
    setSubmitting(true);
    setError(null);
    const all = Object.entries(answersRef.current)
      .filter(([, value]) => value.trim())
      .map(([key, value]) => ({ key, answer: value.trim() }));
    try {
      await api.post('/api/survey', { session_id: session.id, answers: all, final: true });
      removeKey(surveyKey(session.id));
      onDone();
    } catch {
      setError("We couldn't save your answers. Check the wifi, then tap Finish again.");
      setSubmitting(false);
    }
  };

  const next = () => {
    buzz();
    saveQuietly(question);
    if (isLast) void finish();
    else setIndex((i) => i + 1);
  };

  const pick = (value: string) => {
    buzz();
    setAnswer(question.key, value);
    // No follow-up to read: move on by itself after a beat so the choice is seen.
    if (!question.followUp && !isLast) {
      window.setTimeout(() => {
        saveQuietly(question);
        setIndex((i) => (i === index ? i + 1 : i));
      }, 260);
    }
  };

  const minutes = Math.max(1, Math.round((questions.length * 17) / 60));
  const needsAnswer = question.type !== 'text' && !main;
  const progress = Math.round((index / questions.length) * 100);

  return (
    <main className="survey">
      <div className="survey-top">
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={questions.length} aria-valuenow={index + 1}>
          <span style={{ width: `${Math.max(4, progress)}%` }} />
        </div>
        <p className="survey-count">
          Question {index + 1} of {questions.length}
          {index === 0 && ` · about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`}
        </p>
      </div>

      <div className="survey-card hud-panel" key={question.key}>
        <h2 className="survey-prompt">{question.prompt}</h2>

        {question.type === 'rating' && (
          <div className="rating">
            <div className="rating-row">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`rating-button${main === String(n) ? ' is-on' : ''}`}
                  aria-pressed={main === String(n)}
                  aria-label={`${n} out of 5`}
                  onClick={() => pick(String(n))}
                >
                  {n}
                </button>
              ))}
            </div>
            <div className="rating-scale">
              <span>{question.scale?.[0]}</span>
              <span>{question.scale?.[1]}</span>
            </div>
          </div>
        )}

        {question.type === 'choice' && (
          <div className="choices">
            {question.options?.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`choice${main === option.value ? ' is-on' : ''}`}
                aria-pressed={main === option.value}
                onClick={() => pick(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}

        {question.type === 'text' && (
          <textarea
            className="survey-text"
            rows={3}
            maxLength={SURVEY_ANSWER_MAX_LENGTH}
            placeholder="A few words is plenty"
            value={main}
            onChange={(event) => setAnswer(question.key, event.target.value)}
          />
        )}

        {question.followUp && (
          <label className="field">
            <span className="field-label">{question.followUp} (optional)</span>
            <textarea
              className="survey-text"
              rows={2}
              maxLength={SURVEY_ANSWER_MAX_LENGTH}
              value={why}
              onChange={(event) => setAnswer(`${question.key}_why`, event.target.value)}
            />
          </label>
        )}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>

      <div className="survey-actions">
        {index > 0 ? (
          <button type="button" className="btn btn-quiet" onClick={() => (buzz(), setIndex((i) => i - 1))}>
            <IconBack />
            <span>Back</span>
          </button>
        ) : (
          <span />
        )}
        <button type="button" className="btn btn-primary btn-xl" disabled={needsAnswer || submitting} onClick={next}>
          <span>{submitting ? 'Saving…' : isLast ? 'Finish' : question.type === 'text' && !main.trim() ? 'Skip' : 'Next'}</span>
          <IconArrow />
        </button>
      </div>
    </main>
  );
}
