import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function resolveRuntimePackage(name) {
  const runtime = process.env.TTS_RUNTIME || "";
  if (runtime) {
    const pkg = path.join(runtime, "node_modules", name, "dist", "kokoro.js");
    return pathToFileUrl(pkg);
  }
  return name;
}

function pathToFileUrl(filePath) {
  const resolved = path.resolve(filePath).replace(/\\/g, "/");
  return `file:///${resolved.replace(/^\/+/, "")}`;
}

// Kokoro truncates one call at ~510 tokens, so long text is spoken a sentence at a time and joined.
// Sentence-sized parts also give the player exact start/end times to sync word highlighting to.
const MAX_CHUNK_CHARS = 300;
const PAUSE_SECONDS = 0.12;

function splitIntoChunks(text) {
  const sentences = text
    .replace(/\s+/g, " ")
    .match(/[^.!?。！？]+(?:[.!?。！？]+["')\]]*|$)/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) || [text];
  const chunks = [];
  let current = "";
  for (const sentence of sentences) {
    // A single overlong sentence is cut at commas or spaces so no piece gets truncated
    const pieces = sentence.length <= MAX_CHUNK_CHARS ? [sentence] : splitLongSentence(sentence);
    for (const piece of pieces) {
      // Very short fragments ("Okay.") ride along with the next sentence for smoother speech
      if (current && current.length < 24) {
        current = `${current} ${piece}`;
      } else {
        if (current) chunks.push(current);
        current = piece;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitLongSentence(sentence) {
  const pieces = [];
  let rest = sentence;
  while (rest.length > MAX_CHUNK_CHARS) {
    const window = rest.slice(0, MAX_CHUNK_CHARS);
    let cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "));
    if (cut < MAX_CHUNK_CHARS / 3) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = MAX_CHUNK_CHARS;
    pieces.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

// Progress lines go to stderr with a marker; serve.cjs picks them out and keeps the rest as logs
function reportProgress(update) {
  process.stderr.write(`@@progress ${JSON.stringify(update)}\n`);
}

async function main() {
  const payload = JSON.parse(await readStdin());
  process.env.TRANSFORMERS_CACHE = payload.cacheDir || process.env.TRANSFORMERS_CACHE || "";
  process.env.HF_HOME = payload.cacheDir || process.env.HF_HOME || "";

  const chunks = splitIntoChunks(payload.text);
  reportProgress({ phase: "loading", done: 0, total: chunks.length });

  const kokoro = await import(resolveRuntimePackage("kokoro-js"));
  const { KokoroTTS } = kokoro;

  const tts = await KokoroTTS.from_pretrained(payload.modelId, {
    dtype: payload.dtype || "q8",
    device: "cpu",
  });

  const parts = [];
  let first = null;
  for (let i = 0; i < chunks.length; i++) {
    reportProgress({ phase: "speaking", done: i, total: chunks.length });
    const audio = await tts.generate(chunks[i], {
      voice: payload.voice || "af_heart",
      speed: Number(payload.speed) || 1,
    });
    first = first || audio;
    parts.push(audio.audio);
  }
  reportProgress({ phase: "saving", done: chunks.length, total: chunks.length });

  const sampleRate = first.sampling_rate || first.sampleRate || 24000;
  const pause = Math.round(sampleRate * PAUSE_SECONDS);
  const totalSamples = parts.reduce((sum, part) => sum + part.length, 0) + pause * (parts.length - 1);
  const joined = new Float32Array(totalSamples);
  const segments = [];
  let offset = 0;
  parts.forEach((part, index) => {
    joined.set(part, offset);
    segments.push({
      text: chunks[index],
      start: Number((offset / sampleRate).toFixed(3)),
      end: Number(((offset + part.length) / sampleRate).toFixed(3)),
    });
    offset += part.length + (index < parts.length - 1 ? pause : 0);
  });
  const combined = new first.constructor(joined, sampleRate);

  await fs.mkdir(path.dirname(payload.output), { recursive: true });
  combined.save(payload.output);
  process.stdout.write(JSON.stringify({
    ok: true,
    output: payload.output,
    sampleRate,
    durationMs: Math.round((totalSamples / sampleRate) * 1000),
    chunks: chunks.length,
    segments,
  }));
}

main().catch((err) => {
  process.stderr.write(err?.stack || err?.message || String(err));
  process.exit(1);
});
