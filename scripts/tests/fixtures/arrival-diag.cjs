// Request-arrival evidence (test-only, message only, never judged): the refusal-close.test.cjs "20 concurrent refused
// clients" test asserts that the server answered each connection within ANSWER_MS of accepting it. On macOS Intel it
// failed six times with 5.1–8.7 s (#151 class C). The server can only answer after the request head has arrived, and
// its clients run in a separate process, so a late answer measured from the accept can come from a client that had
// not yet sent its head, or from the server (which shares this test process) not running. This describes, as one
// bounded numbers-only line, for every connection: accept -> request (head parsed, the server's 'request' event) and
// request -> answer, plus this process's own 10 ms tick gaps. The test's assertions are unchanged.
//   conns     server records { remotePort, acceptedAt, requestAt, answeredAt }
//   ticks     this (server) process's 10 ms ticks during the run
//   answerMs  the test's ANSWER_MS bound (only used to list the connections over it)
"use strict";
const MAX_ITEMS = 6;
const n = (v) => (Number.isFinite(v) ? Math.round(v) : "?");
const stat = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? `median ${n(v[Math.floor(v.length / 2)])} max ${n(v[v.length - 1])}` : "none"; };

function describeArrivals(conns, ticks, answerMs) {
  const cs = Array.isArray(conns) ? conns : [];
  const t0 = Math.min(...cs.map((c) => c.acceptedAt).filter(Number.isFinite));
  const rel = (t) => (Number.isFinite(t) && Number.isFinite(t0) ? n(t - t0) : "none");
  const acc2req = cs.map((c) => (Number.isFinite(c.requestAt) ? c.requestAt - c.acceptedAt : NaN));
  const req2ans = cs.map((c) => (Number.isFinite(c.requestAt) && Number.isFinite(c.answeredAt) ? c.answeredAt - c.requestAt : NaN));
  const parts = [`${cs.length} connections; accept -> request ${stat(acc2req)}; request -> answer ${stat(req2ans)}; no request seen ${cs.filter((c) => !Number.isFinite(c.requestAt)).length}`];
  const slow = cs.filter((c) => Number.isFinite(c.answeredAt) && c.answeredAt - c.acceptedAt > answerMs);
  parts.push(`over ${n(answerMs)} ms from accept ${slow.length}${slow.length ? `: ${slow.slice(0, MAX_ITEMS).map((c) => `[accepted ${rel(c.acceptedAt)} request ${rel(c.requestAt)} answered ${rel(c.answeredAt)}]`).join(" ")}` : ""}`);
  const tk = Array.isArray(ticks) ? ticks : [];
  const gaps = [];
  for (let i = 1; i < tk.length; i += 1) if (tk[i] - tk[i - 1] >= 100) gaps.push([tk[i - 1], tk[i] - tk[i - 1]]);
  gaps.sort((a, b) => b[1] - a[1]);
  parts.push(tk.length ? `server process ticks ${tk.length}, gaps >= 100 ms ${gaps.length}${gaps.length ? `: ${gaps.slice(0, MAX_ITEMS).map(([at, ms]) => `${n(ms)} from ${rel(at)}`).join(", ")}` : ""}` : "server process ticks not recorded");
  return parts.join("; ").slice(0, 1200);
}

module.exports = { describeArrivals };
