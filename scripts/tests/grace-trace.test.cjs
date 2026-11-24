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
const { startGraceTrace, classify, wall } = require("./fixtures/grace-trace.cjs");

const GRACE = 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function observer() {
  if (!["darwin", "linux"].includes(process.platform)) return { stop: async () => null };
  const c = spawn(process.execPath, [path.join(__dirname, "fixtures", "thread-observer.cjs"), "50", String(process.pid)], { stdio: ["pipe", "pipe", "ignore"] });
  let out = ""; c.stdout.on("data", (d) => { out += d; });
  return { stop: () => new Promise((r) => { c.once("close", () => { try { r(JSON.parse(out)); } catch (_) { r(null); } }); c.stdin.end(); }) };
}
// One refused request through the real helper; `during(sock)` runs right after 'finish' (to disturb the grace period).
async function refuseOnce({ during = () => {}, onSocket = () => {} } = {}) {
  const trace = startGraceTrace({ graceMs: GRACE });
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
  trace.stop();
  const o = await obs.stop();
  c.destroy(); await new Promise((r) => server.close(r));
  return classify({ conn, trace, socketTrace: trace.destroyOf(conn.s), observer: o, cpuMs: trace.cpuMs });
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
