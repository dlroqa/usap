// J2 evidence (#151, test-only, messages only, never judged): for one client whose answer was lost, every input the
// macOS judge (fixtures/refusal-judge.cjs judgeRefusedClientMac) uses, as recorded, and each of its predicates evaluated
// HERE, by separate code that never calls the judge. The line then gives this independent result next to the judge's
// own result, and whether they agree. It prints on every platform; the verdict each test uses is unchanged.
// Times are ms relative to the server's answer (conn.answeredAt). A missing input is "missing" and fails its predicate.
"use strict";
const { GRACE_MS } = require("../../server/http/refusal-close.cjs");
const TOLERANCE_MS = 100, MARGIN_MS = 5, SLACK_MS = 2500; // the judge's documented values, restated independently

// Write and clock evidence (K1, K2, W) is required of every record except one marked conn.replayRecord === true (the
// pinned historical replay, recorded before those fields existed), exactly as the judge requires it; whether a call
// site set requireWriteEvidence decides nothing.
function j2Evidence(st = {}, conn = {}, ticks = [], expectedStatus, judged = null) {
  const a = conn.answeredAt, c = conn.closedAt;
  const fin = Number.isFinite;
  const rel = (t) => (fin(t) && fin(a) ? Math.round(t - a) : "missing");
  if (st.status === expectedStatus) return "answered (no J2 predicate applies)";
  const io = st.io || {}, sorted = [...(ticks || [])].filter(fin).sort((x, y) => x - y);
  const inW = (t) => fin(a) && fin(c) && t > a + MARGIN_MS && t < c - MARGIN_MS;
  const kept = fin(a) && fin(c) ? c - a : NaN;
  const end = io.errorAt != null ? io.errorAt : io.closeAt;
  const drainsAt = Array.isArray(st.drainsAt) ? st.drainsAt : [], checks = Array.isArray(io.drainChecksAt) ? io.drainChecksAt : null;
  const winTicks = sorted.filter(inW);
  let iterations = 0; for (let i = 1; i < sorted.length; i += 1) if (inW(sorted[i - 1]) && inW(sorted[i])) iterations += 1;
  const drains = drainsAt.map((t, i) => ({ t, check: checks && checks[i] != null ? checks[i] : null })).filter((d) => inW(d.t));
  const P = [];
  const add = (name, ok, detail) => P.push({ name, ok, detail });
  add("S server refused, answered, held >= grace", st.status === null && conn.status === expectedStatus && fin(kept) && kept >= GRACE_MS - TOLERANCE_MS, `client status ${st.status}, server ${conn.status}, held ${fin(kept) ? kept : "missing"}`);
  add("I0 no complete loop iteration in window", iterations === 0, `${iterations} iterations, ${winTicks.length} ticks in window`);
  add("T2 ticks bracket the window", sorted.some((t) => t <= a + MARGIN_MS) && sorted.some((t) => t >= c - MARGIN_MS), `last before ${rel(sorted.filter((t) => t <= a + MARGIN_MS).pop())}, first after ${rel(sorted.find((t) => t >= c - MARGIN_MS))}`);
  add("D0 no data before the close", io.firstDataAt == null || io.firstDataAt > c - MARGIN_MS, `first data ${io.firstDataAt == null ? "none" : rel(io.firstDataAt)}`);
  if (conn.replayRecord !== true) {
    add("K1 client start <= server first sight + 5", fin(st.t0) && fin(conn.seenAt) && st.t0 <= conn.seenAt + MARGIN_MS, `t0 ${rel(st.t0)}, seen ${rel(conn.seenAt)}`);
    add("K2 client saw the end >= close - 5", fin(end) && end >= c - MARGIN_MS, `end ${rel(end)}, close ${rel(c)}`);
    add("W socket bytes at finish >= answer body (> 0)", fin(conn.bytesWrittenAtFinish) && fin(conn.minAnswerBytes) && conn.minAnswerBytes > 0 && conn.bytesWrittenAtFinish >= conn.minAnswerBytes, `${conn.bytesWrittenAtFinish ?? "missing"} >= ${conn.minAnswerBytes ?? "missing"}`);
  } else add("K/W", true, "not required: marked historical replay record");
  add("P drains and check records pair", checks === null || checks.length === drainsAt.length, `${drainsAt.length} drains, ${checks === null ? "no" : checks.length} check records`);
  if (drains.length > 0) {
    add("N1 at most one drain in window", drains.length === 1, `${drains.length} at ${drains.map((d) => rel(d.t)).join(",")}`);
    const d = drains[0];
    if (d.check != null) add("C1 that iteration's check phase not before the close", d.check >= c, `check ${rel(d.check)}`);
    else add("C0 no check record: no tick in window", winTicks.length === 0, `${winTicks.length} ticks`);
    add("A1 no tick after the drain", !winTicks.some((t) => t > d.t), `ticks after ${winTicks.filter((t) => t > d.t).length}`);
    add("U close within grace + slack", fin(kept) && kept <= GRACE_MS + SLACK_MS, `${fin(kept) ? kept : "missing"} <= ${GRACE_MS + SLACK_MS}`);
  }
  const independent = P.every((p) => p.ok) ? "excused" : "fail";
  const judge = judged ? (judged.ok ? (judged.kind === "stalled" ? "excused" : judged.kind) : "fail") : "not given";
  const firstFail = P.find((p) => !p.ok);
  return `${P.map((p) => `${p.name.split(" ")[0]} ${p.ok ? "ok" : "FAIL"} (${p.detail})`).join("; ")} -> independent ${independent}${firstFail ? ` at ${firstFail.name.split(" ")[0]}` : ""}; J2 judge ${judge}; ${judge === independent ? "agree" : "DISAGREE"}`.slice(0, 1600);
}

module.exports = { j2Evidence };
