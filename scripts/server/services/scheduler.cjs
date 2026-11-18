// services/scheduler.cjs — resource accounting (Step 9.9b: observe only).
//
// This stage makes no scheduling decisions: it never refuses, queues, delays, unloads or re-prioritizes
// anything, and it changes no thread count or memory setting. It only reads what the engines and the hardware
// service already know and reports it through GET /api/resources (routes/resources.cjs). Later stages
// (docs/roadmap/STEP9_9_SCHEDULING.md, 9.9c-9.9f) add limits, each behind its own setting and approval.
//
// Every value says whether it is known. Unknown memory is reported as unknown (null with known: false), never
// as zero or as "fits" (owner decision B). No paths, model names, prompts, conversation content, client
// addresses or other identifiers are reported.
//
// Rollback: USAP_SCHEDULER=off (or "scheduler": "off" in app/config/scheduler.json) leaves the route
// unregistered, so the server answers exactly as before 9.9b.
"use strict";

const fs = require("fs");
const path = require("path");

const MODES = new Set(["observe", "off"]);

/** Resolve the mode: the environment wins over the config file; anything unknown means "observe". */
function schedulerMode({ env = process.env, configDir } = {}) {
  const fromEnv = String(env.USAP_SCHEDULER || "").trim().toLowerCase();
  if (MODES.has(fromEnv)) return fromEnv;
  if (configDir) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(configDir, "scheduler.json"), "utf8"));
      const fromFile = String((cfg && cfg.scheduler) || "").trim().toLowerCase();
      if (MODES.has(fromFile)) return fromFile;
    } catch (_) { /* no file or not JSON: default */ }
  }
  return "observe";
}

/**
 * Step 9.9c chat queue setting. Off unless USAP_CHAT_QUEUE=on or app/config/scheduler.json has "chatQueue": "on";
 * the environment wins, and USAP_SCHEDULER=off turns it off too. Read at start-up: changing it needs a restart.
 * chatQueueMaxWaitMs (or USAP_CHAT_QUEUE_MAX_WAIT_MS) sets the longest wait, 1 s to 1 hour, default 10 minutes.
 */
function chatQueueSetting({ env = process.env, configDir } = {}) {
  let cfg = {};
  if (configDir) {
    try { cfg = JSON.parse(fs.readFileSync(path.join(configDir, "scheduler.json"), "utf8")) || {}; } catch (_) { cfg = {}; }
  }
  const pick = (v) => { const s = String(v || "").trim().toLowerCase(); return s === "on" || s === "off" ? s : null; };
  let mode = pick(env.USAP_CHAT_QUEUE) || pick(cfg.chatQueue) || "off";
  if (schedulerMode({ env, configDir }) === "off") mode = "off";
  const validWait = (v) => { const n = Number(v); return v !== undefined && v !== null && v !== "" && Number.isFinite(n) && n >= 1000 && n <= 3600000 ? Math.round(n) : null; };
  const maxWaitMs = validWait(env.USAP_CHAT_QUEUE_MAX_WAIT_MS) || validWait(cfg.chatQueueMaxWaitMs) || 600000;
  return Object.freeze({ mode, limit: 4, maxWaitMs });
}

const count = (fn) => {
  try {
    const n = Number(fn());
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch (_) {
    return null;
  }
};
const known = (value) => ({ value: value === null || value === undefined ? null : value, known: value !== null && value !== undefined });
const queue = (pending) => (pending === null
  ? { running: null, waiting: null, known: false }
  : { running: Math.min(1, pending), waiting: Math.max(0, pending - 1), known: true });

/**
 * @param {object} deps
 * @param {{ totalRamBytes: Function, freeRamBytes: Function, totalVramBytes: Function, freeVramBytes: Function }} deps.budget  hardware.budget (read-only)
 * @param {{ logicalCores: Function, physicalCores: Function }} deps.cpu
 * @param {object} deps.engines  read-only accessors per engine (see serve.cjs)
 * @param {() => number} [deps.now]
 */
// Step 9.9d: `memoryCheck` is the warn-only memory check setting and `memoryChecks()` the advisor's latest results
// (services/memory-check.cjs). Both are optional; without them the snapshot is exactly the 9.9c one.
// Step 9.9e: `threads` is the thread-budget setting and `threadBudget()` its latest decision (services/thread-budget.cjs).
// Optional; without them (or with threads off) the snapshot is exactly the 9.9d one.
function createScheduler({ budget, cpu, engines, now = Date.now, chatQueue = { mode: "off" }, memoryCheck = { mode: "off" }, memoryChecks = null, threads = { mode: "off" }, threadBudget = null, whisperThreadCap = null, chatTimeouts = null, memoryAdmission = null, engineSlot = null, voiceQueue = null, transcriptionQueue = null }) {
  for (const [name, value] of Object.entries({ budget, cpu, engines })) {
    if (!value) throw new Error(`scheduler: missing dependency ${name}`);
  }

  const memoryWarn = memoryCheck.mode === "warn";
  const threadsOn = threads.mode === "on";
  function memory() {
    const totalRam = count(budget.totalRamBytes);
    const freeRam = count(budget.freeRamBytes);
    const totalVram = count(budget.totalVramBytes);
    const freeVram = (() => { try { const v = budget.freeVramBytes(); return v === null || v === undefined ? null : count(() => v); } catch (_) { return null; } })();
    const out = {
      ram: { totalBytes: known(totalRam), freeBytes: known(freeRam) },
      // A total of 0 means no GPU memory was detected: unknown, not "no VRAM needed".
      vram: { totalBytes: known(totalVram > 0 ? totalVram : null), freeBytes: known(freeVram) },
    };
    // Additive (9.9d): the latest warn-only result per engine, null until a model was loaded.
    if (memoryWarn) {
      let checks = null;
      try { checks = memoryChecks ? memoryChecks() : null; } catch (_) { checks = null; }
      out.checks = { text: (checks && checks.text) || null, image: (checks && checks.image) || null };
    }
    return out;
  }

  function engineSnapshot() {
    const e = engines;
    const text = e.text();
    const image = e.image();
    const speech = e.speech();
    const voice = e.voice();
    return {
      text: {
        state: text.state,
        loaded: text.loaded,
        operations: queue(count(text.pendingOperations)),
        chat: { active: count(text.chatActive), waitingForEngineConnection: count(text.chatWaiting) },
      },
      image: {
        state: image.state,
        loaded: image.loaded,
        generating: image.generating,
        // The studio passes image requests straight to the engine; it keeps no queue it could count.
        queue: { running: null, waiting: null, known: false },
      },
      speech: { state: speech.state, transcribing: speech.active, operations: queue(count(speech.pendingOperations)) },
      voice: { state: voice.state, synthesizing: voice.active, operations: queue(count(voice.pendingOperations)) },
      download: { active: Boolean(e.download().active) },
    };
  }

  function snapshot() {
    const out = {
      ok: true,
      // Memory warnings are not decisions: they never refuse or delay anything. A lowered transcription thread
      // count (9.9e, when on) is one.
      scheduler: { mode: chatQueue.mode === "on" ? "chat-queue" : "observe", stage: threadsOn ? "9.9e" : memoryWarn ? "9.9d" : "9.9c", decisions: chatQueue.mode === "on" || threadsOn },
      generatedAt: new Date(now()).toISOString(),
      cpu: { logicalCores: known(count(cpu.logicalCores)), physicalCores: known(count(cpu.physicalCores)) },
      memory: memory(),
      heavyModel: engines.heavyModel(),
      engines: engineSnapshot(),
      // Every limit in the plan is off in this stage; nothing is refused or delayed.
      limits: { chatQueue: chatQueue.mode === "on" ? "on" : "off", memoryCheck: memoryWarn ? "warn" : "off", threads: threadsOn ? "on" : "off", queueTimeouts: chatQueue.mode === "on" ? "chat" : "off" },
    };
    // Additive (only when the whisper logical-CPU cap is on, its default): requested and used counts of the latest
    // transcription, numbers only. Absent when off, so the snapshot is then exactly the previous one.
    if (whisperThreadCap) {
      let capReport = null;
      try { capReport = whisperThreadCap(); } catch (_) { capReport = null; }
      if (capReport) out.whisperThreadCap = capReport;
    }
    // Additive (9.9f-1, only when chatTimeouts is observe or on): the setting in effect, counters and the engine
    // guard's state; numbers and fixed words only. Absent when off (the default).
    if (chatTimeouts) {
      let t = null;
      try { t = chatTimeouts(); } catch (_) { t = null; }
      if (t) { out.limits.runningTimeouts = t.mode; out.chatTimeouts = t; }
    }
    // Additive (9.9f-2, only when memoryAdmission is observe or enforce): mode, decision counts, why confidence was
    // low, and the latest decision; sizes, fixed words and codes only. Absent when off (the default).
    if (memoryAdmission) {
      let m = null;
      try { m = memoryAdmission(); } catch (_) { m = null; }
      if (m) {
        out.limits.memoryAdmission = m.mode;
        out.memoryAdmission = m;
        if (m.mode === "enforce") out.scheduler.decisions = true; // a refusal is a decision; observe makes none
      }
    }
    // Additive (Step 9.9f-3, only when voiceQueue is on): running/waiting/limit on the voice engine, the longest wait
    // and counts; numbers and fixed words only (no text, voices or file names). Absent when off (the default).
    if (voiceQueue) {
      let v = null;
      try { v = voiceQueue(); } catch (_) { v = null; }
      if (v) {
        out.limits.voiceQueue = "on";
        out.engines.voice.queue = { running: v.running, waiting: v.waiting, known: true, limit: v.limit };
        out.voiceQueue = { mode: "on", limit: v.limit, maxWaitSeconds: v.maxWaitSeconds, counts: v.counts };
        out.scheduler.decisions = true; // a refusal is a decision
      }
    }
    // Additive (Step 9.9f-3, only when transcriptionQueue is on): running/waiting/uploading/limit on the speech engine, the
    // longest wait, the storage budget and what is booked, and counts; numbers and fixed words only (no names, paths,
    // text or languages). Absent when off (the default).
    if (transcriptionQueue) {
      let q = null;
      try { q = transcriptionQueue(); } catch (_) { q = null; }
      if (q) {
        out.limits.transcriptionQueue = "on";
        out.engines.speech.queue = { running: q.running, waiting: q.waiting, uploading: q.uploading, known: true, limit: q.limit };
        out.transcriptionQueue = { mode: "on", limit: q.limit, maxWaitSeconds: q.maxWaitSeconds, storage: q.storage, counts: q.counts };
        if (q.uploadConnections) out.transcriptionQueue.uploadConnections = q.uploadConnections; // #131
        out.scheduler.decisions = true; // a refusal is a decision
      }
    }
    // Additive (issue #105, only when engineSlot is on): owner kind, phase, epoch, counts and unconfirmed exits;
    // fixed words and numbers only (no model names, PIDs or paths). Absent when off (the default).
    if (engineSlot) {
      let e = null;
      try { e = engineSlot(); } catch (_) { e = null; }
      if (e) { out.limits.engineSlot = "on"; out.engineSlot = e; }
    }
    if (!threadsOn) return out;
    // Additive (9.9e, only when on): the budget's scope and its latest transcription decision (a report; the
    // scheduler itself still sets no thread count).
    let budgetReport = null;
    try { budgetReport = threadBudget ? threadBudget() : null; } catch (_) { budgetReport = null; }
    return { ...out, threads: budgetReport };
  }

  return { snapshot };
}

module.exports = { createScheduler, schedulerMode, chatQueueSetting };
