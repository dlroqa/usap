// #151 diagnostics (test-only, message only, never judged): the "helper fails closed" test in refusal-close.test.cjs.
// Describes, as one bounded numbers-only line, when the fail-closed check closed the socket relative to the answer and
// to the client's reads, and whether other sockets were in their grace period (so the helper's single shared 100 ms
// check timer was probably already running, at an arbitrary phase). It decides no verdict.
//   tm:  test-side records { lingeringBefore, lingeringAtAnswer, destroyAt, destroyRead, closedReadingAtDestroy,
//        closedReadingBefore } (lingeringAtAnswer is taken at the answer's 'finish' and excludes this socket when its own grace
//        period has started; the destroy record comes from a wrapper that calls the original destroy unchanged)
//   rec: server record { answeredAt, readAtAnswer, closedAt, read }
//   st:  fixtures/refusal-clients.cjs result (status, error, io.firstDataAt, io.errorAt, io.closeAt)
//   o:   { watchMs, watchBytes }
// Hypothesis H-D1 (private #151 review): a check that comes soon after the answer because the shared timer was already
// running closes the socket before the client has read the answer. The reading says only whether a record fits it.
"use strict";

function describeFailClosed(tm, rec, st, o) {
  const a = rec && rec.answeredAt;
  if (!a) return "no server answer recorded";
  const rel = (t) => (t == null ? "none" : t - a);
  const io = (st && st.io) || {};
  const byCheck = tm.destroyAt != null && tm.closedReadingAtDestroy != null && tm.closedReadingBefore != null && tm.closedReadingAtDestroy > tm.closedReadingBefore;
  const others = Number.isInteger(tm.lingeringAtAnswer) ? tm.lingeringAtAnswer : null;
  const parts = [
    `other sockets in grace before the request ${tm.lingeringBefore ?? "?"}, at the answer ${others ?? "?"}`,
    `destroy ${rel(tm.destroyAt)}${tm.destroyAt == null ? "" : byCheck ? " by the fail-closed check" : " (not by the fail-closed check)"}`,
    `read by then ${tm.destroyRead == null || rec.readAtAnswer == null ? "?" : tm.destroyRead - rec.readAtAnswer} B after the answer (trigger ${o.watchBytes} B)`,
    `server close ${rel(rec.closedAt)}`,
    `client status ${st && st.status != null ? st.status : "none"}, first data ${rel(io.firstDataAt)}, error ${rel(io.errorAt)} ${String((st && st.error) || "").replace(/[^A-Z0-9_]/g, "").slice(0, 16)}, close ${rel(io.closeAt)}`,
  ];
  const d = tm.destroyAt == null ? null : tm.destroyAt - a;
  const readFirst = io.firstDataAt != null && (tm.destroyAt == null || io.firstDataAt <= tm.destroyAt);
  let reading;
  if (!byCheck) reading = "the fail-closed check did not close this socket: no reading on H-D1";
  else if (d >= o.watchMs) reading = `the first closing check came ${d} ms after the answer (>= the ${o.watchMs} ms interval): not the early-check case of H-D1`;
  else if (others === null) reading = "early closing check; other sockets unknown: no reading on H-D1";
  else if (others > 0) reading = `early closing check (${d} ms < ${o.watchMs} ms) with ${others} other socket(s) in grace: consistent with H-D1 (timer already running)${readFirst ? "; the client read before the close" : "; the client had not read before the close"}`;
  else reading = `early closing check (${d} ms < ${o.watchMs} ms) with no other socket in grace: not explained by H-D1`;
  parts.push(`reading: ${reading}`);
  return parts.join("; ").slice(0, 1200);
}

module.exports = { describeFailClosed };
