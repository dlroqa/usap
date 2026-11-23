// Transcription absolute-deadline evidence (test-only, message only, never judged): the transcription-queue.test.cjs
// test "service: one absolute deadline from arrival covers the upload and any discarding after a refusal". On a macOS
// Intel runner it closed 3561 ms after arrival (bound 2700 ms). The service and the client share the test process, so
// a late close can come from the service (a deadline armed for the wrong time, or one that fires without closing) or
// from the process not running when the timer was due. This describes, as one bounded numbers-only line, what each
// side recorded; the test's assertions are unchanged and run after the line is printed.
//   o.arrival   the server's 'connection' time for the request (all times are relative to it)
//   o.closeAt   when the server saw the connection close
//   o.answerAt  when the client received the answer head (null if never)
//   o.timers    the service's timers in this test, from the harness's setTimer wrapper:
//               [{ setAt, ms, dueAt, firedAt (null if not fired), clearedAt (null if not cleared) }]
//   o.ticks     this process's 10 ms ticks during the test
//   o.deadlineMs, o.boundMs   the configured deadline (2000) and the test's bound (2700)
"use strict";
const MAX_TIMERS = 8;
const n = (v) => (Number.isFinite(v) ? Math.round(v) : "?");

function describeDeadline(o = {}) {
  const a = o.arrival;
  const rel = (t) => (Number.isFinite(t) && Number.isFinite(a) ? n(t - a) : "none");
  const parts = [`closed ${rel(o.closeAt)}, answer head at client ${rel(o.answerAt)} (deadline ${n(o.deadlineMs)} from arrival, bound ${n(o.boundMs)})`];
  const timers = Array.isArray(o.timers) ? o.timers : [];
  // Timers armed after arrival, in order: when armed, for how long, when due, and what happened to them.
  const mine = timers.filter((t) => !Number.isFinite(a) || t.setAt >= a - 5).slice(0, MAX_TIMERS);
  parts.push(`service timers ${mine.length ? mine.map((t) => `[set ${rel(t.setAt)} for ${n(t.ms)} due ${rel(t.dueAt)} ${t.firedAt != null ? `fired ${rel(t.firedAt)} (late ${n(t.firedAt - t.dueAt)})` : t.clearedAt != null ? `cleared ${rel(t.clearedAt)}` : "pending"}]`).join(" ") : "none"}`);
  // A timer due at arrival + deadline (within 100 ms): the absolute deadline as scheduled.
  const dl = mine.filter((t) => Number.isFinite(a) && Math.abs(t.dueAt - (a + o.deadlineMs)) <= 100);
  parts.push(`timers due at the deadline (±100 ms) ${dl.length}${dl.length ? `: fired ${dl.map((t) => (t.firedAt != null ? rel(t.firedAt) : "never")).join(",")}; close after the last firing ${(() => { const f = dl.filter((t) => t.firedAt != null).map((t) => t.firedAt); return f.length && Number.isFinite(o.closeAt) ? n(o.closeAt - Math.max(...f)) : "?"; })()}` : ""}`);
  // This process's own ticks between the deadline and the close: the longest gap (the process not running).
  const ticks = Array.isArray(o.ticks) ? o.ticks : [];
  let gap = 0, gapAt = null;
  const from = Number.isFinite(a) ? a + o.deadlineMs - 50 : -Infinity, to = Number.isFinite(o.closeAt) ? o.closeAt + 50 : Infinity;
  for (let i = 1; i < ticks.length; i += 1) {
    if (ticks[i] >= from && ticks[i - 1] <= to && ticks[i] - ticks[i - 1] > gap) { gap = ticks[i] - ticks[i - 1]; gapAt = ticks[i - 1]; }
  }
  parts.push(ticks.length ? `test process ticks ${ticks.length}, longest gap around the deadline ${n(gap)} ms${gapAt != null ? ` from ${rel(gapAt)}` : ""}` : "test process ticks not recorded");
  return parts.join("; ").slice(0, 1200);
}

module.exports = { describeDeadline };
