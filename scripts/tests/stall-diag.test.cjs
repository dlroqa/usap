// #151 diagnostics: the lost-client description (fixtures/stall-diag.cjs) and the independent sampler
// (fixtures/stall-sampler.cjs). Message-only helpers; these tests pin what they report, not any verdict.
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { performance } = require("node:perf_hooks");
const { describeLostClient } = require("./fixtures/stall-diag.cjs");

// The injected pause is measured on the monotonic clock (performance.now), never the wall clock (Date.now), and
// SIGCONT is held until that clock shows at least `ms`. setTimeout alone does not guarantee it: libuv truncates its
// loop time to whole milliseconds, so a 400 ms timer can fire up to 1 ms early (measured: 1697/3000 timers fired
// below 400 monotonic ms, and 31/3000 read 399 by Date.now, with no clock adjustment). `now` and `later` are
// parameters only so the test below can drive them.
function holdAtLeast(ms, done, now = () => performance.now(), later = setTimeout) {
  const start = now();
  const check = () => { const left = ms - (now() - start); if (left > 0) later(check, Math.ceil(left)); else done(start, now()); };
  later(check, ms);
}

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

test("stall-sampler: reports its own gaps, stops when its stdin closes, and its output is bounded", { skip: process.platform === "win32" ? "no SIGSTOP on Windows" : false }, async () => {
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
});

// ── #151 client CPU-time diagnostics (cpuDiag) ──────────────────────────────────────────────────────────────────────
// samples: [t, userMs, systemMs, voluntary, involuntary, [sentKiB per client]]
const procOf = (gapCpuMs, watchdogGaps) => ({
  samples: [[10000, 100, 50, 10, 5, [100, 200]], [10010, 101, 50, 10, 5, [100, 210]], [12510, 101 + gapCpuMs, 50, 11, 9, [100, 900]], [12520, 102 + gapCpuMs, 50, 11, 9, [100, 910]]],
  watchdog: watchdogGaps === null ? null : { samples: 300, maxGapMs: watchdogGaps.reduce((m, [, ms]) => Math.max(m, ms), 10), gaps: watchdogGaps },
});
const lostAt = lost([], []);

test("stall-diag cpu: the gap's CPU time, switches and bytes are reported, with a reading that names no cause", () => {
  const s = describeLostClient(lostAt, rec, [], null, procOf(0, [[10012, 2495]]), 1);
  assert.match(s, /client process gap 10\.\.2510 \(2500 ms\): CPU \+0 user \+0 system ms; context switches \+1 voluntary \+4 involuntary; sent \+690 KiB all clients, \+690 KiB this client/);
  assert.match(s, /watchdog thread gaps in it 12\+2495/);
  assert.match(s, /reading: little CPU time and the watchdog thread also stopped: consistent with the whole process not running/);
  assert.doesNotMatch(s, /because|caused|cause:/i);
});

test("stall-diag cpu: busy, waiting, unavailable and mixed readings", () => {
  assert.match(describeLostClient(lostAt, rec, [], null, procOf(2400, [[10012, 2495]]), 0), /CPU \+2400 user.*reading: CPU time grew through the gap: consistent with the process executing/);
  assert.match(describeLostClient(lostAt, rec, [], null, procOf(0, []), 0), /watchdog thread gaps in it none.*reading: little CPU time while the watchdog thread ran: consistent with the main thread waiting/);
  assert.match(describeLostClient(lostAt, rec, [], null, procOf(0, null), 0), /watchdog thread: unavailable; reading: little CPU time \(watchdog unavailable\)/);
  assert.match(describeLostClient(lostAt, rec, [], null, procOf(800, []), 0), /reading: mixed: no single reading/);
});

test("stall-diag cpu: missing or gapless records are said, output stays bounded, and callers without it are unchanged", () => {
  assert.match(describeLostClient(lostAt, rec, [], null, null, 0), /; client process: not recorded$/);
  const even = { samples: Array.from({ length: 400 }, (_, i) => [10000 + i * 10, i, 0, 0, 0, [i]]), watchdog: { samples: 400, maxGapMs: 12, gaps: [] } };
  assert.match(describeLostClient(lostAt, rec, [], null, even, 0), /client process: no tick gap >= 50 ms in window \(longest 10 ms\)/);
  const many = { samples: [[10000, 0, 0, 0, 0, Array(10).fill(1)], [13000, 0, 0, 0, 0, Array(10).fill(2)]], watchdog: { samples: 1, maxGapMs: 3000, gaps: Array.from({ length: 50 }, (_, i) => [10000 + i * 60, 55]) } };
  const s = describeLostClient(lostAt, rec, Array.from({ length: 400 }, (_, i) => 10001 + i), { gaps: [], maxGapMs: 12 }, many, 3);
  assert.ok(s.length < 1600, `bounded (${s.length})`);
  assert.doesNotMatch(s, /[\\/][\w.-]+[\\/]|[A-Za-z]:\\/, "no paths");
  assert.doesNotMatch(describeLostClient(lostAt, rec, [], null), /client process/, "no proc argument: same output as before");
});

test("cpuDiag watchdog: its thread keeps running while the main thread is busy", async () => {
  const { startWatchdog } = require("./fixtures/refusal-clients.cjs");
  const wd = startWatchdog();
  await new Promise((r) => setTimeout(r, 100)); // let the thread start
  const until = Date.now() + 1000;
  while (Date.now() < until) { /* main thread busy for 1 s */ }
  const res = await wd.stop();
  assert.ok(res && res.samples >= 10, `the thread sampled while the main thread was busy (${JSON.stringify(res)})`);
  assert.ok(res.maxGapMs < 900, `no gap as long as the busy period (${res.maxGapMs})`);
});

// Runs fixtures/refusal-clients.cjs against a server that answers after 1200 ms. With `stop`, the client process is
// paused (SIGSTOP) for 400 ms only once (a) its watchdog thread has reported its first tick ("watchdog-ready" on
// stderr) and (b) the server has accepted all n client connections: no fixed startup sleep, so a slow start can't put
// the pause before the watchdog runs (macOS Intel CI, maxGapMs 13). The answers are then held until 200 ms after
// SIGCONT, so the pause always falls inside a live run. A process that never reports ready fails the test.
const PAUSE_MS = 400;
function runClients(cpuDiag, stop) {
  const net = require("node:net");
  const n = 2;
  return new Promise((resolve, reject) => {
    const socks = [];
    let ready = false, injected = null, done = false;
    const answer = () => { for (const s of socks.splice(0)) s.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"); };
    let child = null;
    const maybeStop = () => {
      if (!stop || injected || !ready || socks.length < n) return;
      // Conservative bracket: the pause is counted from after SIGSTOP was sent to before SIGCONT is sent.
      child.kill("SIGSTOP");
      injected = { wallStoppedAt: Date.now(), connections: socks.length };
      holdAtLeast(PAUSE_MS, (stoppedAt, resumedAt) => {
        Object.assign(injected, { stoppedAt, resumedAt, wallResumedAt: Date.now() });
        child.kill("SIGCONT");
        setTimeout(answer, 200);
      });
    };
    const server = net.createServer((sock) => {
      sock.on("error", () => {});
      socks.push(sock);
      if (stop) maybeStop(); else setTimeout(answer, 1200);
    });
    server.listen(0, "127.0.0.1", () => {
      const arg = { port: server.address().port, n, opts: { mode: "small", maxMs: 10000 } };
      if (cpuDiag) arg.cpuDiag = true;
      if (stop) arg.readySignal = true;
      child = spawn(process.execPath, [path.join(__dirname, "fixtures", "refusal-clients.cjs"), JSON.stringify(arg)], { stdio: ["ignore", "pipe", stop ? "pipe" : "ignore"] });
      let out = "", err = "";
      child.stdout.on("data", (d) => { out += d; });
      if (stop) child.stderr.on("data", (d) => { err += d; if (!ready && err.includes("watchdog-ready\n")) { ready = true; maybeStop(); } });
      const guard = stop ? setTimeout(() => { if (!injected) { done = true; child.kill("SIGKILL"); server.close(); reject(new Error(`the pause was never injected: watchdog ready ${ready}, connections ${socks.length} of ${n}`)); } }, 20000) : null;
      child.on("exit", (code) => { clearTimeout(guard); server.close(); if (done) return; try { resolve({ code, res: JSON.parse(out), injected }); } catch (e) { reject(e); } });
    });
  });
}

test("cpuDiag pause: held until the monotonic clock shows the full pause, whatever the timer or the wall clock do", async () => {
  // A timer that fires 0.4 ms early (libuv's millisecond truncation: always less than 1 ms) is re-armed instead of
  // ending the pause short.
  let t = 1000.6;
  const arms = [];
  const early = (fn, ms) => { arms.push(ms); t += ms - 0.4; fn(); };
  let got = null;
  holdAtLeast(400, (s, e) => { got = e - s; }, () => t, early);
  assert.ok(got >= 400, `held ${got} ms`);
  assert.deepEqual(arms, [400, 1]);
  // A real pause, with the wall clock stepped forward 300 ms while it runs: the measured pause is unaffected (it
  // agrees with an independent monotonic measure; a wall-clock measure would report about 700 ms).
  const realNow = Date.now;
  try {
    const m0 = performance.now();
    const r = await new Promise((resolve) => {
      holdAtLeast(400, (s, e) => resolve({ reported: e - s, independent: performance.now() - m0 }));
      setTimeout(() => { const off = realNow() + 300; const base = realNow(); Date.now = () => off + (realNow() - base); }, 100);
    });
    assert.ok(r.independent >= 400 && r.reported >= 400 && Math.abs(r.reported - r.independent) < 50, JSON.stringify(r));
  } finally { Date.now = realNow; }
});

test("cpuDiag fixture: without the flag the output has exactly the previous fields", async () => {
  const { code, res } = await runClients(false, false);
  assert.equal(code, 0);
  assert.deepEqual(Object.keys(res).sort(), ["clients", "ticks"]);
  assert.equal(res.clients.length, 2);
});

test("cpuDiag fixture: a stopped client process shows a gap with little CPU time and a stopped watchdog", { skip: process.platform === "win32" ? "no SIGSTOP on Windows" : false }, async () => {
  const { code, res, injected } = await runClients(true, true);
  assert.equal(code, 0);
  assert.ok(injected && injected.resumedAt - injected.stoppedAt >= 400, `the 400 ms pause was injected after the watchdog was running (${injected ? `monotonic ${(injected.resumedAt - injected.stoppedAt).toFixed(1)} ms, wall ${injected.wallResumedAt - injected.wallStoppedAt} ms` : "not injected"})`);
  assert.equal(injected.connections, 2, "both client connections were established before the pause");
  assert.deepEqual(Object.keys(res).sort(), ["clients", "proc", "ticks"]);
  assert.ok(Array.isArray(res.proc.samples) && res.proc.samples.length > 10, "samples recorded");
  // one bytes value per started client (the first sample is taken before the clients start)
  assert.ok(res.proc.samples.every((x) => x.length === 6 && x[5].length <= 2) && res.proc.samples[res.proc.samples.length - 1][5].length === 2, "bytes per client");
  assert.ok(res.proc.watchdog && res.proc.watchdog.maxGapMs >= 300, `watchdog saw the stop (${JSON.stringify(res.proc.watchdog).slice(0, 200)})`);
  const s = res.proc.samples, t0 = s[0][0];
  const d = describeLostClient(lostAt, { finishAt: t0, sockCloseAt: s[s.length - 1][0] }, [], null, res.proc, 0);
  assert.match(d, /client process gap \d+\.\.\d+ \((\d+) ms\)/);
  assert.ok(Number(d.match(/\((\d+) ms\)/)[1]) >= 300, d);
  assert.match(d, /reading: little CPU time and the watchdog thread also stopped: consistent with the whole process not running/, d);
});
