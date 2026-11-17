// Judges what a refused client saw against what the server did on its connection (same rule as the 20-client test in
// refusal-close.test.cjs, #140). The client must have read the expected answer. The one accepted exception is the
// documented reset tradeoff of http/refusal-close.cjs: a client whose answer was lost passes only if the server kept
// the connection open for the whole grace period after writing the answer AND the client's process did not run at all
// in that window (no event-loop tick; `ticks` from fixtures/refusal-clients.cjs). Anything else is a failure.
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
  const ran = ticks.filter((t) => t > conn.answeredAt + TICK_MARGIN_MS && t < conn.closedAt - TICK_MARGIN_MS);
  if (ran.length > 0) return { ok: false, why: `answer lost although the client process ran ${ran.length} times during the ${kept} ms the server kept the connection open` };
  return { ok: true, kind: "stalled", why: `client process did not run while the server held the connection (${kept} ms); client error ${st.error}` };
}

module.exports = { judgeRefusedClient };
