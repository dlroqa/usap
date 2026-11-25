// C1 (round 15, test-only, messages only): controls for readProbeWait (fixtures/memprobe-diag.cjs), the reading the
// memprobe negative-control wait prints before its unchanged assertion. Synthetic records cover every rule in order;
// real probes (scripts/ci/image-queue-memprobe.cjs with diag, no --expose-gc) give "seen", "probe dead" and an R1
// reader gap. The F1 lost-write case is produced for real by the existing EPERM-injection control D1 (#194); here it is
// covered synthetically. Nothing here changes the probe, the 5 s limits, the cycles or any D6 verdict.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { writeTrigger } = require("../ci/memprobe-gc.cjs");
const { observer, readProbeWait } = require("./fixtures/memprobe-diag.cjs");

const PROBE = path.join(__dirname, "..", "ci", "image-queue-memprobe.cjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return null; } };
async function until(fn, ms = 5000, every = 20) { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return null; await sleep(every); } }
function startProbe(dir, out) { // as memprobe-gc.test.cjs, diag on, no --expose-gc
  fs.mkdirSync(path.join(dir, "srv"), { recursive: true });
  const serve = path.join(dir, "srv", "serve.cjs");
  fs.writeFileSync(serve, "setInterval(() => {}, 1000);\n");
  return spawn(process.execPath, ["--require", PROBE, serve], { env: { ...process.env, USAP_IQ_MEMPROBE: out, USAP_IQ_MEMPROBE_DIAG: "1" }, stdio: "ignore" });
}
const stop = (child) => new Promise((r) => { if (child.exitCode !== null || child.signalCode !== null) return r(); child.once("exit", r); child.kill(); });
let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "usap-memprobe-c1-")); });
test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ } });

test("synthetic: every rule, in order", () => {
  const req = { id: "gc-x-1", requestedAt: 1000 };
  const rec = (events, errors = {}) => ({ t: 2000, diag: { ticks: 9, writesOk: 8, events, errors } });
  const obs = (seen = [], failAt = []) => ({ seen, failAt, maxGap: 30 });
  const R = (o) => readProbeWait({ req, attempts: 0, probeRunning: true, triggerPresent: false, obs: obs(), record: rec([]), ...o });
  assert.equal(R({ attempts: null }), "request not published (writeTrigger failed)");
  assert.equal(R({ probeRunning: false }), "probe dead");
  assert.equal(R({ obs: obs([{ t: 1100, gcId: "gc-x-1", firstAt: 1110, lastAt: 1110 }]) }), "marked record seen by the reader");
  assert.equal(R({ record: null }), "undecidable: probe diagnostics not recorded");
  assert.match(R({ triggerPresent: true, record: rec([[1050, "trigger-read-error", "EPERM"]]) }), /^request never consumed \(trigger still present; trigger-read-error EPERM\)/);
  assert.equal(R({ record: rec([[1050, "request", "gc-x-1"], [1060, "write-error", { code: "EPERM", stage: "rename", gcId: "gc-x-1" }]], { "rename:EPERM:marked": 1 }) }), "lost marked write (F1: the marked record's write failed)");
  const win = rec([[1050, "request", "gc-x-1"], [1100, "published-marked", "gc-x-1"], [1300, "replaced-marked", "gc-x-1"]]);
  assert.equal(R({ record: win, obs: obs([{ t: 900, firstAt: 950, lastAt: 1200 }]) }), "R2 published but unseen: reads inside the marked window returned other records (visibility anomaly)");
  assert.equal(R({ record: win, obs: obs([{ t: 900, firstAt: 950, lastAt: 1090 }], [1150, 1160]) }), "read errors: 2 read(s) failed inside the marked window");
  assert.match(R({ record: win, obs: obs([{ t: 900, firstAt: 950, lastAt: 1090 }, { t: 1300, firstAt: 1350, lastAt: 1400 }]) }), /^R1 reader gap: no read inside the marked window \(200 ms; largest gap 30 ms\)$/);
});

test("real: a normal wait reads 'seen'; a reader asleep across the marked window reads R1; a probe killed first reads 'probe dead'", { timeout: 60000 }, async () => {
  const out = path.join(dir, "c1.json");
  const child = startProbe(dir, out);
  try {
    assert.ok(await until(() => { const p = read(out); return p && p.gcAvailable === false; }), "probe running");
    // seen
    let req = { id: "gc-c1-1", requestedAt: Date.now() }; let o = observer();
    let attempts = writeTrigger(`${out}.gc`, req.id);
    assert.ok(await until(() => { const p = o.read(out); return p && p.gcId === req.id; }), "marked record read");
    assert.equal(readProbeWait({ req, attempts, obs: o, probeRunning: true, triggerPresent: false, record: read(out) }), "marked record seen by the reader");
    // R1: read once, sleep past the marked record's life (it is replaced on the next ~200 ms tick), read again later
    await sleep(500);
    req = { id: "gc-c1-2", requestedAt: Date.now() }; o = observer();
    o.read(out);
    attempts = writeTrigger(`${out}.gc`, req.id);
    await sleep(1200);
    const after = await until(() => { const p = read(out); return p && p.diag && p.diag.events.some(([, k, x]) => k === "replaced-marked" && x === req.id) ? p : null; }, 3000);
    o.read(out);
    assert.ok(after, "the probe published and replaced the marked record");
    assert.match(readProbeWait({ req, attempts, obs: o, probeRunning: true, triggerPresent: false, record: after }), /^R1 reader gap: no read inside the marked window/);
  } finally { await stop(child); }
  // probe dead
  const o = observer(); o.read(out);
  assert.equal(readProbeWait({ req: { id: "gc-c1-3", requestedAt: Date.now() }, attempts: 0, obs: o, probeRunning: child.exitCode === null && child.signalCode === null, triggerPresent: true, record: read(out) }), "probe dead");
});
