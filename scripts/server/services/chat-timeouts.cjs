// services/chat-timeouts.cjs — Step 9.9f-1: chat-engine timeouts, cancellation confirmation and the bounded
// UNRESPONSIVE state (docs/roadmap/STEP9_9F_TIMEOUTS.md).
//
// Off by default. "observe" records what would have timed out and changes nothing else; "on" enforces.
// This module holds the setting, the counters and the engine guard. The per-request deadlines live in
// services/chat.cjs, because they sit on the request's own sockets.
//
// The guard keeps two things apart:
//   * transport cancellation: the studio destroyed its HTTP request to llama-server;
//   * confirmed cessation: llama-server's /metrics, probed AFTER that abort, on the SAME engine process, shows no
//     request processing or deferred, twice, at least QUIESCE_GAP_MS apart, with its decode and token counters
//     unchanged in between.
// Until the second holds, the text engine counts as busy: no new chat is sent to it (READY → CONFIRMING). If it
// cannot be confirmed within the confirmation window, chats are refused at once with 503 ENGINE_UNRESPONSIVE
// (bounded: nobody waits indefinitely, nothing restarts) until a probe of the current engine confirms it is
// idle, or a new engine process has started (a model load or reload; the previous process has exited).
//
// Why these readings mean "not computing", for llama.cpp b11418 (see the design §2):
//   * the engine answers /metrics even while a decode runs (a worker thread handles METRICS during the decode),
//     and during a decode the slot doing it is counted in requests_processing;
//   * a CANCEL is applied only between decodes, and the slot stops counting only then;
//   * a request waiting for a slot is counted in requests_deferred;
//   * the HTTP handler notices a closed connection within 1 s (HTTP_POLLING_SECONDS) and only then posts the
//     CANCEL. Two zero readings at least 3 s apart, with n_decode_total and the token counters unchanged, rule
//     out a decode that started, or a reading taken before the handler had even posted its task;
//   * Process-Start-Time-Unix identifies the process, so a reading from another process never counts.
// Missing, malformed, contradictory or stale readings never confirm anything.
"use strict";

const fs = require("fs");
const path = require("path");

const NUMBERS = Object.freeze({
  firstByteSeconds: { key: "chatFirstByteSeconds", env: "USAP_CHAT_FIRST_BYTE_SECONDS", min: 30, max: 3600, def: 600 },
  idleSeconds: { key: "chatIdleSeconds", env: "USAP_CHAT_IDLE_SECONDS", min: 10, max: 600, def: 120 },
  cancelConfirmSeconds: { key: "chatCancelConfirmSeconds", env: "USAP_CHAT_CANCEL_CONFIRM_SECONDS", min: 10, max: 600, def: 120 },
  unresponsiveProbeSeconds: { key: "chatUnresponsiveProbeSeconds", env: "USAP_CHAT_UNRESPONSIVE_PROBE_SECONDS", min: 5, max: 300, def: 15 },
});
const MODES = new Set(["off", "observe", "on"]);
// The legacy non-streaming limit (requestJson(..., 300000) in services/chat.cjs). Not configurable.
const NON_STREAM_TOTAL_SECONDS = 300;
// Fixed in this substage (documented constants, not settings).
const PROBE_INTERVAL_MS = 1000;
const PROBE_LIMIT_MS = 5000;
const QUIESCE_GAP_MS = 3000;
const RETRY_AFTER_SECONDS = 30;

/** An integer in [min, max], from a number or a string of digits; anything else is null. */
function wholeSeconds(v, { min, max }) {
  if (typeof v === "number") return Number.isInteger(v) && v >= min && v <= max ? v : null;
  if (typeof v === "string" && /^\s*\d+\s*$/.test(v)) { const n = Number(v); return n >= min && n <= max ? n : null; }
  return null;
}

/**
 * Resolve the setting. For each value: a valid environment value wins, then a valid scheduler.json value, then the
 * default. An invalid value is never clamped or partly used: it is ignored (and listed in `ignored`, without the
 * value itself) and the next source applies. USAP_SCHEDULER=off forces the mode off. Read once at start-up.
 */
function chatTimeoutSetting({ env = process.env, configDir, schedulerMode } = {}) {
  let cfg = {};
  if (configDir) {
    try { cfg = JSON.parse(fs.readFileSync(path.join(configDir, "scheduler.json"), "utf8")) || {}; } catch (_) { cfg = {}; }
  }
  if (!cfg || typeof cfg !== "object") cfg = {};
  const ignored = [];
  const word = (v, source, name) => {
    if (v === undefined || v === null || v === "") return null;
    const s = String(v).trim().toLowerCase();
    if (MODES.has(s)) return s;
    ignored.push({ name, source, reason: "allowed: off, observe, on" });
    return null;
  };
  let mode = word(env.USAP_CHAT_TIMEOUTS, "environment", "USAP_CHAT_TIMEOUTS") || word(cfg.chatTimeouts, "scheduler.json", "chatTimeouts") || "off";
  if (schedulerMode === "off") mode = "off";
  const out = { mode };
  for (const [field, spec] of Object.entries(NUMBERS)) {
    let value = null;
    for (const [source, name, raw] of [["environment", spec.env, env[spec.env]], ["scheduler.json", spec.key, cfg[spec.key]]]) {
      if (raw === undefined || raw === null || raw === "") continue;
      const n = wholeSeconds(raw, spec);
      if (n === null) { ignored.push({ name, source, reason: `allowed: whole seconds ${spec.min}-${spec.max}` }); continue; }
      value = n;
      break;
    }
    out[field] = value === null ? spec.def : value;
  }
  out.nonStreamTotalSeconds = NON_STREAM_TOTAL_SECONDS;
  out.ignored = Object.freeze(ignored.map((x) => Object.freeze(x)));
  return Object.freeze(out);
}

/**
 * GET /metrics from the local engine, on its own connection. Resolves to { status, startTime, text } or null;
 * `abort()` drops it. The body is capped at 1 MiB.
 */
function httpMetricsFetcher(http) {
  return (port) => {
    let req;
    const promise = new Promise((resolve) => {
      req = http.request({ hostname: "127.0.0.1", port, path: "/metrics", method: "GET", agent: false }, (r) => {
        let text = "";
        r.setEncoding("utf8");
        r.on("data", (c) => { if (text.length < 1048576) text += c; });
        r.on("end", () => resolve({ status: r.statusCode, startTime: r.headers["process-start-time-unix"], text }));
        r.on("error", () => resolve(null));
        r.on("aborted", () => resolve(null));
      });
      req.on("error", () => resolve(null));
      req.end();
    });
    return { promise, abort: () => { if (req && !req.destroyed) req.destroy(); } };
  };
}

/** Parse a Prometheus text body from llama-server into the numbers the guard needs, or null. */
function parseMetrics(text) {
  if (typeof text !== "string") return null;
  const m = {};
  for (const line of text.split("\n")) {
    const x = line.match(/^llamacpp:([a-z_]+)\s+(\S+)\s*$/);
    if (x) m[x[1]] = Number(x[2]);
  }
  const need = ["requests_processing", "requests_deferred", "n_decode_total", "tokens_predicted_total", "prompt_tokens_total"];
  for (const k of need) if (!Number.isFinite(m[k]) || m[k] < 0) return null;
  return { processing: m.requests_processing, deferred: m.requests_deferred, decodes: m.n_decode_total, predicted: m.tokens_predicted_total, prompt: m.prompt_tokens_total };
}

/**
 * @param {object} o
 * @param {object} o.setting                         chatTimeoutSetting()
 * @param {() => {seq:number|null, ready:boolean, port:number}} o.engine  the current text engine (read-only)
 * @param {(port:number) => {promise: Promise<{status:number, startTime:string|undefined, text:string}>, abort: Function}} o.fetchMetrics
 */
function createChatTimeouts({ setting, engine, fetchMetrics, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = (l) => console.log(l) } = {}) {
  const mode = setting.mode;
  const say = (line) => { try { log(`  [timeouts] ${line}`); } catch (_) { /* logging is optional */ } };
  const counts = { firstByte: 0, idle: 0, total: 0, clientCancelled: 0, cancelConfirmed: 0, cancelUnconfirmed: 0, recovered: 0, refusedUnresponsive: 0, engineReplaced: 0, probes: 0, probesRejected: 0 };
  const would = { firstByte: 0, idle: 0, total: 0 };
  let last = null;

  // ── Engine guard (mode "on" only) ───────────────────────────────────────────────────────────────────────
  // Probe-loop timers never keep the process alive on their own (shutdown); request deadlines sit on live sockets.
  const loopTimer = (fn, ms) => { const t = setTimer(fn, ms); if (t && typeof t.unref === "function") t.unref(); return t; };
  const g = { state: "ready", seq: null, since: 0, abortAt: 0, candidate: null, loopToken: 0, timer: null, probe: null };
  const waiters = new Set();   // admission waits while CONFIRMING: { resolve, timer }
  const releasers = [];        // queue releases deferred until CONFIRMING ends
  const currentEngine = () => { try { return engine() || {}; } catch (_) { return {}; } };

  function stopLoop() {
    g.loopToken++;
    if (g.timer) { clearTimer(g.timer); g.timer = null; }
    if (g.probe) { try { g.probe.abort(); } catch (_) { /* gone */ } g.probe = null; }
  }
  function drainReleasers() {
    while (releasers.length) { const fn = releasers.shift(); try { fn(); } catch (_) { /* release is idempotent */ } }
  }
  const refusal = () => ({ ok: false, status: 503, code: "ENGINE_UNRESPONSIVE", retryAfterSeconds: RETRY_AFTER_SECONDS,
    error: "The text engine is still busy with a stopped request, or isn't responding. Wait a little, or reload the model, then try again." });
  function resolveWaiters(result) {
    for (const w of [...waiters]) { waiters.delete(w); clearTimer(w.timer); w.resolve(result()); }
  }
  function toReady(reason) {
    const from = g.state;
    stopLoop();
    g.state = "ready"; g.candidate = null; g.since = now();
    if (reason === "confirmed") counts.cancelConfirmed++;
    else if (reason === "recovered") counts.recovered++;
    else if (reason === "engine-replaced") counts.engineReplaced++;
    if (last && reason === "confirmed" && last.confirmSeconds === null && last.seq === g.seq) last.confirmSeconds = Math.round((now() - g.abortAt) / 100) / 10;
    say(reason === "confirmed" ? "the text engine confirmed it stopped the cancelled work"
      : reason === "recovered" ? "the text engine is idle again; chats are accepted"
      : "a new text engine process started; chats are accepted");
    resolveWaiters(() => ({ ok: true }));
    drainReleasers();
    return from;
  }
  function toUnresponsive() {
    g.state = "unresponsive"; g.candidate = null; g.since = now();
    counts.cancelUnconfirmed++;
    say(`no confirmation within ${setting.cancelConfirmSeconds} s that the text engine stopped; new chats are refused until it is idle or the model is reloaded`);
    resolveWaiters(() => { counts.refusedUnresponsive++; return refusal(); });
    drainReleasers(); // the queue keeps no stuck owner; the gate keeps refusing, so nothing is admitted
  }
  /** Re-sync with the engine: a different process (new seq) that is ready means the uncertain work is gone. */
  function sync() {
    if (g.state === "ready") return;
    const e = currentEngine();
    if (e.seq !== g.seq && e.ready && e.seq !== null && e.seq !== undefined) toReady("engine-replaced");
  }

  function schedule() {
    const token = g.loopToken;
    const delay = g.state === "unresponsive" ? setting.unresponsiveProbeSeconds * 1000 : PROBE_INTERVAL_MS;
    g.timer = loopTimer(() => { g.timer = null; if (token === g.loopToken) probeOnce(token); }, delay);
  }
  function probeOnce(token) {
    sync();
    if (g.state === "ready" || token !== g.loopToken) return;
    const e = currentEngine();
    if (e.seq !== g.seq || !e.ready || !e.port) { afterProbe(token, null); return; } // stopped engine: not confirmable
    const sentAt = now();
    let handle;
    try { handle = fetchMetrics(e.port); } catch (_) { afterProbe(token, null); return; }
    g.probe = handle;
    counts.probes++;
    let done = false;
    const limit = loopTimer(() => { if (done) return; done = true; try { handle.abort(); } catch (_) { /* gone */ } g.probe = null; afterProbe(token, null); }, PROBE_LIMIT_MS);
    Promise.resolve(handle.promise).then((r) => r, () => null).then((r) => {
      if (done) return;
      done = true; clearTimer(limit); g.probe = null;
      if (token !== g.loopToken) return;                       // a newer state owns the loop now
      const still = currentEngine();
      if (still.seq !== e.seq) { afterProbe(token, null); return; } // the engine changed while probing: discard
      const reading = r && r.status === 200 && typeof r.startTime === "string" && r.startTime.trim() ? parseMetrics(r.text) : null;
      afterProbe(token, reading ? { ...reading, start: r.startTime.trim(), sentAt } : null);
    });
  }
  function afterProbe(token, reading) {
    if (token !== g.loopToken || g.state === "ready") return;
    // Valid only if sent after the latest abort; quiet only with nothing processing or deferred.
    const usable = reading && reading.sentAt > g.abortAt;
    if (!usable) counts.probesRejected++;
    if (usable && reading.processing === 0 && reading.deferred === 0) {
      const c = g.candidate;
      const same = c && c.start === reading.start && c.decodes === reading.decodes && c.predicted === reading.predicted && c.prompt === reading.prompt;
      if (same && reading.sentAt - c.sentAt >= QUIESCE_GAP_MS) {
        toReady(g.state === "confirming" ? "confirmed" : "recovered");
        return;
      }
      if (!same) g.candidate = reading; // a new baseline (first quiet reading, or the counters moved)
    } else {
      g.candidate = null;              // busy, missing, malformed or stale: start over
    }
    if (g.state === "confirming" && now() - g.since >= setting.cancelConfirmSeconds * 1000) toUnresponsive();
    if (token === g.loopToken) schedule();
  }

  /** The studio destroyed an engine request whose computation it can't see. `seq` is the engine it was sent to. */
  function noteAbort(seq) {
    if (mode !== "on") return;
    const e = currentEngine();
    if (seq === null || seq === undefined || seq !== e.seq) return; // an older engine process: its work died with it
    if (g.state === "ready") { g.state = "confirming"; g.since = now(); }
    g.seq = seq;
    g.abortAt = now();
    g.candidate = null;
    if (!g.timer && !g.probe) schedule();
  }

  /** Admission for a chat about to be sent to the engine. Resolves to { ok:true } or a refusal. */
  function admit(onClientGone) {
    if (mode !== "on") return Promise.resolve({ ok: true });
    sync();
    if (g.state === "ready") return Promise.resolve({ ok: true });
    if (g.state === "unresponsive") { counts.refusedUnresponsive++; return Promise.resolve(refusal()); }
    return new Promise((resolve) => {
      const w = { resolve, timer: null };
      // Safety bound: the loop ends CONFIRMING within the window; this only guards against a bug there.
      w.timer = setTimer(() => { if (waiters.delete(w)) { counts.refusedUnresponsive++; resolve(refusal()); } }, setting.cancelConfirmSeconds * 1000 + PROBE_LIMIT_MS + 2 * PROBE_INTERVAL_MS);
      waiters.add(w);
      if (typeof onClientGone === "function") onClientGone(() => { if (waiters.delete(w)) { clearTimer(w.timer); resolve({ ok: false, code: "CLIENT_GONE" }); } });
    });
  }

  /** Run `release` when the engine's capacity is known again (now, unless CONFIRMING). */
  function afterConfirmation(release) {
    if (mode !== "on") { release(); return; }
    sync();
    if (g.state === "confirming") releasers.push(release);
    else release();
  }

  function recordTimeout(phase, { stream, elapsedMs, seq }) {
    if (phase === "first-byte") counts.firstByte++; else if (phase === "idle") counts.idle++; else counts.total++;
    last = { outcome: `timeout-${phase}`, stream: Boolean(stream), elapsedSeconds: Math.round(elapsedMs / 100) / 10, confirmSeconds: null, seq, at: new Date(now()).toISOString() };
    say(`${stream ? "streaming" : "non-streaming"} chat stopped: ${phase} limit reached after ${Math.round(elapsedMs / 1000)} s; the engine request was cancelled (no retry, no restart)`);
  }
  function recordWould(phase, { stream, elapsedMs }) {
    if (phase === "first-byte") would.firstByte++; else if (phase === "idle") would.idle++; else would.total++;
    last = { outcome: `would-time-out-${phase}`, stream: Boolean(stream), elapsedSeconds: Math.round(elapsedMs / 100) / 10, confirmSeconds: null, at: new Date(now()).toISOString() };
    say(`observe: a ${stream ? "streaming" : "non-streaming"} chat passed the ${phase} limit (${Math.round(elapsedMs / 1000)} s); nothing was changed`);
  }
  function recordClientCancel(seq) {
    counts.clientCancelled++;
    if (mode === "on") last = { outcome: "client-cancelled", stream: null, elapsedSeconds: null, confirmSeconds: null, seq, at: new Date(now()).toISOString() };
  }

  function snapshot() {
    if (mode === "off") return null;
    sync();
    const out = {
      mode,
      firstByteSeconds: setting.firstByteSeconds,
      idleSeconds: setting.idleSeconds,
      nonStreamTotalSeconds: setting.nonStreamTotalSeconds,
      counts: { ...counts },
      last: last ? { outcome: last.outcome, stream: last.stream, elapsedSeconds: last.elapsedSeconds, confirmSeconds: last.confirmSeconds, at: last.at } : null,
    };
    if (mode === "observe") out.wouldHaveTimedOut = { ...would };
    if (mode === "on") {
      out.cancelConfirmSeconds = setting.cancelConfirmSeconds;
      out.unresponsiveProbeSeconds = setting.unresponsiveProbeSeconds;
      out.engine = g.state;
    }
    return out;
  }

  function close() { stopLoop(); resolveWaiters(() => refusal()); drainReleasers(); }

  return { mode, setting, noteAbort, admit, afterConfirmation, recordTimeout, recordWould, recordClientCancel, snapshot, close,
    timers: { now, setTimer, clearTimer }, engineState: () => { sync(); return g.state; } };
}

module.exports = { chatTimeoutSetting, createChatTimeouts, httpMetricsFetcher, parseMetrics, NUMBERS, NON_STREAM_TOTAL_SECONDS, PROBE_INTERVAL_MS, PROBE_LIMIT_MS, QUIESCE_GAP_MS, RETRY_AFTER_SECONDS };
