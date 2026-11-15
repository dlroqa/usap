// Step 9.9f-3: the bounded voice job queue (services/job-queue.cjs, voiceQueue; docs/roadmap/STEP9_9F_WORKLOAD_QUEUES.md).
// Unit tests of the queue with fake timers, then the real server with a stand-in Kokoro worker that has the real
// worker's contract (JSON job on stdin, WAV at job.output, JSON result on stdout) plus test controls in the text:
//   HOLD:<id>   wait until "<cacheDir>/<id>.release" exists     FAIL   exit 1 with an error
//   CRASH       exit 139 (like a segfault) mid-job               every job appends its text to "<cacheDir>/jobs.log"
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

const { makeRoot, startServer, stopServer, request, IS_WIN } = require("./api-contract/harness.cjs");
const { createJobQueue, jobQueueSetting } = require("../server/services/job-queue.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000, label = "condition") {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(40);
  }
}

// ── Unit: setting ────────────────────────────────────────────────────────────
const SETTING = { name: "voiceQueue", envName: "USAP_VOICE_QUEUE", waitName: "voiceQueueMaxWaitMs", waitEnvName: "USAP_VOICE_QUEUE_MAX_WAIT_MS", defaultWaitMs: 600000 };
test("setting: off by default; environment wins over scheduler.json; USAP_SCHEDULER=off forces off; bounded wait", () => {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "usap-vq-cfg-"));
  try {
    assert.equal(jobQueueSetting({ env: {}, configDir: dir, ...SETTING }).mode, "off");
    assert.equal(jobQueueSetting({ env: { USAP_VOICE_QUEUE: "on" }, configDir: dir, ...SETTING }).mode, "on");
    fs.writeFileSync(path.join(dir, "scheduler.json"), JSON.stringify({ voiceQueue: "on", voiceQueueMaxWaitMs: 30000 }));
    const fromFile = jobQueueSetting({ env: {}, configDir: dir, ...SETTING });
    assert.equal(fromFile.mode, "on");
    assert.equal(fromFile.maxWaitMs, 30000);
    assert.equal(jobQueueSetting({ env: { USAP_VOICE_QUEUE: "off" }, configDir: dir, ...SETTING }).mode, "off");
    const forced = jobQueueSetting({ env: { USAP_VOICE_QUEUE: "on" }, configDir: dir, schedulerMode: "off", ...SETTING });
    assert.equal(forced.mode, "off");
    assert.equal(forced.forcedOffBy, "scheduler-off");
    const bad = jobQueueSetting({ env: { USAP_VOICE_QUEUE: "maybe", USAP_VOICE_QUEUE_MAX_WAIT_MS: "5" }, configDir: dir, ...SETTING });
    assert.equal(bad.mode, "on", "invalid environment value ignored, file used");
    assert.equal(bad.maxWaitMs, 30000, "out-of-range wait ignored, file used");
    assert.deepEqual(bad.ignored.map((x) => x.name), ["USAP_VOICE_QUEUE", "USAP_VOICE_QUEUE_MAX_WAIT_MS"]);
    assert.equal(jobQueueSetting({ env: {}, ...SETTING }).limit, 4);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── Unit: the queue ──────────────────────────────────────────────────────────
function fakeClock() {
  let t = 0; const timers = new Set();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const x = { at: t + ms, fn }; timers.add(x); return x; },
    clearTimer: (x) => { timers.delete(x); },
    advance(ms) { t += ms; for (const x of [...timers].sort((a, b) => a.at - b.at)) if (x.at <= t) { timers.delete(x); x.fn(); } },
    pending: () => timers.size,
  };
}
const gone = () => { let cb = null; const h = (f) => { cb = f; }; h.fire = () => cb && cb(); return h; };

test("queue: empty runs at once; partially full waits FIFO; full answers 429 with Retry-After", async () => {
  const c = fakeClock();
  const q = createJobQueue({ engineLabel: "voice engine", limit: 4, maxWaitMs: 60000, ...c });
  const first = await q.admit(gone());
  assert.equal(first.ok, true);
  const order = [];
  const waits = [1, 2, 3, 4].map((i) => q.admit(gone()).then((r) => { order.push(i); return r; }));
  assert.deepEqual(q.stats(), { running: 1, waiting: 4, limit: 4 });
  const full = await q.admit(gone());
  assert.deepEqual(Object.keys(full).sort(), ["code", "error", "ok", "retryAfterSeconds", "status"]);
  assert.equal(full.status, 429);
  assert.equal(full.code, "QUEUE_FULL");
  assert.ok(full.retryAfterSeconds >= 1 && full.retryAfterSeconds <= 120);
  assert.match(full.error, /voice engine is busy: 4 requests are already waiting/);
  let r = first;
  for (let i = 0; i < 4; i += 1) { c.advance(1000); r.release(); r = await waits[i]; assert.equal(r.ok, true); }
  assert.deepEqual(order, [1, 2, 3, 4], "first in, first out");
  r.release();
  assert.deepEqual(q.stats(), { running: 0, waiting: 0, limit: 4 });
  assert.equal(c.pending(), 0, "no wait timers left behind");
});

test("queue: the wait deadline answers 503 QUEUE_TIMEOUT and the job never gets a turn", async () => {
  const c = fakeClock();
  const q = createJobQueue({ engineLabel: "voice engine", maxWaitMs: 5000, ...c });
  const a = await q.admit(gone());
  const b = q.admit(gone());
  c.advance(4999);
  assert.equal(q.stats().waiting, 1);
  c.advance(1);
  const rb = await b;
  assert.equal(rb.status, 503);
  assert.equal(rb.code, "QUEUE_TIMEOUT");
  assert.match(rb.error, /waited more than 5 s for the voice engine/);
  assert.equal(q.stats().waiting, 0);
  a.release();
  assert.deepEqual(q.stats(), { running: 0, waiting: 0, limit: 4 }, "the timed-out job was not granted");
  assert.equal(q.counts().timedOut, 1);
});

test("queue: a disconnect while waiting leaves at once; disconnect, timeout, refusal and grant settle a job once", async () => {
  const c = fakeClock();
  const q = createJobQueue({ engineLabel: "voice engine", maxWaitMs: 5000, ...c });
  const a = await q.admit(gone());
  const g1 = gone(); const g2 = gone();
  const b = q.admit(g1); const d = q.admit(g2);
  g1.fire();
  assert.equal((await b).code, "CLIENT_GONE");
  assert.equal(q.stats().waiting, 1);
  g1.fire(); // a second disconnect event does nothing
  c.advance(5000); // the remaining one times out...
  g2.fire(); // ...and its client leaving at the same moment doesn't settle it again
  assert.equal((await d).code, "QUEUE_TIMEOUT");
  assert.deepEqual(q.counts().clientGone, 1);
  assert.equal(a.release(), true);
  assert.equal(a.release(), false, "release is idempotent");
  assert.equal(q.stats().running, 0);
  // A disconnect after the job was granted (simultaneous completion and cancellation) changes nothing.
  const e = await q.admit(gone());
  const g3 = gone(); const f = q.admit(g3);
  e.release();
  const rf = await f;
  assert.equal(rf.ok, true);
  g3.fire();
  assert.equal(q.stats().running, 1);
  rf.release();
  assert.deepEqual(q.stats(), { running: 0, waiting: 0, limit: 4 });
  const counts = q.counts();
  assert.equal(counts.admitted, counts.completed, "every granted turn released exactly once");
});

test("queue: refuseWaiting refuses only waiting jobs, once, and leaves the running one", async () => {
  const c = fakeClock();
  const q = createJobQueue({ engineLabel: "voice engine", ...c });
  const a = await q.admit(gone());
  const b = q.admit(gone()); const d = q.admit(gone());
  assert.equal(q.refuseWaiting({ status: 409, code: "ENGINE_NOT_READY", error: "stopped" }), 2);
  assert.equal(q.refuseWaiting({ status: 409, code: "ENGINE_NOT_READY", error: "stopped" }), 0);
  assert.equal((await b).code, "ENGINE_NOT_READY");
  assert.equal((await d).status, 409);
  assert.equal(q.stats().running, 1);
  a.release();
  assert.equal(c.pending(), 0);
});

// ── Through the real server ──────────────────────────────────────────────────
const FAKE_WORKER = `
const fs = await import("node:fs");
const path = await import("node:path");
let raw = "";
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", async () => {
  const job = JSON.parse(raw);
  fs.mkdirSync(job.cacheDir, { recursive: true });
  fs.appendFileSync(path.join(job.cacheDir, "jobs.log"), job.text + "\\n");
  const hold = job.text.match(/HOLD:([a-z0-9-]+)/);
  if (hold) { const f = path.join(job.cacheDir, hold[1] + ".release"); while (!fs.existsSync(f)) await new Promise((r) => setTimeout(r, 25)); }
  if (job.text.includes("CRASH")) process.exit(139);
  if (job.text.includes("FAIL")) { process.stderr.write("fake kokoro: synthesis failed\\n"); process.exit(1); }
  const rate = 24000, n = 2400, data = Buffer.alloc(n * 4);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(3, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(32, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(job.output, Buffer.concat([h, data]));
  process.stdout.write(JSON.stringify({ ok: true, output: job.output, sampleRate: rate, durationMs: 100, chunks: 1, segments: [{ text: job.text, start: 0, end: 0.1 }] }));
});
`;

let root;
test.before(() => {
  root = makeRoot();
  fs.mkdirSync(path.join(root, "app", "tts-runtime", "node_modules", "kokoro-js"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "workers", "tts-kokoro-worker.mjs"), FAKE_WORKER);
});
const CACHE = () => path.join(root, "app", "tts-cache");
const jobsLog = () => { try { return fs.readFileSync(path.join(CACHE(), "jobs.log"), "utf8").trim().split("\n").filter(Boolean); } catch (_) { return []; } };
const resetJobs = () => { try { fs.unlinkSync(path.join(CACHE(), "jobs.log")); } catch (_) {} };
const release = (id) => { fs.mkdirSync(CACHE(), { recursive: true }); fs.writeFileSync(path.join(CACHE(), `${id}.release`), "1"); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; } };
async function workers(srv) {
  const d = (await request(srv.port, "GET", "/api/diagnostics")).json;
  const sup = (d && d.engines && d.engines.processes && d.engines.processes.supervised) || [];
  return sup.filter((r) => /^node(\.exe)?$/i.test(String(r.label))).map((r) => r.enginePid || r.guardPid).filter((p) => p && alive(p));
}
// `abortAfterMs`: the client disconnects then.
function speak(srv, text, { abortAfterMs = null, extra = {} } = {}) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ text, model: "kokoro-onnx-q8.json", ...extra });
    const req = http.request({ host: "127.0.0.1", port: srv.port, method: "POST", path: "/api/tts/speak", agent: false,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
      let b = ""; res.setEncoding("utf8"); res.on("data", (c) => { b += c; });
      res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, json: j, headers: res.headers, at: Date.now() }); });
      res.on("error", () => {});
    });
    let aborted = false;
    if (abortAfterMs !== null) setTimeout(() => { aborted = true; req.destroy(); }, abortAfterMs);
    req.on("error", () => resolve({ status: 0, aborted, at: Date.now() }));
    req.end(data);
  });
}
const queueState = async (srv) => ((await request(srv.port, "GET", "/api/resources")).json.engines.voice.queue);
const waitWaiting = (srv, n) => waitFor(async () => (await queueState(srv)).waiting === n, 10000, `${n} waiting`);
const outputsCount = async (srv) => (await request(srv.port, "GET", "/api/tts/outputs")).json.outputs.length;
const ON = { USAP_VOICE_QUEUE: "on" };
const DEFAULT = { USAP_VOICE_QUEUE: "" };
let holdN = 0;
const hold = () => `h${++holdN}-${Date.now()}`;
async function withServer(env, fn) {
  resetJobs();
  const srv = await startServer(root, env);
  try {
    assert.equal((await request(srv.port, "POST", "/api/tts/download-model", { body: { modelId: "kokoro-onnx-q8" } })).status, 200);
    return await fn(srv);
  } finally { stopServer(srv); await sleep(150); }
}

test("server (queue on): an empty queue runs a job at once; the success body is unchanged", async () => {
  await withServer(ON, async (srv) => {
    const r = await speak(srv, "Hello there.");
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json).sort(), ["ok", "output"]);
    assert.deepEqual(await queueState(srv), { running: 0, waiting: 0, known: true, limit: 4 });
  });
});

test("server (queue on): partially full, full (429 QUEUE_FULL + Retry-After), and FIFO order at the worker", async () => {
  await withServer(ON, async (srv) => {
    const id = hold();
    const first = speak(srv, `T0 HOLD:${id}`);
    await waitFor(async () => (await queueState(srv)).running === 1, 10000, "running");
    const waiting = [];
    for (let i = 1; i <= 4; i += 1) { waiting.push(speak(srv, `T${i}`)); await waitWaiting(srv, i); }
    assert.deepEqual(await queueState(srv), { running: 1, waiting: 4, known: true, limit: 4 });
    const full = await speak(srv, "T5 refused");
    assert.equal(full.status, 429);
    assert.equal(full.json.code, "QUEUE_FULL");
    assert.equal(full.json.ok, false);
    assert.ok(Number(full.headers["retry-after"]) >= 1);
    release(id);
    const rs = await Promise.all([first, ...waiting]);
    assert.deepEqual(rs.map((r) => r.status), [200, 200, 200, 200, 200]);
    assert.deepEqual(jobsLog().map((t) => t.split(" ")[0]), ["T0", "T1", "T2", "T3", "T4"], "first in, first out; the refused job never ran");
    assert.deepEqual(await queueState(srv), { running: 0, waiting: 0, known: true, limit: 4 });
    const res = (await request(srv.port, "GET", "/api/resources")).json;
    assert.equal(res.limits.voiceQueue, "on");
    assert.equal(res.voiceQueue.counts.full, 1);
    assert.equal(JSON.stringify(res.voiceQueue).includes("T0"), false, "no text in the report");
  });
});

test("server (queue on): the wait deadline answers 503 QUEUE_TIMEOUT; the job never reaches the worker", async () => {
  await withServer({ ...ON, USAP_VOICE_QUEUE_MAX_WAIT_MS: "1500" }, async (srv) => {
    const id = hold();
    const first = speak(srv, `A HOLD:${id}`);
    await waitFor(async () => (await queueState(srv)).running === 1, 10000, "running");
    const late = await speak(srv, "B late");
    assert.equal(late.status, 503);
    assert.equal(late.json.code, "QUEUE_TIMEOUT");
    assert.ok(Number(late.headers["retry-after"]) >= 1);
    release(id);
    assert.equal((await first).status, 200);
    assert.deepEqual(jobsLog().map((t) => t[0]), ["A"]);
  });
});

test("server (queue on): a client that disconnects while waiting leaves the queue; its job never runs or saves", async () => {
  await withServer(ON, async (srv) => {
    const id = hold();
    const before = await outputsCount(srv);
    const first = speak(srv, `A HOLD:${id}`);
    await waitFor(async () => (await queueState(srv)).running === 1, 10000, "running");
    const gone = speak(srv, "B abandoned", { abortAfterMs: 300 });
    await waitWaiting(srv, 1);
    assert.equal((await gone).aborted, true);
    await waitWaiting(srv, 0);
    release(id);
    assert.equal((await first).status, 200);
    await sleep(300);
    assert.deepEqual(jobsLog().map((t) => t[0]), ["A"]);
    assert.equal((await outputsCount(srv)) - before, 1);
    assert.equal((await request(srv.port, "GET", "/api/resources")).json.voiceQueue.counts.clientGone, 1);
  });
});

test("server (queue on): a client that disconnects while its job runs doesn't kill the worker; the next job waits for it", async () => {
  await withServer(ON, async (srv) => {
    const id = hold();
    const before = await outputsCount(srv);
    const running = speak(srv, `A HOLD:${id}`, { abortAfterMs: 400 });
    await waitFor(async () => (await workers(srv)).length === 1, 10000, "worker");
    // The worker process exists before it has read its job and logged it; on a slow runner that takes longer than
    // the abort below. Wait for A in the log, so the check below is about B only.
    await waitFor(async () => jobsLog().length === 1, 10000, "A started");
    const [pid] = await workers(srv);
    assert.equal((await running).aborted, true);
    await sleep(300);
    assert.equal(alive(pid), true, "the job's Kokoro worker keeps running");
    assert.equal((await queueState(srv)).running, 1, "its turn is still held");
    const next = speak(srv, "B next");
    await waitWaiting(srv, 1);
    assert.deepEqual(jobsLog().map((t) => t[0]), ["A"], "the next job hasn't started beside it");
    release(id);
    assert.equal((await next).status, 200);
    assert.deepEqual(jobsLog().map((t) => t[0]), ["A", "B"]);
    assert.equal((await outputsCount(srv)) - before, 2, "the finished job's output is saved, as before");
    assert.deepEqual(await queueState(srv), { running: 0, waiting: 0, known: true, limit: 4 });
  });
});

test("server (queue on): a crashing or failing worker answers its error, releases the turn once, and the next job runs", async () => {
  await withServer(ON, async (srv) => {
    const crash = speak(srv, "A CRASH");
    const fail = speak(srv, "B FAIL");
    const ok = speak(srv, "C fine");
    const [rc, rf, ro] = await Promise.all([crash, fail, ok]);
    assert.equal(rc.status, 500);
    assert.equal(rf.status, 500);
    assert.match(rf.json.error, /synthesis failed/);
    assert.deepEqual(Object.keys(rf.json).sort(), ["activeRuntime", "code", "error", "ok"], "the error body is the existing shape");
    assert.equal(ro.status, 200);
    const res = (await request(srv.port, "GET", "/api/resources")).json;
    assert.deepEqual(res.engines.voice.queue, { running: 0, waiting: 0, known: true, limit: 4 });
    assert.equal(res.voiceQueue.counts.admitted, res.voiceQueue.counts.completed);
    assert.deepEqual(await workers(srv), []);
  });
});

test("server (queue on): /api/tts/stop refuses waiting jobs (409 ENGINE_NOT_READY), lets the running one finish; a later job starts the engine again", async () => {
  await withServer(ON, async (srv) => {
    const id = hold();
    const a = speak(srv, `A HOLD:${id}`);
    await waitFor(async () => (await queueState(srv)).running === 1, 10000, "running");
    const b = speak(srv, "B waiting");
    await waitWaiting(srv, 1);
    assert.equal((await request(srv.port, "POST", "/api/tts/stop", { body: {} })).status, 200);
    const rb = await b;
    assert.equal(rb.status, 409);
    assert.equal(rb.json.code, "ENGINE_NOT_READY");
    release(id);
    assert.equal((await a).status, 200);
    const again = await speak(srv, "C after stop");
    assert.equal(again.status, 200);
    assert.equal((await request(srv.port, "GET", "/api/tts/status")).json.ready, true);
    assert.deepEqual(jobsLog().map((t) => t[0]), ["A", "C"]);
  });
});

test("server (queue on): completion and client disconnect at the same moment settle the turn exactly once", async () => {
  await withServer(ON, async (srv) => {
    for (let i = 0; i < 5; i += 1) {
      const id = hold();
      const p = speak(srv, `R${i} HOLD:${id}`, { abortAfterMs: 400 });
      await waitFor(async () => (await queueState(srv)).running === 1, 10000, "running");
      await sleep(390 - 50 * i > 0 ? 390 - 50 * i : 0);
      release(id);
      await p;
      await waitFor(async () => (await queueState(srv)).running === 0, 10000, "released");
    }
    const res = (await request(srv.port, "GET", "/api/resources")).json;
    assert.equal(res.voiceQueue.counts.admitted, 5);
    assert.equal(res.voiceQueue.counts.completed, 5);
    assert.equal((await speak(srv, "after")).status, 200);
  });
});

test("server (queue on): shutting the server down during a job leaves no worker behind", { skip: IS_WIN ? "Windows has no SIGTERM to a process; supervision covers hard kills (engine-supervision tests)" : false }, async () => {
  resetJobs();
  const srv = await startServer(root, ON);
  try {
    assert.equal((await request(srv.port, "POST", "/api/tts/download-model", { body: { modelId: "kokoro-onnx-q8" } })).status, 200);
    const id = hold();
    speak(srv, `A HOLD:${id}`);
    speak(srv, "B waiting");
    const [pid] = await waitFor(async () => { const w = await workers(srv); return w.length ? w : null; }, 10000, "worker");
    process.kill(srv.proc.pid, "SIGTERM");
    await waitFor(() => srv.proc.exitCode !== null || srv.proc.signalCode !== null, 15000, "server exit");
    await waitFor(() => !alive(pid), 10000, "worker gone");
    release(id);
  } finally { stopServer(srv); }
});

test("default off: no queue, unbounded as before (6 at once all succeed), no report keys, a waiting disconnect still runs", async () => {
  await withServer(DEFAULT, async (srv) => {
    const res = (await request(srv.port, "GET", "/api/resources")).json;
    assert.equal("voiceQueue" in res, false);
    assert.equal("voiceQueue" in res.limits, false);
    assert.equal("queue" in res.engines.voice, false);
    const rs = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => speak(srv, `D${i}`)));
    assert.deepEqual(rs.map((r) => r.status), [200, 200, 200, 200, 200, 200]);
    assert.deepEqual(Object.keys(rs[0].json).sort(), ["ok", "output"]);
    resetJobs();
    const id = hold();
    const a = speak(srv, `A HOLD:${id}`);
    await waitFor(async () => jobsLog().length === 1, 10000, "A started");
    await speak(srv, "B abandoned", { abortAfterMs: 300 });
    release(id);
    await a;
    await waitFor(async () => jobsLog().length === 2, 10000, "legacy: the abandoned job still runs");
  });
});

test("rollback: USAP_SCHEDULER=off turns the voice queue off even with USAP_VOICE_QUEUE=on", async () => {
  await withServer({ ...ON, USAP_SCHEDULER: "off" }, async (srv) => {
    assert.match(srv.log(), /voice queue "on" is off because USAP_SCHEDULER=off/);
    assert.equal((await request(srv.port, "GET", "/api/resources")).status, 404);
    const rs = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => speak(srv, `S${i}`)));
    assert.deepEqual(rs.map((r) => r.status), [200, 200, 200, 200, 200, 200], "legacy: no 429");
  });
});

test.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} });
