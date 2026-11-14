// services/memory-admission.cjs — memory-aware text-model load admission (Step 9.9f-2).
//
// Design: docs/roadmap/STEP9_9F_MEMORY_ADMISSION.md. The text engine calls `decide()` once per load attempt, at the
// Step 9.9d memory-check point in services/llm-engine.cjs: after the previous engines were stopped and immediately
// before llama-server is spawned. It uses only the 9.9d assessment (no estimator of its own).
//
// Modes (setting `memoryAdmission`, default "off"):
//   off      not created at all; the load path is the one from before 9.9f-2.
//   observe  records what enforce would have done; never refuses, delays or changes a load.
//   enforce  refuses a load (409 MEMORY_INSUFFICIENT) only when the 9.9d verdict is "may-not-fit" AND every
//            high-confidence condition C1-C8 below was positively established. Anything missing, stale, approximate,
//            contradictory, unsupported or unreadable fails its condition, so it can never become a refusal.
//
// There is no override: a `memoryOverride` request field is ignored in every mode and only reported (the studio can't
// yet tell an authorized local caller from a remote one; design §5). Recovery paths (automatic restart, the chat
// out-of-memory retry, the safer-profile fallback, restoring a model after a benchmark) are assessed but never
// refused. If admission itself fails, the load continues ("fail open").
//
// Reports carry sizes, fixed words and reason codes only: no paths, file or model names, user names or prompts.
"use strict";

const fs = require("fs");
const path = require("path");

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const MODES = new Set(["off", "observe", "enforce"]);
// C3: the only available-memory sources validated for refusals. Windows ("available-physical": commit charge not
// considered) and macOS ("vm-stat": cached, approximate; "os-free-pages": pessimistic) stay low until validated and
// separately approved (design §4.2, §10).
const VALIDATED_SOURCES = Object.freeze({ linux: Object.freeze(["mem-available"]) });
const MAX_READING_AGE_MS = 2000;
// C7 (provisional, design §4.1): the files must exceed available memory by at least this much.
const MIN_SHORTFALL_BYTES = GIB;
const MIN_SHORTFALL_SHARE = 0.10;
// C8: only loads whose weights must be resident (memory mapping off). Every mapped load, with or without mlock, is low.
const RESIDENT_LOAD_MODES = new Set(["mlock", "none"]);
const EXEMPT_PATHS = new Set(["restart", "oom-retry", "profile-fallback", "benchmark-restore"]);
const PATHS = new Set(["start", "benchmark", ...EXEMPT_PATHS]);
// Linux v1 reports "no limit" as a huge page-aligned number.
const CGROUP_V1_UNLIMITED = 2 ** 60;
const INFLATE_RE = /^[1-9][0-9]{0,15}$/;

/**
 * Resolve the setting. Precedence: USAP_SCHEDULER=off, then USAP_MEMORY_ADMISSION, then scheduler.json
 * "memoryAdmission", then "off". Invalid values are ignored (listed in `ignored`), never coerced. Admission needs the
 * 9.9d check, so memoryCheck "off" forces it off. The test-only USAP_TEST_MEMORY_ADMISSION_INFLATE_BYTES can only
 * add to the estimated need (never lower it) and is used only when admission is not off.
 */
function memoryAdmissionSetting({ env = process.env, configDir, schedulerMode, memoryCheckMode = "warn" } = {}) {
  let cfg = {};
  if (configDir) {
    try { cfg = JSON.parse(fs.readFileSync(path.join(configDir, "scheduler.json"), "utf8")) || {}; } catch (_) { cfg = {}; }
  }
  if (!cfg || typeof cfg !== "object") cfg = {};
  const ignored = [];
  const word = (v, source, name) => {
    if (v === undefined || v === null || v === "") return null;
    const s = typeof v === "string" ? v.trim().toLowerCase() : null;
    if (s !== null && MODES.has(s)) return s;
    ignored.push({ name, source, reason: "allowed: off, observe, enforce" });
    return null;
  };
  const requested = word(env.USAP_MEMORY_ADMISSION, "environment", "USAP_MEMORY_ADMISSION") || word(cfg.memoryAdmission, "scheduler.json", "memoryAdmission") || "off";
  let mode = requested;
  let forcedOffBy = null;
  if (schedulerMode === "off") { mode = "off"; forcedOffBy = requested !== "off" ? "scheduler-off" : null; }
  else if (memoryCheckMode !== "warn") { mode = "off"; forcedOffBy = requested !== "off" ? "memory-check-off" : null; }
  let inflateBytes = 0;
  const rawInflate = env.USAP_TEST_MEMORY_ADMISSION_INFLATE_BYTES;
  if (rawInflate !== undefined && rawInflate !== "") {
    const s = String(rawInflate).trim();
    if (INFLATE_RE.test(s) && Number.isSafeInteger(Number(s))) inflateBytes = Number(s);
    else ignored.push({ name: "USAP_TEST_MEMORY_ADMISSION_INFLATE_BYTES", source: "environment", reason: "allowed: a positive whole number of bytes" });
  }
  if (mode === "off") inflateBytes = 0;
  return Object.freeze({ mode, requested, forcedOffBy, inflateBytes, ignored: Object.freeze(ignored.map((x) => Object.freeze(x))) });
}

/**
 * Linux: is this process inside a cgroup whose memory limit is below the machine's total? Walks from the process's
 * own cgroup up to the root. "none" only when every level was read and none limits memory below `totalBytes`;
 * "limited" when one does; "unknown" when anything can't be read or parsed (which fails C6).
 * @param {{ readFile?: (p: string) => string, totalBytes: number }} o
 */
function cgroupMemoryLimit({ readFile = (p) => fs.readFileSync(p, "utf8"), totalBytes } = {}) {
  if (!(totalBytes > 0)) return { state: "unknown" };
  let lines;
  try { lines = String(readFile("/proc/self/cgroup")).split("\n").map((l) => l.trim()).filter(Boolean); } catch (_) { return { state: "unknown" }; }
  const read = (file) => {
    try { return { ok: true, text: String(readFile(file)).trim() }; } catch (err) { return { ok: false, missing: Boolean(err && err.code === "ENOENT") }; }
  };
  const levels = (base, rel) => {
    const parts = rel.split("/").filter(Boolean);
    const out = [];
    for (let i = parts.length; i >= 0; i--) out.push(path.posix.join(base, ...parts.slice(0, i)));
    return out;
  };
  const v1 = lines.find((l) => { const f = l.split(":"); return f.length >= 3 && f[1].split(",").includes("memory"); });
  const v2 = lines.find((l) => l.startsWith("0::"));
  if (v1) {
    const rel = v1.split(":").slice(2).join(":") || "/";
    let seen = 0;
    for (const dir of levels("/sys/fs/cgroup/memory", rel)) {
      const r = read(path.posix.join(dir, "memory.limit_in_bytes"));
      if (!r.ok) { if (r.missing) continue; return { state: "unknown" }; }
      if (!/^[0-9]+$/.test(r.text)) return { state: "unknown" };
      seen += 1;
      const limit = Number(r.text);
      if (limit < CGROUP_V1_UNLIMITED && limit < totalBytes) return { state: "limited" };
    }
    return seen > 0 ? { state: "none" } : { state: "unknown" };
  }
  if (v2) {
    const rel = v2.slice(3) || "/";
    for (const dir of levels("/sys/fs/cgroup", rel)) {
      const r = read(path.posix.join(dir, "memory.max"));
      if (!r.ok) { if (r.missing) continue; return { state: "unknown" }; } // the root cgroup has no memory.max
      if (r.text === "max") continue;
      if (!/^[0-9]+$/.test(r.text)) return { state: "unknown" };
      if (Number(r.text) < totalBytes) return { state: "limited" };
    }
    // Confirm the hierarchy is really there (a missing mount would otherwise look like "no limit at every level").
    const ctl = read("/sys/fs/cgroup/cgroup.controllers");
    return ctl.ok ? { state: "none" } : { state: "unknown" };
  }
  return { state: "unknown" };
}

const gb = (n) => `${(n / GIB).toFixed(1)} GB`;
const known = (v) => Boolean(v && v.known === true && typeof v.value === "number" && Number.isFinite(v.value));

/**
 * The admission decision maker. `decide()` never throws and never awaits.
 * @param {object} o
 * @param {{ mode: "observe"|"enforce", inflateBytes?: number }} o.setting
 * @param {string} [o.platform]
 * @param {() => number} [o.now]
 * @param {(totalBytes: number) => { state: "none"|"limited"|"unknown" }} [o.cgroup]  Linux only
 * @param {(line: string) => void} [o.log]
 */
function createMemoryAdmission({ setting, platform = process.platform, now = Date.now, cgroup = (totalBytes) => cgroupMemoryLimit({ totalBytes }), log = (line) => console.log(line) } = {}) {
  const mode = setting && setting.mode === "enforce" ? "enforce" : "observe";
  const testInflation = Boolean(setting && setting.inflateBytes > 0);
  const counts = { allowed: 0, wouldRefuse: 0, refused: 0, exempt: 0, overrideIgnored: 0 };
  const lowConfidenceByReason = {};
  let last = null;
  let attempts = 0;

  // Each check returns null when the condition was positively established, or a reason code.
  function conditions(c) {
    const a = c.assessment;
    const reasons = [];
    const add = (r) => { if (r) reasons.push(r); };
    const available = a && a.available;
    const free = available && known(available.ramBytes) ? available.ramBytes.value : null;
    const total = available && known(available.totalRamBytes) ? available.totalRamBytes.value : null;
    const lower = a && a.required && known(a.required.lowerBoundBytes) ? a.required.lowerBoundBytes.value : null;
    const source = available && available.ramBytes ? available.ramBytes.source || null : null;
    const t = now();
    // The assessment must be this attempt's text-model assessment, and the attempt must still be current.
    if (!a || a.workload !== "text-model-load") add("assessment-missing");
    if (c.attemptCurrent !== true) add("attempt-not-current");
    // C1: system RAM only (no GPU offload, no Apple Silicon unified pool).
    add(a && a.memoryPool === "system-ram" ? null : "c1-memory-pool");
    // C2: every earlier engine process was seen to exit, and no supervised engine is still alive.
    add(c.release && c.release.confirmed === true ? null : "c2-release-unconfirmed");
    // C3: a live reading from a validated source, taken after the release, at most 2 s old.
    const validated = (VALIDATED_SOURCES[platform] || []).includes(source);
    add(validated ? null : "c3-source-unvalidated");
    const measuredAt = Number(c.measuredAt);
    const releasedAt = Number(c.release && c.release.releasedAt);
    const fresh = Number.isFinite(measuredAt) && Number.isFinite(releasedAt) && measuredAt >= releasedAt && t - measuredAt >= 0 && t - measuredAt <= MAX_READING_AGE_MS;
    add(fresh ? null : "c3-reading-stale");
    // C4: a plausible reading (the 9.9d verdict is not unknown, and free <= total).
    const implausible = !a || a.verdict === "unknown" || free === null || total === null || !(total > 0) || free < 0 || free > total ||
      (Array.isArray(a.reasons) && a.reasons.some((r) => /unavailable|implausible|assessment-error/.test(r)));
    add(implausible ? "c4-reading-implausible" : null);
    // C5: no other heavy workload starting, running or stopping (unknown activity fails).
    const act = c.activity;
    if (!act || typeof act !== "object") add("c5-activity-unknown");
    else if (Object.values(act).some((v) => v !== false)) add(Object.values(act).some((v) => v === true) ? "c5-other-workload" : "c5-activity-unknown");
    // C6: Linux only: no cgroup memory limit below the machine total (unreadable fails).
    if (platform === "linux") {
      let cg = { state: "unknown" };
      try { cg = total ? cgroup(total) : { state: "unknown" }; } catch (_) { cg = { state: "unknown" }; }
      add(cg && cg.state === "none" ? null : cg && cg.state === "limited" ? "c6-cgroup-limit" : "c6-cgroup-unknown");
    }
    // C7: a clear shortfall.
    const shortfallOk = lower !== null && free !== null && lower - free >= Math.max(MIN_SHORTFALL_BYTES, MIN_SHORTFALL_SHARE * lower);
    add(shortfallOk ? null : "c7-shortfall-small");
    // C8: the weights must be resident (memory mapping off).
    add(RESIDENT_LOAD_MODES.has(c.loadMode) ? null : "c8-memory-mapped");
    const measurement = free === null ? "missing" : !validated ? "unvalidated" : !fresh ? "stale" : "fresh";
    return { reasons: [...new Set(reasons)], measurement, source, ageMs: Number.isFinite(measuredAt) ? Math.max(0, t - measuredAt) : null, free, lower };
  }

  /**
   * @param {object} c
   * @param {object|null} c.assessment   the 9.9d result returned for THIS attempt (not a cached one)
   * @param {string} c.path              start | benchmark | restart | oom-retry | profile-fallback | benchmark-restore
   * @param {{ confirmed: boolean, releasedAt: number }} c.release
   * @param {number} c.measuredAt        when the memory reading for this attempt was taken
   * @param {string} c.loadMode          mmap | mmap+mlock | mlock | none
   * @param {object|null} c.activity     other workloads: every value must be exactly false for C5
   * @param {boolean} c.attemptCurrent   the start this attempt belongs to has not been cancelled or superseded
   * @param {boolean} c.overrideRequested a memoryOverride field was sent (ignored; reported only)
   * @returns {{ refuse: boolean, report: object, message: string|null }}
   */
  function decide(c = {}) {
    attempts += 1;
    let report;
    let refuse = false;
    let message = null;
    try {
      const p = PATHS.has(c.path) ? c.path : "start";
      const r = conditions(c);
      const verdict = c.assessment && typeof c.assessment.verdict === "string" ? c.assessment.verdict : "unknown";
      const confidence = r.reasons.length === 0 ? "high" : "low";
      const qualifies = verdict === "may-not-fit" && confidence === "high";
      let decision;
      if (EXEMPT_PATHS.has(p)) decision = "exempt";
      else if (!qualifies) decision = "allowed";
      else decision = mode === "enforce" ? "refused" : "would-refuse";
      refuse = decision === "refused";
      if (refuse) {
        message = `The model's files (${gb(r.lower)}) are larger than the memory available now (${gb(r.free)}), and memory mapping is off, ` +
          "so the whole model would have to fit in memory. It was not loaded. Close other programs and try again, choose a smaller model, " +
          "or load it with memory mapping on (slower if memory runs short).";
      }
      report = {
        stage: "9.9f-2",
        mode,
        decision,
        verdict,
        confidence,
        confidenceReasons: r.reasons,
        path: p,
        attempt: attempts,
        measurement: { state: r.measurement, source: r.source, ageMs: r.ageMs },
        release: c.release && c.release.confirmed === true ? "confirmed" : "unconfirmed",
        loadMode: typeof c.loadMode === "string" ? c.loadMode : null,
        override: c.overrideRequested === true ? { requested: true, accepted: false, reason: "unavailable" } : null,
        ...(testInflation ? { testInflation: true } : {}),
      };
    } catch (_) {
      refuse = false;
      message = null;
      report = { stage: "9.9f-2", mode, decision: "allowed", verdict: "unknown", confidence: "low", confidenceReasons: ["admission-error"], path: "start", attempt: attempts, measurement: null, release: "unconfirmed", loadMode: null, override: null };
    }
    try {
      if (report.decision === "would-refuse") counts.wouldRefuse += 1;
      else counts[report.decision] = (counts[report.decision] || 0) + 1;
      if (report.override) counts.overrideIgnored += 1;
      if (report.confidence === "low") for (const reason of report.confidenceReasons) lowConfidenceByReason[reason] = (lowConfidenceByReason[reason] || 0) + 1;
      last = report;
      log(describe(report));
    } catch (_) { /* reporting never matters more than loading */ }
    return { refuse, report, message };
  }

  return {
    mode,
    decide,
    snapshot: () => ({ mode, counts: { ...counts }, lowConfidenceByReason: { ...lowConfidenceByReason }, last }),
  };
}

/** One log line, without names or paths. */
function describe(r) {
  const why = r.confidence === "low" ? ` (${r.confidenceReasons.join(", ")})` : "";
  const override = r.override ? "; memoryOverride ignored" : "";
  return `  [memory] admission (${r.mode}): ${r.decision}; ${r.verdict}, ${r.confidence} confidence${why}; path ${r.path}${override}.`;
}

module.exports = { memoryAdmissionSetting, createMemoryAdmission, cgroupMemoryLimit, describe, VALIDATED_SOURCES, MAX_READING_AGE_MS, MIN_SHORTFALL_BYTES, MIN_SHORTFALL_SHARE, EXEMPT_PATHS };
