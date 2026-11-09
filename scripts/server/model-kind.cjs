// Works out what a model file is for (image, text, speech) by reading its header, so the
// app can file it under the right type no matter which tab it was added from.
//   GGUF         -> the "general.architecture" metadata ("qwen2", "gemma3" = text; "flux", "sdxl" = image;
//                   "clip" = a text model's vision add-on)
//   safetensors  -> tensor names ("model.diffusion_model.*" = Stable Diffusion; "model.layers.*" = an LLM)
//   .ckpt        -> Stable Diffusion checkpoints
//   whisper .bin -> the ggml magic "lmgg"
const fs = require("fs");

// Diffusion architectures stable-diffusion.cpp and city96's GGUF conversions write
const IMAGE_ARCHITECTURES = new Set([
  "sd1", "sd2", "sdxl", "sd3", "flux", "aura", "hyvid", "ltxv", "wan", "lumina2", "hidream", "cosmos", "chroma", "qwen_image",
]);

const GGUF_TYPE_SIZES = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
const GGUF_STRING = 8;
const GGUF_ARRAY = 9;
const HEADER_READ_BYTES = 4 * 1024 * 1024;

function readStart(filePath, length) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

// Walks the GGUF key/value metadata until it finds general.architecture (normally one of the first keys)
function readGgufArchitecture(buffer) {
  if (buffer.length < 24 || buffer.toString("latin1", 0, 4) !== "GGUF") return null;
  let offset = 16; // magic, version, tensor count
  const kvCount = Number(buffer.readBigUInt64LE(offset));
  offset += 8;
  const readString = () => {
    const length = Number(buffer.readBigUInt64LE(offset));
    offset += 8;
    const value = buffer.toString("utf8", offset, offset + length);
    offset += length;
    return value;
  };
  const skipValue = (type) => {
    if (type === GGUF_STRING) {
      offset += 8 + Number(buffer.readBigUInt64LE(offset));
    } else if (type === GGUF_ARRAY) {
      const itemType = buffer.readUInt32LE(offset);
      const count = Number(buffer.readBigUInt64LE(offset + 4));
      offset += 12;
      if (itemType === GGUF_STRING) {
        for (let i = 0; i < count; i += 1) offset += 8 + Number(buffer.readBigUInt64LE(offset));
      } else {
        offset += count * (GGUF_TYPE_SIZES[itemType] || 0);
      }
    } else {
      offset += GGUF_TYPE_SIZES[type] || 0;
    }
  };
  try {
    for (let i = 0; i < kvCount; i += 1) {
      const key = readString();
      const type = buffer.readUInt32LE(offset);
      offset += 4;
      if (key === "general.architecture" && type === GGUF_STRING) return readString();
      skipValue(type);
    }
  } catch (_) {
    // Ran past the bytes read (a huge vocabulary came first); the caller treats this as unknown
  }
  return null;
}

function readSafetensorsKeys(filePath, buffer) {
  if (buffer.length < 8) return null;
  const headerLength = Number(buffer.readBigUInt64LE(0));
  if (!headerLength || headerLength > 200 * 1024 * 1024) return null;
  const header = headerLength + 8 <= buffer.length
    ? buffer.subarray(8, 8 + headerLength)
    : readStart(filePath, headerLength + 8).subarray(8);
  try {
    return Object.keys(JSON.parse(header.toString("utf8")));
  } catch (_) {
    return null;
  }
}

/**
 * @returns {{ kind: "image" | "text" | "speech" | "unknown", detail: string }}
 *   detail is the architecture or a short reason, for messages
 */
function detectModelKind(filePath) {
  const lower = String(filePath).toLowerCase();
  let buffer;
  try {
    buffer = readStart(filePath, HEADER_READ_BYTES);
  } catch (_) {
    return { kind: "unknown", detail: "unreadable" };
  }

  if (buffer.toString("latin1", 0, 4) === "GGUF") {
    const architecture = readGgufArchitecture(buffer);
    if (!architecture) return { kind: "unknown", detail: "gguf" };
    if (IMAGE_ARCHITECTURES.has(architecture.toLowerCase())) return { kind: "image", detail: architecture };
    // "clip" is the mmproj file that gives a text model vision; it lives with the text models
    return { kind: "text", detail: architecture };
  }

  if (buffer.toString("latin1", 0, 4) === "lmgg") return { kind: "speech", detail: "whisper" };

  if (lower.endsWith(".ckpt")) return { kind: "image", detail: "checkpoint" };

  if (lower.endsWith(".safetensors")) {
    const keys = readSafetensorsKeys(filePath, buffer);
    if (!keys) return { kind: "unknown", detail: "safetensors" };
    const has = (pattern) => keys.some((key) => pattern.test(key));
    if (has(/^(model\.diffusion_model|first_stage_model|cond_stage_model|conditioner|double_blocks|single_blocks|joint_blocks)\./)) {
      return { kind: "image", detail: "diffusion" };
    }
    if (has(/^(model\.)?layers\.\d+\.(self_attn|mlp)\./) || has(/^lm_head\./)) return { kind: "text", detail: "transformer" };
    return { kind: "unknown", detail: "safetensors" };
  }

  return { kind: "unknown", detail: "" };
}

// Memoised by path, size and modified time so model lists stay fast
const cache = new Map();
function detectModelKindCached(filePath) {
  try {
    const stats = fs.statSync(filePath);
    const key = `${filePath}:${stats.size}:${stats.mtimeMs}`;
    if (!cache.has(key)) cache.set(key, detectModelKind(filePath));
    return cache.get(key);
  } catch (_) {
    return { kind: "unknown", detail: "missing" };
  }
}

module.exports = { detectModelKind, detectModelKindCached, readGgufArchitecture, IMAGE_ARCHITECTURES };
