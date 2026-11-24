// #151 diagnostics (test-only, messages only, never judged): one bounded line per lost json-413 client that puts the
// server's and the client's events on one time line (ms from the moment the server handed its 413 to the kernel; a
// server write is NOT client receipt) and, for each window in which the client process's main thread did not run its
// 10 ms timer (ticks), what else was going on: the client's GC pauses, and the main-thread scheduler states the
// independent observer (fixtures/thread-observer.cjs) saw for the client and the studio. The reading follows fixed
// rules and says only which kind of stall the evidence fits; it decides nothing.
"use strict";
const MIN_GAP_MS = 200, MAX_WINDOWS = 3;

// States covering [a, b] from change-only runs [[t, state, cpu, extra]]: "R 1200 ms, S(kevent) 300 ms".
function statesIn(runs, a, b) {
  if (!Array.isArray(runs) || !runs.length) return { text: "not observed", share: {} };
  const dur = new Map();
  for (let i = 0; i < runs.length; i += 1) {
    const from = Math.max(a, runs[i][0]), to = Math.min(b, i + 1 < runs.length ? runs[i + 1][0] : b);
    if (to <= from) continue;
    const key = `${runs[i][1]}${runs[i][3] && !/^runnable/.test(runs[i][3]) ? `(${runs[i][3]})` : ""}`;
    dur.set(key, (dur.get(key) || 0) + (to - from));
  }
  const total = [...dur.values()].reduce((x, y) => x + y, 0) || 1;
  const share = {};
  for (const [k, v] of dur) { const s = k[0]; share[s] = (share[s] || 0) + v / total; }
  return { text: [...dur.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, v]) => `${k} ${Math.round(v)} ms`).join(", ") || "no sample in window", share };
}

// Process CPU (user + system ms, all threads) between the per-tick samples at the window's ends, or null.
function cpuIn(samples, a, b) {
  if (!Array.isArray(samples) || !samples.length) return null;
  const at = (t) => samples.reduce((best, x) => (Math.abs(x[0] - t) < Math.abs(best[0] - t) ? x : best), samples[0]);
  const x = at(a), y = at(b);
  return Math.abs(x[0] - a) <= 20 && Math.abs(y[0] - b) <= 20 ? (y[1] + y[2]) - (x[1] + x[2]) : null;
}
function reading(win, gcMs, client, cpuMs) {
  const len = win[1] - win[0];
  if (gcMs >= len * 0.5) return "GC pause";
  const s = client.share;
  if ((s.R || 0) >= 0.5) return cpuMs === null ? "running or runnable (R; process CPU unknown)" : cpuMs >= len * 0.5 ? "running: a busy main thread (CPU)" : "runnable but not running (descheduled)";
  if ((s.U || 0) + (s.D || 0) >= 0.3) return "uninterruptible OS wait";
  if ((s.S || 0) >= 0.5) return /futex|psynch|mutex|lock/i.test(client.text) ? "blocked in a synchronous wait" : "waiting in the kernel (event-loop wait or a blocking call; see stack leaf frames)";
  return "unclassified";
}

/**
 * @param {object} o  st (client state), rec (server record), ticks, proc ({ gc, loop }), observer (thread-observer
 *                    output or null), clientPid, serverPid
 */
function describeStallCorrelates({ st, rec, ticks = [], proc = null, observer = null, clientPid = null, serverPid = null } = {}) {
  if (!rec || !Number.isFinite(rec.finishAt)) return "no server record";
  const t0 = rec.finishAt;
  const r = (t) => (Number.isFinite(t) ? Math.round(t - t0) : "none");
  const io = (st && st.io) || {};
  const head = [`server answer handed to the kernel 0 (not client receipt), server close ${r(rec.sockCloseAt)}`,
    `client first data ${r(io.firstDataAt)}, error ${st.error || "none"} at ${r(io.errorAt)} with ${io.pendingAtError === undefined ? "?" : io.pendingAtError} B still queued in Node, close ${r(io.closeAt)}, drains ${Array.isArray(st.drainsAt) ? st.drainsAt.length : 0}`];
  const end = Math.max(rec.sockCloseAt || t0, io.closeAt || t0) + 100;
  const wins = [];
  for (let i = 1; i < ticks.length && wins.length < MAX_WINDOWS; i += 1) {
    const a = ticks[i - 1], b = ticks[i];
    if (b - a >= MIN_GAP_MS && b >= t0 - 100 && a <= end) wins.push([a, b]);
  }
  const procs = (observer && observer.procs) || {};
  const parts = wins.map((w) => {
    const gcs = ((proc && proc.gc) || []).filter(([t, d]) => t < w[1] && t + d > w[0]);
    const gcMs = gcs.reduce((x, g) => x + Math.max(0, Math.min(w[1], g[0] + g[1]) - Math.max(w[0], g[0])), 0);
    const c = statesIn(procs[clientPid] && procs[clientPid].runs, w[0], w[1]);
    const s = statesIn(procs[serverPid] && procs[serverPid].runs, w[0], w[1]);
    const cpu = cpuIn(proc && proc.samples, w[0], w[1]);
    return `client main thread silent ${r(w[0])}..${r(w[1])} (${w[1] - w[0]} ms): process CPU ${cpu === null ? "?" : `${cpu} ms`}; GC ${gcs.length} pauses ${gcMs} ms; observer client ${c.text}; studio ${s.text}; reading: ${observer ? reading(w, gcMs, c, cpu) : gcMs >= (w[1] - w[0]) * 0.5 ? "GC pause" : "no observer"}`;
  });
  const loop = proc && proc.loop ? `client loop delay max ${proc.loop.maxMs} ms p99 ${proc.loop.p99Ms} ms` : "loop delay not recorded";
  return [...head, ...(parts.length ? parts : ["no client silent window >= 200 ms around the answer"]), loop, observer ? `observer ${observer.platform} every ${observer.intervalMs} ms${observer.unsupported ? " (unsupported)" : ""}` : "observer not run"].join("; ").slice(0, 2000);
}

module.exports = { describeStallCorrelates, statesIn, reading, cpuIn };
