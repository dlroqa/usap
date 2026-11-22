// #151 diagnostics: the lost-client description (fixtures/stall-diag.cjs) and the independent sampler
// (fixtures/stall-sampler.cjs). Message-only helpers; these tests pin what they report, not any verdict.
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { describeLostClient } = require("./fixtures/stall-diag.cjs");

const rec = { finishAt: 10000, sockCloseAt: 12965, loop: { gaps: [[10100, 2000]], delayP99Ms: 30, delayMaxMs: 2010 } };
const lost = (drainsAt, drainChecksAt) => ({ status: null, drainsAt, io: { drainChecksAt, firstDataAt: null, firstDataCheckAt: null } });

test("stall-diag: a drain whose iteration never reached its check phase before the close (stopped inside it)", () => {
  const s = describeLostClient(lost([10150], [14413]), rec, [9994, 10150, 14413], { gaps: [[10155, 4250]], maxGapMs: 4250 });
  assert.match(s, /drains in window 150@check 4413/);
  assert.match(s, /no drain's loop iteration reached its check phase before the close/);
  assert.match(s, /client ticks in window 1 \(150\)/);
  assert.match(s, /server loop gaps 100\+2000 \(delay p99 30 max 2010\)/);
  assert.match(s, /sampler process gaps in window 155\+4250 \(max over run 4250\)/);
});

test("stall-diag: a drain whose iteration completed before the close is reported as such", () => {
  const s = describeLostClient(lost([10150], [10151]), rec, [9994, 10150, 10160, 10170], null);
  assert.match(s, /reached its check phase before the close \(1\/1\): the client got past that I\/O phase/);
  assert.match(s, /sampler: unavailable/);
});

test("stall-diag: bounded, numbers-only output; missing records are said, not guessed", () => {
  const many = Array.from({ length: 400 }, (_, i) => 10001 + i);
  const s = describeLostClient(lost(many, many.map((t) => t + 1)), { finishAt: 10000, sockCloseAt: 12000 }, many, { gaps: [], maxGapMs: 12 });
  assert.ok(s.length < 1200, `bounded (${s.length})`);
  assert.match(s, /server loop: not recorded/);
  assert.doesNotMatch(s, /[\\/][\w.-]+[\\/]|[A-Za-z]:\\/, "no paths");
  assert.equal(describeLostClient(lost([], []), null, [], null), "no server answer recorded");
});

test("stall-sampler: reports its own gaps, stops when its stdin closes, and its output is bounded", async () => {
  const child = spawn(process.execPath, [path.join(__dirname, "fixtures", "stall-sampler.cjs")], { stdio: ["pipe", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  await new Promise((r) => setTimeout(r, 300));
  child.kill("SIGSTOP");
  await new Promise((r) => setTimeout(r, 250));
  child.kill("SIGCONT");
  await new Promise((r) => setTimeout(r, 100));
  child.stdin.end();
  const code = await new Promise((r) => child.on("exit", r));
  assert.equal(code, 0);
  const res = JSON.parse(out);
  assert.ok(res.samples > 10 && res.gaps.length <= 50, JSON.stringify(res).slice(0, 300));
  assert.ok(res.maxGapMs >= 200, `the 250 ms stop is seen (${res.maxGapMs})`);
}, { skip: process.platform === "win32" ? "no SIGSTOP on Windows" : false });
