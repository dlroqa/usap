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
