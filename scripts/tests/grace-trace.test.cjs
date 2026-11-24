// Controls for the #151 grace-close diagnostics (fixtures/grace-trace.cjs; messages only). The real refusal helper
// (closeAfterAnswer) refuses a real request with a short grace period while the trace and the independent observer
// run, and each kind of late close reads differently: on time; a timer callback delayed by a synchronous block or
// by a busy main thread; a destroy on time whose 'close' is observed late. Synthetic records cover a timer armed
// late, a GC pause and a destroy from another path. The trace keeps every timer's behavior and restores everything.
"use strict";
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { closeAfterAnswer } = require("../server/http/refusal-close.cjs");
const { startGraceTrace, classify, phaseTimers, timerText, LATE_MS, wall } = require("./fixtures/grace-trace.cjs");

const GRACE = 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function observer() {
  if (!["darwin", "linux"].includes(process.platform)) return { stop: async () => null };
  const c = spawn(process.execPath, [path.join(__dirname, "fixtures", "thread-observer.cjs"), "50", String(process.pid)], { stdio: ["pipe", "pipe", "ignore"] });
  let out = ""; c.stdout.on("data", (d) => { out += d; });
  return { stop: () => new Promise((r) => { c.once("close", () => { try { r(JSON.parse(out)); } catch (_) { r(null); } }); c.stdin.end(); }) };
}
// One refused request through the real helper; `during(sock)` runs right after 'finish' (to disturb the grace period).
// shared: an already started trace (kept running; the caller stops it), for multi-phase controls.
async function refuseOnce({ during = () => {}, onSocket = () => {}, shared = null } = {}) {
  const trace = shared || startGraceTrace({ graceMs: GRACE });
  const obs = observer();
  await sleep(250); // the observer's first samples
  const conn = {};
  const server = http.createServer((req, res) => {
    onSocket(req.socket);
    closeAfterAnswer(req, res, { graceMs: GRACE });
    res.once("finish", () => { conn.answeredAt = Date.now(); during(req.socket); });
    const end = res.end; res.end = function (...a) { conn.endCalledAt = Date.now(); return end.apply(this, a); };
    res.writeHead(403, { "Content-Type": "application/json", Connection: "close" }); res.end("{}");
  });
  server.on("connection", (s) => { conn.s = s; s.on("close", () => { conn.closedAt = Date.now(); }); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const c = net.connect(server.address().port, "127.0.0.1");
  c.on("error", () => {}); c.resume();
  c.on("connect", () => { c.write("POST /x HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 10485760\r\n\r\n"); c.write(Buffer.alloc(64 * 1024, 0x61)); });
  const end = Date.now() + 10000; while (!conn.closedAt && Date.now() < end) await sleep(20);
  await sleep(100);
  if (!shared) trace.stop();
  const o = await obs.stop();
  c.destroy(); await new Promise((r) => server.close(r));
  const r = classify({ conn, trace, socketTrace: trace.destroyOf(conn.s), observer: o, cpuMs: trace.cpuMs });
  return shared ? { ...r, conn } : r;
}
const block = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const busy = (ms) => { const e = Date.now() + ms; while (Date.now() < e) { /* spin */ } };

test("real helper: on time; the line separates res.end, 'finish' (not client receipt), timer, destroy and 'close'", { timeout: 30000 }, async () => {
  const r = await refuseOnce();
  assert.equal(r.verdict, "on time", r.line);
  assert.match(r.line, /^on time: res\.end called -?\d+, handed to the OS \('finish'\) 0 \(not client receipt\); grace timer armed -?\d+, due -?\d+, callback -?\d+ \(-?\d+ ms late\), destroy\(\) -?\d+; .close. observed -?\d+$/);
});

test("real helper: a synchronous block during the grace period makes the timer late and reads as such", { timeout: 30000 }, async () => {
  const r = await refuseOnce({ during: () => setTimeout(() => block(900), 50) });
  assert.match(r.verdict, /^late timer/, r.line);
  if (process.platform === "linux") assert.equal(r.verdict, "late timer: blocked in a synchronous wait", r.line);
});

test("real helper: a busy main thread during the grace period makes the timer late and reads as busy", { timeout: 30000 }, async () => {
  const r = await refuseOnce({ during: () => setTimeout(() => busy(900), 50) });
  assert.match(r.verdict, /^late timer/, r.line);
  if (process.platform === "linux") assert.equal(r.verdict, "late timer: busy main thread (CPU)", r.line);
});

test("real helper: destroy on time, 'close' observed late (the main thread blocked right after destroy)", { timeout: 30000 }, async () => {
  const r = await refuseOnce({ onSocket: (s) => { const d = s.destroy; s.destroy = function (...a) { const x = d.apply(this, a); block(500); return x; }; } });
  assert.equal(r.verdict, "destroy on time, close observed late", r.line);
});

test("synthetic: a timer armed late, a GC pause, a destroy from another path, and no destroy", () => {
  const base = 1_000_000; const mono = (w) => w - performance.timeOrigin;
  const conn = { endCalledAt: base - 1, answeredAt: base, closedAt: base + 2600 };
  const timer = { armedAt: mono(base + 500), dueAt: mono(base + 2500), firedAt: mono(base + 2510), endedAt: null };
  const trace = { gcs: [], gaps: [], timers: [timer] };
  assert.equal(classify({ conn, trace, socketTrace: { at: mono(base + 2511), timer } }).verdict, "grace timer armed late");
  const t2 = { armedAt: mono(base + 1), dueAt: mono(base + 2001), firedAt: mono(base + 3001) };
  assert.equal(classify({ conn: { ...conn, closedAt: base + 3002 }, trace: { gcs: [[mono(base + 2001), 900]], gaps: [], timers: [t2] }, socketTrace: { at: mono(base + 3001), timer: t2 } }).verdict, "late timer: GC pause");
  assert.equal(classify({ conn, trace, socketTrace: { at: mono(base + 40), timer: null } }).verdict, "destroyed by another path");
  assert.equal(classify({ conn, trace, socketTrace: null }).verdict, "closed without a traced destroy (peer close or another path)");
  assert.equal(classify({ conn: { ...conn, closedAt: null }, trace, socketTrace: null }).verdict, "never closed");
  assert.equal(wall(mono(base)), base);
});

test("trace: timers keep their behavior (unref, clearTimeout, other delays untouched) and stop() restores everything", async () => {
  const origST = globalThis.setTimeout, origD = net.Socket.prototype.destroy;
  const trace = startGraceTrace({ graceMs: 1234 });
  try {
    assert.notEqual(globalThis.setTimeout, origST);
    let ran = 0;
    const a = setTimeout(() => { ran += 1; }, 1234); assert.equal(typeof a.unref, "function"); clearTimeout(a);
    await new Promise((r) => setTimeout(r, 30)); // another delay: not traced
    assert.equal(trace.timers.length, 1, "only the grace delay is traced");
    const b = setTimeout(() => { ran += 10; }, 1234); b.unref(); b.ref();
    await new Promise((r) => origST(r, 1300));
    assert.equal(ran, 10, "a cleared timer did not run; the other ran once");
  } finally { trace.stop(); }
  assert.equal(globalThis.setTimeout, origST); assert.equal(net.Socket.prototype.destroy, origD);
});

// Phase accounting (refusal-close prints one summary per phase): each phase reports only its own timers and lateness.
test("phase accounting (synthetic): phase 2 excludes phase 1's timers and lateness (cumulative accounting is caught)", () => {
  const mono = (w) => w - performance.timeOrigin, b = 2_000_000;
  const late1 = { armedAt: mono(b), dueAt: mono(b + 2000), firedAt: mono(b + 2900) };      // phase 1: 900 ms late
  const ok2 = { armedAt: mono(b + 5000), dueAt: mono(b + 7000), firedAt: mono(b + 7004) }; // phase 2: 4 ms late
  const s1 = {}, s2 = {}, rec = new Map([[s1, { timer: late1 }], [s2, { timer: ok2 }]]);
  const trace = { timers: [late1, ok2], dropped: 0, destroyOf: (s) => rec.get(s) || null };
  const p1 = phaseTimers({ trace, conns: [{ s: s1 }], from: 0, to: 1 });
  const p2 = phaseTimers({ trace, conns: [{ s: s2 }], from: 1, to: 2 });
  assert.deepEqual(p1, { traced: 1, fired: 1, latenessMaxMs: 900, own: 1, other: 0, fromAnotherWindow: 0, dropped: 0 });
  assert.deepEqual(p2, { traced: 1, fired: 1, latenessMaxMs: 4, own: 1, other: 0, fromAnotherWindow: 0, dropped: 0 });
  assert.match(timerText(p2), /^grace timers traced 1 in this phase \(1 for its connections, 0 other, 0 of its connections closed by a timer from another phase\), callback lateness max 4 ms in this phase \(1 fired\)$/);
  // the old cumulative reading of phase 2 would be "traced 2, lateness max 900": it differs from both phases' own values
  const cumulative = phaseTimers({ trace, conns: [{ s: s2 }], from: 0, to: 2 });
  assert.notEqual(cumulative.traced, p2.traced); assert.notEqual(cumulative.latenessMaxMs, p2.latenessMaxMs);
  // an unfired timer counts as traced, not fired, and adds no lateness
  const pending = { armedAt: mono(b + 8000), dueAt: mono(b + 10000), firedAt: null };
  const p3 = phaseTimers({ trace: { ...trace, timers: [late1, ok2, pending] }, conns: [], from: 2 });
  assert.deepEqual([p3.traced, p3.fired, p3.latenessMaxMs, p3.other], [1, 0, null, 1]);
  assert.match(timerText(p3), /callback lateness max none ms in this phase \(0 fired\)$/);
  assert.match(timerText({ ...p3, dropped: 7 }), /; 7 not recorded \(cap\)\)/);
});

test("phase accounting (synthetic): cross-phase contamination is reported, not hidden", () => {
  const mono = (w) => w - performance.timeOrigin, b = 3_000_000;
  const t1 = { armedAt: mono(b), dueAt: mono(b + 2000), firedAt: mono(b + 2001) };
  const t2 = { armedAt: mono(b + 5000), dueAt: mono(b + 7000), firedAt: mono(b + 7001) };
  const s1 = {}, sX = {}, rec = new Map([[s1, { timer: t1 }], [sX, { timer: t1 }]]); // sX (phase 2) closed by phase 1's timer
  const trace = { timers: [t1, t2], dropped: 0, destroyOf: (s) => rec.get(s) || null };
  const p2 = phaseTimers({ trace, conns: [{ s: sX }], from: 1, to: 2 });
  assert.deepEqual([p2.traced, p2.own, p2.other, p2.fromAnotherWindow], [1, 0, 1, 1]);
  assert.match(timerText(p2), /0 for its connections, 1 other, 1 of its connections closed by a timer from another phase/);
  // a phase connection with no traced timer (destroyed by another path) is neither own nor contamination
  const p1 = phaseTimers({ trace, conns: [{ s: s1 }, { s: {} }], from: 0, to: 1 });
  assert.deepEqual([p1.traced, p1.own, p1.other, p1.fromAnotherWindow], [1, 1, 0, 0]);
});

test("phase accounting (real helper, one trace, two phases): a late phase 1 does not leak into phase 2", { timeout: 60000 }, async () => {
  const trace = startGraceTrace({ graceMs: GRACE });
  try {
    const from1 = trace.mark();
    const r1 = await refuseOnce({ shared: trace, during: () => setTimeout(() => block(900), 50) });
    const to1 = trace.mark();
    const r2 = await refuseOnce({ shared: trace });
    const to2 = trace.mark();
    const p1 = phaseTimers({ trace, conns: [r1.conn], from: from1, to: to1 });
    const p2 = phaseTimers({ trace, conns: [r2.conn], from: to1, to: to2 });
    assert.match(r1.verdict, /^late timer/, r1.line); // per-connection readings unchanged by phase accounting
    assert.equal(r2.verdict, "on time", r2.line);
    assert.deepEqual([p1.traced, p1.own, p1.other, p1.fromAnotherWindow], [1, 1, 0, 0], timerText(p1));
    assert.deepEqual([p2.traced, p2.own, p2.other, p2.fromAnotherWindow], [1, 1, 0, 0], timerText(p2));
    assert.ok(p1.latenessMaxMs >= LATE_MS, timerText(p1));
    assert.ok(p2.latenessMaxMs < LATE_MS, `phase 2 must not carry phase 1's lateness: ${timerText(p2)}`);
    assert.equal(trace.timers.length, 2, "both phases' timers are still recorded (nothing dropped or overwritten)");
  } finally { trace.stop(); }
});
