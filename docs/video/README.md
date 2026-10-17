# Poneglyph explainer video

A five-minute Remotion composition lives here; the silent visual review render is `docs/poneglyph-explainer-preview.mp4`, and the voiced final render belongs at `docs/poneglyph-explainer.mp4`. Its visual direction follows the supplied reference: pure black canvas, italic serif chapter headings, small syntax-colored code, thin data-structure diagrams, restrained colors, and generous negative space. The narration covers sourced facts, append-only history, derived projections, bounded Datalog, commit visibility, and expandable prefix routing. The six-scene script is `script.json` (653 words).

## Render

```sh
cd docs/video
npm install --no-package-lock
npm run studio
```

Generate the Gemini voice-over through the same Pi/OpenCode Cloudflare gateway, then render the final video:

```sh
# Use the existing Cloudflare Access login for opencode.cloudflare.dev.
# If needed: cloudflared access login https://opencode.cloudflare.dev
npm run voiceover
npm run render
```

The generator resolves the same `OPENCODE_CF_TOKEN` override Pi uses, or obtains a token with `cloudflared access token`. `GEMINI_TTS_MODEL` can override the dedicated speech model (default: `gemini-2.5-flash-preview-tts`); `GEMINI_TTS_VOICE` defaults to `Kore`. Audio is written to `public/voiceover.wav`, and the final render includes it. Without audio, `npm run render:preview` creates the silent preview.

The Pi catalog's `gemini-3.8-flash` entry is a text/chat model, not a TTS output model. The gateway does expose Google's Gemini speech-generation endpoint, which the voice-over generator calls using the same Cloudflare Access authentication. The TTS model ID is therefore separate from the Pi chat model ID.
