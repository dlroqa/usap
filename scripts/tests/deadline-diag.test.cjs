// Absolute-deadline evidence line (fixtures/deadline-diag.cjs): message-only helper; pins what it reports.
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { describeDeadline } = require("./fixtures/deadline-diag.cjs");

const A = 50000;
const base = { arrival: A, deadlineMs: 2000, boundMs: 2700 };
const ticksEvery = (from, to, gapFrom = null, gapTo = null) => { const t = []; for (let x = from; x <= to; x += 10) if (gapFrom === null || x <= gapFrom || x >= gapTo) t.push(x); return t; };

test("on time: the deadline timer due at arrival + 2000, fired, close right after; no gap", () => {
  const s = describeDeadline({ ...base, closeAt: A + 2011, answerAt: A + 1010, timers: [{ setAt: A + 7, ms: 1998, dueAt: A + 2005, firedAt: null, clearedAt: A + 1008 }, { setAt: A + 1007, ms: 998, dueAt: A + 2005, firedAt: A + 2006, clearedAt: null }], ticks: ticksEvery(A, A + 2100) });
  assert.match(s, /^closed 2011, answer head at client 1010 \(deadline 2000 from arrival, bound 2700\); service timers \[set 7 for 1998 due 2005 cleared 1008\] \[set 1007 for 998 due 2005 fired 2006 \(late 1\)\]; timers due at the deadline \(±100 ms\) 2: fired never,2006; close after the last firing 5; test process ticks \d+, longest gap around the deadline 10 ms/);
});

test("the three cases a late close can be are told apart: process not running, wrong deadline, no close on firing", () => {
  const stalled = describeDeadline({ ...base, closeAt: A + 3397, timers: [{ setAt: A + 1007, ms: 998, dueAt: A + 2005, firedAt: A + 3391, clearedAt: null }], ticks: ticksEvery(A, A + 3500, A + 1883, A + 3391) });
  assert.match(stalled, /fired 3391 \(late 1386\)/); assert.match(stalled, /longest gap around the deadline 15\d\d ms from 18\d\d/);
  const wrong = describeDeadline({ ...base, closeAt: A + 3018, timers: [{ setAt: A + 1010, ms: 2000, dueAt: A + 3010, firedAt: A + 3011, clearedAt: null }], ticks: ticksEvery(A, A + 3100) });
  assert.match(wrong, /timers due at the deadline \(±100 ms\) 0; test process ticks \d+, longest gap around the deadline 10 ms/);
  const noClose = describeDeadline({ ...base, closeAt: A + 19993, timers: [{ setAt: A + 1007, ms: 998, dueAt: A + 2005, firedAt: A + 2007, clearedAt: null }], ticks: ticksEvery(A, A + 20000) });
  assert.match(noClose, /close after the last firing 17986/);
});

test("missing records are said, and the line is bounded", () => {
  assert.equal(describeDeadline({ deadlineMs: 2000, boundMs: 2700 }), "closed none, answer head at client none (deadline 2000 from arrival, bound 2700); service timers none; timers due at the deadline (±100 ms) 0; test process ticks not recorded");
  const many = Array.from({ length: 100 }, (_, i) => ({ setAt: A + i, ms: 1500, dueAt: A + i + 1500, firedAt: null, clearedAt: A + i + 1 }));
  const s = describeDeadline({ ...base, closeAt: A + 2000, timers: many, ticks: ticksEvery(A, A + 2000) });
  assert.ok(s.length <= 1200); assert.equal((s.match(/\[set /g) || []).length, 8);
});

// T1 E5/E6 signals (messages only): the test process's CPU time and in-process watchdog thread over the gap. Sample
// shapes follow a local 1.5 s stall just before the deadline (Linux, Node 22.12.0). The line decides nothing.
const late = { ...base, closeAt: A + 3390, timers: [{ setAt: A + 1007, ms: 998, dueAt: A + 2005, firedAt: A + 3385, clearedAt: null }], ticks: ticksEvery(A, A + 3500, A + 1880, A + 3385) };
const samples = (cpuOverGap) => [[A + 1870, 100, 20, 10, 1, []], [A + 1880, 101, 20, 10, 1, []], [A + 3385, 101 + cpuOverGap, 20, 12, 1, []], [A + 3395, 102 + cpuOverGap, 20, 12, 1, []]];
const wdRunning = { samples: 340, maxGapMs: 12, gaps: [] };
const wdStopped = { samples: 190, maxGapMs: 1505, gaps: [[A + 1881, 1505]] };

test("T1 evidence: a busy loop, a waiting main thread and a stopped process read differently", () => {
  const busy = describeDeadline({ ...late, proc: { samples: samples(1500), watchdog: wdRunning } });
  assert.match(busy, /test process gap 1880\.\.3385 \(1505 ms\): CPU \+1500 user \+0 system ms/);
  assert.match(busy, /watchdog thread gaps in it none \(max over run 12\); reading: CPU time grew through the gap: consistent with the process executing/);
  const waiting = describeDeadline({ ...late, proc: { samples: samples(30), watchdog: wdRunning } });
  assert.match(waiting, /reading: little CPU time while the watchdog thread ran: consistent with the main thread waiting while the process ran/);
  const stopped = describeDeadline({ ...late, proc: { samples: samples(1), watchdog: wdStopped } });
  assert.match(stopped, /watchdog thread gaps in it 1881\+1505 \(max over run 1505\); reading: little CPU time and the watchdog thread also stopped: consistent with the whole process not running/);
  // without the watchdog, waiting and not running are not told apart
  const noWd = describeDeadline({ ...late, proc: { samples: samples(1), watchdog: null } });
  assert.match(noWd, /watchdog thread: unavailable; reading: little CPU time \(watchdog unavailable\): the process was mostly not executing; waiting and not running are not told apart/);
  for (const s of [busy, waiting, stopped, noWd]) { assert.ok(s.length <= 1600); assert.doesNotMatch(s, /client process/); }
});

test("T1 evidence: missing CPU records are said; without the field the line is exactly as before", () => {
  assert.match(describeDeadline({ ...late, proc: null }), /; test process: not recorded$/);
  assert.match(describeDeadline({ ...late, proc: { samples: [[A + 3385, 1, 1, 1, 1, []]], watchdog: wdStopped } }), /; test process: not recorded$/);
  assert.match(describeDeadline({ ...late, proc: { samples: samples(1).slice(2), watchdog: wdStopped } }), /test process: no tick gap >= 50 ms in window \(longest 10 ms\)$/);
  const without = describeDeadline(late);
  assert.doesNotMatch(without, /CPU|watchdog|not recorded$/);
  assert.match(without, /longest gap around the deadline 1510 ms from 1880$/);
  // a description failure is said, never thrown
  assert.match(describeDeadline({ ...late, proc: { get samples() { throw new Error("x"); } } }), /test process CPU\/watchdog: description failed$/);
});
