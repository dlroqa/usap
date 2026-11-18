// Issue #105: cross-engine model-load coordination (docs/roadmap/STEP9_9F_ENGINE_LIFECYCLE.md).
//
// One heavy-engine slot, shared by the text engine (llama.cpp) and the image engine (sd.cpp, OpenVINO, Core ML).
// A load claims it synchronously, before its first await, inside its own engine's lifecycle chain. The other kind
// is then refused at once with 409 MODEL_ALREADY_ACTIVE (the existing code and wording; `phase` is additive).
// The slot is given back only after every process the owner spawned is seen to exit: the process's "exit" event,
// then (for a supervised engine) its engine PID gone. A closed connection, a free port, a timer or a cleared
// JavaScript reference never counts. Inference (chat, image generation, Whisper, Kokoro) never touches the slot.
//
// Off by default (engineSlot / USAP_ENGINE_SLOT; USAP_SCHEDULER=off forces it off). Off: never created, and the
// engines take the code paths from before this change, including the known race.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const KINDS = new Set(["text", "image"]);
const LABEL = { text: "Text", image: "Image" };
const PHASE_NOTE = { loading: "still loading", unloading: "still stopping", "restart-pending": "restarting after a crash" };

/**
 * The engineSlot setting: USAP_ENGINE_SLOT (environment) wins over app/config/scheduler.json "engineSlot".
 * on | off, default off. USAP_SCHEDULER=off forces it off. Read at start-up.
 */
function engineSlotSetting({ env = process.env, configDir, schedulerMode } = {}) {
  let cfg = {};
  if (configDir) {
    try { cfg = JSON.parse(fs.readFileSync(path.join(configDir, "scheduler.json"), "utf8")) || {}; } catch (_) { cfg = {}; }
  }
  if (!cfg || typeof cfg !== "object") cfg = {};
  const ignored = [];
  const word = (v, source, name) => {
    if (v === undefined || v === null || v === "") return null;
    const s = typeof v === "string" ? v.trim().toLowerCase() : null;
    if (s === "on" || s === "off") return s;
    ignored.push({ name, source, reason: "allowed: on, off" });
    return null;
  };
  const requested = word(env.USAP_ENGINE_SLOT, "environment", "USAP_ENGINE_SLOT") || word(cfg.engineSlot, "scheduler.json", "engineSlot") || "off";
  let mode = requested;
  let forcedOffBy = null;
  if (schedulerMode === "off") { mode = "off"; forcedOffBy = requested !== "off" ? "scheduler-off" : null; }
  return Object.freeze({ mode, requested, forcedOffBy, ignored: Object.freeze(ignored.map((x) => Object.freeze(x))) });
}

function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err && err.code === "EPERM"; }
}

// The engine guard's own grace (engine-guard.cjs): after SIGTERM it stops its engine politely, then by force after this.
const GUARD_GRACE_MS = Math.max(100, Number(process.env.USAP_ENGINE_STOP_GRACE_MS) || 3000);

/**
 * An engine whose guard is gone but which is still running (#136) is stopped through the guard's process group
 * (POSIX). The guard starts in its own group (supervisor.cjs, detached) and the engine inherits it. A process group ID
 * is not reused while the group exists, and the engine must still be in that group, so nothing else is signalled.
 * Windows: the guard stops engines with `taskkill /T`, and this case doesn't arise; nothing is done.
 * Resolves true when the engine's group was signalled.
 */
function processGroupOf(pid) {
  if (process.platform === "linux") {
    try { const st = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[2]); } catch (_) { return null; }
  }
  try {
    const out = require("node:child_process").execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const n = Number(out.trim()); return Number.isInteger(n) && n > 0 ? n : null;
  } catch (_) { return null; }
}
async function defaultReapOrphan({ guardPid, enginePid, isAlive, graceMs = GUARD_GRACE_MS }) {
  if (process.platform === "win32" || !Number.isInteger(guardPid) || guardPid <= 1 || !isAlive(enginePid)) return false;
  if (processGroupOf(enginePid) !== guardPid) return false; // not (or no longer) the engine this guard started
  try { process.kill(-guardPid, "SIGTERM"); } catch (_) { return false; }
  const end = Date.now() + graceMs;
  while (Date.now() < end && isAlive(enginePid)) await new Promise((r) => setTimeout(r, 50));
  if (isAlive(enginePid) && processGroupOf(enginePid) === guardPid) { try { process.kill(-guardPid, "SIGKILL"); } catch (_) { /* gone */ } }
  return true;
}

function hasExited(proc) {
  return Boolean(proc) && (proc.exitCode !== null && proc.exitCode !== undefined || proc.signalCode !== null && proc.signalCode !== undefined);
}

/**
 * Stop one process and wait for its exit: SIGTERM, wait, SIGKILL, wait. Resolves { exited } and never throws.
 * `exited: false` means no exit was seen after SIGKILL; the caller must report it, not treat the engine as stopped.
 * The first wait is longer than the engine guard's own grace (#136), so a guarded engine that is slow to stop is
 * stopped by its guard (politely, then by force) before the server forces anything.
 */
async function stopProcess(proc, { termWaitMs = GUARD_GRACE_MS + 1500, killWaitMs = 2500, waitForChildExit } = {}) {
  if (!proc) return { exited: true, forced: false };
  if (hasExited(proc)) return { exited: true, forced: false };
  try { proc.kill("SIGTERM"); } catch (_) { /* already gone */ }
  if (await waitForChildExit(proc, termWaitMs)) return { exited: true, forced: false };
  try { proc.kill("SIGKILL"); } catch (_) { /* already gone */ }
  return { exited: await waitForChildExit(proc, killWaitMs), forced: true };
}

/**
 * @param {object} [o]
 * @param {() => number} [o.now]
 * @param {(pid:number) => boolean} [o.isAlive]   engine PID liveness (tests inject a fake)
 * @param {number} [o.pidGoneTimeoutMs]           how long to wait for the engine PID after its guard's exit
 * @param {number} [o.recheckMs]                  how often a stuck process is re-checked
 * @param {{warn:Function, log:Function}} [o.log]
 */
function createEngineSlot({ now = Date.now, isAlive = defaultIsAlive, pidGoneTimeoutMs = 2000, recheckMs = 1000, log = console, reapOrphan } = {}) {
  // Real process handling only with real liveness: a slot driven by an injected isAlive (tests) never signals real
  // processes unless the caller passes reapOrphan explicitly.
  if (reapOrphan === undefined) reapOrphan = isAlive === defaultIsAlive ? defaultReapOrphan : null;
  const s = { owner: null, model: null, phase: "idle", epoch: 0, since: now() };
  const ops = { text: 0, image: 0 };
  const records = new Set(); // { kind, epoch, proc, guardPid, enginePid, exitSeen, stuck, reason }
  const waiters = new Set(); // { kind, resolve }
  const counts = { reserved: 0, refused: 0, released: 0, unconfirmed: 0, staleIgnored: 0, orphansStopped: 0 };
  let lastRefusal = null;

  function liveRecords(kind) {
    return [...records].filter((r) => !kind || r.kind === kind);
  }
  function stuckRecords(kind) {
    return liveRecords(kind).filter((r) => r.stuck);
  }

  function setPhase(phase) {
    if (s.phase !== phase) s.since = now();
    s.phase = phase;
  }

  function notifyWaiters() {
    for (const w of [...waiters]) {
      if (liveRecords(w.kind).length === 0) { waiters.delete(w); w.resolve(true); }
    }
  }

  function maybeRelease() {
    notifyWaiters();
    if (s.phase !== "unloading") return;
    if (s.owner && ops[s.owner] > 0) return;
    if (liveRecords(s.owner).length > 0) return;
    s.owner = null;
    s.model = null;
    setPhase("idle");
    counts.released += 1;
  }

  function runtimeOf() {
    return { type: s.owner, label: LABEL[s.owner], model: s.model || "", phase: s.phase };
  }

  function conflictError(kind, model) {
    const rt = runtimeOf();
    const stuck = stuckRecords().length > 0;
    counts.refused += 1;
    lastRefusal = { at: new Date(now()).toISOString(), target: kind, owner: rt.type, phase: rt.phase, stuck };
    if (stuck) {
      const err = new Error(`The ${rt.type} engine did not exit after it was stopped, so no model can be loaded yet. Restart USAP if this persists.`);
      return Object.assign(err, { statusCode: 503, code: "ENGINE_EXIT_UNCONFIRMED", activeRuntime: rt, targetRuntime: { type: kind, model } });
    }
    const note = PHASE_NOTE[rt.phase] ? ` (${PHASE_NOTE[rt.phase]})` : "";
    // Same wording as assertNoOtherActiveRuntime in serve.cjs: the original WebUI matches "already loaded as a text model".
    const err = new Error(`"${rt.model}" is already loaded as a ${rt.label} model${note}. Unload it before loading "${model}".`);
    return Object.assign(err, { statusCode: 409, code: "MODEL_ALREADY_ACTIVE", activeRuntime: rt, targetRuntime: { type: kind, model } });
  }

  /** Claim the slot for `kind` (synchronous). Same kind: kept, new epoch. Other kind not idle: throws 409/503. */
  function begin(kind, model) {
    if (!KINDS.has(kind)) throw new Error(`engine-slot: unknown kind ${kind}`);
    const name = path.basename(String(model || ""));
    if (s.owner && s.owner !== kind) throw conflictError(kind, name);
    if (stuckRecords(kind).length > 0) throw conflictError(kind, name);
    s.owner = kind;
    if (name) s.model = name;
    s.epoch += 1;
    ops[kind] += 1;
    setPhase("loading"); // a reload of a loaded engine is a transition too
    counts.reserved += 1;
    return s.epoch;
  }

  /** The operation started by begin() ended. `live`: the kind's engine process exists; `ready`: it answers. */
  function end(kind, { live = false, ready = false } = {}) {
    if (ops[kind] > 0) ops[kind] -= 1;
    if (ops[kind] > 0 || s.owner !== kind) { maybeRelease(); return; }
    if (live) setPhase(ready ? "loaded" : "loading");
    else setPhase("unloading");
    maybeRelease();
  }

  function current(kind, epoch) {
    if (s.owner === kind && epoch === s.epoch) return true;
    counts.staleIgnored += 1;
    return false;
  }

  /** The current engine of `kind` became ready (ignored for an older epoch). */
  function markLoaded(kind, epoch) {
    if (!current(kind, epoch)) return false;
    if (ops[kind] === 0) setPhase("loaded");
    return true;
  }

  /** The text engine crashed and a restart is scheduled: the slot stays owned, with no process. */
  function markRestartPending(kind, epoch) {
    if (!current(kind, epoch)) return false;
    if (ops[kind] === 0) setPhase("restart-pending");
    return true;
  }

  /** The engine of `kind` was stopped or crashed for good. Ignored while an operation of that kind runs. */
  function stopped(kind, epoch = null) {
    if (s.owner !== kind) { maybeRelease(); return false; }
    if (epoch !== null && epoch !== s.epoch) { counts.staleIgnored += 1; return false; }
    if (ops[kind] > 0) return false;
    setPhase("unloading");
    maybeRelease();
    return true;
  }

  function confirmGone(r) {
    const finish = () => {
      if (!records.has(r)) return;
      records.delete(r);
      if (r.stuck) log.warn(`  [engine-slot] ${r.kind} engine process ${r.enginePid || r.guardPid} exited after all (it was reported as not stopping).`);
      maybeRelease();
    };
    const pid = r.proc && r.proc.supervised ? (r.proc.enginePid || r.enginePid) : null;
    if (!pid || !isAlive(pid)) { finish(); return; }
    const started = now();
    const timer = setInterval(() => {
      if (!isAlive(pid)) { clearInterval(timer); finish(); return; }
      if (!r.stuck && now() - started >= pidGoneTimeoutMs) {
        r.stuck = true; r.reason = "engine-pid-alive-after-guard-exit"; counts.unconfirmed += 1;
        log.warn(`  [engine-slot] ${r.kind} engine process ${pid} is still alive after its guard exited; capacity stays reserved.`);
        // Stop it through its guard's process group (verified, POSIX). Capacity stays reserved until its exit is seen.
        if (reapOrphan && !r.reaping && r.guardPid) {
          r.reaping = true;
          Promise.resolve().then(() => reapOrphan({ guardPid: r.guardPid, enginePid: pid, isAlive })).then((done) => {
            if (done) { counts.orphansStopped += 1; log.warn(`  [engine-slot] stopped ${r.kind} engine process ${pid} through its guard's process group.`); }
          }, () => { /* a failed attempt leaves the slot reserved, as before */ });
        }
      }
    }, Math.min(50, recheckMs));
    if (timer.unref) timer.unref();
  }

  /** Follow a process the owner spawned under `epoch` until its exit is confirmed. */
  function track(kind, proc, epoch) {
    if (!proc) return;
    const r = { kind, epoch, proc, guardPid: proc.pid || null, enginePid: proc.enginePid || null, exitSeen: false, stuck: false, reason: "" };
    proc.usapEpoch = epoch;
    records.add(r);
    const onExit = () => { if (r.exitSeen) return; r.exitSeen = true; r.enginePid = proc.enginePid || r.enginePid; confirmGone(r); };
    if (hasExited(proc)) { onExit(); return; }
    proc.once("exit", onExit);
    // A process that never started ("error" with no "exit", e.g. ENOENT) has nothing to wait for.
    proc.once("error", () => { if (!proc.pid) onExit(); });
  }

  /** A stop request escalated to SIGKILL and still saw no exit: report it; the slot stays reserved. */
  function noteStopUnconfirmed(kind, proc) {
    for (const r of records) {
      if (r.kind === kind && r.proc === proc && !r.stuck) {
        r.stuck = true; r.reason = "no-exit-after-sigkill"; counts.unconfirmed += 1;
        log.warn(`  [engine-slot] ${kind} engine process ${proc.enginePid || proc.pid} did not exit after SIGKILL; capacity stays reserved until it does.`);
      }
    }
  }

  /** Wait (bounded) until every earlier process of `kind` has a confirmed exit. Resolves true/false. */
  function waitForExits(kind, timeoutMs = 5000) {
    if (liveRecords(kind).length === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const w = { kind, resolve };
      waiters.add(w);
      const t = setTimeout(() => { if (waiters.delete(w)) resolve(false); }, timeoutMs); // bounded, so kept referenced
      const done = w.resolve;
      w.resolve = (v) => { clearTimeout(t); done(v); };
    });
  }

  function unconfirmedError(kind) {
    const err = new Error(`An earlier ${kind} engine process has not exited yet, so a new one is not started. Try again shortly; restart USAP if this persists.`);
    return Object.assign(err, { statusCode: 503, code: "ENGINE_EXIT_UNCONFIRMED" });
  }

  /** Throws the conflict error when the other kind owns the slot (any phase). */
  function assertNotOther(kind, model) {
    if (s.owner && s.owner !== kind) throw conflictError(kind, path.basename(String(model || "")));
  }

  function hasStuck(kind) { return stuckRecords(kind).length > 0; }

  /** For GET /api/resources: fixed words and numbers only (no model names, PIDs or paths). */
  function snapshot() {
    return {
      mode: "on",
      owner: s.owner,
      phase: s.phase,
      epoch: s.epoch,
      sinceSeconds: Math.max(0, Math.round((now() - s.since) / 100) / 10),
      operations: { text: ops.text, image: ops.image },
      processes: { text: liveRecords("text").length, image: liveRecords("image").length },
      unconfirmedExits: stuckRecords().map((r) => ({ kind: r.kind, reason: r.reason })),
      counts: { ...counts },
      lastRefusal,
    };
  }

  function state() {
    return { owner: s.owner, model: s.model, phase: s.phase, epoch: s.epoch, ops: { ...ops } };
  }

  return { begin, end, assertNotOther, current: state, isCurrent: (kind, epoch) => s.owner === kind && s.epoch === epoch, markLoaded, markRestartPending, stopped, track, noteStopUnconfirmed, waitForExits, unconfirmedError, hasStuck, runtime: () => (s.owner ? runtimeOf() : null), snapshot };
}

module.exports = {
  GUARD_GRACE_MS, defaultReapOrphan, processGroupOf, engineSlotSetting, createEngineSlot, stopProcess, hasExited };
