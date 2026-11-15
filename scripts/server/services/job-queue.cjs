// services/job-queue.cjs — bounded per-engine job queue (Step 9.9f-3, docs/roadmap/STEP9_9F_WORKLOAD_QUEUES.md).
//
// The same policy as the 9.9c chat queue (services/chat-queue.cjs, which is left unchanged): one job runs at a time,
// at most `limit` more wait behind it, first in, first out. A full queue answers 429 QUEUE_FULL with a Retry-After
// estimate; a job that waits longer than `maxWaitMs` gets 503 QUEUE_TIMEOUT; a waiting job whose client disconnects
// leaves at once and never runs. `release()` is idempotent, so a job is settled exactly once whatever ends it.
// It orders inference jobs only: it never starts, stops or restarts an engine (lifecycle stays in the engine chains).
//
// Used by the voice queue (voiceQueue, off by default). Off: not created, and the route is the one from before.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_SERVICE_MS = 10000;
const MIN_WAIT_MS = 1000;
const MAX_WAIT_MS = 60 * 60 * 1000;

/**
 * A queue setting: `envName` (environment, wins) or scheduler.json `name`, on | off, default off. USAP_SCHEDULER=off
 * forces it off. The longest wait: `waitEnvName` or scheduler.json `waitName`, 1 s to 1 h in ms, else `defaultWaitMs`.
 */
function jobQueueSetting({ env = process.env, configDir, schedulerMode, name, envName, waitName, waitEnvName, defaultWaitMs, limit = 4 }) {
  let cfg = {};
  if (configDir) {
    try { cfg = JSON.parse(fs.readFileSync(path.join(configDir, "scheduler.json"), "utf8")) || {}; } catch (_) { cfg = {}; }
  }
  if (!cfg || typeof cfg !== "object") cfg = {};
  const ignored = [];
  const word = (v, source, n) => {
    if (v === undefined || v === null || v === "") return null;
    const s = typeof v === "string" ? v.trim().toLowerCase() : null;
    if (s === "on" || s === "off") return s;
    ignored.push({ name: n, source, reason: "allowed: on, off" });
    return null;
  };
  const wait = (v, source, n) => {
    if (v === undefined || v === null || v === "") return null;
    const x = Number(v);
    if (Number.isFinite(x) && x >= MIN_WAIT_MS && x <= MAX_WAIT_MS) return Math.round(x);
    ignored.push({ name: n, source, reason: `allowed: ${MIN_WAIT_MS}-${MAX_WAIT_MS} ms` });
    return null;
  };
  const requested = word(env[envName], "environment", envName) || word(cfg[name], "scheduler.json", name) || "off";
  let mode = requested;
  let forcedOffBy = null;
  if (schedulerMode === "off") { mode = "off"; forcedOffBy = requested !== "off" ? "scheduler-off" : null; }
  const maxWaitMs = wait(env[waitEnvName], "environment", waitEnvName) || wait(cfg[waitName], "scheduler.json", waitName) || defaultWaitMs;
  return Object.freeze({ mode, requested, forcedOffBy, limit, maxWaitMs, ignored: Object.freeze(ignored.map((x) => Object.freeze(x))) });
}

/**
 * @param {object} o
 * @param {string} o.engineLabel  words used in messages, e.g. "voice engine"
 * @param {number} [o.limit]      waiting jobs allowed behind the running one (4)
 * @param {number} [o.maxWaitMs]  longest wait before QUEUE_TIMEOUT
 */
function createJobQueue({ engineLabel, limit = 4, maxWaitMs = 10 * 60 * 1000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (!engineLabel) throw new Error("job-queue: engineLabel required");
  let running = 0;
  const waiting = []; // { grant, settle, timer, done }
  let avgServiceMs = DEFAULT_SERVICE_MS;
  let served = 0;
  const counts = { admitted: 0, waited: 0, full: 0, timedOut: 0, clientGone: 0, refused: 0, completed: 0 };

  const retryAfterSeconds = (ahead) => Math.max(1, Math.min(120, Math.ceil((avgServiceMs * (ahead + 1)) / 1000)));

  function grantNext() {
    while (running === 0 && waiting.length) {
      const entry = waiting.shift();
      if (entry.done) continue;
      entry.done = true;
      clearTimer(entry.timer);
      entry.grant();
    }
  }

  /** The running turn. Call release() when the job has settled; extra calls do nothing. */
  function start() {
    running += 1;
    counts.admitted += 1;
    const startedAt = now();
    let released = false;
    return () => {
      if (released) return false;
      released = true;
      running -= 1;
      counts.completed += 1;
      const took = Math.max(0, now() - startedAt);
      served += 1;
      avgServiceMs = served === 1 ? took || DEFAULT_SERVICE_MS : Math.round(avgServiceMs * 0.7 + took * 0.3);
      grantNext();
      return true;
    };
  }

  /**
   * Ask for a turn. `onClientGone(cb)` must call cb if the client disconnects while waiting.
   * Resolves { ok: true, release } or { ok: false, status, code, retryAfterSeconds?, error }.
   */
  function admit(onClientGone) {
    if (running === 0 && waiting.length === 0) return Promise.resolve({ ok: true, release: start() });
    if (waiting.length >= limit) {
      counts.full += 1;
      const s = retryAfterSeconds(waiting.length);
      return Promise.resolve({ ok: false, status: 429, code: "QUEUE_FULL", retryAfterSeconds: s,
        error: `The ${engineLabel} is busy: ${limit} requests are already waiting. Try again in about ${s} s.` });
    }
    counts.waited += 1;
    return new Promise((resolve) => {
      const entry = { done: false };
      const leave = () => { const i = waiting.indexOf(entry); if (i >= 0) waiting.splice(i, 1); };
      entry.grant = () => resolve({ ok: true, release: start() });
      entry.settle = (result) => {
        if (entry.done) return false;
        entry.done = true;
        clearTimer(entry.timer);
        leave();
        resolve(result);
        return true;
      };
      entry.timer = setTimer(() => {
        if (entry.done) return;
        counts.timedOut += 1;
        const s = retryAfterSeconds(Math.max(0, waiting.length - 1));
        entry.settle({ ok: false, status: 503, code: "QUEUE_TIMEOUT", retryAfterSeconds: s,
          error: `This request waited more than ${Math.round(maxWaitMs / 1000)} s for the ${engineLabel}. Try again in about ${s} s.` });
      }, maxWaitMs);
      waiting.push(entry);
      onClientGone(() => { if (entry.settle({ ok: false, status: 0, code: "CLIENT_GONE" })) counts.clientGone += 1; });
    });
  }

  /** Refuse every waiting job now with `result` (the running job is not touched). Returns how many. */
  function refuseWaiting(result) {
    let n = 0;
    for (const entry of [...waiting]) if (entry.settle({ ok: false, ...result })) n += 1;
    counts.refused += n;
    return n;
  }

  return {
    admit,
    refuseWaiting,
    stats: () => ({ running, waiting: waiting.filter((e) => !e.done).length, limit }),
    counts: () => ({ ...counts }),
    maxWaitMs,
  };
}

module.exports = { createJobQueue, jobQueueSetting };
