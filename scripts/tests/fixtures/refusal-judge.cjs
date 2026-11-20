// Judges what a refused client saw against what the server did on its connection (same rule as the 20-client test in
// refusal-close.test.cjs, #140). The client must have read the expected answer. The one accepted exception is the
// documented reset tradeoff of http/refusal-close.cjs: a client whose answer was lost passes only if the server kept
// the connection open for the whole grace period after writing the answer AND the client's process did not complete
// an event-loop iteration in that window (no two consecutive ticks; `ticks` from fixtures/refusal-clients.cjs). Anything else is a failure.
//   conn: { status, answeredAt, closedAt } (server side, wall-clock ms); st: a refusal-clients.cjs result.
"use strict";
const { GRACE_MS } = require("../../server/http/refusal-close.cjs");

const GRACE_TOLERANCE_MS = 100; // timer granularity: the grace timer starts just before 'finish' is observed
const TICK_MARGIN_MS = 5;       // loopback delivery time for the answer and for the reset

// #151 diagnostics: where the client's activity fell relative to the server's answer and close (ms; bounded), so a
// failure or an excuse can be checked against the timeline instead of a count.
function timeline(st, conn, ticks) {
  if (!conn || conn.answeredAt == null) return "";
  const rel = (t) => (t == null ? null : t - conn.answeredAt);
  const sorted = [...(ticks || [])].sort((a, b) => a - b);
  const end = conn.closedAt == null ? Infinity : conn.closedAt;
  const inside = sorted.filter((t) => t > conn.answeredAt && t < end);
  const before = sorted.filter((t) => t <= conn.answeredAt).at(-1), after = sorted.find((t) => t >= end);
  const io = st.io || {};
  return ` [timeline ms from the server's answer: serverClose ${rel(conn.closedAt)}; ticks last-before ${rel(before)}, inside ${inside.length}${inside.length ? ` (first ${inside.slice(0, 5).map(rel).join(",")})` : ""}, first-after ${rel(after)}; drains ${JSON.stringify((st.drainsAt || []).map(rel).filter((x) => x > -1000 && x < 10000).slice(0, 10))}; client firstData ${rel(io.firstDataAt)} (${io.dataEvents || 0} events), end ${rel(io.endAt)}, error ${rel(io.errorAt)}, close ${rel(io.closeAt)}]`;
}

function judgeRefusedClient(st, conn, ticks, status, bodyMatch = null) {
  const v = judgeRefusedClientRule(st, conn, ticks, status, bodyMatch);
  return v.kind === "answered" ? v : { ...v, why: `${v.why}${timeline(st, conn, ticks)}` };
}

function judgeRefusedClientRule(st, conn, ticks, status, bodyMatch = null) {
  if (!conn) return { ok: false, why: `no server record for client port ${st.localPort}` };
  if (st.status === status) {
    if (bodyMatch && !bodyMatch.test(st.body || "")) return { ok: false, why: `client read ${status} with an unexpected body ${JSON.stringify(String(st.body).slice(0, 120))}` };
    return { ok: true, kind: "answered" };
  }
  if (st.status !== null) return { ok: false, why: `client read status ${st.status}, expected ${status}` };
  if (conn.status !== status || conn.answeredAt == null || conn.closedAt == null) return { ok: false, why: `server status ${conn.status}, answered ${conn.answeredAt}, closed ${conn.closedAt}` };
  const kept = conn.closedAt - conn.answeredAt;
  if (kept < GRACE_MS - GRACE_TOLERANCE_MS) return { ok: false, why: `answer lost, and the server closed only ${kept} ms after answering (grace ${GRACE_MS} ms)` };
  // Running = one whole event-loop iteration inside the window: two consecutive ticks both in it. A single tick only
  // shows the timers phase ran; the process can be descheduled before the I/O phase that would read the answer (#145).
  const inWindow = (t) => t > conn.answeredAt + TICK_MARGIN_MS && t < conn.closedAt - TICK_MARGIN_MS;
  // Direct evidence first: the client handled I/O on this very connection inside the window (#145).
  const own = (st.drainsAt || []).filter(inWindow);
  if (own.length > 0) return { ok: false, why: `answer lost although the client handled I/O on this connection ${own.length} time(s) while the server kept it open` };
  const sorted = [...ticks].sort((a, b) => a - b);
  let iterations = 0;
  for (let i = 1; i < sorted.length; i += 1) if (inWindow(sorted[i - 1]) && inWindow(sorted[i])) iterations += 1;
  if (iterations > 0) return { ok: false, why: `answer lost although the client process completed ${iterations} event-loop iteration(s) during the ${kept} ms the server kept the connection open` };
  return { ok: true, kind: "stalled", why: `client process did not run while the server held the connection (${kept} ms); client error ${st.error}` };
}

// ── PROPOSAL ONLY (#151), used by no test that judges a real run ─────────────────────────────────────────────────────
// On macOS, libuv's kqueue backend hands a socket's EVFILT_READ and EVFILT_WRITE results to their callback as separate
// entries, in the kernel's order (libuv v1.49.1, as bundled with Node 22.12.0 src/unix/kqueue.c); on Linux one epoll event carries both and the read
// is handled first (src/unix/linux.c, src/unix/stream.c). So on macOS a write completion ('drain') can run before the
// read of an answer that has already arrived, and a stall right after it loses the answer. Proposed rule, for
// platform "darwin" only: a drain in the window is evidence the client ran at that moment (like a tick), not that it
// read; a lost answer is still a failure if the client received any data in the window, or if two activity points
// (ticks and drains together) fall in the window (the loop moved past that I/O phase, so a ready read was handled).
// Every other platform keeps today's rule.
function judgeRefusedClientProposed(st, conn, ticks, status, bodyMatch = null, platform = process.platform) {
  if (platform !== "darwin") return judgeRefusedClient(st, conn, ticks, status, bodyMatch);
  const base = judgeRefusedClientRule({ ...st, drainsAt: [] }, conn, ticks, status, bodyMatch);
  if (!base.ok || base.kind !== "stalled") return base.kind === "answered" ? base : { ...base, why: `${base.why}${timeline(st, conn, ticks)}` };
  const inWindow = (t) => t > conn.answeredAt + TICK_MARGIN_MS && t < conn.closedAt - TICK_MARGIN_MS;
  const io = st.io || {};
  if (io.firstDataAt != null && io.firstDataAt <= conn.closedAt - TICK_MARGIN_MS) return { ok: false, why: `answer lost although the client received data on this connection ${io.firstDataAt - conn.answeredAt} ms after the answer${timeline(st, conn, ticks)}` };
  const points = [...ticks, ...(st.drainsAt || [])].sort((a, b) => a - b);
  for (let i = 1; i < points.length; i += 1) {
    if (inWindow(points[i - 1]) && inWindow(points[i])) return { ok: false, why: `answer lost although the client ran at ${points[i - 1] - conn.answeredAt} ms and again at ${points[i] - conn.answeredAt} ms after the answer (ticks and drains together)${timeline(st, conn, ticks)}` };
  }
  return { ok: true, kind: "stalled", why: `client process did not run past a single activity point while the server held the connection (macOS rule)${timeline(st, conn, ticks)}` };
}

module.exports = { judgeRefusedClient, judgeRefusedClientProposed, timeline };
