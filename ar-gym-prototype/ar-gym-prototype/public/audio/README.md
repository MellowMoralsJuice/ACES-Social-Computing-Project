# Starting audio tips

`maya.mp3` and `dev.mp3` belong here. They are generated once, at build time, by
`npm run audio:generate` (see `scripts/generate-audio.sh`) and then committed.

If this folder holds only this note, the files have not been generated yet. The app
still works: it reads the two transcripts aloud with the phone's own speech voice
until the files are added.
