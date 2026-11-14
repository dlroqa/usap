// services/thread-budget.cjs — Step 9.9e thread budget, whisper only (docs/roadmap/STEP9_9E_THREADS.md).
//
// An advisory heuristic, not enforcement: when a transcription job starts while another CPU workload is busy (a chat
// running, an image generating, a voice job), whisper.cpp gets fewer threads for that job:
//
//     threads = max(1, min(requested, 2, logicalCpus - 1))
//
// Alone, the requested count is used unchanged, exactly as before. Nothing else is touched: the text (llama.cpp) and
// image (stable-diffusion.cpp) engines keep the thread counts they started with and are never restarted, Kokoro is
// left alone, and no request is refused, delayed or queued. A job that is already running keeps its count.
//
// "Busy" comes only from server state (running chats, image generation requests and engine progress, the voice
// job), never from a request. Anything unknown (CPU count, an activity check that fails) falls back to the requested
// count, so the policy can only ever lower a thread count when it is sure, never raise one.
//
// Setting: USAP_THREADS=on|off, or app/config/scheduler.json { "threads": "on" } (the environment wins). Default
// off; USAP_SCHEDULER=off turns it off too. Read at start-up. Off gives exactly the behaviour before 9.9e.
"use strict";

const fs = require("fs");
const path = require("path");

const SHARE = 2; // the measured per-job share when another workload is busy (STEP9_9E_THREADS.md §2)

/** Resolve the setting. The environment wins over scheduler.json; USAP_SCHEDULER=off turns it off. */
function threadsSetting({ env = process.env, configDir, schedulerMode } = {}) {
  let cfg = {};
  if (configDir) {
    try { cfg = JSON.parse(fs.readFileSync(path.join(configDir, "scheduler.json"), "utf8")) || {}; } catch (_) { cfg = {}; }
  }
  const pick = (v) => { const s = String(v || "").trim().toLowerCase(); return s === "on" || s === "off" ? s : null; };
  let mode = pick(env.USAP_THREADS) || pick(cfg.threads) || "off";
  if (schedulerMode === "off") mode = "off";
  return Object.freeze({ mode });
}

/**
 * The rule itself (pure).
 * @param {{ requested: number, logicalCpus: number|null, othersBusy: boolean }} o
 * @returns {{ threads: number, reduced: boolean, reason: string }}
 */
function perJobThreads({ requested, logicalCpus, othersBusy }) {
  const req = Number.isInteger(requested) && requested >= 1 ? requested : null;
  if (req === null) return { threads: requested, reduced: false, reason: "requested-invalid" };
  if (!othersBusy) return { threads: req, reduced: false, reason: "alone" };
  const cpus = Number.isInteger(logicalCpus) && logicalCpus >= 1 ? logicalCpus : null;
  if (cpus === null) return { threads: req, reduced: false, reason: "cpu-count-unknown" };
  const threads = Math.max(1, Math.min(req, SHARE, cpus - 1));
  return { threads, reduced: threads < req, reason: threads < req ? "other-workload-busy" : "within-share" };
}

/**
 * @param {object} o
 * @param {{ mode: "on"|"off" }} o.setting
 * @param {() => number} o.logicalCpus
 * @param {() => Record<string, boolean>} o.activity  busy flags from server state (e.g. { chat, image, voice })
 */
function createThreadBudget({ setting = { mode: "off" }, logicalCpus, activity = () => ({}), log = (line) => console.log(line), now = Date.now } = {}) {
  const on = setting.mode === "on";
  let last = null;

  /** Threads for a transcription job about to start. Never throws; off or unsure gives `requested`. */
  function forTranscription(requested) {
    if (!on) return requested;
    try {
      let busy;
      try { busy = Object.entries(activity() || {}).filter(([, v]) => v === true).map(([k]) => k).sort(); } catch (_) { busy = null; }
      let cpus = null;
      try { const n = logicalCpus(); cpus = Number.isInteger(n) && n >= 1 ? n : null; } catch (_) { cpus = null; }
      const decision = busy === null
        ? { threads: requested, reduced: false, reason: "activity-unknown" }
        : perJobThreads({ requested, logicalCpus: cpus, othersBusy: busy.length > 0 });
      last = { job: "transcription", requested, threads: decision.threads, reduced: decision.reduced, reason: decision.reason, busy: busy || [], logicalCpus: cpus, at: new Date(now()).toISOString() };
      if (decision.reduced) {
        try { log(`  [threads] Transcription: ${decision.threads} thread${decision.threads === 1 ? "" : "s"} instead of ${requested} (${busy.join(", ")} busy). Other engines unchanged.`); } catch (_) { /* logging is optional */ }
      }
      return decision.threads;
    } catch (_) {
      return requested;
    }
  }

  return {
    mode: on ? "on" : "off",
    forTranscription,
    snapshot: () => (on ? { mode: "on", stage: "9.9e", scope: "transcription", share: SHARE, lastTranscription: last } : null),
  };
}

module.exports = { createThreadBudget, perJobThreads, threadsSetting, SHARE };
