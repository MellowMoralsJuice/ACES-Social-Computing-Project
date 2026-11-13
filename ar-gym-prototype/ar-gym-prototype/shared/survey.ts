/**
 * The post-session survey: ONE list, one question per screen, about 4 minutes.
 * It asks about what the participant did and noticed, not whether they liked it.
 *
 * "What do you think a faded tip means?" comes BEFORE anything explains
 * fading, and nothing in the app explains it either.
 *
 * Some questions depend on what the participant actually did (logged, not
 * asked): whether they posted a tip, and whether they played an audio tip.
 *
 * Each answer is stored as its own row in survey_responses keyed by question
 * `key`, so questions can change between sessions without a schema change.
 * A question's optional free-text follow-up is stored under `<key>_why`.
 */
export type QuestionType = 'rating' | 'choice' | 'text';

/** What this participant did during the session; picks the follow-up questions. */
export interface SurveyFacts {
  posted: boolean;
  playedAudio: boolean;
}

export interface SurveyQuestion {
  key: string;
  type: QuestionType;
  prompt: string;
  /** For rating questions: labels for 1 and 5. */
  scale?: [string, string];
  /** For choice questions. */
  options?: Array<{ value: string; label: string }>;
  /** Optional free-text follow-up shown under a rating / choice question. */
  followUp?: string;
  /** Only asked when this is true of what the participant did. */
  when?: 'posted' | 'not_posted' | 'played_audio' | 'no_audio';
  /** Hidden in the plain-text baseline, which has no panel, audio, badges, votes or fading to ask about. */
  fullOnly?: boolean;
}

function options(...labels: string[]): Array<{ value: string; label: string }> {
  return labels.map((label) => ({
    value: label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, ''),
    label,
  }));
}

export const SURVEY_QUESTIONS: SurveyQuestion[] = [
  // --- Who they are ------------------------------------------------------------------
  {
    key: 'gym_comfort',
    type: 'rating',
    prompt: 'Before today, how comfortable were you in a gym?',
    scale: ['Not at all', 'Very'],
  },
  {
    key: 'gym_experience',
    type: 'choice',
    prompt: 'How experienced are you in a gym?',
    options: options('Brand new', 'Some experience', 'Experienced'),
  },

  // --- What they did and understood ----------------------------------------------------
  {
    key: 'first_tab',
    type: 'choice',
    prompt: 'Which tab did you open first?',
    options: options('Text', 'Audio', 'Not sure'),
    followUp: 'Why that one?',
    fullOnly: true,
  },
  {
    key: 'glasses_natural',
    type: 'rating',
    prompt: 'Looking through the glasses view felt natural.',
    scale: ['Strongly disagree', 'Strongly agree'],
    fullOnly: true,
  },
  {
    key: 'faded_meaning',
    type: 'text',
    prompt: 'Some tips looked faded. In your own words, what do you think a faded tip means?',
    fullOnly: true,
  },
  {
    key: 'skip_reaction',
    type: 'choice',
    prompt: 'When time jumped ahead, how did you react to the tips changing?',
    options: options('Expected it', 'Surprised but fine', 'Confused', 'Did not notice'),
    fullOnly: true,
  },
  {
    key: 'trust',
    type: 'rating',
    prompt: 'How much did you trust the tips you saw?',
    scale: ['Not at all', 'Completely'],
    followUp: 'What made you trust or doubt one?',
  },
  {
    key: 'badge_or_warning',
    type: 'choice',
    prompt: 'Did the Loaf badge or the warning label change which tip you followed?',
    options: options('The Loaf badge did', 'The warning label did', 'Both did', 'Neither did', 'Did not notice them'),
    followUp: 'How?',
    fullOnly: true,
  },
  {
    key: 'helped_count',
    type: 'choice',
    prompt: 'Did the "Helped" count on a tip influence which one you followed?',
    options: options('Yes', 'A little', 'No', 'Did not notice it'),
    fullOnly: true,
  },

  // --- Follow-ups that depend on what they did ------------------------------------------
  { key: 'posted_why', type: 'text', prompt: 'You left a tip. What made you decide to post it?', when: 'posted', fullOnly: true },
  {
    key: 'posted_ease',
    type: 'rating',
    prompt: 'How easy was it to add your tip?',
    scale: ['Very hard', 'Very easy'],
    when: 'posted',
    fullOnly: true,
  },
  { key: 'not_posted_why', type: 'text', prompt: 'You did not leave a tip. What stopped you?', when: 'not_posted', fullOnly: true },
  {
    key: 'audio_vs_reading',
    type: 'choice',
    prompt: 'You played an audio tip. How did listening compare with reading?',
    options: options('Listening was better', 'About the same', 'Reading was better'),
    followUp: 'Why?',
    when: 'played_audio',
    fullOnly: true,
  },
  { key: 'audio_why_not', type: 'text', prompt: 'You did not play an audio tip. Why not?', when: 'no_audio', fullOnly: true },

  // --- Closing ---------------------------------------------------------------------------
  { key: 'most_confusing', type: 'text', prompt: 'What was the one most confusing moment?' },
  { key: 'one_change', type: 'text', prompt: 'What is the one thing you would change?' },
];

/** Every key the survey route accepts, including follow-ups. */
export const SURVEY_KEYS: string[] = SURVEY_QUESTIONS.flatMap((q) => (q.followUp ? [q.key, `${q.key}_why`] : [q.key]));

export const SURVEY_ANSWER_MAX_LENGTH = 600;

/** The questions one participant sees. */
export function questionsFor(baseline: boolean, facts: SurveyFacts): SurveyQuestion[] {
  const applies = (when: SurveyQuestion['when']) =>
    when === undefined ||
    (when === 'posted' && facts.posted) ||
    (when === 'not_posted' && !facts.posted) ||
    (when === 'played_audio' && facts.playedAudio) ||
    (when === 'no_audio' && !facts.playedAudio);
  return SURVEY_QUESTIONS.filter((q) => applies(q.when) && !(baseline && q.fullOnly));
}

/** Is `answer` acceptable for question `key`? Used by the survey route. */
export function isValidAnswer(key: string, answer: string): boolean {
  if (answer.length === 0 || answer.length > SURVEY_ANSWER_MAX_LENGTH) return false;
  const base = SURVEY_QUESTIONS.find((q) => q.key === key);
  if (!base) return SURVEY_KEYS.includes(key); // a `_why` follow-up: any short text
  if (base.type === 'rating') return /^[1-5]$/.test(answer);
  if (base.type === 'choice') return (base.options ?? []).some((o) => o.value === answer);
  return true;
}
