// services/whisper-thread-cap.cjs — whisper.cpp threads never exceed the server's logical CPUs
// (docs/roadmap/STEP9_9E_THREADS.md §8 and §9).
//
// At the whisper-cli spawn boundary the requested `-t` is clamped to the logical CPU count:
//
//     threads = min(requested, logicalCpus)       when logicalCpus is a known integer >= 1
//     threads = requested                         otherwise (unknown, zero or invalid CPU count: nothing invented)
//
// A request at or below the CPU count is used unchanged, and the count is never raised. It runs before the optional
// Step 9.9e overlap budget, which can only lower the result further. The CPU count is `os.cpus().length` (the same
// source as the server's default and the image engine's cap), never the physical-core heuristic. Nothing else is
// touched: the text and image engines, Kokoro, the 9.9e budget's default, queues and saved settings stay as they
// are, and no engine is restarted. A saved or requested value above the CPU count stays saved; only the `-t`
// passed to that job changes.
//
// Measured on hosted 3-4-vCPU runners only (§8): requests above the logical CPUs were slower on every target, by
// 3-10% on Linux and Windows, 13-57% on macOS Intel and 4-25x on the macOS arm64 VM. This is not a guaranteed
// improvement on hardware that wasn't measured; it only avoids asking for more threads than there are CPUs.
//
// Setting: USAP_WHISPER_THREAD_CAP=on|off, or app/config/scheduler.json { "whisperThreadCap": "on" | "off" } (the
// environment wins; other values are ignored). Default ON. USAP_SCHEDULER=off turns it off. Read at start-up.
// Off gives exactly the behaviour before the cap, including requests above the CPU count.
"use strict";

const fs = require("fs");
const path = require("path");

/** Resolve the setting. The environment wins over scheduler.json; USAP_SCHEDULER=off turns it off. Default on. */
function whisperThreadCapSetting({ env = process.env, configDir, schedulerMode } = {}) {
  let cfg = {};
  if (configDir) {
    try { cfg = JSON.parse(fs.readFileSync(path.join(configDir, "scheduler.json"), "utf8")) || {}; } catch (_) { cfg = {}; }
  }
  const pick = (v) => { const s = String(v == null ? "" : v).trim().toLowerCase(); return s === "on" || s === "off" ? s : null; };
  let mode = pick(env.USAP_WHISPER_THREAD_CAP) || pick(cfg && cfg.whisperThreadCap) || "on";
  if (schedulerMode === "off") mode = "off";
  return Object.freeze({ mode });
}

/** A usable logical CPU count, or null. */
function knownCpus(n) {
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * The rule itself (pure).
 * @param {{ requested: number, logicalCpus: number|null }} o
 * @returns {{ threads: number, capped: boolean, reason: string }}
 */
function capWhisperThreads({ requested, logicalCpus }) {
  if (!(Number.isInteger(requested) && requested >= 1)) return { threads: requested, capped: false, reason: "requested-invalid" };
  const cpus = knownCpus(logicalCpus);
  if (cpus === null) return { threads: requested, capped: false, reason: "cpu-count-unknown" };
  if (requested <= cpus) return { threads: requested, capped: false, reason: "within-cpus" };
  return { threads: cpus, capped: true, reason: "above-logical-cpus" };
}

/**
 * @param {object} o
 * @param {{ mode: "on"|"off" }} o.setting
 * @param {() => number} o.logicalCpus
 */
function createWhisperThreadCap({ setting = { mode: "on" }, logicalCpus, log = (line) => console.log(line), now = Date.now } = {}) {
  const on = setting.mode === "on";
  let last = null;
  let cappedJobs = 0;

  /** Threads for a transcription about to start. Never throws; off or unsure gives `requested`. */
  function forTranscription(requested) {
    if (!on) return requested;
    try {
      let cpus = null;
      try { cpus = knownCpus(logicalCpus()); } catch (_) { cpus = null; }
      const d = capWhisperThreads({ requested, logicalCpus: cpus });
      if (d.capped) cappedJobs++;
      // Numbers and fixed words only: no paths, file or model names.
      last = { requested, threads: d.threads, capped: d.capped, reason: d.reason, logicalCpus: cpus, at: new Date(now()).toISOString() };
      if (d.capped) {
        try { log(`  [threads] Transcription: ${d.threads} thread${d.threads === 1 ? "" : "s"} instead of ${requested} (the server has ${cpus} logical CPU${cpus === 1 ? "" : "s"}). Saved settings unchanged.`); } catch (_) { /* logging is optional */ }
      }
      return Number.isInteger(d.threads) && d.threads >= 1 && d.threads <= requested ? d.threads : requested;
    } catch (_) {
      return requested;
    }
  }

  return {
    mode: on ? "on" : "off",
    forTranscription,
    snapshot: () => (on ? { mode: "on", scope: "transcription", rule: "min(requested, logical CPUs)", cappedJobs, lastTranscription: last } : null),
  };
}

module.exports = { createWhisperThreadCap, capWhisperThreads, whisperThreadCapSetting };
