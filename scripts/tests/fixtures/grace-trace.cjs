// #151 diagnostics (test-only, messages only, never judged): why an in-process refusal server closed a connection
// late (macOS Intel CI: "server closed port N 5812 ms after the answer", grace 2000 ms). The refusal helper
// (server/http/refusal-close.cjs) arms its grace timer with the global setTimeout (a default parameter, looked up at
// call time) and destroys the socket in its callback. While a trace is started (one test only), this process:
//   - wraps globalThis.setTimeout: for timers of exactly `graceMs` it records when the timer was armed, its due time
//     (monotonic, performance.now) and when its callback started; every timer still behaves exactly as before;
//   - wraps net.Socket.prototype.destroy: records, per socket, when destroy() was first called and whether that call
//     came from inside a traced grace-timer callback;
//   - records the event loop's delay (histogram), GC pauses >= 5 ms (at most 60) and the main thread's own gaps (a
//     10 ms unref'd heartbeat; gaps >= 100 ms, at most 50).
// The test keeps its own per-connection records (res.end called, 'finish' = handed to the OS, 'close' observed).
// classify() reads one connection with fixed rules: timer armed late, callback late (and why, with the independent
// observer's main-thread states: GC, busy, descheduled, synchronous block, kernel wait), destroy on time but close
// observed late, or destroyed by something other than the grace timer. stop() restores everything.
"use strict";
const net = require("node:net");
const perf = require("node:perf_hooks");

const DESTROY = Symbol("usapGraceTraceDestroy");
const now = () => perf.performance.now();
const wall = (mono) => Math.round(perf.performance.timeOrigin + mono);

function startGraceTrace({ graceMs }) {
  const t = { graceMs, timers: [], gaps: [], gcs: [], cpu: [], active: null, stopped: false };
  const cpuNow = () => { try { const r = process.cpuUsage(); return Math.round((r.user + r.system) / 1000); } catch (_) { return null; } };
  const origSetTimeout = globalThis.setTimeout;
  const origDestroy = net.Socket.prototype.destroy;
  globalThis.setTimeout = function tracedSetTimeout(fn, delay, ...args) {
    if (delay === graceMs && typeof fn === "function" && t.timers.length < 500) {
      const rec = { armedAt: now(), dueAt: now() + delay, firedAt: null, endedAt: null };
      t.timers.push(rec);
      return origSetTimeout.call(this, function tracedTimer(...a) {
        rec.firedAt = now(); const prev = t.active; t.active = rec;
        try { return fn.apply(this, a); } finally { t.active = prev; rec.endedAt = now(); }
      }, delay, ...args);
    }
    return origSetTimeout.call(this, fn, delay, ...args);
  };
  net.Socket.prototype.destroy = function tracedDestroy(...a) {
    if (!this[DESTROY]) this[DESTROY] = { at: now(), timer: t.active };
    return origDestroy.apply(this, a);
  };
  let last = now();
  const hb = setInterval(() => {
    const n = now(); if (n - last >= 100 && t.gaps.length < 50) t.gaps.push([last, n - last]); last = n;
    if (t.cpu.length < 6000) t.cpu.push([wall(n), cpuNow()]); // process CPU ms (all threads) at each heartbeat
  }, 10);
  hb.unref();
  let eld = null; try { eld = perf.monitorEventLoopDelay({ resolution: 10 }); eld.enable(); } catch (_) { eld = null; }
  let gcObs = null;
  try { gcObs = new perf.PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.duration >= 5 && t.gcs.length < 60) t.gcs.push([e.startTime, e.duration]); }); gcObs.observe({ entryTypes: ["gc"] }); } catch (_) { gcObs = null; }
  t.destroyOf = (socket) => (socket && socket[DESTROY]) || null;
  t.loopNow = () => { try { return eld ? { maxMs: Math.round(eld.max / 1e6), p99Ms: Math.round(eld.percentile(99) / 1e6) } : t.loop || null; } catch (_) { return null; } };
  // process CPU over the heartbeats that bracket wall window [a, b] (last at or before a, first at or after b; a
  // stalled main thread takes no heartbeats, so the bracket spans the stall) -> { cpu, span } or null
  t.cpuMs = (a, b) => {
    const before = t.cpu.filter((x) => x[0] <= a && x[1] !== null).pop(), after = t.cpu.find((x) => x[0] >= b && x[1] !== null);
    return before && after && after[0] > before[0] ? { cpu: after[1] - before[1], span: after[0] - before[0] } : null;
  };
  t.stop = () => {
    if (t.stopped) return;
    t.stopped = true;
    globalThis.setTimeout = origSetTimeout;
    net.Socket.prototype.destroy = origDestroy;
    clearInterval(hb);
    try { if (gcObs) gcObs.disconnect(); } catch (_) { /* diagnostics only */ }
    if (eld) { try { eld.disable(); t.loop = { maxMs: Math.round(eld.max / 1e6), p99Ms: Math.round(eld.percentile(99) / 1e6) }; } catch (_) { /* none */ } }
  };
  return t;
}

// Observer runs ([[wallT, state, cpu, extra]]) covering [a, b] (wall ms) -> { text, share }.
function statesIn(runs, a, b) {
  if (!Array.isArray(runs) || !runs.length) return { text: "not observed", share: {} };
  const dur = new Map();
  for (let i = 0; i < runs.length; i += 1) {
    const from = Math.max(a, runs[i][0]), to = Math.min(b, i + 1 < runs.length ? runs[i + 1][0] : b);
    if (to <= from) continue;
    const k = `${runs[i][1]}${runs[i][3] && !/^runnable/.test(runs[i][3]) ? `(${runs[i][3]})` : ""}`;
    dur.set(k, (dur.get(k) || 0) + (to - from));
  }
  const total = [...dur.values()].reduce((x, y) => x + y, 0) || 1, share = {};
  for (const [k, v] of dur) share[k[0]] = (share[k[0]] || 0) + v / total;
  return { text: [...dur.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, v]) => `${k} ${Math.round(v)} ms`).join(", ") || "no sample in window", share };
}

const LATE_MS = 200; // a timer callback, a destroy or a close event this much after its cause counts as late

/**
 * One connection. conn: { endCalledAt, answeredAt, closedAt } (Date.now ms), socketTrace: t.destroyOf(socket),
 * observer: thread-observer output (or null) with this process's pid, cpuMs(a, b): process CPU over a wall window (or null).
 */
function classify({ conn, trace, socketTrace, observer = null, pid = process.pid, cpuMs = () => null }) {
  const rel = (w) => (Number.isFinite(w) ? Math.round(w - conn.answeredAt) : "none");
  const d = socketTrace;
  const timer = d && d.timer ? d.timer : null;
  const parts = [`res.end called ${rel(conn.endCalledAt)}, handed to the OS ('finish') 0 (not client receipt)`];
  let verdict;
  if (!d) { parts.push("destroy() not seen"); verdict = conn.closedAt ? "closed without a traced destroy (peer close or another path)" : "never closed"; }
  else {
    const destroyW = wall(d.at);
    if (!timer) { parts.push(`destroy() ${rel(destroyW)} not from the grace timer`); verdict = "destroyed by another path"; }
    else {
      const armedW = wall(timer.armedAt), dueW = wall(timer.dueAt), firedW = wall(timer.firedAt);
      const late = timer.firedAt - timer.dueAt;
      parts.push(`grace timer armed ${rel(armedW)}, due ${rel(dueW)}, callback ${rel(firedW)} (${Math.round(late)} ms late), destroy() ${rel(destroyW)}`);
      if (armedW - conn.answeredAt >= LATE_MS) verdict = "grace timer armed late";
      else if (late >= LATE_MS) {
        const gcMs = trace.gcs.filter(([s, du]) => s < timer.firedAt && s + du > timer.dueAt).reduce((x, [s, du]) => x + Math.min(timer.firedAt, s + du) - Math.max(timer.dueAt, s), 0);
        const gap = trace.gaps.filter(([s, g]) => s < timer.firedAt && s + g > timer.dueAt).reduce((x, [, g]) => Math.max(x, g), 0);
        const st = statesIn(observer && observer.procs && observer.procs[pid] && observer.procs[pid].runs, dueW, firedW);
        const cpu = cpuMs(dueW, firedW);
        parts.push(`while late: GC ${Math.round(gcMs)} ms, main-thread gap ${Math.round(gap)} ms, observer ${st.text}${cpu ? `, process CPU ${cpu.cpu} ms over ${Math.round(cpu.span)} ms` : ""}`);
        const len = firedW - dueW;
        verdict = gcMs >= len * 0.5 ? "late timer: GC pause"
          : (st.share.R || 0) >= 0.5 ? (!cpu ? "late timer: main thread running or runnable (R)" : cpu.cpu >= cpu.span * 0.5 ? "late timer: busy main thread (CPU)" : "late timer: descheduled (runnable, little CPU)")
          : (st.share.U || 0) + (st.share.D || 0) >= 0.3 ? "late timer: uninterruptible OS wait"
          : (st.share.S || 0) >= 0.5 ? (/futex|psynch|mutex|lock/i.test(st.text) ? "late timer: blocked in a synchronous wait" : "late timer: main thread waiting in the kernel")
          : observer ? "late timer: unclassified" : "late timer (no observer)";
      } else if (conn.closedAt && conn.closedAt - destroyW >= LATE_MS) verdict = "destroy on time, close observed late";
      else verdict = "on time";
    }
  }
  parts.push(`'close' observed ${rel(conn.closedAt)}`);
  return { verdict, line: `${verdict}: ${parts.join("; ")}`.slice(0, 900) };
}

module.exports = { startGraceTrace, classify, statesIn, LATE_MS, wall };
