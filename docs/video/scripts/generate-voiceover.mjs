import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = resolve(projectRoot, "script.json");
const outputPath = resolve(projectRoot, "public/voiceover.wav");
const rawOutputPath = resolve(projectRoot, "public/voiceover-raw.wav");
const ttsModel = process.env.GEMINI_TTS_MODEL ?? "gemini-2.5-flash-preview-tts";
const gatewayOrigin = "https://opencode.cloudflare.dev";
const gatewayUrl = "https://gateway.opencode.cloudflare.dev/google-ai-studio/v1beta";

function accessToken() {
  const override = process.env.OPENCODE_CF_TOKEN?.trim();
  if (override) return override;

  const result = spawnSync("cloudflared", ["access", "token", `-app=${gatewayOrigin}`], { encoding: "utf8" });
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`Could not obtain the Pi gateway Access token. Run cloudflared access login ${gatewayOrigin}.`);
  }
  return result.stdout.trim();
}

const script = JSON.parse(await readFile(scriptPath, "utf8"));
const narration = script.scenes.map((scene) => scene.narration.trim()).join("\n\n");
const response = await fetch(
  `${gatewayUrl}/models/${encodeURIComponent(ttsModel)}:generateContent`,
  {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-access-token": accessToken(),
      "X-Requested-With": "xmlhttprequest",
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `Read the following narration verbatim in a lower-register, slightly gravelly voice. Sound like a knowledgeable engineer with dry wit and a lightly sassy, confident edge: conversational, measured, clear, never mean or overacted. Leave a short natural pause between scene paragraphs. Do not add, omit, or improvise words.\n\n${narration}` }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: process.env.GEMINI_TTS_VOICE ?? "Algenib" },
          },
        },
      },
    }),
  },
);

const result = await response.json();
if (!response.ok) {
  const message = result?.error?.message ?? `Gemini TTS returned HTTP ${response.status}`;
  throw new Error(message);
}

const audioPart = result?.candidates?.[0]?.content?.parts?.find((part) => part?.inlineData?.data);
if (!audioPart) {
  throw new Error("Gemini TTS response did not contain inline audio data.");
}

const pcm = Buffer.from(audioPart.inlineData.data, "base64");
if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
  throw new Error("Gemini TTS returned empty or malformed 16-bit PCM audio.");
}

const sampleRate = 24_000;
const channels = 1;
const bitsPerSample = 16;
const wav = Buffer.alloc(44 + pcm.byteLength);
wav.write("RIFF", 0);
wav.writeUInt32LE(36 + pcm.byteLength, 4);
wav.write("WAVE", 8);
wav.write("fmt ", 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(channels, 22);
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
wav.writeUInt16LE(channels * bitsPerSample / 8, 32);
wav.writeUInt16LE(bitsPerSample, 34);
wav.write("data", 36);
wav.writeUInt32LE(pcm.byteLength, 40);
pcm.copy(wav, 44);

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(rawOutputPath, wav);

const bytesPerSecond = sampleRate * channels * bitsPerSample / 8;
const sourceDurationSeconds = pcm.byteLength / bytesPerSecond;
const tempo = sourceDurationSeconds / script.durationSeconds;
if (tempo < 0.5 || tempo > 2) {
  await rm(rawOutputPath, { force: true });
  throw new Error(`Narration duration (${sourceDurationSeconds.toFixed(1)}s) is too far from the ${script.durationSeconds}s composition to fit safely.`);
}

const fit = spawnSync("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-y", "-i", rawOutputPath,
  "-filter:a", `atempo=${tempo.toFixed(6)}`,
  "-acodec", "pcm_s16le", "-ar", String(sampleRate), "-ac", String(channels), outputPath,
], { encoding: "utf8" });
await rm(rawOutputPath, { force: true });
if (fit.error || fit.status !== 0) {
  throw new Error("Could not fit the Gemini narration to the five-minute composition with ffmpeg atempo.");
}

console.log(`Saved ${outputPath} (${(wav.byteLength / 1_000_000).toFixed(1)} MB PCM WAV).`);
console.log(`Narration fit from ${sourceDurationSeconds.toFixed(1)}s to ${script.durationSeconds}s (atempo=${tempo.toFixed(3)}).`);
