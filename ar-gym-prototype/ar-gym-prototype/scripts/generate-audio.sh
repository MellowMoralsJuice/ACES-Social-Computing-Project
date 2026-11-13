#!/usr/bin/env bash
#
# Generates the two starting audio tips with edge-tts (Microsoft's online voices).
#
# This is a BUILD-TIME step. The app never calls edge-tts or Microsoft at run time:
# it only plays the two mp3 files this script writes into public/audio/.
# Run it once on a machine with internet access, then commit the two files:
#
#   npm run audio:generate        (or: bash scripts/generate-audio.sh)
#   git add public/audio/maya.mp3 public/audio/dev.mp3
#
# Until the files exist, the app reads the same two scripts aloud with the
# phone's own speech voice (a temporary fallback, not the intended voices).
#
# The two texts below must stay word-for-word identical to MAYA_SCRIPT and
# DEV_SCRIPT in shared/seed.ts, where they are stored as the transcripts.
# A unit test (tests/decay.test.ts) fails if they drift apart.
#
set -euo pipefail
cd "$(dirname "$0")/.."

MAYA_TEXT="Hey, it's Maya. For the seated dumbbell shoulder press, sit tall with your back against the pad and a dumbbell in each hand at ear height. Press up slow and steady, breathe out as you go, keep your wrists stacked over your elbows, and take about two seconds coming back down. Lighter weight, better form."
DEV_TEXT="Quick tip from Dev. I use this one as a warm-up. Grab light dumbbells, do ten quick reps, and keep your core tight so your back does not arch. Then go heavier for your real sets."

if command -v pip >/dev/null 2>&1; then
  pip install edge-tts
else
  python3 -m pip install edge-tts
fi

mkdir -p public/audio

# If the Microsoft service cannot be reached, do not leave an empty or half-written file behind:
# the app treats a missing file as "read the transcript aloud instead".
cleanup() {
  for f in public/audio/maya.mp3 public/audio/dev.mp3; do
    if [ -f "$f" ] && [ ! -s "$f" ]; then rm -f "$f"; fi
  done
}
trap cleanup EXIT

edge-tts --voice en-US-AriaNeural --text "$MAYA_TEXT" --write-media public/audio/maya.mp3
edge-tts --voice en-US-GuyNeural --text "$DEV_TEXT" --write-media public/audio/dev.mp3

ls -l public/audio/maya.mp3 public/audio/dev.mp3
echo "Done. Commit both files. If either clip runs longer than 20 seconds, that is fine: the 20-second limit applies to recordings people make, not to these two."
