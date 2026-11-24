// #151 macOS judge v2b (fixtures/refusal-judge.cjs judgeRefusedClientMac), used on darwin only by the json-413
// concurrent and refusal-close 20-client tests. Pins: the 254-record historical replay, the exception predicate, and
// the negative controls (real server delay, missing scheduling evidence, incorrect closure, helper reset, lost
// response). Today's rule (judgeRefusedClient) and its pinned tests are unchanged.
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { judgeRefusedClient, judgeRefusedClientMac, MAC_SLACK_MS } = require("./fixtures/refusal-judge.cjs");
const { GRACE_MS } = require("../server/http/refusal-close.cjs");
const { records } = require("./fixtures/refusal-judge-replay.json");

const A = 100000; // the server's answer
const conn = (closeMs, extra = {}) => ({ status: 413, answeredAt: A, closedAt: closeMs == null ? null : A + closeMs, ...extra });
const lost = (extra = {}) => ({ localPort: 1, status: null, body: "", error: "ECONNRESET", drainsAt: [], io: { firstDataAt: null, dataEvents: 0, drainChecksAt: [] }, ...extra });
const withDrain = (d, check = null, extra = {}) => lost({ drainsAt: [A + d], io: { firstDataAt: null, dataEvents: 0, drainChecksAt: [check == null ? null : A + check] }, ...extra });
const bracket = (closeMs) => [A - 10, A + closeMs + 200]; // last tick before the answer, first after the close
const M = (st, c, ticks) => judgeRefusedClientMac(st, c, ticks, 413);

function fromRecord(r) {
  const ticks = [];
  if (r.lastBefore != null) ticks.push(A + r.lastBefore);
  if (r.inside >= 1) { const f = A + (r.first ?? (r.lastBefore + 10)); for (let k = 0; k < r.inside; k += 1) ticks.push(f + 10 * k); }
  if (r.firstAfter != null) ticks.push(A + r.firstAfter);
  const st = lost({ drainsAt: r.drains.map((d) => A + d), io: { firstDataAt: r.firstData == null ? null : A + r.firstData, dataEvents: r.firstData == null ? 0 : 1, drainChecksAt: r.checks.map((c) => (c == null ? null : A + c)) } });
  return { st, c: conn(r.serverClose), ticks };
}

test("replay (254 records): every loss today's rule excused stays excused; 4 of the 9 historical failures are newly excused; 5 stay failing", () => {
  assert.equal(records.length, 254);
  const excused = records.filter((r) => r.verdict === "excused");
  const failed = records.filter((r) => r.verdict === "fail");
  assert.equal(excused.length, 245); assert.equal(failed.length, 9);
  for (const r of excused) {
    const { st, c, ticks } = fromRecord(r);
    assert.equal(judgeRefusedClient(st, c, ticks, 413).ok, true, "the replay input reproduces today's verdict");
    assert.equal(M(st, c, ticks).ok, true, `still excused: ${JSON.stringify(r)}`);
  }
  const outcome = Object.fromEntries(failed.map((r) => { const { st, c, ticks } = fromRecord(r); assert.equal(judgeRefusedClient(st, c, ticks, 413).ok, false); return [r.source, M(st, c, ticks)]; }));
  const newly = Object.keys(outcome).filter((k) => outcome[k].ok).sort();
  assert.deepEqual(newly, ["#182 0f1a3bb job 137713317507", "#184 aeaa4aa job 137761435701", "bench b164-B-1", "main 339cb2e attempt 2 job 138036987450"]);
  assert.match(outcome["#165 job 137074259462"].why, /server closed 12770 ms after the answer \(more than grace 2000 \+ 2500 ms\)/, "the 12.77 s late server close must fail");
  for (const k of ["#173 job 137233286423", "job 137122535311", "bench b164-B-7", "bench b164-C-4"]) assert.match(outcome[k].why, /without a check-phase record and a tick in the window/, k);
});

test("the excused shapes, each needing every condition", () => {
  // drain whose iteration never reached its check phase before the close (#184 aeaa4aa, main 339cb2e attempt 2)
  assert.equal(M(withDrain(1978, 2221), conn(2002), [A - 13, A + 2222]).kind, "stalled");
  assert.equal(M(withDrain(1978, 2002), conn(2002), [A - 13, A + 2222]).kind, "stalled", "check phase exactly at the close");
  assert.equal(M(withDrain(1581, 2054), conn(2002), [A - 16, A + 1580, A + 2055]).kind, "stalled", "a tick in the same iteration, before the drain");
  // drain without a check record and no tick in the window (#182 0f1a3bb)
  assert.equal(M(withDrain(6), conn(2002), [A - 1, A + 7835]).kind, "stalled");
  // without a drain, today's rule decides
  assert.equal(M(lost(), conn(2002), bracket(2002)).kind, "stalled");
  assert.equal(M({ ...lost(), status: 413, body: "{}" }, conn(2002), bracket(2002)).kind, "answered");
  assert.equal(MAC_SLACK_MS, 2500);
});

test("negative controls: real server delay and incorrect closure fail", () => {
  assert.equal(M(withDrain(149), conn(12770), [A - 7, A + 12780]).ok, false, "server closed 10.7 s late (#165)");
  assert.equal(M(withDrain(100, GRACE_MS + MAC_SLACK_MS + 20), conn(GRACE_MS + MAC_SLACK_MS + 1), bracket(GRACE_MS + MAC_SLACK_MS + 1)).ok, false, "just past grace + slack");
  assert.equal(M(withDrain(100, GRACE_MS + MAC_SLACK_MS + 20), conn(GRACE_MS + MAC_SLACK_MS), bracket(GRACE_MS + MAC_SLACK_MS)).kind, "stalled", "at grace + slack");
  assert.equal(M(withDrain(50, 400), conn(300), bracket(300)).ok, false, "closed early (300 ms)");
  assert.equal(M(withDrain(50), conn(GRACE_MS - 101), bracket(GRACE_MS)).ok, false, "closed just under the grace tolerance");
  assert.equal(M(withDrain(50), conn(null), [A - 10]).ok, false, "never closed");
  assert.equal(M(withDrain(50), conn(2002, { answeredAt: null }), bracket(2002)).ok, false, "never answered");
  assert.equal(M(withDrain(50), conn(2002, { status: 400 }), bracket(2002)).ok, false, "different server status");
  assert.equal(M(withDrain(50), null, bracket(2002)).ok, false, "no server record");
});

test("negative control: helper reset (the fail-closed check closing about 100 ms after the answer) fails", () => {
  for (const close of [60, 100, 140, 400]) {
    assert.equal(M(withDrain(20), conn(close), [A - 10, A + close + 300]).ok, false, `closed ${close} ms after the answer`);
    assert.equal(M(lost(), conn(close), [A - 10, A + close + 300]).ok, false, `no drain, closed ${close} ms after the answer`);
  }
});

test("negative controls: missing scheduling evidence fails", () => {
  assert.equal(M(withDrain(6), conn(2002), []).ok, false, "no ticks at all");
  assert.equal(M(withDrain(6), conn(2002), [A - 1]).ok, false, "no tick at or after the close");
  assert.equal(M(withDrain(6), conn(2002), [A + 7835]).ok, false, "no tick at or before the answer");
  assert.equal(M(lost(), conn(2002), []).ok, false, "no drain and no ticks: not excused on macOS either");
  // today's rule (other platforms) is not changed by this
  assert.equal(judgeRefusedClient(lost(), conn(2002), [], 413).kind, "stalled");
});

test("negative controls: a lost response while the client was running fails", () => {
  const every10 = (to) => Array.from({ length: Math.ceil((to + 300) / 10) }, (_, i) => A - 50 + i * 10);
  assert.equal(M(withDrain(500), conn(2002), every10(2002)).ok, false, "a client ticking normally");
  assert.equal(M(lost(), conn(2002), [A - 10, A + 500, A + 510, A + 2200]).ok, false, "two consecutive ticks");
  assert.equal(M(withDrain(300), conn(2002), [A - 10, A + 900, A + 2200]).ok, false, "a tick after the drain");
  assert.equal(M(withDrain(300, 301), conn(2002), [A - 10, A + 2200]).ok, false, "the drain's iteration finished before the close");
  assert.equal(M(withDrain(300, 2000), conn(2002), [A - 10, A + 2200]).ok, false, "check phase 2 ms before the close (no margin for C1)");
  assert.equal(M(withDrain(300), conn(2002), [A - 10, A + 299, A + 2200]).ok, false, "no check record and a tick in the window");
  assert.equal(M(lost({ drainsAt: [A + 300, A + 400], io: { firstDataAt: null, dataEvents: 0, drainChecksAt: [A + 2100, A + 2100] } }), conn(2002), [A - 10, A + 2200]).ok, false, "two drains");
  assert.equal(M(withDrain(300, 2100, { io: { firstDataAt: A + 301, dataEvents: 1, drainChecksAt: [A + 2100] } }), conn(2002), [A - 10, A + 2200]).ok, false, "received data");
  assert.equal(M({ ...withDrain(300, 2100), status: 200 }, conn(2002), [A - 10, A + 2200]).ok, false, "read a different answer");
  assert.equal(judgeRefusedClientMac({ ...lost(), status: 413, body: "x" }, conn(2002), bracket(2002), 413, /BODY_TOO_LARGE/).ok, false, "read the right status with the wrong body");
});

test("today's rule is untouched: the macOS rule is a separate function", () => {
  assert.equal(judgeRefusedClient(withDrain(6), conn(2002), [A - 1, A + 7835], 413).ok, false, "a drain in the window still fails today's rule");
  assert.equal(judgeRefusedClient(withDrain(1978, 2221), conn(2002), [A - 13, A + 2222], 413).ok, false);
});

// ── J2 safety controls (2026-11-24): write evidence, ±5 ms boundaries, drain/check pairing, clock offsets ──────────
// Live records (requireWriteEvidence) carry the server's first sight of the request (seenAt), its socket's byte count
// at 'finish' (bytes accepted for writing, not proof of an OS hand-off), and the client's start (t0) and end (io.errorAt).
const live = (closeMs, extra = {}) => conn(closeMs, { requireWriteEvidence: true, seenAt: A - 90, bytesWrittenAtFinish: 180, minAnswerBytes: 90, ...extra });
const liveSt = (st, closeMs, endAfterClose = 50) => ({ ...st, t0: A - 100, io: { ...st.io, errorAt: A + closeMs + endAfterClose } });

test("W: on live records the socket's byte count at finish must cover the answer body; missing values fail; replay records are not affected", () => {
  const st = liveSt(withDrain(1978, 2221), 2002), ticks = [A - 13, A + 2222];
  assert.equal(M(st, live(2002), ticks).kind, "stalled", "bytes written >= the answer body");
  assert.equal(M(st, live(2002, { bytesWrittenAtFinish: 89 }), ticks).ok, false, "fewer bytes than the answer body");
  assert.equal(M(st, live(2002, { bytesWrittenAtFinish: 0 }), ticks).ok, false, "nothing written");
  assert.equal(M(st, live(2002, { bytesWrittenAtFinish: null }), ticks).ok, false, "not recorded");
  assert.equal(M(st, live(2002, { minAnswerBytes: null }), ticks).ok, false, "answer size unknown");
  assert.equal(M(liveSt(lost(), 2002), live(2002, { bytesWrittenAtFinish: null }), bracket(2002)).ok, false, "also without a drain: a live loss needs write evidence on macOS");
  assert.equal(M(liveSt(lost(), 2002), live(2002), bracket(2002)).kind, "stalled");
  assert.equal(M({ ...lost(), status: 413, body: "{}" }, live(2002, { bytesWrittenAtFinish: null }), bracket(2002)).kind, "answered", "an answered client needs no write evidence");
  assert.equal(M(withDrain(1978, 2221), conn(2002), ticks).kind, "stalled", "historical records (no flag) keep their replay classification");
});

test("K: on live records, inconsistent or missing clock evidence fails", () => {
  const ticks = [A - 13, A + 2222];
  assert.equal(M({ ...liveSt(withDrain(1978, 2221), 2002), t0: undefined }, live(2002), ticks).ok, false, "no client start");
  assert.equal(M(liveSt(withDrain(1978, 2221), 2002), live(2002, { seenAt: null }), ticks).ok, false, "no server first sight");
  assert.equal(M({ ...liveSt(withDrain(1978, 2221), 2002), t0: A - 80 }, live(2002, { seenAt: A - 90 }), ticks).ok, false, "client started 10 ms after the server saw it");
  assert.equal(M(liveSt(withDrain(1978, 2221), 2002, -10), live(2002), ticks).ok, false, "client saw the end 10 ms before the server closed");
  assert.equal(M({ ...liveSt(withDrain(1978, 2221), 2002), io: { ...withDrain(1978, 2221).io, errorAt: null, closeAt: null } }, live(2002), ticks).ok, false, "client never saw the end");
});

test("B: ±5 ms boundaries of the window are pinned", () => {
  // the window is (answer + 5, close - 5) exclusive (TICK_MARGIN_MS = 5)
  const at = (d, check) => M(withDrain(d, check), conn(2002), [A - 10, A + 2210]);
  assert.equal(at(5, null).kind, "stalled", "drain at answer + 5: outside the window, today's rule (no tick inside) applies");
  assert.equal(at(6, null).kind, "stalled", "drain at answer + 6: inside; no check record and no tick inside, so C0 holds");
  assert.equal(at(6, 6).ok, false, "drain at answer + 6 whose check ran at once (before the close): C1 fails");
  assert.equal(at(1997, null).kind, "stalled", "drain at close - 5: outside the window");
  assert.equal(at(1996, 2001).ok, false, "drain at close - 6 with check 1 ms before the close: C1 fails (no margin)");
  assert.equal(at(1996, 2002).kind, "stalled", "check exactly at the close: C1 holds");
  const ticks = (xs) => M(lost(), conn(2002), [A - 10, ...xs.map((x) => A + x), A + 2210]);
  assert.equal(ticks([5, 15]).kind, "stalled", "ticks at +5 and +15: only one inside the window");
  assert.equal(ticks([6, 16]).ok, false, "ticks at +6 and +16: two consecutive inside, T2 fails");
  assert.equal(ticks([1987, 1997]).kind, "stalled", "ticks at close - 15 and close - 5: only one inside");
  assert.equal(ticks([1986, 1996]).ok, false, "ticks at close - 16 and close - 6: two inside, T2 fails");
  assert.equal(M(lost(), conn(2002), [A + 5, A + 2210]).kind, "stalled", "E0: a tick at answer + 5 counts as before the answer");
  assert.equal(M(lost(), conn(2002), [A + 6, A + 2210]).ok, false, "E0: the first tick at answer + 6 leaves the start uncovered");
  assert.equal(M(lost(), conn(2002), [A - 10, A + 1997]).kind, "stalled", "E0: a tick at close - 5 counts as after the close");
  assert.equal(M(lost(), conn(2002), [A - 10, A + 1996]).ok, false, "E0: the last tick at close - 6 leaves the end uncovered");
});

test("P: drain and check-phase records must pair one to one", () => {
  const ticks = [A - 13, A + 2222];
  const st = (drains, checks) => lost({ drainsAt: drains.map((d) => A + d), io: { firstDataAt: null, dataEvents: 0, drainChecksAt: checks.map((c) => (c == null ? null : A + c)) } });
  assert.equal(M(st([1978], [2221]), conn(2002), ticks).kind, "stalled", "paired");
  assert.equal(M(st([1978], []), conn(2002), ticks).ok, false, "a drain without its check record slot");
  assert.equal(M(st([1978], [2221, 2300]), conn(2002), ticks).ok, false, "an extra check record");
  assert.equal(M(st([100, 1978], [2221]), conn(2002), ticks).ok, false, "a check record missing for an earlier drain (misaligned)");
  assert.equal(M(st([1978], [null]), conn(2002), ticks).kind, "stalled", "a paired slot whose check has not run yet counts as no check record (C0)");
});

test("D: ±50 ms clock offsets on live records never excuse a genuine failure", () => {
  // every client-side time moves together (ticks, drains, checks, data, start, end); server times stay
  const shift = (st, ticks, d) => [{ ...st, t0: st.t0 + d, drainsAt: (st.drainsAt || []).map((t) => t + d), io: { ...st.io, firstDataAt: st.io.firstDataAt == null ? null : st.io.firstDataAt + d, errorAt: st.io.errorAt == null ? null : st.io.errorAt + d, drainChecksAt: (st.io.drainChecksAt || []).map((t) => (t == null ? null : t + d)) } }, ticks.map((t) => t + d)];
  const every10 = (to) => Array.from({ length: Math.ceil((to + 300) / 10) }, (_, i) => A - 50 + i * 10);
  const L = (st, close, ticks, endAfter = 5) => [liveSt(st, close, endAfter), live(close), ticks];
  const genuine = [
    L(withDrain(500), 2002, every10(2002)),
    L(lost(), 2002, [A - 10, A + 500, A + 510, A + 2200]),
    L(withDrain(300), 2002, [A - 10, A + 900, A + 2200]),
    L(withDrain(300, 301), 2002, [A - 10, A + 2200]),
    L(withDrain(300), 2002, [A - 10, A + 299, A + 2200]),
    L(lost({ drainsAt: [A + 300, A + 400], io: { firstDataAt: null, dataEvents: 0, drainChecksAt: [A + 2100, A + 2100] } }), 2002, [A - 10, A + 2200]),
    L(withDrain(300, 2100, { io: { firstDataAt: A + 301, dataEvents: 1, drainChecksAt: [A + 2100] } }), 2002, [A - 10, A + 2200]),
    L(withDrain(149), 12770, [A - 7, A + 12780]),
    L(withDrain(50), 300, bracket(300)),
    L(withDrain(20), 100, [A - 10, A + 400]),
    // the replay's C0 failures (a tick and a drain together soon after the answer), as live records whose client saw
    // the reset at once: a -50 ms offset would move that activity before the answer; K catches it
    L(withDrain(23), 3953, [A - 4, A + 23, A + 3958]),
    L(withDrain(150), 2965, [A - 6, A + 150, A + 4413]),
    L(withDrain(15), 4276, [A - 9, A + 13, A + 5916]),
    L(withDrain(334), 2775, [A - 10, A + 333, A + 4191]),
  ];
  for (const [i, [st, c, ticks]] of genuine.entries()) {
    assert.equal(M(st, c, ticks).ok, false, `case ${i} fails unshifted`);
    for (const d of [-50, -20, 20, 50]) {
      const [s2, t2] = shift(st, ticks, d);
      assert.equal(M(s2, c, t2).ok, false, `case ${i} must still fail with the client's clock offset ${d} ms`);
    }
  }
  // and a consistent live excuse stays excused at offsets within the causal slack only
  const okCase = L(withDrain(1978, 2221), 2002, [A - 13, A + 2222], 50);
  assert.equal(M(...okCase).kind, "stalled");
  assert.equal(M(...shift(okCase[0], okCase[2], 20).slice(0, 1), okCase[1], shift(okCase[0], okCase[2], 20)[1]).ok, false, "+20 ms: the client would have started after the server saw it");
});
