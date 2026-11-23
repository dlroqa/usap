// Request-arrival evidence (fixtures/arrival-diag.cjs): message-only helper; pins what it reports.
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { describeArrivals } = require("./fixtures/arrival-diag.cjs");

const T = 70000;
const ticks = (from, to, gapFrom = null, gapTo = null) => { const t = []; for (let x = from; x <= to; x += 10) if (gapFrom === null || x <= gapFrom || x >= gapTo) t.push(x); return t; };

test("a late request head (client side) and a stalled server read differently", () => {
  const late = Array.from({ length: 3 }, (_, i) => ({ remotePort: i, acceptedAt: T + i, requestAt: T + 6000 + i, answeredAt: T + 6001 + i }));
  const a = describeArrivals(late, ticks(T, T + 7000), 5000);
  assert.match(a, /^3 connections; accept -> request median 6000 max 6000; request -> answer median 1 max 1; no request seen 0; over 5000 ms from accept 3: \[accepted 0 request 6000 answered 6001\]/);
  assert.match(a, /server process ticks \d+, gaps >= 100 ms 0$/);
  const stalled = [{ remotePort: 1, acceptedAt: T, requestAt: T + 6005, answeredAt: T + 6006 }];
  assert.match(describeArrivals(stalled, ticks(T, T + 7000, T + 2, T + 6004), 5000), /gaps >= 100 ms 1: 6010 from 0$/);
});

test("missing records are said; bounded", () => {
  assert.match(describeArrivals([{ acceptedAt: T, requestAt: null, answeredAt: null }], [], 5000), /accept -> request none; request -> answer none; no request seen 1; over 5000 ms from accept 0; server process ticks not recorded$/);
  const many = Array.from({ length: 50 }, (_, i) => ({ acceptedAt: T, requestAt: T + 9000, answeredAt: T + 9001 }));
  const s = describeArrivals(many, ticks(T, T + 100), 5000);
  assert.ok(s.length <= 1200); assert.equal((s.match(/\[accepted/g) || []).length, 6);
});
