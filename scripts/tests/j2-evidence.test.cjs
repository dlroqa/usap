// J2 evidence line (fixtures/j2-evidence.cjs, messages only): its predicates are evaluated by separate code that never
// calls the judge. These tests pin that the two agree on every pinned historical record and on live-record shapes, and
// that a live record without write/clock evidence never reads as excused.
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { judgeRefusedClientMac } = require("./fixtures/refusal-judge.cjs");
const { j2Evidence } = require("./fixtures/j2-evidence.cjs");
const { records } = require("./fixtures/refusal-judge-replay.json");

const A = 100000;
const conn = (closeMs, extra = {}) => ({ status: 413, answeredAt: A, closedAt: closeMs == null ? null : A + closeMs, ...extra });
const replay = (closeMs) => conn(closeMs, { replayRecord: true }); // the pinned historical records
const lost = (extra = {}) => ({ localPort: 1, status: null, body: "", error: "ECONNRESET", drainsAt: [], io: { firstDataAt: null, dataEvents: 0, drainChecksAt: [] }, ...extra });
function fromRecord(r) {
  const ticks = [];
  if (r.lastBefore != null) ticks.push(A + r.lastBefore);
  if (r.inside >= 1) { const f = A + (r.first ?? (r.lastBefore + 10)); for (let k = 0; k < r.inside; k += 1) ticks.push(f + 10 * k); }
  if (r.firstAfter != null) ticks.push(A + r.firstAfter);
  const st = lost({ drainsAt: r.drains.map((d) => A + d), io: { firstDataAt: r.firstData == null ? null : A + r.firstData, dataEvents: r.firstData == null ? 0 : 1, drainChecksAt: r.checks.map((c) => (c == null ? null : A + c)) } });
  return { st, c: replay(r.serverClose), ticks };
}

const verdictOf = (line) => line.match(/-> independent (\w+)/)[1];

test("J2 evidence: the independent evaluation agrees with the judge on all 254 pinned records", () => {
  assert.equal(records.length, 254);
  let excused = 0;
  for (const r of records) {
    const { st, c, ticks } = fromRecord(r);
    const v = judgeRefusedClientMac(st, c, ticks, 413);
    const line = j2Evidence(st, c, ticks, 413, v);
    assert.match(line, /; agree$/, line);
    if (verdictOf(line) === "excused") excused += 1;
  }
  assert.equal(excused, 249, "245 excused today + 4 newly excused (the pinned replay counts)");
});

// The #188 248cec1 macOS Intel record (client 1; times from the CI log) and live-record shapes around it.
const st188 = (extra = {}) => ({ status: null, error: "ECONNRESET", t0: A - 30, drainsAt: [A + 13], io: { drainChecksAt: [A + 2017], firstDataAt: null, errorAt: A + 2014, closeAt: A + 2017 }, ...extra });
const ticks188 = [A - 24, A - 14, A + 13, A + 2017];
const live = (extra = {}) => conn(2002, { requireWriteEvidence: true, seenAt: A - 1, bytesWrittenAtFinish: 250, minAnswerBytes: 89, ...extra });
const check = (st, c, ticks, want, at = null) => {
  const v = judgeRefusedClientMac(st, c, ticks, 413);
  const line = j2Evidence(st, c, ticks, 413, v);
  assert.match(line, /; agree$/, line);
  assert.equal(verdictOf(line), want, line);
  if (at) assert.match(line, new RegExp(`independent fail at ${at}`), line);
  return line;
};

test("J2 evidence: live records — every predicate shown; missing or contradicting evidence never reads as excused", () => {
  const ok = check(st188(), live(), ticks188, "excused");
  for (const p of ["S", "I0", "T2", "D0", "K1", "K2", "W", "P", "N1", "C1", "A1", "U"]) assert.match(ok, new RegExp(`(^|; )${p} ok \\(`), `${p} shown: ${ok}`);
  // A record without write/clock evidence and without the requireWriteEvidence flag (the #188 run as recorded): both
  // the judge and the independent evaluation fail it closed; the flag decides nothing.
  check(st188(), conn(2002, { seenAt: null }), ticks188, "fail", "K1");
  check(st188(), conn(2002, { seenAt: A - 1, bytesWrittenAtFinish: 250, minAnswerBytes: 89 }), ticks188, "excused");
  check(st188({ t0: undefined }), live({ seenAt: null }), ticks188, "fail", "K1");
  check(st188({ t0: A + 50 }), live(), ticks188, "fail", "K1");
  check(st188({ io: { drainChecksAt: [A + 2017], firstDataAt: null, errorAt: A + 1900, closeAt: A + 1900 } }), live(), ticks188, "fail", "K2");
  check(st188(), live({ bytesWrittenAtFinish: 10 }), ticks188, "fail", "W");
  check(st188(), live({ bytesWrittenAtFinish: null }), ticks188, "fail", "W");
  check(st188({ io: { drainChecksAt: [], firstDataAt: null, errorAt: A + 2014, closeAt: A + 2017 } }), live(), ticks188, "fail", "P");
  check(st188({ io: { drainChecksAt: [A + 4615], firstDataAt: null, errorAt: A + 4612, closeAt: A + 4615 } }), live({ closedAt: A + 4600 }), [A - 14, A + 13, A + 4615], "fail", "U");
  check(st188(), live(), [A - 14, A + 13, A + 14, A + 2017], "fail", "I0");
  check(st188({ io: { drainChecksAt: [A + 20], firstDataAt: null, errorAt: A + 2014, closeAt: A + 2017 } }), live(), ticks188, "fail", "C1");
  check(st188({ io: { drainChecksAt: [A + 2017], firstDataAt: A + 5, errorAt: A + 2014, closeAt: A + 2017 } }), live(), ticks188, "fail", "D0");
  check(st188(), live(), [A + 13], "fail", "T2");
  check(st188({ drainsAt: [A + 13, A + 40], io: { drainChecksAt: [A + 2017, A + 2017], firstDataAt: null, errorAt: A + 2014, closeAt: A + 2017 } }), live(), ticks188, "fail", "N1");
  check(st188(), live({ closedAt: A + 500 }), [A - 14, A + 13, A + 515], "fail", "S");
  assert.equal(j2Evidence({ status: 413 }, live(), ticks188, 413, null), "answered (no J2 predicate applies)");
});
