// #151 diagnostics: describes one refused client whose answer was lost, from the records of three processes, as a
// bounded, numbers-only line for t.diagnostic(). It never decides a verdict: the tests keep their assertions and
// fixtures/refusal-judge.cjs unchanged, and print this line before asserting.
//   st:      a fixtures/refusal-clients.cjs result (drainsAt, io.drainChecksAt, io.firstDataAt, ...)
//   rec:     the connection-log record for that connection (finishAt, sockCloseAt, optional loop)
//   ticks:   the client process's 10 ms timer runs
//   sampler: fixtures/stall-sampler.cjs output, or null
// All times are printed in ms relative to the server's answer (rec.finishAt).
"use strict";
const MAX_ITEMS = 10;

function overlaps([at, ms], from, to) { return at + ms > from && at < to; }

function describeLostClient(st, rec, ticks, sampler) {
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
  return parts.join("; ");
}

module.exports = { describeLostClient };
