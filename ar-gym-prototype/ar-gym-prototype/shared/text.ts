/**
 * Text helpers for breadcrumbs: validation limits, normalization, and the
 * hash used to merge near-duplicate tips. Merging is a single indexed lookup
 * on (station, kind, text_hash) — never a pairwise comparison of tips.
 */

export const TIP_MIN_LENGTH = 3;
export const TIP_MAX_LENGTH = 140;

/** Words that carry no meaning for duplicate detection. */
const FILLER = new Set(['a', 'an', 'the', 'your', 'you', 'to', 'please', 'just', 'really', 'always']);

/** Strip control characters and collapse whitespace. Output is still shown as plain text only. */
export function cleanTipText(raw: string): string {
  return (
    raw
      .normalize('NFKC')
      // eslint-disable-next-line no-control-regex -- stripping control characters is the point
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Lower-case, drop punctuation and filler words: "Keep your wrists stacked!" == "keep wrists stacked". */
export function normalizeTip(raw: string): string {
  return cleanTipText(raw)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(' ')
    .filter((word) => word && !FILLER.has(word))
    .join(' ');
}

/** 53-bit string hash (cyrb53), hex encoded. Deterministic on server and client. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** Hash of the normalized tip text, stored in breadcrumbs.text_hash. */
export function tipHash(raw: string): string {
  return hashText(normalizeTip(raw));
}

/** Tags a tip can carry; also the filter chips in the panel. */
export const TAGS = [
  { key: 'for-beginners', label: 'For beginners' },
  { key: 'fixing-my-wrist', label: 'Fixing my wrist' },
] as const;
export const TAG_KEYS: string[] = TAGS.map((tag) => tag.key);

/** Tappable starter phrases in the Add flow. */
export const STARTER_PHRASES = [
  'Keep your wrists stacked over your elbows.',
  'Start lighter than you think. Smooth reps first.',
  'Sit tall with your back against the pad.',
  'Breathe out as you press, in as you lower.',
];

/** Recorded audio tips: length and size limits, and the formats phones actually record. */
export const AUDIO_MAX_SECONDS = 20;
export const AUDIO_MAX_BYTES = 1024 * 1024;
/** iPhone Safari records mp4 (AAC); Chrome and Android record webm (Opus); Firefox records ogg. */
export const AUDIO_MIME_TYPES = ['audio/mp4', 'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/aac'] as const;

/** The optional note that can go with "Helped me". Short on purpose: a thank-you, not a message thread. */
export const THANKS_MAX_LENGTH = 80;
export const THANKS_STARTERS = ['Thanks, this fixed it!', 'Made my first set easier.', 'Wish I knew this sooner.'];
