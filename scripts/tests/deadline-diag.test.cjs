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
