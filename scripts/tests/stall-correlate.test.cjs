// Controls for the #151 stall correlation line (fixtures/stall-correlate.cjs) and the independent main-thread state
// observer (fixtures/thread-observer.cjs); messages only. Each kind of stall reads differently: a GC pause, a busy
// main thread, a descheduled one, an uninterruptible wait, a synchronous block and a kernel wait. On Linux a real
// process that busy-loops, then blocks in Atomics.wait, then idles is observed as R, then a futex wait, then ep_poll,
// and the line says the server's write is not client receipt.
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { describeStallCorrelates, statesIn, reading, cpuIn } = require("./fixtures/stall-correlate.cjs");

const T = 1_000_000;
const base = (extra = {}) => ({
  st: { error: "EPIPE", drainsAt: [T + 900], io: { firstDataAt: null, errorAt: T + 2280, closeAt: T + 2285, pendingAtError: 4194304 } },
  rec: { finishAt: T, sockCloseAt: T + 2001 },
  ticks: [T - 20, T - 10, T + 1814, T + 1824, T + 2300],
  clientPid: 11, serverPid: 22, ...extra,
});
const obs = (clientRuns, serverRuns = [[T - 50, "S", null, "kevent"]]) => ({ platform: "test", intervalMs: 200, procs: { 11: { samples: 9, runs: clientRuns }, 22: { samples: 9, runs: serverRuns } } });
const samples = (cpuMs) => [[T - 10, 100, 20], [T + 1814, 100 + cpuMs, 20]];

test("line: times from the server's hand-off (not receipt), client error with bytes still queued, window and reading", () => {
  const line = describeStallCorrelates(base({ proc: { gc: [], loop: { maxMs: 1830, p99Ms: 12 }, samples: samples(40) }, observer: obs([[T - 50, "S", null, ""], [T + 100, "R", null, ""], [T + 1800, "S", null, ""]]) }));
  assert.match(line, /^server answer handed to the kernel 0 \(not client receipt\), server close 2001; client first data none, error EPIPE at 2280 with 4194304 B still queued in Node, close 2285, drains 1;/);
  assert.match(line, /client main thread silent -10\.\.1814 \(1824 ms\): process CPU 40 ms; GC 0 pauses 0 ms; observer client R 1700 ms, S 124 ms; studio S\(kevent\) 1824 ms; reading: runnable but not running \(descheduled\)/);
  assert.match(line, /client loop delay max 1830 ms/);
});

test("readings: GC pause, busy main thread, uninterruptible wait, synchronous block, kernel wait, no observer", () => {
  const w = [0, 1000];
  assert.equal(reading(w, 600, statesIn([[0, "R"]], 0, 1000), 900), "GC pause");
  assert.equal(reading(w, 0, statesIn([[0, "R"]], 0, 1000), 900), "running: a busy main thread (CPU)");
  assert.equal(reading(w, 0, statesIn([[0, "R"]], 0, 1000), 30), "runnable but not running (descheduled)");
  assert.equal(reading(w, 0, statesIn([[0, "U"]], 0, 1000), 30), "uninterruptible OS wait");
  assert.equal(reading(w, 0, statesIn([[0, "S", null, "futex_do_wait"]], 0, 1000), 30), "blocked in a synchronous wait");
  assert.match(reading(w, 0, statesIn([[0, "S", null, "ep_poll"]], 0, 1000), 30), /^waiting in the kernel/);
  assert.equal(cpuIn([[0, 1, 1], [1000, 5, 2]], 0, 1000), 5);
  assert.equal(cpuIn([[0, 1, 1]], 500, 1500), null, "no sample near the window's ends");
  assert.match(describeStallCorrelates(base({ proc: { gc: [[T + 100, 1500, 4]], samples: samples(1600) }, observer: null })), /reading: GC pause/);
  assert.match(describeStallCorrelates(base({ proc: null, observer: null })), /reading: no observer; loop delay not recorded; observer not run/);
  assert.equal(describeStallCorrelates(base({ rec: null })), "no server record");
});

test("observer (Linux): a real busy loop, a synchronous block and an idle loop read R, futex wait, ep_poll", { skip: process.platform !== "linux" && "uses /proc (Linux); macOS uses ps -M on CI" }, async () => {
  const subject = spawn(process.execPath, ["-e", "setTimeout(()=>{const e=Date.now()+700;while(Date.now()<e){}},300);setTimeout(()=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,700)},1200);setTimeout(()=>{},2400)"]);
  const o = spawn(process.execPath, [path.join(__dirname, "fixtures", "thread-observer.cjs"), "50", String(subject.pid)], { stdio: ["pipe", "pipe", "ignore"] });
  let out = ""; o.stdout.on("data", (d) => { out += d; });
  await new Promise((r) => subject.once("exit", r));
  o.stdin.end(); await new Promise((r) => o.once("close", r));
  const runs = JSON.parse(out).procs[subject.pid].runs.map((x) => `${x[1]}${x[3] ? `(${x[3]})` : ""}`);
  const iR = runs.findIndex((x) => x === "R"), iF = runs.findIndex((x) => /futex/.test(x));
  assert.ok(iR >= 0 && iF > iR, runs.join(" "));
  assert.ok(runs.slice(iF).some((x) => /ep_poll/.test(x)), runs.join(" "));
});
