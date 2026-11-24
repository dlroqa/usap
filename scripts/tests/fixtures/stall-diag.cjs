// #151 diagnostics: describes one refused client whose answer was lost, from the records of three processes, as a
// bounded, numbers-only line for t.diagnostic(). It never decides a verdict: the tests keep their assertions and
// fixtures/refusal-judge.cjs unchanged, and print this line before asserting.
//   st:      a fixtures/refusal-clients.cjs result (drainsAt, io.drainChecksAt, io.firstDataAt, ...)
//   rec:     the connection-log record for that connection (finishAt, sockCloseAt, optional loop)
//   ticks:   the client process's 10 ms timer runs
//   sampler: fixtures/stall-sampler.cjs output, or null
//   proc:    optional; the "proc" output of fixtures/refusal-clients.cjs with cpuDiag (CPU time, context switches and
//            bytes sent at each client tick, and the in-process watchdog thread), or null when it was not recorded
//   index:   optional; this client's index in proc's per-client bytes
// All times are printed in ms relative to the server's answer (rec.finishAt).
"use strict";
const MAX_ITEMS = 10;

function overlaps([at, ms], from, to) { return at + ms > from && at < to; }

// The client process's longest tick gap that overlaps [from, to], read from its samples: how much CPU time the process
// used, how often it was switched out and how many bytes its clients sent during the gap, and whether the watchdog
// thread in the same process also stopped. Readings say what the numbers are consistent with; they never name a cause.
const BUSY_SHARE = 0.5, IDLE_SHARE = 0.1, MIN_GAP_MS = 50;
function describeProcessGap(proc, index, from, to, rel) {
  if (!proc || !Array.isArray(proc.samples) || proc.samples.length < 2) return "client process: not recorded";
  const s = proc.samples;
  let best = -1;
  for (let i = 1; i < s.length; i++) {
    if (s[i][0] <= from || s[i - 1][0] >= to) continue; // gap does not overlap the window
    if (best < 0 || s[i][0] - s[i - 1][0] > s[best][0] - s[best - 1][0]) best = i;
  }
  if (best < 0) return "client process: no samples in window";
  const [a, b] = [s[best - 1], s[best]];
  const wall = b[0] - a[0];
  if (wall < MIN_GAP_MS) return `client process: no tick gap >= ${MIN_GAP_MS} ms in window (longest ${wall} ms)`;
  const cpu = (b[1] - a[1]) + (b[2] - a[2]);
  const sentAll = (b[5] || []).reduce((x, y) => x + y, 0) - (a[5] || []).reduce((x, y) => x + y, 0);
  const sentThis = index == null || a[5] == null || a[5][index] == null || b[5][index] == null ? null : b[5][index] - a[5][index];
  const parts = [`client process gap ${rel(a[0])}..${rel(b[0])} (${wall} ms): CPU +${b[1] - a[1]} user +${b[2] - a[2]} system ms; context switches +${b[3] - a[3]} voluntary +${b[4] - a[4]} involuntary; sent +${sentAll} KiB all clients${sentThis == null ? "" : `, +${sentThis} KiB this client`}`];
  const wd = proc.watchdog;
  let wdStopped = null;
  if (wd && Array.isArray(wd.gaps)) {
    const g = wd.gaps.filter(([at, ms]) => at + ms > a[0] && at < b[0]).slice(0, MAX_ITEMS);
    const covered = g.reduce((x, [at, ms]) => x + Math.max(0, Math.min(at + ms, b[0]) - Math.max(at, a[0])), 0);
    wdStopped = covered >= wall * BUSY_SHARE;
    parts.push(`watchdog thread gaps in it ${g.map(([at, ms]) => `${rel(at)}+${ms}`).join(",") || "none"} (max over run ${wd.maxGapMs})`);
  } else parts.push("watchdog thread: unavailable");
  let reading;
  if (cpu >= wall * BUSY_SHARE) reading = "CPU time grew through the gap: consistent with the process executing, not with it being stopped";
  else if (cpu <= wall * IDLE_SHARE && wdStopped === true) reading = "little CPU time and the watchdog thread also stopped: consistent with the whole process not running";
  else if (cpu <= wall * IDLE_SHARE && wdStopped === false) reading = "little CPU time while the watchdog thread ran: consistent with the main thread waiting while the process ran";
  else if (cpu <= wall * IDLE_SHARE) reading = "little CPU time (watchdog unavailable): the process was mostly not executing; waiting and not running are not told apart";
  else reading = "mixed: no single reading";
  parts.push(`reading: ${reading}`);
  return parts.join("; ");
}

function describeLostClient(st, rec, ticks, sampler, proc, index) {
  if (!rec || rec.finishAt == null) return "no server answer recorded";
  const a = rec.finishAt, close = rec.sockCloseAt == null ? Infinity : rec.sockCloseAt;
  const rel = (t) => (t == null ? null : t - a);
  const inWin = (t) => t != null && t > a && t < close;
  const io = st.io || {};
  const drains = (st.drainsAt || []).map((t, i) => [t, (io.drainChecksAt || [])[i]]).filter(([t]) => inWin(t)).slice(0, MAX_ITEMS);
  const passed = drains.filter(([, c]) => c != null && c < close).length;
  const sorted = [...(ticks || [])].sort((x, y) => x - y);
  const ticksIn = sorted.filter(inWin);
  const parts = [];
  parts.push(`serverClose ${rel(rec.sockCloseAt)}`);
  parts.push(`drains in window ${drains.length ? drains.map(([t, c]) => `${rel(t)}@check ${c == null ? "none" : rel(c)}`).join(",") : "none"}`);
  if (drains.length) parts.push(passed ? `a drain's loop iteration reached its check phase before the close (${passed}/${drains.length}): the client got past that I/O phase while the connection was open`
    : "no drain's loop iteration reached its check phase before the close: the client stopped inside the iteration that handled the drain");
  parts.push(`client data first ${rel(io.firstDataAt)} check ${rel(io.firstDataCheckAt)}`);
  parts.push(`client ticks in window ${ticksIn.length}${ticksIn.length ? ` (${ticksIn.slice(0, MAX_ITEMS).map(rel).join(",")})` : ""}`);
  const loop = rec.loop;
  if (loop) parts.push(`server loop gaps ${(loop.gaps || []).slice(0, MAX_ITEMS).map(([at, ms]) => `${rel(at)}+${ms}`).join(",") || "none"} (delay p99 ${loop.delayP99Ms} max ${loop.delayMaxMs})`);
  else parts.push("server loop: not recorded");
  if (sampler && Array.isArray(sampler.gaps)) {
    const from = a, to = Number.isFinite(close) ? close : a + 60000;
    const g = sampler.gaps.filter((x) => overlaps(x, from, to)).slice(0, MAX_ITEMS);
    parts.push(`sampler process gaps in window ${g.map(([at, ms]) => `${rel(at)}+${ms}`).join(",") || "none"} (max over run ${sampler.maxGapMs})`);
  } else parts.push("sampler: unavailable");
  if (proc !== undefined) parts.push(describeProcessGap(proc, index, a, Number.isFinite(close) ? close : a + 60000, rel));
  return parts.join("; ");
}

module.exports = { describeLostClient, describeProcessGap };
