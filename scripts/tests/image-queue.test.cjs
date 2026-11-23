"use strict";
// Step 9.9f-3 image-generation queue (docs/roadmap/STEP9_9F_IMAGE_QUEUE.md; services/image-queue.cjs).
// Part 1: the setting. Part 2: the queue itself, in process, against a controllable fake upstream (an HTTP server the
// test holds, answers or breaks) and a fake engine state (slot owner, phase, epoch, process). Part 3: the real server
// with the fake sd-server: off by default and unchanged, refused without engineSlot, USAP_SCHEDULER=off, and on.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { imageQueueSetting, createImageQueue, isQueuedRoute, MIN_RETRY_AFTER_SECONDS } = require("../server/services/image-queue.cjs");
const { withoutCorsHeaders } = require("../server/request-policy.cjs");
const { withoutAuthHeaders } = require("../server/lan-auth.cjs");

const MiB = 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A client answer within `ms`, or { timedOut: true } (a request wrongly forwarded to the held fake engine never ends).
const within = (p, ms = 5000) => Promise.race([p, sleep(ms).then(() => ({ timedOut: true }))]);
async function waitFor(fn, ms = 10000, label = "condition") {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(20);
  }
}

// ── Part 1: setting ──────────────────────────────────────────────────────────────────────────────────────────────
test("setting: off by default; on needs engineSlot on; USAP_SCHEDULER=off forces it off; values in range or ignored", () => {
  const d = imageQueueSetting({ env: {}, engineSlotMode: "on" });
  assert.equal(d.mode, "off"); assert.equal(d.requested, "off"); assert.equal(d.forcedOffBy, null);
  assert.equal(d.limit, 2); assert.equal(d.maxWaitMs, 10 * 60 * 1000); assert.equal(d.bodyBytes, 64 * MiB); assert.equal(d.bodyBudgetBytes, 128 * MiB);
  const on = imageQueueSetting({ env: { USAP_IMAGE_QUEUE: "on" }, engineSlotMode: "on" });
  assert.equal(on.mode, "on");
  const noSlot = imageQueueSetting({ env: { USAP_IMAGE_QUEUE: "on" }, engineSlotMode: "off" });
  assert.equal(noSlot.mode, "off"); assert.equal(noSlot.requested, "on"); assert.equal(noSlot.forcedOffBy, "engine-slot-off");
  const schedOff = imageQueueSetting({ env: { USAP_IMAGE_QUEUE: "on" }, schedulerMode: "off", engineSlotMode: "off" });
  assert.equal(schedOff.mode, "off"); assert.equal(schedOff.forcedOffBy, "scheduler-off");
  const bad = imageQueueSetting({ env: { USAP_IMAGE_QUEUE: "on", USAP_IMAGE_QUEUE_LIMIT: "3", USAP_IMAGE_QUEUE_BODY_BYTES: String(65 * MiB), USAP_IMAGE_QUEUE_MAX_WAIT_MS: String(61 * 60 * 1000) }, engineSlotMode: "on" });
  assert.equal(bad.limit, 2); assert.equal(bad.bodyBytes, 64 * MiB); assert.equal(bad.maxWaitMs, 10 * 60 * 1000);
  assert.deepEqual(bad.ignored.map((x) => x.name).sort(), ["USAP_IMAGE_QUEUE_BODY_BYTES", "USAP_IMAGE_QUEUE_LIMIT", "USAP_IMAGE_QUEUE_MAX_WAIT_MS"]);
  const budget = imageQueueSetting({ env: { USAP_IMAGE_QUEUE_BODY_BYTES: String(32 * MiB), USAP_IMAGE_QUEUE_BODY_BUDGET_BYTES: String(16 * MiB) }, engineSlotMode: "on" });
  assert.equal(budget.bodyBudgetBytes, 128 * MiB, "a budget below the per-request ceiling is ignored");
  assert.ok(budget.ignored.some((x) => x.name === "imageQueueBodyBudgetBytes"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usap-iq-"));
  try {
    fs.writeFileSync(path.join(dir, "scheduler.json"), JSON.stringify({ imageQueue: "on", imageQueueLimit: 1 }));
    const f = imageQueueSetting({ env: {}, configDir: dir, engineSlotMode: "on" });
    assert.equal(f.mode, "on"); assert.equal(f.limit, 1);
    assert.equal(imageQueueSetting({ env: { USAP_IMAGE_QUEUE: "off" }, configDir: dir, engineSlotMode: "on" }).mode, "off", "the environment wins");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("routes: exactly the four synchronous generation routes are queued (query allowed); every GET and other POST is not", () => {
  for (const u of ["/sdapi/v1/txt2img", "/sdapi/v1/img2img", "/v1/images/generations", "/v1/images/edits", "/sdapi/v1/txt2img?x=1"]) assert.equal(isQueuedRoute({ method: "POST", url: u }), true, u);
  for (const [m, u] of [["GET", "/sdapi/v1/txt2img"], ["GET", "/v1/models"], ["POST", "/sdapi/v1/options"], ["POST", "/v1/images/variations"], ["POST", "/sdapi/v1/txt2imgx"], ["POST", "/sdcpp/v1/img_gen"], ["POST", "/sdapi/v1/txt2img/x"]]) {
    assert.equal(isQueuedRoute({ method: m, url: u }), false, `${m} ${u}`);
  }
});

// ── Part 2: the queue in process ─────────────────────────────────────────────────────────────────────────────────
// A fake upstream (sd-server stand-in) that records each request with its full body and holds the answer until the
// test calls answer(i) or breaks it.
function fakeUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rec = { url: req.url, headers: req.headers, body: Buffer.concat(chunks), res, answeredAt: null };
      seen.push(rec);
    });
  });
  return {
    seen, server,
    answer(i, status = 200, payload = { images: ["x"] }) { const r = seen[i]; r.answeredAt = Date.now(); r.res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); r.res.end(JSON.stringify(payload)); },
    breakIt(i) { seen[i].res.socket.destroy(); },
    listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))),
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
function fakeProc() { const p = new EventEmitter(); p.exitCode = null; p.signalCode = null; p.exit = (code = 0) => { p.exitCode = code; p.emit("exit", code, null); }; return p; }

async function harness({ limit = 2, maxWaitMs = 60000, bodyBytes = 1 * MiB, bodyBudgetBytes = 2 * MiB, uploadMaxMs = 5000, uploadIdleMs = 2000 } = {}) {
  const up = fakeUpstream();
  const port = await up.listen();
  const eng = { slotOwner: "image", slotPhase: "loaded", epoch: 1, proc: fakeProc(), ready: true, port, backend: "sd-server" };
  let tracked = 0;
  const passed = [];
  const q = createImageQueue({
    setting: { mode: "on", limit, maxWaitMs, bodyBytes, bodyBudgetBytes },
    engine: { snapshot: () => ({ ...eng }), trackGeneration: () => { tracked += 1; } },
    json: (res, status, body) => { const t = JSON.stringify(body); res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(t) }); res.end(t); },
    withoutAuthHeaders, withoutCorsHeaders, uploadMaxMs, uploadIdleMs, log: { warn() {}, log() {} },
  });
  const studio = http.createServer((req, res) => {
    if (isQueuedRoute(req)) return q.handle(req, res, (rq, rs) => { passed.push(rq.url); rs.writeHead(299); rs.end("passthrough"); });
    res.writeHead(404); res.end();
  });
  const sport = await new Promise((r) => studio.listen(0, "127.0.0.1", () => r(studio.address().port)));
  // A client: sends `body` (Buffer) with Content-Length unless chunked; resolves { status, headers, json, text }.
  const clients = [];
  const keepAlive = new http.Agent({ keepAlive: true, maxSockets: 64 });
  function send({ url = "/sdapi/v1/txt2img", body = Buffer.from(JSON.stringify({ prompt: "p" })), chunked = false, declared, headers = {}, hold = false, reuse = false } = {}) {
    const h = { "Content-Type": "application/json", Authorization: "Bearer secret", Cookie: "s=1", ...headers };
    if (!chunked) h["Content-Length"] = String(declared !== undefined ? declared : body.length);
    else h["Transfer-Encoding"] = "chunked"; // explicit: Node would otherwise add Content-Length for a body passed to end()
    const req = http.request({ host: "127.0.0.1", port: sport, method: "POST", path: url, headers: h, agent: reuse ? keepAlive : false });
    const done = new Promise((resolve) => {
      req.on("response", (res) => { let t = ""; res.on("data", (c) => { t += c; }); res.on("end", () => { let j; try { j = JSON.parse(t); } catch (_) { j = undefined; } resolve({ status: res.statusCode, headers: res.headers, json: j, text: t }); }); res.on("error", () => resolve({ status: res.statusCode, error: "res" })); });
      req.on("error", (e) => resolve({ error: e.code || e.message }));
    });
    if (!hold) req.end(body); else req.write(body.subarray(0, Math.min(body.length, 10)));
    const c = { req, done, abort: () => req.destroy() };
    clients.push(c);
    return c;
  }
  return {
    q, up, eng, send, passed, tracked: () => tracked, sport,
    async close() { keepAlive.destroy(); for (const c of clients) c.req.destroy(); studio.closeAllConnections(); await new Promise((r) => studio.close(() => r())); await up.close(); },
  };
}

test("queue: one forwarded at a time, FIFO, limit + 1 refused with 429 QUEUE_FULL, Retry-After >= 30 s, detail starts 'Generation failed:'", async () => {
  const h = await harness();
  try {
    const a = h.send({ body: Buffer.from('{"prompt":"a"}') });
    await waitFor(() => h.up.seen.length === 1, 5000, "first forwarded");
    const b = h.send({ body: Buffer.from('{"prompt":"b"}') });
    await waitFor(() => h.q.stats().waiting === 1);
    const c = h.send({ body: Buffer.from('{"prompt":"c"}') });
    await waitFor(() => h.q.stats().waiting === 2);
    const d = await h.send({ body: Buffer.from('{"prompt":"d"}') }).done;
    assert.equal(d.status, 429); assert.equal(d.json.code, "QUEUE_FULL"); assert.match(d.json.detail, /^Generation failed: /);
    assert.ok(Number(d.headers["retry-after"]) >= MIN_RETRY_AFTER_SECONDS);
    assert.equal(h.up.seen.length, 1, "never two forwarded");
    h.up.answer(0);
    assert.equal((await a.done).status, 200);
    await waitFor(() => h.up.seen.length === 2);
    assert.equal(h.up.seen[1].body.toString(), '{"prompt":"b"}', "FIFO: b before c");
    h.up.answer(1); await b.done;
    await waitFor(() => h.up.seen.length === 3);
    assert.equal(h.up.seen[2].body.toString(), '{"prompt":"c"}');
    h.up.answer(2); await c.done;
    assert.deepEqual(h.q.memory(), { bodyBytes: 1 * MiB, budgetBytes: 2 * MiB, reservedBytes: 0, heldJobs: 0 }, "every body and reservation released");
    assert.equal(h.tracked(), 3, "the 9.9e generation count sees each forwarded job");
    // Credentials stay in the studio; the body is forwarded byte for byte.
    assert.equal(h.up.seen[0].headers.authorization, undefined); assert.equal(h.up.seen[0].headers.cookie, undefined);
  } finally { await h.close(); }
});

test("queue: the engine's answer is passed through byte for byte (status, body), without CORS headers", async () => {
  const h = await harness();
  try {
    const a = h.send();
    await waitFor(() => h.up.seen.length === 1);
    h.up.answer(0, 418, { odd: "answer", n: [1, 2] });
    const r = await a.done;
    assert.equal(r.status, 418); assert.equal(r.text, JSON.stringify({ odd: "answer", n: [1, 2] }));
    assert.equal(r.headers["access-control-allow-origin"], undefined);
  } finally { await h.close(); }
});

test("queue: a client that leaves while waiting is never forwarded, and its body and place go at once", async () => {
  const h = await harness();
  try {
    const a = h.send();
    await waitFor(() => h.up.seen.length === 1);
    const b = h.send({ body: Buffer.from('{"prompt":"leaves"}') });
    const c = h.send({ body: Buffer.from('{"prompt":"stays"}') });
    await waitFor(() => h.q.stats().waiting === 2);
    b.abort();
    await waitFor(() => h.q.stats().waiting === 1, 5000, "left the queue");
    h.up.answer(0); await a.done;
    await waitFor(() => h.up.seen.length === 2);
    assert.equal(h.up.seen[1].body.toString(), '{"prompt":"stays"}', "the job that left was never sent");
    h.up.answer(1); await c.done;
    await sleep(100);
    assert.equal(h.up.seen.length, 2);
    assert.equal(h.q.memory().reservedBytes, 0); assert.equal(h.q.memory().heldJobs, 0);
    assert.equal(h.q.counts().leftWhileWaiting, 1);
  } finally { await h.close(); }
});

test("queue: a client that leaves while its job runs never releases the engine early; the answer is discarded; the next job waits for the engine's real end", async () => {
  const h = await harness();
  try {
    const a = h.send();
    await waitFor(() => h.up.seen.length === 1);
    const b = h.send({ body: Buffer.from('{"prompt":"next"}') });
    await waitFor(() => h.q.stats().waiting === 1);
    a.abort();
    await waitFor(() => h.q.stats().abandoned === true, 5000, "shown as abandoned");
    await sleep(300);
    assert.equal(h.up.seen.length, 1, "premature release would forward the next job now");
    assert.equal(h.q.stats().running, 1);
    assert.ok(h.q.stats().runningSeconds >= 0);
    h.up.answer(0); // the engine finishes the abandoned job
    await waitFor(() => h.up.seen.length === 2, 5000, "next forwarded only after the engine's end");
    h.up.answer(1);
    assert.equal((await b.done).status, 200);
    assert.equal(h.q.counts().leftWhileRunning, 1);
  } finally { await h.close(); }
});

test("queue: a stalled engine keeps the running place (no timer frees it); its process exit releases it", async () => {
  const h = await harness({ maxWaitMs: 60000 });
  try {
    const a = h.send();
    await waitFor(() => h.up.seen.length === 1);
    const b = h.send();
    await waitFor(() => h.q.stats().waiting === 1);
    await sleep(600);
    assert.equal(h.up.seen.length, 1); assert.equal(h.q.stats().running, 1);
    h.eng.ready = false; h.eng.slotPhase = "unloading";
    h.eng.proc.exit(1); // supervision saw the engine exit
    await waitFor(() => h.q.stats().running === 0 || h.up.seen.length > 1, 5000, "released on exit");
    const rb = await b.done;
    assert.equal(rb.status, 503); assert.equal(rb.json.code, "ENGINE_NOT_READY", "the waiting job is not sent to a gone engine");
    const ra = await a.done;
    assert.ok(ra.error || ra.status >= 500, "the running job's client gets an error, not a hang");
    assert.equal(h.up.seen.length, 1);
    assert.equal(h.q.counts().engineExited, 1);
    assert.equal(h.q.memory().heldJobs, 0);
  } finally { await h.close(); }
});

test("queue: an engine failure (connection lost mid-job) answers the client, releases once, and the next job runs", async () => {
  const h = await harness();
  try {
    const a = h.send();
    await waitFor(() => h.up.seen.length === 1);
    const b = h.send();
    await waitFor(() => h.q.stats().waiting === 1);
    h.up.breakIt(0);
    const ra = await a.done;
    assert.equal(ra.status, 502); assert.match(ra.json.error, /Image backend is not reachable/);
    await waitFor(() => h.up.seen.length === 2);
    h.up.answer(1);
    assert.equal((await b.done).status, 200);
    assert.equal(h.q.counts().upstreamFailed, 1);
    assert.equal(h.q.stats().running, 0);
  } finally { await h.close(); }
});

test("queue: a waiting job times out with 503 QUEUE_TIMEOUT; the running job is untouched", async () => {
  const h = await harness({ maxWaitMs: 400 });
  try {
    const a = h.send();
    await waitFor(() => h.up.seen.length === 1);
    const b = await h.send().done;
    assert.equal(b.status, 503); assert.equal(b.json.code, "QUEUE_TIMEOUT"); assert.match(b.json.detail, /^Generation failed: /);
    assert.ok(Number(b.headers["retry-after"]) >= MIN_RETRY_AFTER_SECONDS);
    assert.equal(h.q.stats().running, 1);
    h.up.answer(0);
    assert.equal((await a.done).status, 200);
    assert.equal(h.up.seen.length, 1);
    assert.equal(h.q.memory().heldJobs, 0);
  } finally { await h.close(); }
});

test("queue: not ready at admission (starting, loading, unloading, other owner) → 503 ENGINE_NOT_READY before any body byte", async () => {
  const h = await harness();
  try {
    for (const change of [{ ready: false }, { slotPhase: "loading" }, { slotPhase: "unloading" }, { slotOwner: "text" }, { slotOwner: null, slotPhase: "idle" }, { proc: null }]) {
      const saved = { ...h.eng };
      Object.assign(h.eng, change);
      const r = await h.send({ body: Buffer.alloc(200 * 1024, 120), reuse: true }).done; // a keep-alive client
      Object.assign(h.eng, saved);
      assert.equal(r.status, 503, JSON.stringify(change)); assert.equal(r.json.code, "ENGINE_NOT_READY");
      assert.equal(r.headers.connection, "close", "the unread body is not read: the connection closes after the answer");
    }
    assert.equal(h.up.seen.length, 0); assert.equal(h.q.memory().reservedBytes, 0);
    assert.equal(h.q.counts().notReady, 6, "refused at admission, before any body byte");
    assert.equal(h.q.counts().admitted, 0, "nothing was admitted (a later dispatch check is not the admission check)");
  } finally { await h.close(); }
});

test("queue: stale ownership or a different engine at dispatch → 503 ENGINE_NOT_READY, never forwarded to the wrong engine", async () => {
  for (const change of ["epoch", "proc"]) {
    const h = await harness();
    try {
      const a = h.send();
      await waitFor(() => h.up.seen.length === 1);
      const b = h.send({ body: Buffer.from('{"prompt":"admitted for the old engine"}') });
      await waitFor(() => h.q.stats().waiting === 1);
      if (change === "epoch") h.eng.epoch += 1; else h.eng.proc = fakeProc(); // a reload / a different process now owns the slot
      h.up.answer(0); await a.done;
      const rb = await within(b.done);
      assert.ok(!rb.timedOut, `${change}: answered, not forwarded to the wrong engine`);
      assert.equal(rb.status, 503, change); assert.equal(rb.json.code, "ENGINE_NOT_READY");
      assert.equal(h.up.seen.length, 1, `${change}: not forwarded`);
      assert.equal(h.q.counts().refusedAtDispatch, 1);
    } finally { await h.close(); }
  }
});

test("queue: body bounds — declared over the ceiling 413 at once; chunked over the ceiling 413; budget exhausted 429 body-budget; idle and total upload deadlines 408", async () => {
  const h = await harness({ bodyBytes: 256 * 1024, bodyBudgetBytes: 512 * 1024, uploadIdleMs: 300, uploadMaxMs: 1500 });
  try {
    const big = await h.send({ body: Buffer.alloc(10), declared: 300 * 1024, hold: true, reuse: true }).done;
    assert.equal(big.status, 413); assert.equal(big.json.code, "BODY_TOO_LARGE"); assert.equal(big.headers.connection, "close");
    const chunked = await within(h.send({ body: Buffer.alloc(300 * 1024, 97), chunked: true }).done);
    assert.ok(!chunked.timedOut, "a chunked body over the ceiling is refused, not forwarded");
    assert.ok(chunked.status === 413 || chunked.error, `chunked overflow refused (${chunked.status || chunked.error})`);
    if (chunked.status) assert.equal(chunked.json.code, "BODY_TOO_LARGE");
    await sleep(200);
    assert.equal(h.up.seen.length, 0, "a body over the ceiling (counted in actual bytes, not Content-Length) never reaches the engine");
    assert.equal(h.q.counts().tooLarge, 2);
    // Budget: one running job (chunked reserves the whole ceiling) and one held → a third chunked request can't reserve.
    const a = h.send({ chunked: true });
    await waitFor(() => h.up.seen.length === 1);
    const b = h.send({ chunked: true });
    await waitFor(() => h.q.stats().waiting === 1);
    h.up.answer(0); await a.done; // a's body was released when it was forwarded; b now forwarded
    await waitFor(() => h.up.seen.length === 2);
    const holdA = h.send({ body: Buffer.alloc(200 * 1024), hold: true }); // reserves 200 KiB, uploading (waiting)
    const holdB = h.send({ body: Buffer.alloc(200 * 1024), hold: true }); // reserves 200 KiB → 400 of 512 KiB
    await waitFor(() => h.q.stats().waiting === 2);
    const tooMuch = await h.send({ body: Buffer.alloc(200 * 1024) }).done;
    assert.ok(tooMuch.status === 429, `queue full or budget (${tooMuch.status})`);
    // The two held uploads stop sending: idle deadline (300 ms) → 408 (they are waiting; answered when refused).
    const [ra, rb] = await Promise.all([holdA.done, holdB.done]);
    for (const r of [ra, rb]) { assert.equal(r.status, 408, JSON.stringify(r.json)); assert.equal(r.json.code, "UPLOAD_TIMEOUT"); assert.equal(r.json.phase, "idle"); }
    h.up.answer(1); await b.done;
    await waitFor(() => h.q.memory().reservedBytes === 0, 3000, "all reservations released");
    assert.equal(h.q.memory().heldJobs, 0);
    // Total deadline: a slow drip that never pauses long enough for the idle limit.
    const drip = h.send({ body: Buffer.alloc(1000), declared: 100000, hold: true });
    const t = setInterval(() => { try { drip.req.write(Buffer.alloc(10)); } catch (_) { /* closed */ } }, 100);
    const rd = await drip.done; clearInterval(t);
    assert.equal(rd.status, 408); assert.equal(rd.json.phase, "total");
    assert.equal(h.up.seen.length, 2, "nothing over a bound was ever forwarded");
    for (const r of h.up.seen) assert.ok(r.body.length <= 256 * 1024, `forwarded body ${r.body.length} bytes is within the ceiling`);
  } finally { await h.close(); }
});

test("queue: body budget — the aggregate reservation never exceeds the budget; a request that would cross it is refused 429 body-budget before admission; one that exactly fits is admitted", async () => {
  const KiB = 1024;
  const budget = 300 * KiB;
  // Upload deadlines longer than this test, so the held upload keeps its reservation for the whole check.
  const h = await harness({ bodyBytes: 256 * KiB, bodyBudgetBytes: budget, uploadIdleMs: 20000, uploadMaxMs: 30000 });
  let peak = 0;
  const sampler = setInterval(() => { peak = Math.max(peak, h.q.memory().reservedBytes); }, 2);
  try {
    const a = h.send({ body: Buffer.alloc(10), declared: 250 * KiB, hold: true }); // reserves 250 KiB, keeps uploading
    await waitFor(() => h.q.memory().reservedBytes === 250 * KiB);
    const before = { ...h.q.stats() };
    // 250 + 100 > 300: must be refused at admission. A missing budget check admits it instead: it then waits behind the
    // held upload and never answers, so the answer is bounded here and the invariant is checked first, by name.
    const over = await within(h.send({ body: Buffer.alloc(100 * KiB) }).done, 3000);
    const m = h.q.memory();
    peak = Math.max(peak, m.reservedBytes);
    assert.ok(peak <= budget, `body budget: peak reservation ${peak} bytes must stay within the ${budget}-byte budget`);
    assert.equal(m.reservedBytes, 250 * KiB, "body budget: the refused request reserved nothing");
    assert.equal(m.heldJobs, 1, "body budget: the refused request holds no body");
    assert.deepEqual({ running: h.q.stats().running, waiting: h.q.stats().waiting }, { running: before.running, waiting: before.waiting }, "body budget: the refused request took no queue place");
    assert.ok(!over.timedOut, "body budget: the request over the budget is answered at once, not admitted");
    assert.equal(over.status, 429); assert.equal(over.json.code, "QUEUE_FULL"); assert.equal(over.json.reason, "body-budget");
    assert.ok(Number(over.headers["retry-after"]) >= MIN_RETRY_AFTER_SECONDS);
    assert.equal(h.q.counts().bodyBudget, 1, "body budget: counted once");
    // Boundary: 250 + 50 = 300 fits the budget exactly and is admitted (waits behind the held upload).
    const fit = h.send({ body: Buffer.alloc(10), declared: 50 * KiB, hold: true });
    await waitFor(() => h.q.memory().reservedBytes === budget, 3000, "an exactly fitting request reserved");
    assert.equal(h.q.counts().bodyBudget, 1, "body budget: the exactly fitting request is not refused");
    assert.equal(h.up.seen.length, 0, "nothing forwarded while uploads are incomplete");
    a.abort(); fit.abort();
    await waitFor(() => h.q.memory().reservedBytes === 0, 3000, "released when the clients left");
    assert.equal(h.q.memory().heldJobs, 0);
    assert.ok(peak <= budget, `body budget: peak reservation ${peak} bytes stayed within the budget throughout`);
  } finally { clearInterval(sampler); await h.close(); }
});

test("queue: stop/restart refuse waiting jobs with 503 ENGINE_NOT_READY; the running job is not touched", async () => {
  const h = await harness();
  try {
    const a = h.send();
    await waitFor(() => h.up.seen.length === 1);
    const b = h.send(); const c = h.send();
    await waitFor(() => h.q.stats().waiting === 2);
    assert.equal(h.q.forwardedUnsettled(), true);
    assert.equal(h.q.refuseWaiting("stop"), 2);
    for (const r of await Promise.all([b.done, c.done])) { assert.equal(r.status, 503); assert.equal(r.json.code, "ENGINE_NOT_READY"); }
    assert.equal(h.q.stats().running, 1);
    h.up.answer(0); assert.equal((await a.done).status, 200);
    assert.equal(h.q.forwardedUnsettled(), false);
    assert.equal(h.up.seen.length, 1); assert.equal(h.q.memory().heldJobs, 0);
  } finally { await h.close(); }
});

test("queue: with the Core ML backend (apple-npu) requests pass through to today's proxy and the queue reports inactive", async () => {
  const h = await harness();
  try {
    h.eng.backend = "apple-npu";
    const r = await within(h.send().done);
    assert.ok(!r.timedOut, "passed through, not queued and forwarded");
    assert.equal(r.status, 299); assert.equal(r.text, "passthrough");
    assert.equal(h.q.stats().inactive, "backend");
    assert.equal(h.q.counts().passedThrough, 1);
  } finally { await h.close(); }
});

// ── Part 3: the real server with the fake sd-server ──────────────────────────────────────────────────────────────
const { makeRoot, startServer, stopServer, request, installFakeSdServer, fakeSdDiag } = require("./api-contract/harness.cjs");
const { describeRollbackFailures } = require("./fixtures/rollback-diag.cjs");
const { describeQueueOnObservation } = require("./fixtures/queue-on-diag.cjs");
function writeModel(dir, name) {
  const kv = (key, type, val) => {
    const k = Buffer.from(key); const head = Buffer.alloc(8 + k.length + 4); head.writeBigUInt64LE(BigInt(k.length)); k.copy(head, 8); head.writeUInt32LE(type, 8 + k.length);
    if (type === 8) { const v = Buffer.from(val); const b = Buffer.alloc(8 + v.length); b.writeBigUInt64LE(BigInt(v.length)); v.copy(b, 8); return Buffer.concat([head, b]); }
    const b = Buffer.alloc(4); b.writeUInt32LE(val); return Buffer.concat([head, b]);
  };
  const header = Buffer.alloc(24); header.write("GGUF"); header.writeUInt32LE(3, 4); header.writeBigUInt64LE(0n, 8); header.writeBigUInt64LE(2n, 16);
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.concat([header, kv("general.architecture", 8, "sd1"), kv("general.file_type", 4, 2)]));
  fs.truncateSync(file, 130 * 1024 * 1024);
}
const MODEL = "sd1-slow-generate-q4_0.gguf"; // each txt2img takes 3 s on the fake
const QUIET = "sd1-slow-generate-quiet-generate-q4_0.gguf"; // 3 s, no step lines: the log never says "generating"
async function withServer(env, fn) {
  const root = makeRoot();
  installFakeSdServer(root);
  writeModel(path.join(root, "app", "models"), MODEL);
  writeModel(path.join(root, "app", "models"), QUIET);
  const srv = await startServer(root, env);
  try { await fn(srv); } finally {
    try { await request(srv.port, "POST", "/api/stop-backend", { body: {} }); } catch (_) { /* gone */ }
    stopServer(srv);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* Windows */ }
  }
}
const load = async (srv) => {
  const r = await request(srv.port, "POST", "/api/restart-backend", { body: { model: MODEL, backend_type: "cpu", use_gpu: false, width: 64, height: 64, steps: 4 } });
  assert.equal(r.status, 200, r.text);
  await waitFor(async () => (await request(srv.port, "GET", "/api/backend-status")).json.ready, 30000, "ready");
};
const txt2img = (port, prompt) => new Promise((resolve) => {
  const d = JSON.stringify({ prompt, steps: 4, width: 64, height: 64 });
  const t0 = Date.now();
  const q = http.request({ host: "127.0.0.1", port, method: "POST", path: "/sdapi/v1/txt2img", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(d) }, agent: false }, (r) => {
    let b = ""; r.on("data", (c) => { b += c; }); r.on("end", () => { let j; try { j = JSON.parse(b); } catch (_) { j = undefined; } resolve({ status: r.statusCode, ms: Date.now() - t0, json: j, headers: r.headers }); });
  });
  q.on("error", (e) => resolve({ error: e.code || e.message, ms: Date.now() - t0 }));
  q.end(d);
});
const resources = async (srv) => (await request(srv.port, "GET", "/api/resources")).json;

test("server: off by default — no queue, concurrent generations reach the engine at once as before, /api/resources unchanged", async () => {
  await withServer({ USAP_ENGINE_SLOT: "on" }, async (srv) => {
    await load(srv);
    const rs = await resources(srv);
    assert.equal(rs.limits.imageQueue, undefined); assert.equal(rs.imageQueue, undefined);
    assert.deepEqual(rs.engines.image.queue, { running: null, waiting: null, known: false });
    const t0 = Date.now();
    const all = await Promise.all([0, 1, 2, 3].map((i) => txt2img(srv.port, `p${i}`)));
    for (const r of all) assert.equal(r.status, 200, "no 429 when off");
    assert.ok(Date.now() - t0 < 9000, "all four were forwarded at once (the fake runs them concurrently)");
  });
});

test("server: imageQueue on without engineSlot is refused at start with a clear log line, and stays off", async () => {
  await withServer({ USAP_IMAGE_QUEUE: "on" }, async (srv) => {
    assert.match(srv.log(), /image queue "on" is not supported without engineSlot and stays off/);
    await load(srv);
    const rs = await resources(srv);
    assert.equal(rs.limits.imageQueue, undefined);
    const all = await Promise.all([0, 1, 2, 3].map((i) => txt2img(srv.port, `p${i}`)));
    for (const r of all) assert.equal(r.status, 200);
  });
});

test("server: USAP_SCHEDULER=off forces the queue off even with engineSlot and imageQueue on (rollback)", async (t) => {
  await withServer({ USAP_ENGINE_SLOT: "on", USAP_IMAGE_QUEUE: "on", USAP_SCHEDULER: "off" }, async (srv) => {
    assert.doesNotMatch(srv.log(), /Image queue on/);
    await load(srv);
    const t0 = Date.now();
    const all = await Promise.all([0, 1, 2, 3].map((i) => txt2img(srv.port, `p${i}`)));
    // Diagnostics only (a Windows run once answered one of these 502): printed before, and independent of, the
    // unchanged assertions below. Never throws.
    if (all.some((r) => r.status !== 200)) {
      let line;
      try {
        let stats = null;
        try { const port = (await request(srv.port, "GET", "/api/backend-status")).json.port; stats = (await request(port, "GET", "/fake/stats")).json; } catch (_) {}
        line = describeRollbackFailures(all, { t0, diag: fakeSdDiag(srv.root), stats, log: srv.log() });
      } catch (_) { line = "description failed"; }
      t.diagnostic(`rollback generations: ${line}`);
    }
    for (const r of all) assert.equal(r.status, 200);
  });
});

test("server: on (with engineSlot) — one at a time, FIFO, 429 past the limit, reported in /api/resources; restart 409 while forwarded; stop refuses waiting", async (t) => {
  await withServer({ USAP_ENGINE_SLOT: "on", USAP_IMAGE_QUEUE: "on" }, async (srv) => {
    assert.match(srv.log(), /Image queue on: 1 running, 2 waiting at most/);
    // Not ready yet: refused before any body byte.
    const early = await txt2img(srv.port, "too early");
    assert.equal(early.status, 503); assert.equal(early.json.code, "ENGINE_NOT_READY"); assert.match(early.json.detail, /^Generation failed: /);
    await load(srv);
    // #179 diagnostics (record only): send/answer times, queue and engine counts sampled while waiting, engine
    // lifecycle. The requests, the 700 ms wait and the observation are as before; the line is printed only when the
    // observation is not 1 running / 2 waiting, before the unchanged assertions. Never throws.
    const t0 = Date.now(), sent = [], results = [];
    let enginePort = null;
    try { enginePort = (await request(srv.port, "GET", "/api/backend-status")).json.port; } catch (_) { /* record only */ }
    const ps = [0, 1, 2].map(async (i) => { await sleep(i * 150); sent[i] = Date.now(); const r = await txt2img(srv.port, `p${i}`); r.doneAt = Date.now(); results[i] = r; return r; });
    const samples = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling && samples.length < 12) {
        const s = { t: Date.now() };
        try { const q = (await resources(srv)).engines.image.queue; s.running = q.running; s.waiting = q.waiting; s.known = q.known; } catch (_) { /* record only */ }
        try { if (enginePort) { const st = (await request(enginePort, "GET", "/fake/stats")).json; s.engineRequests = st.requests; s.engineCompleted = st.completed; s.engineAborted = st.aborted; } } catch (_) { /* record only */ }
        samples.push(s);
        await sleep(150);
      }
    })();
    await sleep(700);
    const rs = await resources(srv);
    const observedAt = Date.now();
    sampling = false;
    await sampler;
    const oq = rs && rs.engines && rs.engines.image && rs.engines.image.queue;
    if (!oq || oq.running !== 1 || oq.waiting !== 2) {
      let line;
      try {
        await Promise.race([Promise.all(ps), sleep(15000)]);
        line = describeQueueOnObservation({ t0, sent, results: results.slice(), observedAt, rs, samples, diag: fakeSdDiag(srv.root), log: srv.log() });
      } catch (_) { line = "description failed"; }
      t.diagnostic(`#179 queue-on observation: ${line}`);
    }
    assert.equal(rs.limits.imageQueue, "on");
    assert.deepEqual({ ...rs.engines.image.queue, runningSeconds: 0 }, { running: 1, waiting: 2, limit: 2, known: true, abandoned: false, runningSeconds: 0, inactive: null });
    const full = await txt2img(srv.port, "p3");
    assert.equal(full.status, 429); assert.equal(full.json.code, "QUEUE_FULL");
    const restart = await request(srv.port, "POST", "/api/restart-backend", { body: { model: MODEL, backend_type: "cpu", use_gpu: false, width: 64, height: 64, steps: 5 } });
    assert.equal(restart.status, 409, `restart refused while a forwarded job is unsettled: ${restart.text}`);
    const res = await Promise.all(ps);
    for (const r of res) assert.equal(r.status, 200);
    const ms = res.map((r) => r.ms);
    assert.ok(ms[1] > ms[0] + 2000 && ms[2] > ms[1] + 2000, `one after another (${ms.join("/")} ms)`);
    // Stop with waiting jobs: they are refused; the running one ends with the engine.
    const q2 = [0, 1, 2].map(async (i) => { await sleep(i * 150); return txt2img(srv.port, `s${i}`); });
    await sleep(700);
    const stop = await request(srv.port, "POST", "/api/stop-backend", { body: {} });
    assert.equal(stop.status, 200, stop.text);
    const r2 = await Promise.all(q2);
    const waitingRefused = r2.slice(1);
    for (const r of waitingRefused) { assert.equal(r.status, 503); assert.equal(r.json.code, "ENGINE_NOT_READY"); }
    assert.equal((await resources(srv)).imageQueue.counts.refused, 2, "the stop itself refused the waiting jobs (not a later dispatch check)");
    assert.ok(r2[0].error || r2[0].status >= 500 || r2[0].status === 200, "the running job ends with the engine");
    const after = await resources(srv);
    assert.equal(after.imageQueue.memory.reservedBytes, 0); assert.equal(after.imageQueue.memory.heldJobs, 0);
    assert.equal(after.engines.image.queue.running, 0); assert.equal(after.engines.image.queue.waiting, 0);
  });
});

test("server: shutdown with a running and waiting jobs exits cleanly; waiting clients get an answer or a closed connection; no engine left", async () => {
  const root = makeRoot();
  installFakeSdServer(root);
  writeModel(path.join(root, "app", "models"), MODEL);
  const srv = await startServer(root, { USAP_ENGINE_SLOT: "on", USAP_IMAGE_QUEUE: "on" });
  try {
    await load(srv);
    const d = (await request(srv.port, "GET", "/api/diagnostics")).json;
    const sup = ((d && d.engines && d.engines.processes && d.engines.processes.supervised) || []).find((x) => x.label === "image");
    const enginePid = sup && (sup.enginePid || sup.guardPid);
    const ps = [0, 1, 2].map(async (i) => { await sleep(i * 150); return txt2img(srv.port, `x${i}`); });
    await sleep(700);
    const exited = new Promise((r) => srv.proc.once("exit", (code) => r(code)));
    srv.proc.kill("SIGTERM");
    const code = await Promise.race([exited, sleep(15000).then(() => "timeout")]);
    assert.notEqual(code, "timeout", "the server exits");
    const res = await Promise.race([Promise.all(ps), sleep(10000).then(() => null)]);
    assert.ok(res, "every client got an answer or a closed connection");
    for (const r of res.slice(1)) assert.ok(r.error || r.status === 503, JSON.stringify(r));
    if (enginePid) await waitFor(() => { try { process.kill(enginePid, 0); return false; } catch (e) { return e.code !== "EPERM"; } }, 10000, "engine gone");
  } finally {
    stopServer(srv);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* Windows */ }
  }
});

test("server: restart answers 409 while a queued generation is forwarded, even before the engine's log shows it generating", async () => {
  await withServer({ USAP_ENGINE_SLOT: "on", USAP_IMAGE_QUEUE: "on" }, async (srv) => {
    const r0 = await request(srv.port, "POST", "/api/restart-backend", { body: { model: QUIET, backend_type: "cpu", use_gpu: false, width: 64, height: 64, steps: 4 } });
    assert.equal(r0.status, 200, r0.text);
    await waitFor(async () => (await request(srv.port, "GET", "/api/backend-status")).json.ready, 30000, "ready");
    const gen = txt2img(srv.port, "quiet");
    await waitFor(async () => (await resources(srv)).engines.image.queue.running === 1, 5000, "forwarded");
    const progress = (await request(srv.port, "GET", "/api/generation-progress")).json;
    assert.notEqual(progress.active, true, "the log-based state does not show this generation (the window the check closes)");
    const restart = await request(srv.port, "POST", "/api/restart-backend", { body: { model: QUIET, backend_type: "cpu", use_gpu: false, width: 64, height: 64, steps: 5 } });
    assert.equal(restart.status, 409, `restart refused while the forwarded job is unsettled: ${restart.text}`);
    assert.equal((await gen).status, 200, "the running generation finishes normally");
  });
});

