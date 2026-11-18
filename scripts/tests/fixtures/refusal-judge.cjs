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

function judgeRefusedClient(st, conn, ticks, status, bodyMatch = null) {
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
  const sorted = [...ticks].sort((a, b) => a - b);
  let iterations = 0;
  for (let i = 1; i < sorted.length; i += 1) if (inWindow(sorted[i - 1]) && inWindow(sorted[i])) iterations += 1;
  if (iterations > 0) return { ok: false, why: `answer lost although the client process completed ${iterations} event-loop iteration(s) during the ${kept} ms the server kept the connection open` };
  return { ok: true, kind: "stalled", why: `client process did not run while the server held the connection (${kept} ms); client error ${st.error}` };
}

module.exports = { judgeRefusedClient };
