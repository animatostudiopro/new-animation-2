# Animato cloud renderer

This folder is installed and kept up to date automatically by the Animato app.
Each GitHub Actions run renders **one** episode and publishes it to YouTube:

1. The app's server decides an automation is due and sends a `repository_dispatch`
   (`render_video`) to this repository.
2. `.github/workflows/auto_render_publish.yml` installs FFmpeg + the neural voice
   engine and runs `node --experimental-strip-types animato-cloud/renderer.mts`.
3. The renderer writes the script (OpenRouter), records the voice-over (Microsoft
   Edge neural voices via `edge-tts`), finds images, renders a 9:16 MP4 with the
   automation's character, uploads it to YouTube and reports back to the app.
4. The app records the episode and schedules the next one.

Nothing here waits or loops, so pausing or deleting an automation in the app
stops it immediately and no Actions minutes are wasted between posts.

Do not edit these files here — change them in the app (`animato-cloud/` and
`server/bootstrap/workflow.yml`); the next run will re-sync this repository.
