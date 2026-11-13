import type { Settings } from './types.js';

/** What the app assumes until the first /api/state answer arrives (and when offline). */
export const DEFAULT_SETTINGS: Settings = {
  virtual_clock_offset_seconds: 0,
  gym_busyness: 'normal',
  decay_multiplier: 1,
  auto_skip_enabled: true,
  session_epoch: 0,
  survey_nonce: 0,
  survey_session_id: null,
  prototype_version: 'session_1',
  content_rev: 0,
};
