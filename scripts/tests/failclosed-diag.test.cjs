// #151 fail-closed timing description (fixtures/failclosed-diag.cjs): message-only helper; these tests pin what it
// reports, not any verdict.
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { describeFailClosed } = require("./fixtures/failclosed-diag.cjs");

const A = 10000, O = { watchMs: 100, watchBytes: 262144 };
const rec = { answeredAt: A, readAtAnswer: 1000, closedAt: A + 2, read: 475609 };
const tmOf = (x) => ({ lingeringBefore: 1, lingeringAtAnswer: 1, destroyAt: A + 1, destroyRead: 475609, closedReadingBefore: 4, closedReadingAtDestroy: 5, ...x });
const lostSt = { status: null, error: "ECONNRESET", io: { firstDataAt: null, errorAt: A + 1, closeAt: A + 1 } };

test("fail-closed timing: an early closing check with another socket in grace fits H-D1; the line says whether the client read first", () => {
  const s = describeFailClosed(tmOf({}), rec, lostSt, O);
  assert.match(s, /^other sockets in grace before the request 1, at the answer 1; destroy 1 by the fail-closed check; read by then 474609 B after the answer \(trigger 262144 B\); server close 2; client status none, first data none, error 1 ECONNRESET, close 1/);
  assert.match(s, /reading: early closing check \(1 ms < 100 ms\) with 1 other socket\(s\) in grace: consistent with H-D1 \(timer already running\); the client had not read before the close$/);
  const read = { status: 403, error: "EPIPE", io: { firstDataAt: A + 1, errorAt: A + 3, closeAt: A + 3 } };
  assert.match(describeFailClosed(tmOf({ destroyAt: A + 2 }), rec, read, O), /consistent with H-D1 \(timer already running\); the client read before the close$/);
});

test("fail-closed timing: other cases are not read as H-D1", () => {
  assert.match(describeFailClosed(tmOf({ lingeringAtAnswer: 0 }), rec, lostSt, O), /reading: early closing check \(1 ms < 100 ms\) with no other socket in grace: not explained by H-D1$/);
  assert.match(describeFailClosed(tmOf({ destroyAt: A + 103 }), rec, lostSt, O), /reading: the first closing check came 103 ms after the answer \(>= the 100 ms interval\): not the early-check case of H-D1$/);
  assert.match(describeFailClosed(tmOf({ closedReadingAtDestroy: 4 }), rec, lostSt, O), /destroy 1 \(not by the fail-closed check\).*reading: the fail-closed check did not close this socket: no reading on H-D1$/);
  assert.match(describeFailClosed(tmOf({ destroyAt: null, destroyRead: null, closedReadingAtDestroy: null }), rec, lostSt, O), /destroy none; read by then \? B .*no reading on H-D1$/);
  assert.match(describeFailClosed(tmOf({ lingeringAtAnswer: null }), rec, lostSt, O), /at the answer \?; .*reading: early closing check; other sockets unknown: no reading on H-D1$/);
  assert.equal(describeFailClosed(tmOf({}), { answeredAt: null }, lostSt, O), "no server answer recorded");
});

test("fail-closed timing: bounded, numbers and fixed words only", () => {
  const s = describeFailClosed(tmOf({}), rec, { status: null, error: "x/y\\z " + "E".repeat(100), io: {} }, O);
  assert.ok(s.length <= 1200);
  assert.doesNotMatch(s, /[\\/][a-z]/);
});
