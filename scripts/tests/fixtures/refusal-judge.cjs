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

// ── macOS judge v2b (#151 class B; used on darwin only, by the json-413 concurrent and refusal-close 20-client tests) ──
// Same server-side conditions as today's rule. On macOS, libuv's kqueue backend hands a socket's write and read results
// to their callback as separate entries, so a write completion ('drain') can run before the read of an answer that has
// already arrived, and a process that stops right after it loses the answer. A lost answer is excused only if:
//   E0 the client's own ticks bracket the window (a tick at or before the answer, a tick at or after the close):
//      missing scheduling evidence is never excused;
//   D0 the client received no data before the close;
//   T2 no two consecutive client ticks inside the window (no complete event-loop iteration);
//   N1 at most one drain inside the window;
//   C1 a drain whose check phase was recorded: that check phase ran at or after the close, with no margin (the
//      iteration that handled the drain never finished while the server held the connection);
//   C0 a drain without a recorded check phase: no tick at all inside the window;
//   A1 no tick after the drain inside the window (no later iteration began);
//   U  when a drain is inside the window: the server closed within GRACE_MS + MAC_SLACK_MS of the answer (a server far
//      outside its close bound is not excused by this rule);
//   W  (every record except a pinned historical replay record) when the answer finished, the server socket's byte count covered at
//      least the answer body (conn.bytesWrittenAtFinish >= conn.minAnswerBytes); missing values fail. What this shows,
//      and what it does not: the record is taken at the response's 'finish' event, which Node documents as emitted once
//      the response's last segment was handed off to the operating system; that is the only evidence of an OS
//      hand-off here. socket.bytesWritten itself counts bytes accepted for writing, including bytes still queued in
//      Node's buffers (verified on Node 22.12.0: a 64 MiB write to a non-reading peer reads 64 MiB at once), so the
//      count alone proves no hand-off; it shows the answer was at least fully written to the socket. Neither shows
//      that the bytes reached or were read by the client. The count includes headers, so it is a lower-bound check
//      (single-request connections only). W and K are required of EVERY record, whether or not a call site sets
//      conn.requireWriteEvidence (that flag no longer decides anything): a call site that omitted it can never get an
//      excuse without write and clock evidence. The only exception is a record explicitly marked conn.replayRecord ===
//      true: the pinned historical replay (refusal-judge-replay.json), recorded before these fields existed; only its
//      test sets the mark. Historical replay records carry no such fields and no requireWriteEvidence
//      flag;
//   K  (live records) the two processes' clocks are consistent with causality: the client started its request no later
//      than the server first saw it (st.t0 <= conn.seenAt + 5 ms), and the client saw the connection end no earlier
//      than the server closed it (io.errorAt or io.closeAt >= closedAt - 5 ms). A record that violates either, or
//      lacks the values, fails: an offset between the records' clocks never produces an excuse it detects. Limit: an
//      offset smaller than the slack between those causal events is not detectable; both processes read the same
//      machine's wall clock, so the real offset is the reading latency only;
//   P  drain and check-phase records pair one to one (io.drainChecksAt has the same length as drainsAt when present):
//      otherwise neither can be trusted and the loss fails.
// Without a drain in the window the verdict is today's rule (plus E0). Never used on Linux or Windows.
const MAC_SLACK_MS = 2500; // the scheduling slack refusal-close.test.cjs already allows on top of the grace period
function judgeRefusedClientMac(st, conn, ticks, status, bodyMatch = null) {
  const base = judgeRefusedClientRule({ ...st, drainsAt: [] }, conn, ticks, status, bodyMatch);
  if (base.kind === "answered") return base;
  if (!base.ok) return { ...base, why: `${base.why}${timeline(st, conn, ticks)}` };
  const fail = (why) => ({ ok: false, why: `${why} (macOS rule)${timeline(st, conn, ticks)}` });
  const sorted = [...(ticks || [])].sort((a, b) => a - b);
  const inWindow = (t) => t > conn.answeredAt + TICK_MARGIN_MS && t < conn.closedAt - TICK_MARGIN_MS;
  if (!sorted.some((t) => t <= conn.answeredAt + TICK_MARGIN_MS) || !sorted.some((t) => t >= conn.closedAt - TICK_MARGIN_MS)) return fail("answer lost, and the client's ticks do not cover the window (no scheduling evidence)");
  const io = st.io || {};
  if (io.firstDataAt != null && io.firstDataAt <= conn.closedAt - TICK_MARGIN_MS) return fail(`answer lost although the client received data ${io.firstDataAt - conn.answeredAt} ms after the answer`);
  if (conn.replayRecord !== true) { // W and K: required unless the record is a marked historical replay record
    const end = io.errorAt != null ? io.errorAt : io.closeAt;
    if (!Number.isFinite(st.t0) || !Number.isFinite(conn.seenAt) || st.t0 > conn.seenAt + TICK_MARGIN_MS) return fail(`answer lost, and the client's start (${st.t0}) is not before the server saw the request (${conn.seenAt}): clocks inconsistent`);
    if (!Number.isFinite(end) || end < conn.closedAt - TICK_MARGIN_MS) return fail(`answer lost, and the client saw the end ${Number.isFinite(end) ? `${end - conn.closedAt} ms` : "never"} relative to the server's close: clocks inconsistent or no end seen`);
    const w = conn.bytesWrittenAtFinish, need = conn.minAnswerBytes;
    if (!Number.isFinite(w) || !Number.isFinite(need) || need <= 0 || w < need) return fail(`answer lost, and the server's write of the answer is not shown (socket bytes counted at finish ${w}, answer body ${need})`);
  }
  const drainsAt = st.drainsAt || [], checks = io.drainChecksAt || [];
  if (Array.isArray(io.drainChecksAt) && io.drainChecksAt.length !== drainsAt.length) return fail(`answer lost, and the drain and check-phase records do not pair (${drainsAt.length} drains, ${io.drainChecksAt.length} check records)`);
  const drains = drainsAt.map((t, i) => ({ t, check: checks[i] == null ? null : checks[i] })).filter((d) => inWindow(d.t));
  if (drains.length === 0) return { ...base, why: `${base.why}${timeline(st, conn, ticks)}` };
  if (drains.length > 1) return fail(`answer lost although the client handled I/O on this connection ${drains.length} times while the server kept it open`);
  const [d] = drains;
  const inTicks = sorted.filter(inWindow);
  if (d.check != null && d.check < conn.closedAt) return fail(`answer lost although the loop iteration that handled a drain at ${d.t - conn.answeredAt} ms reached its check phase at ${d.check - conn.answeredAt} ms, before the close`);
  if (d.check == null && inTicks.length > 0) return fail(`answer lost; a drain at ${d.t - conn.answeredAt} ms without a check-phase record and a tick in the window`);
  if (inTicks.some((t) => t > d.t)) return fail(`answer lost although the client ticked after its drain at ${d.t - conn.answeredAt} ms`);
  const kept = conn.closedAt - conn.answeredAt;
  if (kept > GRACE_MS + MAC_SLACK_MS) return fail(`answer lost, and the server closed ${kept} ms after the answer (more than grace ${GRACE_MS} + ${MAC_SLACK_MS} ms)`);
  return { ok: true, kind: "stalled", why: `the client's loop did not complete an I/O phase after its drain at ${d.t - conn.answeredAt} ms before the close at ${kept} ms (macOS rule)${timeline(st, conn, ticks)}` };
}

module.exports = { judgeRefusedClient, judgeRefusedClientProposed, judgeRefusedClientMac, MAC_SLACK_MS, timeline };
