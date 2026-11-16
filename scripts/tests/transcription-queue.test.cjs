// Step 9.9f-3 transcription queue (services/transcription-queue.cjs, docs/roadmap/STEP9_9F_WHISPER_QUEUE.md).
// Two layers:
//   * the real server (harness) with a whisper-cli stand-in that logs each job and can be held: defaults, rollback,
//     FIFO by admission, 413/429/507/503/408/409, disconnects, exactly-once release, files, memory, thread cap;
//   * the service on a real HTTP server with a fake speech service, an injected statfs and small limits: limits that
//     the server can't reach in a test (1 GiB, low disk, chunked growth, total deadline).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { makeRoot, startServer, stopServer, request, IS_WIN, fakeLlamaPath } = require("./api-contract/harness.cjs");
const { transcriptionQueueSetting, createStorageLedger, prepareUploadDir, createTranscriptionQueue } = require("../server/services/transcription-queue.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 10000, label = "condition") {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${label}`); await sleep(25); }
}
const MiB = 1024 * 1024;
// A request that should end within `ms`: if it doesn't, the test fails by name instead of hanging the file.
const within = (p, ms, label) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${label}: no answer within ${ms} ms`); })]);
const OS_DIR = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";

// ── whisper-cli stand-in ─────────────────────────────────────────────────────
// Logs { ev, name, t, f } per job to <FAKE_WHISPER_DIR>/jobs.log; holds while <dir>/hold exists; FAIL in the source
// name (the -of base can't carry it, so the stand-in reads it from the job file's first data bytes) exits 1.
const FAKE_WHISPER = `#!/usr/bin/env node
const fs = require("fs"); const path = require("path");
const a = process.argv.slice(2); const arg = (k) => { const i = a.indexOf(k); return i === -1 ? null : a[i + 1]; };
const dir = process.env.FAKE_WHISPER_DIR;
const f = arg("-f");
const tag = fs.readFileSync(f).subarray(44, 60).toString("latin1").replace(/\\0+$/, "");
fs.appendFileSync(path.join(dir, "jobs.log"), JSON.stringify({ ev: "start", name: tag, t: Number(arg("-t")), f, pid: process.pid }) + "\\n");
const tick = () => {
  if (fs.existsSync(path.join(dir, "hold"))) return setTimeout(tick, 20);
  if (tag.startsWith("FAIL")) { process.stderr.write("fake whisper: failed\\n"); process.exit(1); }
  fs.writeFileSync(arg("-of") + ".txt", " transcript of " + tag + "\\n");
  fs.writeFileSync(arg("-of") + ".json", JSON.stringify({ result: { language: "en" } }));
  fs.appendFileSync(path.join(dir, "jobs.log"), JSON.stringify({ ev: "end", name: tag }) + "\\n");
  process.exit(0);
};
tick();
`;
function installFakeWhisper(root) {
  const cli = path.join(root, "app", "speech-backend", OS_DIR, "cpu", IS_WIN ? "whisper-cli.exe" : "whisper-cli");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  if (IS_WIN) {
    fs.copyFileSync(fakeLlamaPath(root), cli); // the compiled launcher runs fake-llama-server.cjs next to it
    fs.writeFileSync(path.join(path.dirname(cli), "fake-llama-server.cjs"), FAKE_WHISPER);
  } else {
    fs.writeFileSync(cli, FAKE_WHISPER);
    fs.chmodSync(cli, 0o755);
  }
  fs.mkdirSync(path.join(root, "app", "speech-models"), { recursive: true });
  fs.writeFileSync(path.join(root, "app", "speech-models", "ggml-test.bin"), "fake whisper model");
}
// A WAV whose first data bytes carry `tag` (so the stand-in can tell jobs apart).
function wav(tag, dataBytes = 3200) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + dataBytes, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(dataBytes, 40);
  const data = Buffer.alloc(dataBytes); data.write(String(tag).slice(0, 16), 0, "latin1");
  return Buffer.concat([h, data]);
}

/**
 * A transcription upload with control over the body: `parts` are sent with `gapMs` between them; `stopAfter` sends
 * only that many parts and then leaves the request open; `abortAfterMs` destroys the request; `claim` overrides
 * Content-Length (null = chunked). Resolves { status, json, headers, ms } or { status: 0, error }. Every upload ends
 * within `timeoutMs` (a client timeout), so no test can hang on a server that never answers.
 */
function upload(port, body, { parts = 1, gapMs = 0, stopAfter = null, abortAfterMs = null, claim = body.length, query = "", hold = null, timeoutMs = 60000 } = {}) {
  let req;
  const t0 = Date.now();
  const promise = new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve({ ...v, ms: Date.now() - t0 }); } };
    const headers = { "Content-Type": "audio/wav" };
    if (claim !== null) headers["Content-Length"] = claim;
    req = http.request({ host: "127.0.0.1", port, method: "POST", path: `/api/speech/transcribe?model=ggml-test.bin${query}`, headers, agent: false }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => { let json = null; try { json = JSON.parse(text); } catch (_) { /* not json */ } fin({ status: res.statusCode, json, headers: res.headers }); });
      res.on("error", () => fin({ status: res.statusCode, cut: true }));
    });
    req.on("error", (e) => fin({ status: 0, error: e.code || e.message }));
    const size = Math.ceil(body.length / parts);
    (async () => {
      for (let i = 0; i < parts; i += 1) {
        if (stopAfter !== null && i >= stopAfter) return;
        if (hold && i > 0) await hold;
        if (req.destroyed) return;
        req.write(body.subarray(i * size, Math.min(body.length, (i + 1) * size)));
        if (gapMs && i < parts - 1) await sleep(gapMs);
      }
      if (!req.destroyed) req.end();
    })();
    if (abortAfterMs !== null) setTimeout(() => { req.destroy(); fin({ status: 0, aborted: true }); }, abortAfterMs);
    const limit = setTimeout(() => { req.destroy(); fin({ status: 0, error: "client timeout" }); }, timeoutMs);
    if (limit.unref) limit.unref();
  });
  return { promise, abort: () => req && req.destroy() };
}

async function withServer(env, fn) {
  const root = makeRoot();
  installFakeWhisper(root);
  const dir = path.join(root, "fake-whisper"); fs.mkdirSync(dir);
  const srv = await startServer(root, { FAKE_WHISPER_DIR: dir, ...env });
  const ctx = {
    root, srv, dir,
    hold: () => fs.writeFileSync(path.join(dir, "hold"), ""),
    release: () => fs.rmSync(path.join(dir, "hold"), { force: true }),
    jobs: () => { try { return fs.readFileSync(path.join(dir, "jobs.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } },
    started: () => ctx.jobs().filter((j) => j.ev === "start").map((j) => j.name),
    uploads: () => { try { return fs.readdirSync(path.join(root, "app", "cache", "speech-uploads")); } catch (_) { return null; } },
    saved: () => fs.readdirSync(path.join(root, "app", "transcriptions")).filter((f) => f.startsWith("transcript-") && f.endsWith(".json")).length,
    resources: async () => (await request(srv.port, "GET", "/api/resources")).json,
  };
  try { return await fn(ctx); } finally {
    ctx.release();
    stopServer(srv); await sleep(300);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* Windows may hold files briefly */ }
  }
}
const ON = { USAP_TRANSCRIPTION_QUEUE: "on" };
const queueState = async (c) => (await c.resources()).engines.speech.queue;
// The end state every queue test must reach: nothing running or waiting, no booked storage, no files left.
async function assertDrained(c) {
  await waitFor(async () => { const r = await c.resources(); return r.engines.speech.queue.running === 0 && r.engines.speech.queue.waiting === 0 && r.transcriptionQueue.storage.reservedBytes === 0; }, 10000, "queue drained");
  await waitFor(async () => (c.uploads() || []).length === 0, 10000, "upload folder empty");
}

// ── Settings ─────────────────────────────────────────────────────────────────
test("setting: off by default; limits and their ranges; invalid values are ignored (never clamped); USAP_SCHEDULER=off forces off", () => {
  const d = transcriptionQueueSetting({ env: {} });
  assert.deepEqual([d.mode, d.limit, d.maxWaitMs, d.budgetBytes, d.uploadIdleMs, d.uploadMaxMs], ["off", 4, 600000, 2 * 1024 * MiB, 30000, 240000]);
  const on = transcriptionQueueSetting({ env: { USAP_TRANSCRIPTION_QUEUE: "on", USAP_TRANSCRIPTION_QUEUE_LIMIT: "2", USAP_TRANSCRIPTION_QUEUE_STORAGE_BUDGET_BYTES: String(64 * MiB), USAP_TRANSCRIPTION_QUEUE_UPLOAD_IDLE_MS: "5000", USAP_TRANSCRIPTION_QUEUE_UPLOAD_MAX_MS: "30000", USAP_TRANSCRIPTION_QUEUE_MAX_WAIT_MS: "1000" } });
  assert.deepEqual([on.mode, on.limit, on.budgetBytes, on.uploadIdleMs, on.uploadMaxMs, on.maxWaitMs], ["on", 2, 64 * MiB, 5000, 30000, 1000]);
  const bad = transcriptionQueueSetting({ env: { USAP_TRANSCRIPTION_QUEUE: "yes", USAP_TRANSCRIPTION_QUEUE_LIMIT: "17", USAP_TRANSCRIPTION_QUEUE_STORAGE_BUDGET_BYTES: "1000", USAP_TRANSCRIPTION_QUEUE_UPLOAD_IDLE_MS: "1", USAP_TRANSCRIPTION_QUEUE_UPLOAD_MAX_MS: "300000" } });
  assert.deepEqual([bad.mode, bad.limit, bad.budgetBytes, bad.uploadIdleMs, bad.uploadMaxMs], ["off", 4, 2 * 1024 * MiB, 30000, 240000], "out of range: the default, not the nearest bound");
  assert.equal(bad.ignored.length, 5);
  const forced = transcriptionQueueSetting({ env: { USAP_TRANSCRIPTION_QUEUE: "on" }, schedulerMode: "off" });
  assert.deepEqual([forced.mode, forced.forcedOffBy], ["off", "scheduler-off"]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usap-tq-"));
  try {
    fs.writeFileSync(path.join(root, "scheduler.json"), JSON.stringify({ transcriptionQueue: "on", transcriptionQueueLimit: 3 }));
    const f = transcriptionQueueSetting({ env: {}, configDir: root });
    assert.deepEqual([f.mode, f.limit], ["on", 3]);
    assert.equal(transcriptionQueueSetting({ env: { USAP_TRANSCRIPTION_QUEUE: "off" }, configDir: root }).mode, "off", "the environment wins");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── Storage ledger ───────────────────────────────────────────────────────────
test("ledger: reservations are booked atomically against the budget and free space minus a margin; release is exactly once", () => {
  const big = () => ({ bavail: 100 * 1024, bsize: MiB, blocks: 1000 * 1024 }); // 100 GiB free on a 1000 GiB volume
  const l = createStorageLedger({ budgetBytes: 100 * MiB, dir: "/x", statfs: big });
  const a = l.reserve(60 * MiB); assert.ok(a.ok);
  assert.deepEqual(l.reserve(50 * MiB), { ok: false, reason: "budget" });
  const b = l.reserve(40 * MiB); assert.ok(b.ok);
  assert.equal(l.reservedBytes(), 100 * MiB);
  assert.equal(l.release(a.reservation), true);
  assert.equal(l.release(a.reservation), false, "a second release does nothing");
  assert.equal(l.reservedBytes(), 40 * MiB);
  assert.equal(l.grow(b.reservation, 64 * MiB), false, "growth past the budget is refused");
  assert.equal(l.grow(b.reservation, 60 * MiB), true);
  assert.equal(l.reservedBytes(), 100 * MiB);
  l.release(b.reservation);
  assert.equal(l.reservedBytes(), 0);
  // Low disk: 300 MiB free on a 1 TiB volume, margin 256 MiB -> only 44 MiB usable whatever the budget.
  const low = createStorageLedger({ budgetBytes: 2048 * MiB, dir: "/x", statfs: () => ({ bavail: 300, bsize: MiB, blocks: 1024 * 1024 }) });
  assert.deepEqual(low.reserve(64 * MiB), { ok: false, reason: "disk" });
  assert.ok(low.reserve(40 * MiB).ok);
  // Small volume: the margin is 2 % of it (8 GiB volume -> about 164 MiB).
  const small = createStorageLedger({ budgetBytes: 2048 * MiB, dir: "/x", statfs: () => ({ bavail: 200, bsize: MiB, blocks: 8 * 1024 }) });
  assert.ok(small.reserve(30 * MiB).ok);
  assert.deepEqual(small.reserve(10 * MiB), { ok: false, reason: "disk" });
  // No statfs on this volume: only the budget applies.
  const none = createStorageLedger({ budgetBytes: 100 * MiB, dir: "/x", statfs: () => { throw new Error("ENOSYS"); } });
  assert.ok(none.reserve(100 * MiB).ok);
});

test("upload folder: created with private permissions inside the data root; a link or an outside folder is refused", { skip: IS_WIN && "symlinks need privileges on Windows" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usap-tq-"));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "usap-tq-other-"));
  try {
    const dir = prepareUploadDir({ dataRoot: root });
    assert.equal(dir, path.join(root, "cache", "speech-uploads"));
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "usap-tq-"));
    fs.mkdirSync(path.join(root2, "cache"));
    fs.symlinkSync(other, path.join(root2, "cache", "speech-uploads"));
    assert.throws(() => prepareUploadDir({ dataRoot: root2 }), /not a plain folder/);
    fs.rmSync(root2, { recursive: true, force: true });
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }); }
});

// ── Real server: off, rollback, compatibility ────────────────────────────────
test("server, off (default): today's behaviour, no upload folder, no new /api/resources keys; ten requests all accepted", async () => {
  await withServer({}, async (c) => {
    const r = await c.resources();
    assert.equal(r.transcriptionQueue, undefined);
    assert.equal(r.engines.speech.queue, undefined);
    assert.equal(r.limits.transcriptionQueue, undefined);
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => upload(c.srv.port, wav(`j${i}`)).promise));
    assert.deepEqual(rs.map((x) => x.status), Array(10).fill(200), "no bound when off (as before)");
    assert.equal(c.uploads(), null, "the upload folder is never created when off");
  });
});

test("server, rollback: USAP_SCHEDULER=off turns the queue off even with USAP_TRANSCRIPTION_QUEUE=on", async () => {
  await withServer({ ...ON, USAP_SCHEDULER: "off" }, async (c) => {
    const rs = await Promise.all(Array.from({ length: 7 }, (_, i) => upload(c.srv.port, wav(`r${i}`)).promise));
    assert.deepEqual(rs.map((x) => x.status), Array(7).fill(200));
    assert.equal(c.uploads(), null);
  });
});

test("server, on: an empty queue runs at once; the success body is the same as with the queue off", async () => {
  let offBody;
  await withServer({}, async (c) => { offBody = (await upload(c.srv.port, wav("same")).promise).json; });
  await withServer(ON, async (c) => {
    const r = await upload(c.srv.port, wav("same")).promise;
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json).sort(), Object.keys(offBody).sort());
    assert.deepEqual(Object.keys(r.json.transcription).sort(), Object.keys(offBody.transcription).sort());
    assert.equal(r.json.transcription.text, offBody.transcription.text);
    assert.equal(c.saved(), 1, "saved as before");
    await assertDrained(c);
  });
});

// ── Real server: order, capacity, limits ─────────────────────────────────────
test("server, on: FIFO by admission: a request that arrived first runs first, even if a later one finished uploading first", async () => {
  await withServer(ON, async (c) => {
    c.hold();
    const h = upload(c.srv.port, wav("H")).promise;
    await waitFor(() => c.started().length === 1, 10000, "H running");
    let letGo; const gate = new Promise((r) => { letGo = r; });
    const a = upload(c.srv.port, wav("A", 200000), { parts: 2, hold: gate }); // arrives first, finishes its upload last
    await waitFor(async () => (await queueState(c)).waiting === 1, 5000, "A admitted");
    const b = upload(c.srv.port, wav("B")); // arrives second, uploads at once
    await waitFor(async () => (await queueState(c)).waiting === 2, 5000, "B admitted");
    await sleep(300);
    letGo();
    await sleep(300);
    c.release();
    const rs = await Promise.all([h, a.promise, b.promise]);
    assert.deepEqual(rs.map((x) => x.status), [200, 200, 200]);
    assert.deepEqual(c.started(), ["H", "A", "B"]);
    await assertDrained(c);
  });
});

test("server, on: capacity is 1 running + 4 waiting; the next gets 429 QUEUE_FULL with Retry-After at once, its body unread", async () => {
  await withServer(ON, async (c) => {
    c.hold();
    const first = upload(c.srv.port, wav("H")).promise;
    await waitFor(() => c.started().length === 1, 10000, "running");
    const waiting = [1, 2, 3, 4].map((i) => upload(c.srv.port, wav(`W${i}`)).promise);
    await waitFor(async () => (await queueState(c)).waiting === 4, 5000, "4 waiting");
    const full = await upload(c.srv.port, wav("F", 4 * MiB)).promise;
    assert.equal(full.status, 429);
    assert.equal(full.json.code, "QUEUE_FULL");
    assert.ok(Number(full.headers["retry-after"]) >= 1);
    assert.ok(full.ms < 3000, `answered at once (${full.ms} ms)`);
    c.release();
    const rs = await Promise.all([first, ...waiting]);
    assert.deepEqual(rs.map((x) => x.status), [200, 200, 200, 200, 200]);
    assert.deepEqual(c.started(), ["H", "W1", "W2", "W3", "W4"]);
    await assertDrained(c);
  });
});

test("server, on: a declared size over 1 GiB gets 413 UPLOAD_TOO_LARGE before anything is read or reserved", async () => {
  await withServer(ON, async (c) => {
    const r = await upload(c.srv.port, wav("big", 1024), { claim: 2 * 1024 * MiB, stopAfter: 1 }).promise;
    assert.equal(r.status, 413);
    assert.equal(r.json.code, "UPLOAD_TOO_LARGE");
    assert.ok(r.ms < 3000, `${r.ms} ms`);
    assert.equal(c.started().length, 0);
    await assertDrained(c);
  });
});

test("server, on: the storage budget is booked at admission: an upload that doesn't fit gets 507 INSUFFICIENT_STORAGE", async () => {
  await withServer({ ...ON, USAP_TRANSCRIPTION_QUEUE_STORAGE_BUDGET_BYTES: String(64 * MiB) }, async (c) => {
    c.hold();
    const h = upload(c.srv.port, wav("H")).promise;
    await waitFor(() => c.started().length === 1, 10000, "running");
    const a = upload(c.srv.port, wav("A", 50 * MiB), { parts: 50, gapMs: 20 }); // books 50 MiB at once, uploads slowly
    await waitFor(async () => (await c.resources()).transcriptionQueue.storage.reservedBytes > 50 * MiB, 5000, "A booked");
    const b = await upload(c.srv.port, wav("B", 20 * MiB)).promise;
    assert.equal(b.status, 507);
    assert.equal(b.json.code, "INSUFFICIENT_STORAGE");
    assert.ok(b.headers["retry-after"], "budget held by others: Retry-After");
    assert.doesNotMatch(JSON.stringify(b.json), /[\\/](app|cache|speech-uploads|tmp)[\\/]/i, "no paths in the answer");
    c.release();
    const rs = await Promise.all([h, a.promise]);
    assert.deepEqual(rs.map((x) => x.status), [200, 200]);
    assert.deepEqual(c.started(), ["H", "A"]);
    await assertDrained(c);
  });
});

test("server, on: a job waits at most the configured time (503 QUEUE_TIMEOUT); its file and reservation are released", async () => {
  await withServer({ ...ON, USAP_TRANSCRIPTION_QUEUE_MAX_WAIT_MS: "1000" }, async (c) => {
    c.hold();
    const h = upload(c.srv.port, wav("H")).promise;
    await waitFor(() => c.started().length === 1, 10000, "running");
    const late = await upload(c.srv.port, wav("L")).promise;
    assert.equal(late.status, 503);
    assert.equal(late.json.code, "QUEUE_TIMEOUT");
    assert.ok(Number(late.headers["retry-after"]) >= 1);
    c.release();
    assert.equal((await h).status, 200);
    assert.deepEqual(c.started(), ["H"], "the timed-out job never ran");
    await assertDrained(c);
  });
});

test("server, on: an upload that stalls gets 408 UPLOAD_TIMEOUT (idle), even at the head of the queue; the next job runs", async () => {
  await withServer({ ...ON, USAP_TRANSCRIPTION_QUEUE_UPLOAD_IDLE_MS: "5000" }, async (c) => {
    const stall = upload(c.srv.port, wav("S", 100000), { parts: 4, stopAfter: 1 }); // first part, then nothing
    await waitFor(async () => (await queueState(c)).running === 1, 5000, "S holds the turn while uploading");
    const next = upload(c.srv.port, wav("N")).promise;
    const r = await within(stall.promise, 15000, "the stalled upload");
    assert.equal(r.status, 408);
    assert.deepEqual([r.json.code, r.json.phase], ["UPLOAD_TIMEOUT", "idle"]);
    assert.ok(r.ms >= 4500 && r.ms < 9000, `${r.ms} ms`);
    assert.equal((await next).status, 200);
    assert.deepEqual(c.started(), ["N"], "the stalled upload never reached whisper-cli");
    await assertDrained(c);
  });
});

test("server, on: a body that isn't WAV is refused early with today's status and message", async () => {
  await withServer(ON, async (c) => {
    const r = await upload(c.srv.port, Buffer.from("not a wave file at all, just some text bytes for the test")).promise;
    assert.equal(r.status, 500);
    assert.equal(r.json.error, "Speech transcription currently accepts WAV audio only.");
    assert.equal(c.started().length, 0);
    await assertDrained(c);
  });
});

// ── Real server: disconnects, stop, failures ─────────────────────────────────
test("server, on: a client that leaves while waiting (or still uploading) never reaches whisper-cli, nothing is saved", async () => {
  await withServer(ON, async (c) => {
    c.hold();
    const h = upload(c.srv.port, wav("H")).promise;
    await waitFor(() => c.started().length === 1, 10000, "running");
    const gone = upload(c.srv.port, wav("G"), { abortAfterMs: 500 });
    const half = upload(c.srv.port, wav("U", 200000), { parts: 4, stopAfter: 1, abortAfterMs: 700 });
    await Promise.all([gone.promise, half.promise]);
    await waitFor(async () => (await queueState(c)).waiting === 0, 5000, "left the queue");
    c.release();
    assert.equal((await h).status, 200);
    await sleep(300);
    assert.deepEqual(c.started(), ["H"]);
    assert.equal(c.saved(), 1, "only the running job's transcript");
    await assertDrained(c);
  });
});

test("server, on: a client that leaves while its job runs doesn't stop whisper-cli; the turn and file are held until it exits", async () => {
  await withServer(ON, async (c) => {
    c.hold();
    const running = upload(c.srv.port, wav("R"), { abortAfterMs: 600 });
    await waitFor(() => c.started().length === 1, 10000, "running");
    assert.equal((await running.promise).aborted, true);
    await sleep(300);
    const st = await queueState(c);
    assert.equal(st.running, 1, "still owns its turn");
    assert.equal((c.uploads() || []).length, 1, "its file is kept while whisper-cli runs");
    const next = upload(c.srv.port, wav("N")).promise;
    await waitFor(async () => (await queueState(c)).waiting === 1, 5000, "next waits");
    c.release();
    assert.equal((await within(next, 15000, "the next job")).status, 200);
    assert.deepEqual(c.started(), ["R", "N"]);
    assert.equal(c.saved(), 2, "the abandoned job's transcript is saved, as before");
    await assertDrained(c);
  });
});

test("server, on: /api/speech/stop refuses waiting jobs (409 ENGINE_NOT_READY) and lets the running one finish", async () => {
  await withServer(ON, async (c) => {
    c.hold();
    const h = upload(c.srv.port, wav("H")).promise;
    await waitFor(() => c.started().length === 1, 10000, "running");
    const w = upload(c.srv.port, wav("W")).promise;
    await waitFor(async () => (await queueState(c)).waiting === 1, 5000, "waiting");
    assert.equal((await request(c.srv.port, "POST", "/api/speech/stop", { body: {} })).status, 200);
    const r = await w;
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "ENGINE_NOT_READY");
    c.release();
    assert.equal((await h).status, 200);
    assert.deepEqual(c.started(), ["H"]);
    await assertDrained(c);
  });
});

test("server, on: a failing transcription answers its error, releases its turn once, and the next job runs", async () => {
  await withServer(ON, async (c) => {
    const [f, ok] = await Promise.all([upload(c.srv.port, wav("FAIL")).promise, upload(c.srv.port, wav("OK")).promise]);
    assert.equal(f.status, 500);
    assert.match(f.json.error, /failed/);
    assert.deepEqual(Object.keys(f.json).sort(), ["error", "ok"], "today's error shape");
    assert.equal(ok.status, 200);
    const r = await c.resources();
    assert.equal(r.transcriptionQueue.counts.admitted, r.transcriptionQueue.counts.completed, "every turn released exactly once");
    await assertDrained(c);
  });
});

test("server, on: files are private and generated (no client file name); the logical-CPU cap still applies", async () => {
  await withServer(ON, async (c) => {
    c.hold();
    const r = upload(c.srv.port, wav("T"), { query: "&threads=999&filename=..%2F..%2Fescape.wav" }).promise;
    await waitFor(() => c.started().length === 1, 10000, "running");
    const files = c.uploads();
    assert.equal(files.length, 1);
    assert.match(files[0], /^[0-9a-f]{16}-\d+-[0-9a-f]{16}\.wav$/, "generated name");
    if (!IS_WIN) assert.equal(fs.statSync(path.join(c.root, "app", "cache", "speech-uploads", files[0])).mode & 0o777, 0o600);
    const job = c.jobs()[0];
    assert.equal(fs.realpathSync(path.dirname(job.f)), fs.realpathSync(path.join(c.root, "app", "cache", "speech-uploads")), "inside the upload folder (real paths: macOS temp is a link)");
    assert.ok(job.t >= 1 && job.t <= os.cpus().length, `-t ${job.t} is capped at ${os.cpus().length} logical CPUs`);
    c.release();
    assert.equal((await r).status, 200);
    await assertDrained(c);
  });
});

test("server, on: server memory stays flat while 4 large uploads wait (today: about 2x each body)", { skip: process.platform !== "linux" && "RSS read from /proc" }, async () => {
  await withServer(ON, async (c) => {
    const rss = () => Math.round(Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${c.srv.proc.pid}/status`, "utf8"))[1]) / 1024);
    c.hold();
    const h = upload(c.srv.port, wav("H")).promise;
    await waitFor(() => c.started().length === 1, 10000, "running");
    const before = rss();
    const big = wav("BIG", 64 * MiB);
    const ws = [1, 2, 3, 4].map(() => upload(c.srv.port, big).promise);
    await waitFor(async () => { const r = await c.resources(); return r.engines.speech.queue.waiting === 4 && r.engines.speech.queue.uploading === 0; }, 60000, "all 4 uploaded and waiting");
    const grew = rss() - before;
    assert.ok(grew < 64, `server RSS grew ${grew} MB for 256 MB of waiting uploads`);
    c.release();
    const rs = await Promise.all([h, ...ws]);
    assert.deepEqual(rs.map((x) => x.status), [200, 200, 200, 200, 200]);
    await assertDrained(c);
  });
});

// ── The service on a real HTTP server: limits a test server can't reach ───────
async function withService(opts, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usap-tq-svc-"));
  const setting = { limit: 4, maxWaitMs: 600000, budgetBytes: 64 * MiB, uploadIdleMs: 5000, uploadMaxMs: 240000, ...opts.setting };
  let holdResolve = null;
  const runs = [];
  const speech = {
    runExclusiveSpeechOperation: (f) => f(),
    transcribeWavFile: async (file) => { runs.push(path.basename(file)); if (opts.hold) await new Promise((r) => { holdResolve = r; }); return { text: "ok" }; },
    getSettings: () => ({}), setError: () => {}, getError: () => "error",
  };
  const json = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  // The service's own timers, counted so a test can check that every one was cleared or fired (exactly-once settling).
  const pending = new Set();
  const setTimer = (f, ms) => { const t = setTimeout(() => { pending.delete(t); f(); }, ms); pending.add(t); return t; };
  const clearTimer = (t) => { pending.delete(t); clearTimeout(t); };
  const q = createTranscriptionQueue({ setting, dir, speech, json, statfs: opts.statfs, maxUploadBytes: opts.maxUploadBytes, setTimer, clearTimer });
  const srv = http.createServer((req, res) => q.handle(req, res, {}));
  const conns = []; // server side, per connection: body+header bytes read and when the server saw it close
  srv.on("connection", (sock) => { const c = { t0: Date.now(), bytesRead: 0, closedMs: null }; conns.push(c); sock.on("close", () => { c.bytesRead = sock.bytesRead; c.closedMs = Date.now() - c.t0; }); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try { return await fn({ port: srv.address().port, q, dir, runs, conns, pendingTimers: () => pending.size, releaseHold: () => holdResolve && holdResolve() }); }
  finally { srv.closeAllConnections(); srv.close(); for (const t of pending) clearTimeout(t); fs.rmSync(dir, { recursive: true, force: true }); }
}

/**
 * A raw-socket client for refusal tests: sends the request head, then `steps` ({ data } or { waitMs }), then `tail`:
 * "fast" (64 KiB writes as fast as the socket takes them), "drip" (1 byte every `dripMs`) or "silent". `chunked` frames
 * every write. It never stops by itself before `timeoutMs` (the client-side bound), so the server must end it.
 * Resolves { status, json, closedMs, answerMs, sent, error }: `status` 0 means no complete answer arrived.
 */
function rawUpload(port, { claim = null, chunked = claim === null, steps = [], tail = "silent", dripMs = 200, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect(port, "127.0.0.1");
    let raw = Buffer.alloc(0); let sent = 0; let error = null; let answerMs = null; let closed = false;
    const frame = (b) => (chunked ? Buffer.concat([Buffer.from(`${b.length.toString(16)}\r\n`), b, Buffer.from("\r\n")]) : b);
    const send = (b) => { if (closed || sock.destroyed) return false; sent += b.length; return sock.write(frame(b)); };
    const limit = setTimeout(() => sock.destroy(), timeoutMs);
    sock.on("data", (d) => { raw = Buffer.concat([raw, d]); if (answerMs === null && raw.includes("\r\n\r\n")) answerMs = Date.now() - t0; });
    sock.on("error", (e) => { error = e.code || e.message; });
    sock.on("close", () => {
      closed = true; clearTimeout(limit);
      const text = raw.toString("latin1"); const cut = text.indexOf("\r\n\r\n");
      const m = /^HTTP\/1\.1 (\d{3})/.exec(text); const len = /content-length: (\d+)/i.exec(text.slice(0, cut));
      const bodyText = cut >= 0 ? text.slice(cut + 4) : "";
      let json = null; try { json = JSON.parse(bodyText); } catch (_) { /* incomplete */ }
      const complete = m && len && Buffer.byteLength(bodyText, "latin1") >= Number(len[1]);
      resolve({ status: complete ? Number(m[1]) : 0, json, closedMs: Date.now() - t0, answerMs, sent, error });
    });
    sock.on("connect", async () => {
      const head = ["POST /api/speech/transcribe HTTP/1.1", "Host: 127.0.0.1", "Content-Type: audio/wav", claim === null ? "Transfer-Encoding: chunked" : `Content-Length: ${claim}`];
      sock.write(`${head.join("\r\n")}\r\n\r\n`);
      for (const st of steps) { if (st.waitMs) await sleep(st.waitMs); else send(st.data); }
      if (tail === "fast") {
        const filler = Buffer.alloc(64 * 1024, 7);
        const pump = () => { while (!closed && !sock.destroyed) { if (!send(filler)) return sock.once("drain", pump); } };
        pump();
      } else if (tail === "drip") {
        const one = Buffer.from([7]);
        const tick = () => { if (!closed && !sock.destroyed) { send(one); setTimeout(tick, dripMs); } };
        tick();
      }
    });
  });
}
const riffHead = () => wav("R", 0).subarray(0, 44); // a valid 44-byte WAV header (no data yet)

// Sends the whole body even after an early answer; resolves { status, json, sentAll, socketError }.
function sendAll(port, body) {
  return new Promise((resolve) => {
    let answer = null; let socketError = null; let sentAll = false;
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/speech/transcribe", agent: false, headers: { "Content-Type": "audio/wav", "Content-Length": body.length } }, (res) => {
      let t = ""; res.on("data", (c) => { t += c; }); res.on("end", () => { answer = { status: res.statusCode, json: JSON.parse(t) }; });
    });
    req.on("error", (e) => { socketError = e.code || e.message; });
    req.on("close", () => setTimeout(() => resolve({ ...(answer || { status: 0 }), sentAll, socketError }), 50));
    req.end(body, () => { sentAll = true; });
  });
}

test("service: an early refusal reads the rest of the body, so the connection ends normally (no reset) after the answer", async () => {
  await withService({ setting: { budgetBytes: 64 * MiB } }, async (s) => {
    const r = await sendAll(s.port, wav("big", 120 * MiB));
    assert.equal(r.status, 507);
    assert.equal(r.json.code, "INSUFFICIENT_STORAGE");
    assert.equal(r.socketError, null, "the client could send its whole body: the server didn't reset the connection");
    assert.equal(r.sentAll, true);
    assert.deepEqual(s.runs, []);
    assert.equal(fs.readdirSync(s.dir).length, 0, "nothing was written");
  });
});

test("service: an upload over the ceiling while streaming (no Content-Length) gets 413; nothing is left", async () => {
  await withService({ maxUploadBytes: 1 * MiB }, async (s) => {
    // Two parts of 1 MiB + 1 byte, 300 ms apart: the limit is crossed by the last byte of the first part, so no data is
    // in flight when the server closes the connection after its answer (the ceiling is spent: nothing is discarded).
    const r = await upload(s.port, wav("C", 2 * MiB + 2 - 44), { claim: null, parts: 2, gapMs: 300 }).promise;
    assert.equal(r.status, 413);
    assert.equal(r.json.code, "UPLOAD_TOO_LARGE");
    assert.deepEqual(s.runs, []);
    await waitFor(() => s.q.storage().reservedBytes === 0 && fs.readdirSync(s.dir).length === 0 && s.pendingTimers() === 0, 5000, "released");
    await waitFor(() => s.conns.length === 1 && s.conns[0].closedMs !== null, 5000, "connection closed");
    assert.ok(s.conns[0].bytesRead < 1 * MiB + 64 * 1024, `the second part was never read (${s.conns[0].bytesRead} bytes)`);
  });
});

// ── One account per request: a refusal never opens a new byte budget or deadline ──
// Each of these failed on the first implementation, which gave the discarding after a refusal a fresh ceiling, a
// fresh whole-upload deadline and a fresh inactivity period.
async function assertSettled(s) {
  await waitFor(() => s.conns.length >= 1 && s.conns.every((c) => c.closedMs !== null), 10000, "the server closed the connection");
  await waitFor(() => s.q.storage().reservedBytes === 0 && fs.readdirSync(s.dir).length === 0 && s.pendingTimers() === 0, 5000, "files, reservations and timers released");
  const st = s.q.stats();
  assert.deepEqual([st.running, st.waiting, st.uploading], [0, 0, 0], "no job left in the queue");
}

test("service: bytes count once per request: a refusal after part of the upload discards only up to the same ceiling", async () => {
  // 64 MiB budget: the first 64 MiB are booked, growth is refused (507) after 64 MiB; ceiling 96 MiB for the request.
  await withService({ maxUploadBytes: 96 * MiB, setting: { budgetBytes: 64 * MiB } }, async (s) => {
    const r = await rawUpload(s.port, { steps: [{ data: riffHead() }], tail: "fast" });
    await assertSettled(s);
    const read = s.conns[0].bytesRead;
    assert.ok(read <= 96 * MiB + 4 * MiB, `server read ${(read / MiB).toFixed(1)} MiB in all (ceiling 96 MiB, not 64 + 96)`);
    assert.ok(r.status === 507 || r.status === 0, `507, or a reset after it (client still sending): ${r.status} ${r.error}`);
    assert.equal(s.q.counts().insufficientStorage, 1, "the server refused it for storage (not a crash)");
    assert.deepEqual(s.runs, []);
  });
});

test("service: one absolute deadline from arrival covers the upload and any discarding after a refusal", async () => {
  await withService({ setting: { uploadIdleMs: 1500, uploadMaxMs: 2000 } }, async (s) => {
    // "RIFF" + 2 bytes, 1 s later 6 bytes that aren't "WAVE": refused at about 1 s; then 1 byte every 200 ms.
    const r = await rawUpload(s.port, { steps: [{ data: Buffer.from("RIFF\0\0") }, { waitMs: 1000 }, { data: Buffer.from("\0\0NOPE") }], tail: "drip" });
    assert.equal(r.status, 500);
    assert.equal(r.json.error, "Speech transcription currently accepts WAV audio only.");
    await assertSettled(s);
    assert.ok(s.conns[0].closedMs < 2700, `closed ${s.conns[0].closedMs} ms after arrival (deadline 2000 ms from arrival, not from the refusal)`);
    assert.deepEqual(s.runs, []);
  });
});

test("service: inactivity counts from the last byte received; a refusal for silence closes at once", async () => {
  await withService({ setting: { uploadIdleMs: 1000, uploadMaxMs: 20000 } }, async (s) => {
    const r = await rawUpload(s.port, { claim: 1 * MiB, steps: [{ data: riffHead() }], tail: "silent" });
    assert.equal(r.status, 408);
    assert.deepEqual([r.json.code, r.json.phase], ["UPLOAD_TIMEOUT", "idle"]);
    await assertSettled(s);
    assert.ok(s.conns[0].closedMs < 1700, `closed ${s.conns[0].closedMs} ms after arrival (idle 1000 ms, not twice)`);
  });
});

test("service: a declared size over the ceiling is answered and closed; its body is not discarded", async () => {
  await withService({ maxUploadBytes: 16 * MiB }, async (s) => {
    const r = await rawUpload(s.port, { claim: 100 * 1024 * MiB, tail: "fast" });
    await assertSettled(s);
    assert.ok(r.status === 413 || r.status === 0, `413, or a reset after it: ${r.status} ${r.error}`);
    assert.ok(s.conns[0].bytesRead < 4 * MiB, `server read ${(s.conns[0].bytesRead / MiB).toFixed(2)} MiB of a 100 GiB claim`);
    assert.equal(s.q.counts().tooLarge, 1);
    assert.deepEqual(s.runs, []);
  });
});

test("service: an early refusal (429) of a chunked body that never ends stops at the ceiling; the queue is untouched", async () => {
  await withService({ maxUploadBytes: 16 * MiB, hold: true, setting: { limit: 1 } }, async (s) => {
    const a = upload(s.port, wav("A")).promise;
    await waitFor(() => s.runs.length === 1, 5000, "A running");
    const b = upload(s.port, wav("B")).promise;
    await waitFor(() => s.q.stats().waiting === 1, 5000, "B waiting");
    const r = await rawUpload(s.port, { steps: [{ data: riffHead() }], tail: "fast" });
    assert.ok(r.status === 429 || r.status === 0, `429, or a reset after it: ${r.status} ${r.error}`);
    await waitFor(() => s.conns[2].closedMs !== null, 5000, "closed");
    assert.ok(s.conns[2].bytesRead <= 16 * MiB + 4 * MiB, `read ${(s.conns[2].bytesRead / MiB).toFixed(1)} MiB`);
    assert.deepEqual([s.q.stats().running, s.q.stats().waiting], [1, 1], "the refusal took no place in the queue");
    s.releaseHold(); await waitFor(() => s.runs.length === 2, 5000, "B running"); s.releaseHold();
    assert.deepEqual((await Promise.all([a, b])).map((x) => x.status), [200, 200]);
    await assertSettled(s);
  });
});

test("service: an upload without Content-Length grows its reservation in steps; when growth is refused it gets 507", async () => {
  await withService({ maxUploadBytes: 512 * MiB, setting: { budgetBytes: 100 * MiB } }, async (s) => {
    const ok = await upload(s.port, wav("small", 2 * MiB), { claim: null, parts: 4 }).promise;
    assert.equal(ok.status, 200, "fits in the first 64 MiB step");
    const big = await upload(s.port, wav("big", 120 * MiB), { claim: null, parts: 60 }).promise;
    assert.equal(big.status, 507, "the second 64 MiB step doesn't fit the 100 MiB budget");
    assert.equal(big.json.code, "INSUFFICIENT_STORAGE");
    await waitFor(() => s.q.storage().reservedBytes === 0 && fs.readdirSync(s.dir).length === 0, 5000, "released");
  });
});

test("service: low free disk space gets 507 before the body is read, whatever the budget", async () => {
  const lowDisk = () => ({ bavail: 260, bsize: MiB, blocks: 1024 * 1024 }); // 260 MiB free, 256 MiB margin
  await withService({ statfs: lowDisk, setting: { budgetBytes: 2048 * MiB } }, async (s) => {
    const r = await upload(s.port, wav("D", 10 * MiB)).promise;
    assert.equal(r.status, 507);
    assert.equal(r.json.code, "INSUFFICIENT_STORAGE");
    assert.equal(r.headers["retry-after"], undefined, "disk, not budget: no Retry-After");
    assert.ok(r.ms < 3000);
    const small = await upload(s.port, wav("d", 1 * MiB)).promise;
    assert.equal(small.status, 200, "an upload that fits the remaining space is accepted");
  });
});

test("service: the whole-upload deadline ends a slow upload (408, phase total) and releases everything", async () => {
  // At the deadline the budget is spent, so the server answers and closes at once (STEP9_9F_WHISPER_QUEUE.md §13.2).
  // A part arriving at that moment can make the client see a reset instead of the answer (Windows did, with parts
  // 200 ms apart and a 600 ms deadline), so parts go out at 0, 400 and 800 ms: the deadline falls 200 ms from either.
  await withService({ setting: { uploadIdleMs: 5000, uploadMaxMs: 600 } }, async (s) => {
    const r = await upload(s.port, wav("slow", 100000), { parts: 10, gapMs: 400 }).promise;
    assert.equal(r.status, 408);
    assert.deepEqual([r.json.code, r.json.phase], ["UPLOAD_TIMEOUT", "total"]);
    assert.deepEqual(s.runs, []);
    await assertSettled(s);
    assert.ok(s.conns[0].closedMs < 1100, `the server closed the connection ${s.conns[0].closedMs} ms after arrival (deadline 600 ms)`);
  });
});

test("service: the running job keeps its file and reservation until the transcription settles; then both go", async () => {
  await withService({ hold: true }, async (s) => {
    const r = upload(s.port, wav("H", 1 * MiB)).promise;
    await waitFor(() => s.runs.length === 1, 5000, "running");
    assert.equal(fs.readdirSync(s.dir).length, 1);
    assert.ok(s.q.storage().reservedBytes >= 1 * MiB);
    s.releaseHold();
    assert.equal((await r).status, 200);
    await waitFor(() => s.q.storage().reservedBytes === 0 && fs.readdirSync(s.dir).length === 0, 5000, "released");
  });
});

test("service: cleanupSync deletes this instance's files (process exit)", async () => {
  await withService({ hold: true }, async (s) => {
    const r = upload(s.port, wav("H", 1 * MiB)).promise;
    await waitFor(() => s.runs.length === 1, 5000, "running");
    assert.equal(fs.readdirSync(s.dir).length, 1);
    s.q.cleanupSync();
    assert.equal(fs.readdirSync(s.dir).length, 0);
    assert.equal(s.q.storage().reservedBytes, 0);
    s.releaseHold();
    await r;
  });
});
