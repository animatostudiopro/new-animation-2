# Animato cloud renderer

This folder is installed and kept up to date automatically by the Animato app.
Each GitHub Actions run renders **one** episode and publishes it to YouTube:

1. The app's server decides an automation is due and sends a `repository_dispatch`
   (`render_video`) to this repository.
2. `.github/workflows/auto_render_publish.yml` installs FFmpeg + the neural voice
   engine and runs `node --experimental-strip-types animato-cloud/renderer.mts`.
3. The renderer writes the script with the best free OpenRouter model (with
   performance tags such as `[sad]`, `[look_image]`, `[nod]` pinned to words),
   records the voice-over with word timings (Microsoft Edge neural voices via
   `edge-tts`), finds one matching image per scene, then renders the video in
   headless Chrome with the app's own character engine (`stage.html` +
   `stage.js`): lip-sync, blinking, expressions, 2.5D head turns and looks at
   each image, word-by-word captions. FFmpeg encodes it as a YouTube Short
   (9:16 / 1:1) or a regular video (16:9 / 4:3), it is uploaded to YouTube and
   the episode is reported back to the app.
4. The app records the episode and schedules the next one.

Nothing here waits or loops, so pausing or deleting an automation in the app
stops it immediately and no Actions minutes are wasted between posts.

Do not edit these files here — change them in the app (`animato-cloud/` and
`server/bootstrap/workflow.yml`); the next run will re-sync this repository.
