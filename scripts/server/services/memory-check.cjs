// services/memory-check.cjs — warn-only memory check before a model loads (Step 9.9d).
//
// Before the text engine (llama.cpp) or the image engine (stable-diffusion.cpp) starts with a model, this module
// compares what the model is estimated to need with the memory the operating system reports as available, and
// records an advisory result. It is observational only: it never refuses, delays, queues or reorders anything,
// never changes a model, backend, context size, thread count or any other setting, never stops or restarts an
// engine and never returns an HTTP error. A failure inside the check gives an "unknown" result, never an error.
//
// Measured values and estimates are kept apart, and every number says whether it is known. Unknown memory is
// never treated as enough (owner decision B, docs/roadmap/STEP9_9_SCHEDULING.md): when available memory or the
// model's needs can't be determined, the verdict is "unknown", never "likely-fits".
//
// The result names no model, file, folder, user, prompt or process argument: only sizes, a verdict and reason
// codes. The engines call it through an optional dependency (memoryAdvisor.beforeLoad), so leaving it out, or
// the setting `memoryCheck: off`, gives exactly the behaviour before 9.9d.
//
// Setting: USAP_MEMORY_CHECK=warn|off, or app/config/scheduler.json { "memoryCheck": "warn" | "off" } (the
// environment wins). Default "warn". USAP_SCHEDULER=off turns it off too. Read at start-up.
"use strict";

const fs = require("fs");
const path = require("path");

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
// Compute buffers and runtime allocations that the KV-cache estimate doesn't cover. The same allowance as
// model-metadata.cjs (Step 9.8f). An assumption, not a measurement.
const TEXT_OVERHEAD_BYTES = 256 * MIB;
// Room to leave for the operating system and other programs before calling an estimate "likely-fits".
const MIN_MARGIN_BYTES = 512 * MIB;
const MARGIN_SHARE_OF_TOTAL = 0.05;
// Bytes per cached value for llama.cpp --cache-type-k/-v (block size 32). Unknown types make the cache unknown.
const CACHE_BYTES_PER_VALUE = { f32: 4, f16: 2, bf16: 2, q8_0: 34 / 32, q5_1: 24 / 32, q5_0: 22 / 32, q4_1: 20 / 32, q4_0: 18 / 32, iq4_nl: 18 / 32 };
const Q8_0 = CACHE_BYTES_PER_VALUE.q8_0; // model-metadata.cjs estimates the cache with q8_0

const MODES = new Set(["warn", "off"]);

/** Resolve the setting. The environment wins over scheduler.json; USAP_SCHEDULER=off turns it off. */
function memoryCheckSetting({ env = process.env, configDir, schedulerMode } = {}) {
  let cfg = {};
  if (configDir) {
    try { cfg = JSON.parse(fs.readFileSync(path.join(configDir, "scheduler.json"), "utf8")) || {}; } catch (_) { cfg = {}; }
  }
  const pick = (v) => { const s = String(v || "").trim().toLowerCase(); return MODES.has(s) ? s : null; };
  let mode = pick(env.USAP_MEMORY_CHECK) || pick(cfg.memoryCheck) || "warn";
  if (schedulerMode === "off") mode = "off";
  return Object.freeze({ mode });
}

const value = (v, basis, extra = {}) => ({ value: v === null || v === undefined ? null : v, known: v !== null && v !== undefined, basis, ...extra });
const roundMib = (n) => Math.round(n / MIB) * MIB;
const gb = (n) => `${(n / GIB).toFixed(1)} GB`;

// Only a real finite number counts as a reading: null, "", false and strings would otherwise become 0 or a value
// nobody measured.
function readNumber(fn) {
  try {
    const n = fn();
    return typeof n === "number" && Number.isFinite(n) ? n : NaN;
  } catch (_) {
    return NaN;
  }
}

/**
 * Available and total RAM as measured by the platform, with malformed readings marked unknown.
 * @param {{ totalRamBytes: Function, freeRamBytes: Function, freeRamSource?: Function }} budget hardware.budget
 */
function measureMemory(budget, platform) {
  const reasons = [];
  let total = readNumber(() => budget.totalRamBytes());
  let free = readNumber(() => budget.freeRamBytes());
  if (!(total > 0)) { reasons.push("total-memory-unavailable"); total = null; }
  if (!(free >= 0)) { reasons.push("available-memory-unavailable"); free = null; }
  if (total !== null && free !== null && free > total) { reasons.push("available-memory-implausible"); free = null; }
  let source = null;
  try { source = typeof budget.freeRamSource === "function" ? String(budget.freeRamSource() || "") || null : null; } catch (_) { source = null; }
  if (platform === "darwin" && source === "os-free-pages") reasons.push("macos-available-memory-pessimistic");
  return { total, free, source, reasons };
}

function fileSize(p) {
  if (!p) return null;
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st.size : null;
  } catch (_) {
    return null;
  }
}

/**
 * What a text model is estimated to need: the GGUF file (and vision projector), the KV cache at the context
 * size the engine is started with, and a fixed allowance for compute buffers.
 */
function textRequirement(info, inspectModel, sizeOf) {
  const reasons = [];
  const weights = sizeOf(info.modelPath);
  const projector = info.projectorPath ? sizeOf(info.projectorPath) : 0;
  if (weights === null) reasons.push("model-size-unavailable");
  if (info.projectorPath && projector === null) reasons.push("projector-size-unavailable");
  const weightsBytes = weights === null || projector === null ? null : weights + projector;

  let kvCacheBytes = null;
  const contextSize = Number(info.contextSize) > 0 ? Math.round(Number(info.contextSize)) : null;
  if (!contextSize) reasons.push("context-size-unknown");
  else if (weights !== null) {
    let meta = null;
    try { meta = inspectModel(info.modelPath, { contextSize }); } catch (_) { meta = null; }
    const q8 = meta && meta.memory && Number.isFinite(meta.memory.kvCacheBytes) ? meta.memory.kvCacheBytes : null;
    const k = CACHE_BYTES_PER_VALUE[String(info.cacheTypeK || "q8_0").toLowerCase()];
    const v = CACHE_BYTES_PER_VALUE[String(info.cacheTypeV || "q8_0").toLowerCase()];
    if (q8 === null) reasons.push("model-metadata-missing");
    else if (!k || !v) reasons.push("cache-type-unknown");
    else kvCacheBytes = Math.round(q8 * ((k + v) / 2) / Q8_0); // K and V are the same size per layer here
  }
  const estimate = weightsBytes !== null && kvCacheBytes !== null ? roundMib(weightsBytes + kvCacheBytes + TEXT_OVERHEAD_BYTES) : null;
  return {
    reasons,
    contextSize,
    lowerBound: weightsBytes,
    estimate,
    parts: {
      weightsBytes: value(weightsBytes, "measured-file-size"),
      kvCacheBytes: value(kvCacheBytes === null ? null : roundMib(kvCacheBytes), "estimate-from-model-header", { cacheType: kvCacheBytes === null ? null : `${info.cacheTypeK || "q8_0"}/${info.cacheTypeV || "q8_0"}` }),
      overheadBytes: value(weightsBytes === null ? null : TEXT_OVERHEAD_BYTES, "fixed-allowance"),
    },
  };
}

/** Image models: only the model file is known. Working memory depends on resolution and pipeline. */
function imageRequirement(info, sizeOf) {
  const reasons = ["compute-memory-unknown"];
  const weights = sizeOf(info.modelPath);
  if (weights === null) reasons.push("model-size-unavailable");
  return {
    reasons,
    contextSize: null,
    lowerBound: weights,
    estimate: null,
    parts: { weightsBytes: value(weights, "measured-file-size"), workingBytes: value(null, "not-estimated") },
  };
}

// Which memory pool the comparison is about. Discrete GPU memory is not assessed in this stage: with layers
// offloaded, system RAM needs are lower and VRAM needs are unknown, so the result is "unknown".
function memoryPool({ kind, info, platform, arch }) {
  if (kind === "text") {
    const mode = String(info.backendMode || "");
    const gpuBackend = /GPU|CUDA|Vulkan|Metal|ROCm|SYCL|HIP/i.test(mode) || /^Auto/i.test(mode);
    const offload = gpuBackend && Number(info.gpuLayers) !== 0;
    if (!offload) return "system-ram";
    return platform === "darwin" && arch === "arm64" ? "unified" : "gpu-offload-not-assessed";
  }
  if (kind === "image") {
    if (!info.useGpu) return "system-ram";
    return platform === "darwin" && arch === "arm64" ? "unified" : "gpu-offload-not-assessed";
  }
  return "system-ram";
}

const MESSAGES = {
  "may-not-fit": (r, m) => `The model's files alone (${gb(r.lowerBound)}) are larger than the memory available now (${gb(m.free)}). Loading may fail, swap heavily or slow the computer down.`,
  tight: (r, m) => `The model is estimated to need about ${gb(r.estimate)} and ${gb(m.free)} is available now, which leaves little room for other programs.`,
};

/**
 * Assess one model load. Pure apart from reading file sizes and the model header; never throws.
 * @param {object} o
 * @param {"text"|"image"} o.kind
 * @param {object} o.info      text: { modelPath, projectorPath, contextSize, cacheTypeK, cacheTypeV, gpuLayers, backendMode }; image: { modelPath, useGpu }
 * @param {object} o.budget    hardware.budget (read-only)
 * @param {Function} o.inspectModel model-metadata.cjs inspectModel
 * @param {object} [o.activity] other work running now: { chatActive, imageGenerating, transcribing, synthesizing } (booleans)
 * @param {Function} [o.sizeOf] file size in bytes or null (tests inject this for very large models)
 */
function assessModelLoad({ kind, info = {}, budget, inspectModel, activity = {}, platform = process.platform, arch = process.arch, now = Date.now, sizeOf = fileSize }) {
  try {
    const mem = budget ? measureMemory(budget, platform) : { total: null, free: null, source: null, reasons: ["available-memory-unavailable"] };
    const req = kind === "text" ? textRequirement(info || {}, inspectModel, sizeOf) : kind === "image" ? imageRequirement(info || {}, sizeOf) : { reasons: ["workload-unknown"], lowerBound: null, estimate: null, contextSize: null, parts: {} };
    const pool = memoryPool({ kind, info, platform, arch });
    const reasons = [...mem.reasons, ...req.reasons];
    if (pool === "gpu-offload-not-assessed") reasons.push("gpu-memory-not-assessed");
    if (pool === "unified") reasons.push("unified-memory");
    const others = Object.entries(activity || {}).filter(([, on]) => on === true).map(([k]) => k).sort();
    if (others.length) reasons.push("other-workloads-active");

    const margin = mem.total ? Math.max(MIN_MARGIN_BYTES, Math.round(mem.total * MARGIN_SHARE_OF_TOTAL)) : MIN_MARGIN_BYTES;
    let verdict = "unknown";
    // Without a readable total, the available reading can't be checked for plausibility: unknown.
    if (pool === "gpu-offload-not-assessed" || mem.free === null || mem.total === null) verdict = "unknown";
    else if (req.lowerBound !== null && mem.free < req.lowerBound) verdict = "may-not-fit";
    else if (req.estimate === null) verdict = "unknown";
    else if (mem.free < req.estimate + margin) verdict = "tight";
    else verdict = "likely-fits";

    const message = MESSAGES[verdict] ? MESSAGES[verdict](req, mem) : null;
    return {
      stage: "9.9d",
      mode: "warn",
      advisory: true,
      enforced: false,
      workload: kind === "text" ? "text-model-load" : kind === "image" ? "image-model-load" : "unknown",
      at: new Date(now()).toISOString(),
      verdict,
      warning: message ? { code: verdict === "may-not-fit" ? "MEMORY_MAY_NOT_FIT" : "MEMORY_TIGHT", message } : null,
      memoryPool: pool,
      required: {
        estimateBytes: value(req.estimate, "estimate"),
        lowerBoundBytes: value(req.lowerBound, "measured-file-size"),
        contextSize: req.contextSize,
        parts: req.parts,
      },
      available: {
        ramBytes: value(mem.free, "measured", { source: mem.source }),
        totalRamBytes: value(mem.total, "measured"),
        marginBytes: value(margin, "fixed-rule"),
      },
      otherWorkloads: others,
      reasons: [...new Set(reasons)],
    };
  } catch (_) {
    return {
      stage: "9.9d", mode: "warn", advisory: true, enforced: false,
      workload: kind === "text" ? "text-model-load" : kind === "image" ? "image-model-load" : "unknown",
      at: new Date(now()).toISOString(), verdict: "unknown", warning: null, memoryPool: null,
      required: null, available: null, otherWorkloads: [], reasons: ["assessment-error"],
    };
  }
}

/** One log line, without names or paths. */
function describe(a) {
  const what = a.workload === "image-model-load" ? "Image model" : "Text model";
  const need = a.required && a.required.estimateBytes.known ? `needs about ${gb(a.required.estimateBytes.value)} (estimate${a.required.contextSize ? `, ${a.required.contextSize}-token context` : ""})`
    : a.required && a.required.lowerBoundBytes.known ? `files ${gb(a.required.lowerBoundBytes.value)}, total need unknown` : "need unknown";
  const have = a.available && a.available.ramBytes.known ? `${gb(a.available.ramBytes.value)} available (measured)` : "available memory unknown";
  return `  [memory] ${what}: ${a.verdict}; ${need}; ${have}. Warning only, loading continues.${a.reasons.length ? ` (${a.reasons.join(", ")})` : ""}`;
}

/**
 * The advisor the engines call. `beforeLoad` returns the assessment (or null when off) and never throws.
 * @param {{ mode: "warn"|"off" }} setting
 */
function createMemoryAdvisor({ setting = { mode: "warn" }, budget, inspectModel, activity = () => ({}), log = (line) => console.log(line), platform, arch, now, sizeOf } = {}) {
  const last = { text: null, image: null };
  const enabled = setting.mode === "warn";
  function beforeLoad(kind, info) {
    if (!enabled) return null;
    let current = {};
    try { current = activity() || {}; } catch (_) { current = {}; }
    const a = assessModelLoad({ kind, info, budget, inspectModel, activity: current, platform, arch, now, sizeOf });
    if (kind === "text" || kind === "image") last[kind] = a;
    try { log(describe(a)); } catch (_) { /* logging never matters more than loading */ }
    return a;
  }
  return {
    mode: enabled ? "warn" : "off",
    beforeLoad,
    last: (kind) => (enabled ? last[kind] || null : null),
    snapshot: () => (enabled ? { text: last.text, image: last.image } : null),
  };
}

module.exports = { createMemoryAdvisor, assessModelLoad, memoryCheckSetting, describe, CACHE_BYTES_PER_VALUE, TEXT_OVERHEAD_BYTES, MIN_MARGIN_BYTES };
