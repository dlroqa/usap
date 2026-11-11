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
function createScheduler({ budget, cpu, engines, now = Date.now }) {
  for (const [name, value] of Object.entries({ budget, cpu, engines })) {
    if (!value) throw new Error(`scheduler: missing dependency ${name}`);
  }

  function memory() {
    const totalRam = count(budget.totalRamBytes);
    const freeRam = count(budget.freeRamBytes);
    const totalVram = count(budget.totalVramBytes);
    const freeVram = (() => { try { const v = budget.freeVramBytes(); return v === null || v === undefined ? null : count(() => v); } catch (_) { return null; } })();
    return {
      ram: { totalBytes: known(totalRam), freeBytes: known(freeRam) },
      // A total of 0 means no GPU memory was detected: unknown, not "no VRAM needed".
      vram: { totalBytes: known(totalVram > 0 ? totalVram : null), freeBytes: known(freeVram) },
    };
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
    return {
      ok: true,
      scheduler: { mode: "observe", stage: "9.9b", decisions: false },
      generatedAt: new Date(now()).toISOString(),
      cpu: { logicalCores: known(count(cpu.logicalCores)), physicalCores: known(count(cpu.physicalCores)) },
      memory: memory(),
      heavyModel: engines.heavyModel(),
      engines: engineSnapshot(),
      // Every limit in the plan is off in this stage; nothing is refused or delayed.
      limits: { chatQueue: "off", memoryCheck: "off", threads: "off", queueTimeouts: "off" },
    };
  }

  return { snapshot };
}

module.exports = { createScheduler, schedulerMode };
