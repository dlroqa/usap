// model-metadata.cjs — read-only facts about a model file (Step 9.8f).
//
// Reports a model's format, quantization, architecture, the engine in this studio that runs it, its size
// and a rough memory estimate, from the file's own header. It never loads a model, converts anything or
// changes which engine or settings are used. Everything it reports is informational.
//
// GGUF is read with bounded, positional reads: at most READ_LIMIT bytes, with limits on key, tensor and
// string counts, so a damaged or hostile header gives "unknown" fields or a warning instead of an error.
"use strict";

const fs = require("fs");
const path = require("path");
const { detectModelKind, IMAGE_ARCHITECTURES } = require("./model-kind.cjs");

const READ_LIMIT = 64 * 1024 * 1024; // metadata + tensor index; vocabularies are a few MB
const MAX_KEYS = 100000;
const MAX_TENSORS = 1000000;
const MAX_KEPT_STRING = 4096;

// llama.cpp `enum llama_ftype` (general.file_type). Gaps are removed historical values.
const FILE_TYPES = {
  0: "F32", 1: "F16", 2: "Q4_0", 3: "Q4_1", 7: "Q8_0", 8: "Q5_0", 9: "Q5_1", 10: "Q2_K", 11: "Q3_K_S", 12: "Q3_K_M",
  13: "Q3_K_L", 14: "Q4_K_S", 15: "Q4_K_M", 16: "Q5_K_S", 17: "Q5_K_M", 18: "Q6_K", 19: "IQ2_XXS", 20: "IQ2_XS",
  21: "Q2_K_S", 22: "IQ3_XS", 23: "IQ3_XXS", 24: "IQ1_S", 25: "IQ4_NL", 26: "IQ3_S", 27: "IQ3_M", 28: "IQ2_S",
  29: "IQ2_M", 30: "IQ4_XS", 31: "IQ1_M", 32: "BF16", 36: "TQ1_0", 37: "TQ2_0", 38: "MXFP4_MOE",
};
// ggml `enum ggml_type` (per tensor), with bits per weight for the common types.
const TENSOR_TYPES = {
  0: ["F32", 32], 1: ["F16", 16], 2: ["Q4_0", 4.5], 3: ["Q4_1", 5], 6: ["Q5_0", 5.5], 7: ["Q5_1", 6], 8: ["Q8_0", 8.5],
  9: ["Q8_1", 9], 10: ["Q2_K", 2.625], 11: ["Q3_K", 3.4375], 12: ["Q4_K", 4.5], 13: ["Q5_K", 5.5], 14: ["Q6_K", 6.5625],
  15: ["Q8_K", 9.125], 16: ["IQ2_XXS", 2.0625], 17: ["IQ2_XS", 2.3125], 18: ["IQ3_XXS", 3.0625], 19: ["IQ1_S", 1.5625],
  20: ["IQ4_NL", 4.5], 21: ["IQ3_S", 3.4375], 22: ["IQ2_S", 2.5], 23: ["IQ4_XS", 4.25], 24: ["I8", 8], 25: ["I16", 16],
  26: ["I32", 32], 27: ["I64", 64], 28: ["F64", 64], 29: ["IQ1_M", 1.75], 30: ["BF16", 16], 34: ["TQ1_0", 1.6875],
  35: ["TQ2_0", 2.0625], 39: ["MXFP4", 4.25],
};
const FILENAME_QUANT = /(?:^|[-_.])((?:I?Q\d(?:_[A-Z0-9]+)*)|BF16|F16|F32|FP16|FP32)(?=[-_.]|$)/i;

const GGUF = { UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5, FLOAT32: 6, BOOL: 7, STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12 };
const SCALAR_SIZE = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

class HeaderError extends Error {}

// Positional reader over a file descriptor, never past READ_LIMIT or the end of the file. Reads in
// 1 MB chunks, so a vocabulary of 150,000 strings costs a few reads, not 300,000.
const CHUNK = 1024 * 1024;
function reader(fd, size) {
  const limit = Math.min(size, READ_LIMIT);
  let pos = 0;
  let chunk = Buffer.alloc(0);
  let chunkStart = 0;
  const take = (n) => {
    if (!Number.isSafeInteger(n) || n < 0 || pos + n > limit) throw new HeaderError("header is longer than the file or the read limit");
    if (pos < chunkStart || pos + n > chunkStart + chunk.length) {
      const length = Math.min(Math.max(n, CHUNK), limit - pos);
      chunk = Buffer.alloc(length);
      fs.readSync(fd, chunk, 0, length, pos);
      chunkStart = pos;
    }
    const out = chunk.subarray(pos - chunkStart, pos - chunkStart + n);
    pos += n;
    return out;
  };
  const u64 = () => { const v = take(8).readBigUInt64LE(0); if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new HeaderError("value out of range"); return Number(v); };
  const skip = (n) => { if (!Number.isSafeInteger(n) || n < 0 || pos + n > limit) throw new HeaderError("header is longer than the file or the read limit"); pos += n; };
  return {
    u32: () => take(4).readUInt32LE(0),
    u64,
    skip,
    // Long strings (and ones not needed) are skipped, never read into memory.
    str: (keep = true) => {
      const n = u64();
      if (!keep || n > MAX_KEPT_STRING) { skip(n); return null; }
      return take(n).toString("utf8");
    },
    scalar: (type) => {
      const b = take(SCALAR_SIZE[type]);
      switch (type) {
        case GGUF.UINT8: return b.readUInt8(0);
        case GGUF.INT8: return b.readInt8(0);
        case GGUF.UINT16: return b.readUInt16LE(0);
        case GGUF.INT16: return b.readInt16LE(0);
        case GGUF.UINT32: return b.readUInt32LE(0);
        case GGUF.INT32: return b.readInt32LE(0);
        case GGUF.FLOAT32: return b.readFloatLE(0);
        case GGUF.BOOL: return b.readUInt8(0) !== 0;
        case GGUF.UINT64: return Number(b.readBigUInt64LE(0));
        case GGUF.INT64: return Number(b.readBigInt64LE(0));
        case GGUF.FLOAT64: return b.readDoubleLE(0);
        default: throw new HeaderError(`unknown value type ${type}`);
      }
    },
  };
}

function readGguf(filePath, size) {
  const fd = fs.openSync(filePath, "r");
  try {
    const r = reader(fd, size);
    if (r.u32() !== 0x46554747) throw new HeaderError("not a GGUF file"); // "GGUF"
    const version = r.u32();
    if (version < 2 || version > 3) return { version, kv: {}, tensors: null, warning: `GGUF version ${version} is not supported here` };
    const tensorCount = r.u64();
    const kvCount = r.u64();
    if (kvCount > MAX_KEYS || tensorCount > MAX_TENSORS) throw new HeaderError("implausible key or tensor count");
    const kv = {};
    const skipValue = (type, depth = 0) => {
      if (type === GGUF.STRING) { r.str(false); return; }
      if (type === GGUF.ARRAY) {
        if (depth > 2) throw new HeaderError("arrays nested too deeply");
        const itemType = r.u32();
        const count = r.u64();
        if (itemType === GGUF.STRING || itemType === GGUF.ARRAY) { for (let i = 0; i < count; i += 1) skipValue(itemType, depth + 1); return; }
        if (!SCALAR_SIZE[itemType]) throw new HeaderError(`unknown array type ${itemType}`);
        r.skip(count * SCALAR_SIZE[itemType]);
        return;
      }
      if (!SCALAR_SIZE[type]) throw new HeaderError(`unknown value type ${type}`);
      r.skip(SCALAR_SIZE[type]);
    };
    for (let i = 0; i < kvCount; i += 1) {
      const key = r.str();
      if (key === null) throw new HeaderError("key name too long");
      const type = r.u32();
      if (type === GGUF.STRING) kv[key] = r.str();
      else if (type === GGUF.ARRAY) skipValue(type);
      else if (SCALAR_SIZE[type]) kv[key] = r.scalar(type);
      else throw new HeaderError(`unknown value type ${type}`);
    }
    // Tensor index: name, dimensions, type, offset. Counted by type, weighted by element count.
    const byType = {};
    for (let i = 0; i < tensorCount; i += 1) {
      r.str(false);
      const dims = r.u32();
      if (dims > 8) throw new HeaderError("implausible tensor dimensions");
      let elements = 1;
      for (let d = 0; d < dims; d += 1) elements *= r.u64();
      const type = r.u32();
      r.skip(8);
      byType[type] = (byType[type] || 0) + elements;
    }
    return { version, kv, tensors: { count: tensorCount, byType } };
  } finally {
    fs.closeSync(fd);
  }
}

function dominantTensorType(byType) {
  // The weights: ignore F32 (norms, biases) unless nothing else is there.
  const entries = Object.entries(byType).map(([t, n]) => [Number(t), n]).sort((a, b) => b[1] - a[1]);
  const weights = entries.filter(([t]) => t !== 0);
  const [type] = (weights.length ? weights : entries)[0] || [];
  return type === undefined ? null : (TENSOR_TYPES[type] ? TENSOR_TYPES[type][0] : `type ${type}`);
}

function quantFromName(filename) {
  const m = FILENAME_QUANT.exec(path.basename(filename).replace(/\.(gguf|bin|safetensors|ckpt)$/i, ""));
  return m ? m[1].toUpperCase().replace(/^FP/, "F") : null;
}

function engineFor(format, kind, architecture) {
  if (format === "gguf") {
    if (architecture && IMAGE_ARCHITECTURES.has(architecture.toLowerCase())) return "stable-diffusion.cpp";
    if (architecture === "clip") return "llama.cpp (vision projector)";
    return kind === "text" ? "llama.cpp" : null;
  }
  if (format === "safetensors" || format === "ckpt") return kind === "image" ? "stable-diffusion.cpp" : null;
  if (format === "ggml") return "whisper.cpp";
  if (format === "coreml") return "Core ML (macOS)";
  return null;
}

// Rough memory need of a GGUF text model: the weights (memory-mapped) plus the KV cache at `contextSize`
// with q8_0 cache (the studio's default), plus a fixed allowance for compute buffers.
function estimateTextMemory(kv, architecture, sizeBytes, contextSize) {
  const a = (k) => kv[`${architecture}.${k}`];
  const layers = Number(a("block_count")) || 0;
  const heads = Number(a("attention.head_count")) || 0;
  const kvHeads = Number(a("attention.head_count_kv")) || heads;
  const embedding = Number(a("embedding_length")) || 0;
  const keyLength = Number(a("attention.key_length")) || (heads ? embedding / heads : 0);
  const valueLength = Number(a("attention.value_length")) || keyLength;
  if (!layers || !kvHeads || !keyLength) return { weightsBytes: sizeBytes, kvCacheBytes: null, totalBytes: null, contextSize };
  const bytesPerValue = 34 / 32; // q8_0: 32 values in 34 bytes
  const kvCacheBytes = Math.round(layers * contextSize * kvHeads * (keyLength + valueLength) * bytesPerValue);
  const overhead = 256 * 1024 * 1024;
  return { weightsBytes: sizeBytes, kvCacheBytes, totalBytes: sizeBytes + kvCacheBytes + overhead, contextSize };
}

/**
 * @param {string} filePath a model file (or a Core ML folder)
 * @param {{contextSize?: number}} [options] context size for the text-model estimate (default 4096)
 */
function inspectModel(filePath, { contextSize = 4096 } = {}) {
  const warnings = [];
  let stats;
  try { stats = fs.statSync(filePath); } catch (_) { return { format: "unknown", sizeBytes: 0, warnings: ["The file can't be read."] }; }
  const lower = filePath.toLowerCase();
  if (stats.isDirectory()) {
    if (/\.(coreml|mlmodelc|mlpackage)$/.test(lower)) {
      return { format: "coreml", kind: "image", architecture: null, quantization: null, engine: engineFor("coreml"), compatible: null, sizeBytes: null, memory: null, warnings };
    }
    return { format: "unknown", sizeBytes: null, warnings: ["This is a folder, not a model file."] };
  }
  const sizeBytes = stats.size;
  const detected = detectModelKind(filePath);
  const kind = detected.kind;
  // `engine` is the engine that runs this kind of file. Whether this file loads in the shipped engine version is
  // not checked (issue #61), so `compatible` is always null: detected metadata, not confirmed compatibility.
  const result = { format: "unknown", kind, architecture: null, name: null, quantization: null, engine: null, compatible: null, sizeBytes, contextLength: null, parameters: null, memory: null, warnings };

  const head = Buffer.alloc(4);
  try { const fd = fs.openSync(filePath, "r"); try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); } } catch (_) { /* empty file */ }
  const magic = head.toString("latin1");

  if (magic === "GGUF") {
    result.format = "gguf";
    let gguf = null;
    try {
      gguf = readGguf(filePath, sizeBytes);
    } catch (err) {
      warnings.push(`The GGUF header couldn't be read completely (${err instanceof HeaderError ? err.message : "read error"}).`);
    }
    if (gguf && gguf.warning) warnings.push(`${gguf.warning}.`);
    const kv = (gguf && gguf.kv) || {};
    result.ggufVersion = gguf ? gguf.version : null;
    result.architecture = typeof kv["general.architecture"] === "string" ? kv["general.architecture"] : (detected.detail && detected.detail !== "gguf" ? detected.detail : null);
    result.name = typeof kv["general.name"] === "string" ? kv["general.name"] : null;
    const arch = result.architecture;
    if (arch && Number(kv[`${arch}.context_length`])) result.contextLength = Number(kv[`${arch}.context_length`]);
    if (typeof kv["general.size_label"] === "string") result.parameters = kv["general.size_label"];
    if (Number.isInteger(kv["general.file_type"])) {
      const ft = kv["general.file_type"];
      result.quantization = { type: FILE_TYPES[ft] || `file type ${ft}`, source: "header" };
    } else if (gguf && gguf.tensors && Object.keys(gguf.tensors.byType).length) {
      result.quantization = { type: dominantTensorType(gguf.tensors.byType), source: "tensors" };
    } else if (quantFromName(filePath)) {
      result.quantization = { type: quantFromName(filePath), source: "file name" };
    }
    result.engine = engineFor("gguf", kind, arch);
    if (kind === "text" && arch && arch !== "clip") result.memory = estimateTextMemory(kv, arch, sizeBytes, contextSize);
    else result.memory = { weightsBytes: sizeBytes, kvCacheBytes: null, totalBytes: null, contextSize: null };
  } else if (magic === "lmgg") {
    result.format = "ggml";
    result.architecture = "whisper";
    const q = quantFromName(filePath);
    result.quantization = q ? { type: q, source: "file name" } : null;
    result.engine = engineFor("ggml");
    result.memory = { weightsBytes: sizeBytes, kvCacheBytes: null, totalBytes: null, contextSize: null };
  } else if (lower.endsWith(".safetensors")) {
    result.format = "safetensors";
    result.architecture = detected.detail === "safetensors" ? null : detected.detail;
    const q = quantFromName(filePath);
    result.quantization = q ? { type: q, source: "file name" } : null;
    result.engine = engineFor("safetensors", kind);
    if (kind === "text") warnings.push("Text models in safetensors format can't be run here; the chat engine needs GGUF.");
    if (kind === "unknown") warnings.push("The safetensors header couldn't be read or isn't a known model type.");
    result.memory = { weightsBytes: sizeBytes, kvCacheBytes: null, totalBytes: null, contextSize: null };
  } else if (lower.endsWith(".ckpt")) {
    result.format = "ckpt";
    result.engine = engineFor("ckpt", kind);
    result.memory = { weightsBytes: sizeBytes, kvCacheBytes: null, totalBytes: null, contextSize: null };
  } else {
    warnings.push("This file type isn't a model format the studio's engines read.");
  }
  if (!result.engine && result.format !== "unknown") warnings.push("No engine in this studio is known to run this file.");
  return result;
}

module.exports = { inspectModel, FILE_TYPES, TENSOR_TYPES, READ_LIMIT };
