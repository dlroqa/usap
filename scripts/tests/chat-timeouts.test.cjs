// Step 9.9f-1: chat-engine timeouts, cancellation confirmation and the UNRESPONSIVE gate
// (services/chat-timeouts.cjs, services/chat.cjs; docs/roadmap/STEP9_9F_TIMEOUTS.md). Off by default.
//
// Three layers:
//   1. the setting and the engine guard alone, with a fake clock and a scripted /metrics;
//   2. the chat service in-process, on real sockets, against an engine the test controls byte by byte, with every
//      deadline, probe and queue timer on a fake clock (so a 600 s limit takes no real time);
//   3. the real server (serve.cjs) with the contract-test fake llama-server, for defaults, settings, rollback and
//      one end-to-end run with the smallest allowed limits.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const nodeTest = require("node:test");
// Every test has a time limit, so a regression that leaves a request hanging fails instead of stalling the run.
const test = (name, a, b) => (typeof a === "function" ? nodeTest(name, { timeout: 60000 }, a) : nodeTest(name, { timeout: 60000, ...a }, b));

const { chatTimeoutSetting, createChatTimeouts, httpMetricsFetcher, parseMetrics, QUIESCE_GAP_MS } = require("../server/services/chat-timeouts.cjs");
const { createChatService } = require("../server/services/chat.cjs");
const { createChatQueue } = require("../server/services/chat-queue.cjs");
const { createScheduler } = require("../server/services/scheduler.cjs");
const errors = require("../server/errors.cjs");
const { makeRoot, startServer, stopServer, request } = require("./api-contract/harness.cjs");

const REPO = path.resolve(__dirname, "..", "..");
const FIXTURE = path.join(REPO, "tests", "e2e", "fixtures", "chat-timeout-stream.txt");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
async function waitFor(fn, ms = 5000, label = "condition") {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${label}`); await sleep(5); }
}

// A fake clock: timers run in time order; `advance` lets I/O and promises settle after each one.
function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  let order = 0;
  const timers = new Map();
  const clock = {
    now: () => t,
    setTimer: (fn, ms) => { const h = { id: ++order }; timers.set(h, { at: t + Math.max(0, ms), fn, order: h.id }); return h; },
    clearTimer: (h) => { timers.delete(h); },
    pending: () => timers.size,
    /** Advance time; the first due timer runs synchronously (before any pending I/O is seen). */
    advanceSync(ms) {
      const end = t + ms;
      const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at || a[1].order - b[1].order)[0];
      if (due) { t = Math.max(t, due[1].at); timers.delete(due[0]); due[1].fn(); }
      return end;
    },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at || a[1].order - b[1].order)[0];
        if (!due) break;
        t = Math.max(t, due[1].at); timers.delete(due[0]); due[1].fn();
        await flush();
        await sleep(2); // real sockets: let the bytes travel
      }
      t = end;
      await flush();
    },
  };
  return clock;
}

const prom = ({ processing = 0, deferred = 0, decodes = 7, predicted = 7, prompt = 3 } = {}) =>
  `# TYPE x gauge\nllamacpp:prompt_tokens_total ${prompt}\nllamacpp:tokens_predicted_total ${predicted}\nllamacpp:n_decode_total ${decodes}\nllamacpp:requests_processing ${processing}\nllamacpp:requests_deferred ${deferred}\n`;

// ── 1. Setting ───────────────────────────────────────────────────────────────────────────────────────────
test("setting: off by default; 600/120 s defaults; ranges enforced; invalid values ignored (never clamped); the environment wins; USAP_SCHEDULER=off forces off", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usap-timeouts-"));
  const file = (o) => fs.writeFileSync(path.join(dir, "scheduler.json"), JSON.stringify(o));
  try {
    const d = chatTimeoutSetting({ env: {}, configDir: dir });
    assert.equal(d.mode, "off");
    assert.deepEqual([d.firstByteSeconds, d.idleSeconds, d.nonStreamTotalSeconds, d.cancelConfirmSeconds, d.unresponsiveProbeSeconds], [600, 120, 300, 120, 15]);
    assert.equal(d.ignored.length, 0);
    assert.ok(Object.isFrozen(d));
    assert.equal(chatTimeoutSetting({ env: { USAP_CHAT_TIMEOUTS: " Observe " } }).mode, "observe");
    assert.equal(chatTimeoutSetting({ env: { USAP_CHAT_TIMEOUTS: "on" } }).mode, "on");
    // Bounds: 30-3600 first byte, 10-600 idle (both ends allowed).
    for (const [k, v, want] of [["USAP_CHAT_FIRST_BYTE_SECONDS", "30", 30], ["USAP_CHAT_FIRST_BYTE_SECONDS", "3600", 3600], ["USAP_CHAT_IDLE_SECONDS", "10", 10], ["USAP_CHAT_IDLE_SECONDS", "600", 600]]) {
      const s = chatTimeoutSetting({ env: { [k]: v } });
      assert.equal(k.includes("FIRST") ? s.firstByteSeconds : s.idleSeconds, want, `${k}=${v}`);
    }
    // Invalid: out of range, fractional, signs, units, words. Never clamped: the default stays.
    for (const v of ["29", "3601", "0", "-5", "60.5", "1e3", "60s", "ten", " "]) {
      const s = chatTimeoutSetting({ env: { USAP_CHAT_FIRST_BYTE_SECONDS: v } });
      assert.equal(s.firstByteSeconds, 600, `first byte ${JSON.stringify(v)} ignored`);
    }
    for (const v of ["9", "601", "12.0"]) assert.equal(chatTimeoutSetting({ env: { USAP_CHAT_IDLE_SECONDS: v } }).idleSeconds, 120, `idle ${v} ignored`);
    const bad = chatTimeoutSetting({ env: { USAP_CHAT_IDLE_SECONDS: "9", USAP_CHAT_TIMEOUTS: "maybe" } });
    assert.deepEqual(bad.ignored.map((x) => x.name).sort(), ["USAP_CHAT_IDLE_SECONDS", "USAP_CHAT_TIMEOUTS"]);
    assert.ok(!JSON.stringify(bad.ignored).includes("maybe"), "the rejected value itself is never echoed");
    // File values; the environment wins; an invalid environment value falls back to a valid file value.
    file({ chatTimeouts: "on", chatFirstByteSeconds: 900, chatIdleSeconds: 45 });
    let s = chatTimeoutSetting({ env: {}, configDir: dir });
    assert.deepEqual([s.mode, s.firstByteSeconds, s.idleSeconds], ["on", 900, 45]);
    s = chatTimeoutSetting({ env: { USAP_CHAT_TIMEOUTS: "off", USAP_CHAT_IDLE_SECONDS: "30" }, configDir: dir });
    assert.deepEqual([s.mode, s.idleSeconds], ["off", 30], "the environment wins");
    s = chatTimeoutSetting({ env: { USAP_CHAT_IDLE_SECONDS: "5" }, configDir: dir });
    assert.equal(s.idleSeconds, 45, "an invalid environment value doesn't hide a valid file value");
    file({ chatTimeouts: "on", chatFirstByteSeconds: 20, chatIdleSeconds: "60" });
    s = chatTimeoutSetting({ env: {}, configDir: dir });
    assert.deepEqual([s.firstByteSeconds, s.idleSeconds], [600, 60], "file: out of range ignored; digit strings accepted");
    file({ chatTimeouts: true, chatIdleSeconds: 60.5 });
    s = chatTimeoutSetting({ env: {}, configDir: dir });
    assert.deepEqual([s.mode, s.idleSeconds], ["off", 120]);
    fs.writeFileSync(path.join(dir, "scheduler.json"), "{ not json");
    assert.equal(chatTimeoutSetting({ env: {}, configDir: dir }).mode, "off", "unreadable file: defaults");
    // Global rollback.
    assert.equal(chatTimeoutSetting({ env: { USAP_CHAT_TIMEOUTS: "on" }, schedulerMode: "off" }).mode, "off");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("metrics parsing: all five numbers or nothing", () => {
  assert.deepEqual(parseMetrics(prom({ processing: 1 })), { processing: 1, deferred: 0, decodes: 7, predicted: 7, prompt: 3 });
  assert.equal(parseMetrics(prom().replace(/llamacpp:requests_deferred.*\n/, "")), null, "missing metric");
  assert.equal(parseMetrics(prom().replace("requests_processing 0", "requests_processing NaN")), null, "not a number");
  assert.equal(parseMetrics(prom().replace("requests_processing 0", "requests_processing -1")), null, "negative");
  assert.equal(parseMetrics(""), null);
  assert.equal(parseMetrics(null), null);
});

// ── 1b. Engine guard ─────────────────────────────────────────────────────────────────────────────────────
// A scripted /metrics: `next` decides each answer; handles allow late (stale) answers.
function scriptedMetrics(next) {
  const m = { calls: 0, inflight: 0, maxInflight: 0, handles: [] };
  m.fetch = (port) => {
    m.calls++; m.inflight++; m.maxInflight = Math.max(m.maxInflight, m.inflight);
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const h = { port, done: false, answer(v) { if (h.done) return; h.done = true; m.inflight--; resolve(v); } };
    m.handles.push(h);
    const v = next(m.calls, h);
    if (v !== "hang" && v !== "manual") h.answer(v);
    return { promise, abort: () => h.answer(null) };
  };
  return m;
}
const ok = (o, start = "1000") => ({ status: 200, startTime: start, text: prom(o) });
function guardWith({ mode = "on", next, engine, setting = {} } = {}) {
  const clock = fakeClock();
  const eng = engine || { seq: 1, ready: true, port: 4242 };
  const metrics = scriptedMetrics(next || (() => ok({})));
  const T = createChatTimeouts({ setting: { ...chatTimeoutSetting({ env: { USAP_CHAT_TIMEOUTS: mode } }), ...setting }, engine: () => eng, fetchMetrics: metrics.fetch, ...clock, log: () => {} });
  return { T, clock, eng, metrics };
}

test("guard: an abort makes the engine CONFIRMING; two quiet readings >= 3 s apart with unchanged counters confirm it; deferred releases and waiters then go", async () => {
  // Busy for the first 3 probes (still computing after the transport abort), then quiet.
  const { T, clock, metrics } = guardWith({ next: (n) => ok({ processing: n <= 3 ? 1 : 0, decodes: n <= 3 ? n : 10, predicted: n <= 3 ? n : 10 }) });
  assert.equal(T.engineState(), "ready");
  T.noteAbort(1);
  assert.equal(T.engineState(), "confirming");
  let released = 0;
  T.afterConfirmation(() => { released++; });
  const waiter = T.admit(() => {});
  let admitted = null; waiter.then((r) => { admitted = r; });
  await clock.advance(4000); // probes 1-3 busy, probe 4 quiet (first baseline)
  assert.equal(T.engineState(), "confirming", "one quiet reading is not enough");
  assert.equal(released, 0); assert.equal(admitted, null);
  await clock.advance(2000); // probe 6 is only 2 s after the baseline
  assert.equal(T.engineState(), "confirming", "the second quiet reading must be >= 3 s after the first");
  await clock.advance(1000);
  assert.equal(T.engineState(), "ready");
  assert.equal(released, 1, "the deferred queue release ran exactly once");
  assert.deepEqual(admitted, { ok: true });
  assert.equal(metrics.maxInflight, 1, "never more than one probe at a time");
  const snap = T.snapshot();
  assert.equal(snap.engine, "ready"); assert.equal(snap.counts.cancelConfirmed, 1);
  const calls = metrics.calls;
  await clock.advance(60000);
  assert.equal(metrics.calls, calls, "no probing once confirmed");
  assert.equal(clock.pending(), 0, "no timers left");
});

test("guard: counters that move between quiet readings, a changed process start time, missing metrics or header, deferred work, or an HTTP error never confirm", async () => {
  const cases = {
    "counters move": (n) => ok({ decodes: n, predicted: n }),
    "process start time changes": (n) => ok({}, String(1000 + n)),
    "missing header": () => ({ status: 200, startTime: undefined, text: prom({}) }),
    "missing metric": () => ({ status: 200, startTime: "1000", text: "llamacpp:prompt_tokens_total 3\n" }),
    "deferred request": () => ok({ deferred: 1 }),
    "HTTP 501": () => ({ status: 501, startTime: "1000", text: prom({}) }),
    "no answer at all": () => null,
  };
  for (const [name, next] of Object.entries(cases)) {
    const { T, clock } = guardWith({ next });
    T.noteAbort(1);
    await clock.advance(119000);
    assert.equal(T.engineState(), "confirming", name);
    await clock.advance(2000);
    assert.equal(T.engineState(), "unresponsive", `${name}: after the window, unresponsive (never ready)`);
    T.close();
  }
});

test("guard: a reading from a probe sent before the latest abort is stale and rejected", async () => {
  // Probe 1 is held; a second abort happens; probe 1 then answers quiet. It must not count.
  const { T, clock, metrics } = guardWith({ next: (n) => (n === 1 ? "manual" : ok({ processing: 1 })) });
  T.noteAbort(1);
  await clock.advance(1000); // probe 1 sent, pending
  assert.equal(metrics.handles.length, 1);
  await clock.advance(500);
  T.noteAbort(1); // e.g. a second request's abort on the same engine
  metrics.handles[0].answer(ok({}));
  await flush();
  const rejected = T.snapshot().counts.probesRejected;
  assert.ok(rejected >= 1, "stale reading rejected");
  assert.equal(T.engineState(), "confirming");
  T.close();
});

test("guard: an engine reload (new process) ends CONFIRMING; a late answer about the old process is discarded and can't confirm a newer abort; an abort for an old process is ignored", async () => {
  const eng = { seq: 1, ready: true, port: 4242 };
  const { T, clock, metrics } = guardWith({ engine: eng, next: () => "manual" });
  T.noteAbort(1);
  await clock.advance(1000); // probe to engine 1 pending
  const old = metrics.handles[0];
  eng.seq = 2; eng.port = 4343; // a model reload: the old process exited, a new one is ready
  assert.equal(T.engineState(), "ready", "new engine process: the uncertain work died with the old one");
  assert.equal(T.snapshot().counts.engineReplaced, 1);
  T.noteAbort(1);
  assert.equal(T.engineState(), "ready", "an abort for the old process is ignored");
  T.noteAbort(2);
  assert.equal(T.engineState(), "confirming");
  old.answer(ok({}));            // the old engine's quiet answer arrives late
  await clock.advance(10000);
  assert.equal(T.engineState(), "confirming", "never confirmed by the old engine's reading");
  assert.ok(metrics.handles.slice(1).every((h) => h.port === 4343), "new probes go to the new engine");
  T.close();
});

test("guard: UNRESPONSIVE refuses at once with 503 + Retry-After; recovers only on two quiet readings of the current process or a new engine process", async () => {
  let quiet = false;
  const eng = { seq: 1, ready: true, port: 4242 };
  const { T, clock } = guardWith({ engine: eng, next: () => (quiet ? ok({}) : "hang") });
  T.noteAbort(1);
  let released = 0;
  T.afterConfirmation(() => { released++; });
  const waiting = T.admit(() => {});
  await clock.advance(121000);
  assert.equal(T.engineState(), "unresponsive");
  assert.deepEqual(await waiting, { ok: false, status: 503, code: "ENGINE_UNRESPONSIVE", retryAfterSeconds: 30, error: (await waiting).error });
  assert.equal(released, 1, "the queue slot is released on entering UNRESPONSIVE (the gate keeps refusing)");
  const now = await T.admit(() => {});
  assert.equal(now.code, "ENGINE_UNRESPONSIVE", "refused at once");
  assert.equal(T.snapshot().counts.cancelUnconfirmed, 1);
  // A stopped engine (same process id, not ready) can't recover by probe.
  quiet = true;
  await clock.advance(15000);
  assert.equal(T.engineState(), "unresponsive", "one quiet reading is not enough");
  await clock.advance(15000);
  assert.equal(T.engineState(), "ready", "two quiet readings 15 s apart");
  assert.equal(T.snapshot().counts.recovered, 1);
  // Again, but recovery through a new engine process.
  quiet = false;
  T.noteAbort(1);
  await clock.advance(126000);
  assert.equal(T.engineState(), "unresponsive");
  eng.ready = false; // the user stops the model
  assert.equal(T.engineState(), "unresponsive");
  eng.seq = 2; eng.ready = true; // and loads it again
  assert.equal(T.engineState(), "ready");
  T.close();
});

test("guard: a hung /metrics is bounded per probe (5 s) and keeps one probe in flight; a waiter whose client leaves gets CLIENT_GONE", async () => {
  const { T, clock, metrics } = guardWith({ next: () => "hang" });
  T.noteAbort(1);
  let leave;
  const w = T.admit((cb) => { leave = cb; });
  await clock.advance(30000);
  assert.equal(metrics.maxInflight, 1);
  assert.ok(metrics.calls >= 4 && metrics.calls <= 6, `about one probe per 6 s while hung (got ${metrics.calls})`);
  leave();
  assert.deepEqual(await w, { ok: false, code: "CLIENT_GONE" });
  T.close();
});

test("guard: off and observe never probe, gate or defer; observe reports would-have-timed-out counts; off reports nothing", async () => {
  for (const mode of ["off", "observe"]) {
    const { T, clock, metrics } = guardWith({ mode });
    T.noteAbort(1);
    let released = 0;
    T.afterConfirmation(() => { released++; });
    assert.equal(released, 1, `${mode}: released at once`);
    assert.deepEqual(await T.admit(() => {}), { ok: true });
    await clock.advance(200000);
    assert.equal(metrics.calls, 0, `${mode}: no probe`);
    if (mode === "off") assert.equal(T.snapshot(), null);
    else {
      T.recordWould("idle", { stream: true, elapsedMs: 120000 });
      const s = T.snapshot();
      assert.equal(s.mode, "observe"); assert.equal(s.wouldHaveTimedOut.idle, 1); assert.equal(s.engine, undefined);
    }
  }
});

test("scheduler: the chatTimeouts key and limits.runningTimeouts appear only when the reporter returns something", () => {
  const deps = { budget: { totalRamBytes: () => 1, freeRamBytes: () => 1, totalVramBytes: () => 0, freeVramBytes: () => null }, cpu: { logicalCores: () => 4, physicalCores: () => 4 },
    engines: { text: () => ({ state: "ready", loaded: true, pendingOperations: () => 0, chatActive: () => 0, chatWaiting: () => 0 }), image: () => ({}), speech: () => ({}), voice: () => ({}), download: () => ({}), heavyModel: () => null }, now: () => 0 };
  const base = createScheduler(deps).snapshot();
  assert.equal("chatTimeouts" in base, false);
  assert.equal("runningTimeouts" in base.limits, false);
  assert.deepEqual(createScheduler({ ...deps, chatTimeouts: () => null }).snapshot(), base, "off: exactly the previous snapshot");
  const on = createScheduler({ ...deps, chatTimeouts: () => ({ mode: "on", engine: "ready" }) }).snapshot();
  assert.equal(on.limits.runningTimeouts, "on");
  assert.deepEqual(on.chatTimeouts, { mode: "on", engine: "ready" });
  assert.deepEqual({ ...on, chatTimeouts: undefined, limits: { ...on.limits, runningTimeouts: undefined } }, { ...base, chatTimeouts: undefined, limits: { ...base.limits, runningTimeouts: undefined } });
});

// ── 2. The chat service in-process, real sockets, fake clock ───────────────────────────────────────────
const SSE = { "Content-Type": "text/event-stream" };
const chunk = (content) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;
const DONE = `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;

// An engine the test drives: every chat request is queued for the test; /metrics reports what the test sets
// (by default: requests still open, plus `busy`).
async function controlledEngine() {
  const e = { requests: [], waiters: [], taken: 0, metricsCalls: 0, busy: 0, metricsMode: "normal", start: "1700000000", decodes: 1 };
  e.server = http.createServer((req, res) => {
    if (req.url.startsWith("/metrics")) {
      e.metricsCalls++;
      if (e.metricsMode === "hang") return;
      const open = e.requests.filter((r) => !r.closed).length;
      res.writeHead(200, { "Content-Type": "text/plain", "Process-Start-Time-Unix": e.start });
      return res.end(prom({ processing: open + e.busy, decodes: e.decodes, predicted: e.decodes }));
    }
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const r = { body: JSON.parse(raw || "{}"), req, res, closed: false };
      res.on("close", () => { r.closed = true; });
      e.requests.push(r);
      e.decodes++;
      if (e.waiters.length) { e.taken++; e.waiters.shift()(r); }
    });
  });
  await new Promise((r) => e.server.listen(0, "127.0.0.1", r));
  e.port = e.server.address().port;
  // The next chat request the engine received (in arrival order), now or when it comes.
  e.next = () => new Promise((resolve) => { if (e.taken < e.requests.length) resolve(e.requests[e.taken++]); else e.waiters.push(resolve); });
  e.close = () => new Promise((r) => { for (const x of e.requests) { try { x.res.destroy(); } catch (_) { /* gone */ } } e.server.close(r); e.server.closeAllConnections?.(); });
  return e;
}

async function rig({ mode = "on", queue = false, setting = {}, startLlm } = {}) {
  const clock = fakeClock();
  const engine = await controlledEngine();
  const state = { PORT_LLM: engine.port, llmProcSeq: 1, llmReady: true, llmProc: {}, llmSettings: { model: "m", contextSize: 4096, threads: 2, gpuLayers: 0 } };
  const logs = [];
  const T = mode === "off" ? null : createChatTimeouts({
    setting: { ...chatTimeoutSetting({ env: { USAP_CHAT_TIMEOUTS: mode } }), ...setting },
    engine: () => ({ seq: state.llmProcSeq, ready: state.llmReady, port: state.PORT_LLM }),
    fetchMetrics: httpMetricsFetcher(http), ...clock, log: (l) => logs.push(l),
  });
  let releases = 0;
  const q = queue ? createChatQueue({ limit: 4, maxWaitMs: 600000, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer }) : null;
  const countedQueue = q && { admit: (g) => q.admit(g).then((t) => (t.ok ? { ...t, release: () => { releases++; t.release(); } } : t)), stats: () => q.stats() };
  const starts = [];
  const chat = createChatService({
    chatTimeouts: T, chatQueue: countedQueue, state, http,
    errorBody: errors.errorBody, errorStatus: errors.errorStatus,
    json: (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); },
    redactPaths: errors.redactPaths || ((s) => s),
    requestJson: () => { throw new Error("legacy requestJson is not used by these tests"); },
    runExclusiveLlmOperation: (fn) => fn(),
    startLlm: startLlm || (async (s) => { starts.push(s); state.llmProcSeq++; }),
    webSearch: { augmentMessagesWithWebSearch: async (messages) => ({ messages, webSources: [], webContext: "" }) },
  });
  const studio = http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => { raw += c; });
    req.on("end", () => { chat.doLlmChat(req, res, JSON.parse(raw)); });
  });
  await new Promise((r) => studio.listen(0, "127.0.0.1", r));
  const port = studio.address().port;
  // A client: `result` resolves with what it saw; `headers` once the status line arrived.
  const send = (content, { stream = true } = {}) => {
    const out = { status: null, text: "", ended: false, cut: false, headers: null };
    let req;
    let gotHeaders;
    out.headersSeen = new Promise((r) => { gotHeaders = r; });
    out.result = new Promise((resolve) => {
      req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/llm/chat", agent: false, headers: { "Content-Type": "application/json" } }, (res) => {
        out.status = res.statusCode; out.headers = res.headers; gotHeaders();
        res.setEncoding("utf8");
        res.on("data", (c) => { out.text += c; });
        res.on("end", () => { out.ended = true; resolve(out); });
        res.on("aborted", () => { out.cut = true; resolve(out); });
        res.on("error", () => { out.cut = true; resolve(out); });
      });
      req.on("error", () => { out.cut = true; resolve(out); });
      req.end(JSON.stringify({ messages: [{ role: "user", content }], stream }));
    });
    out.abort = () => req.destroy();
    return out;
  };
  const done = async () => { T && T.close(); await engine.close(); await new Promise((r) => { studio.close(r); studio.closeAllConnections?.(); }); };
  return { clock, engine, state, T, chat, send, done, logs, queue: q, releases: () => releases, starts };
}
const sseEvents = (text) => text.split("\n\n").filter(Boolean);
const lastEvent = (text) => { const ev = sseEvents(text).at(-1) || ""; try { return JSON.parse(ev.replace(/^data: /, "")); } catch (_) { return ev; } };

test("stream, on: no status line at all → 504 ENGINE_TIMEOUT phase first-byte after 600 s (not before); the engine request is destroyed; the engine is CONFIRMING", async (t) => {
  const r = await rig(); t.after(r.done);
  const c = r.send("hello");
  const e = await r.engine.next();
  await r.clock.advance(599_999);
  assert.equal(c.status, null, "nothing before the limit");
  await r.clock.advance(1);
  await c.result;
  assert.equal(c.status, 504);
  const body = JSON.parse(c.text);
  assert.deepEqual([body.ok, body.code, body.phase], [false, "ENGINE_TIMEOUT", "first-byte"]);
  assert.ok(!/127\.0\.0\.1|:\d{4,5}|\/home\/|\\\\/.test(body.error), "no address, port or path in the message");
  await waitFor(() => e.closed, 3000, "engine request destroyed");
  assert.equal(r.T.engineState(), "confirming");
  assert.equal(r.T.snapshot().counts.firstByte, 1);
});

test("stream, on: a status line without a body is not the first byte → after 600 s an in-stream ENGINE_TIMEOUT error event, no [DONE]", async (t) => {
  const r = await rig(); t.after(r.done);
  const c = r.send("hello");
  const e = await r.engine.next();
  e.res.writeHead(200, SSE); e.res.flushHeaders();
  await c.headersSeen;
  assert.equal(c.status, 200, "the studio committed its headers when the engine's status line came");
  await r.clock.advance(600_000);
  await c.result;
  const ev = lastEvent(c.text);
  assert.deepEqual([ev.error?.code, ev.error?.phase], ["ENGINE_TIMEOUT", "first-byte"]);
  assert.ok(!c.text.includes("[DONE]"), "never [DONE] after a timeout");
  await waitFor(() => e.closed, 3000, "engine request destroyed");
});

test("stream, on: the first body chunk at 590 s and chunks every 119 s never time out; [DONE] passes through; nothing is counted", async (t) => {
  const r = await rig(); t.after(r.done);
  const c = r.send("hello");
  const e = await r.engine.next();
  e.res.writeHead(200, SSE); e.res.flushHeaders();
  await r.clock.advance(590_000);
  // Each chunk must reach the studio before time moves on (real sockets, fake clock).
  e.res.write(chunk("a")); await waitFor(() => c.text.includes('"a"'), 3000, "a");
  for (let i = 0; i < 3; i++) { await r.clock.advance(119_000); e.res.write(chunk(`b${i}`)); await waitFor(() => c.text.includes(`"b${i}"`), 3000, `b${i}`); }
  await r.clock.advance(119_000);
  e.res.end(DONE);
  await c.result;
  assert.ok(c.text.endsWith("data: [DONE]\n\n"), c.text.slice(-200));
  assert.ok(!c.text.includes("ENGINE_TIMEOUT"));
  const s = r.T.snapshot();
  assert.deepEqual([s.counts.firstByte, s.counts.idle, s.engine], [0, 0, "ready"]);
  await r.clock.advance(1_000_000);
  assert.equal(r.engine.metricsCalls, 0, "a completed request needs no confirmation");
});

test("stream, on: partial output then a stall → error event after 120 s idle, after the partial chunks; bytes match the WebUI fixture", async (t) => {
  const r = await rig(); t.after(r.done);
  const c = r.send("hello");
  const e = await r.engine.next();
  e.res.writeHead(200, SSE);
  e.res.write(chunk("partial-1 ")); e.res.write(chunk("partial-2 "));
  await waitFor(() => c.text.includes("partial-2"), 3000, "partial output forwarded");
  await r.clock.advance(119_999);
  assert.equal(c.ended, false);
  await r.clock.advance(1);
  await c.result;
  const ev = lastEvent(c.text);
  assert.deepEqual([ev.error.code, ev.error.phase], ["ENGINE_TIMEOUT", "idle"]);
  assert.ok(c.text.startsWith(chunk("partial-1 ") + chunk("partial-2 ")), "partial chunks kept, nothing retracted");
  assert.ok(!c.text.includes("[DONE]"));
  assert.equal(c.text, fs.readFileSync(FIXTURE, "utf8"), "the Playwright fixture is exactly what the server sends");
  await waitFor(() => e.closed, 3000, "engine request destroyed");
  assert.equal(r.T.snapshot().counts.idle, 1);
});

test("stream, on: SSE keep-alive comments are not progress; the idle limit still ends the stall", async (t) => {
  const r = await rig(); t.after(r.done);
  const c = r.send("hello");
  const e = await r.engine.next();
  e.res.writeHead(200, SSE); e.res.write(chunk("x"));
  await waitFor(() => c.text.includes('"x"'), 3000, "chunk");
  // Each keep-alive must reach the studio before time moves on, or the check would prove nothing.
  await r.clock.advance(60_000); e.res.write(": keep-alive\n\n"); await waitFor(() => c.text.includes(": keep-alive"), 3000, "keep-alive 1");
  await r.clock.advance(59_000); e.res.write(":\n\n"); await waitFor(() => c.text.endsWith(":\n\n"), 3000, "keep-alive 2");
  await r.clock.advance(1_000);
  await waitFor(() => c.ended, 3000, "the stall ended at 120 s after the last real chunk");
  assert.equal(lastEvent(c.text).error.phase, "idle");
});

test("stream, on: a client that disconnects before the first byte, or mid-stream, aborts the engine request, is counted once and leaves the engine CONFIRMING; no answer is written", async (t) => {
  for (const when of ["before-first-byte", "mid-stream"]) {
    const r = await rig();
    try {
      const c = r.send("hello");
      const e = await r.engine.next();
      if (when === "mid-stream") { e.res.writeHead(200, SSE); e.res.write(chunk("x")); await waitFor(() => c.text.includes('"x"'), 3000, "chunk"); }
      c.abort();
      await waitFor(() => e.closed, 3000, `${when}: engine request destroyed`);
      await flush();
      const s = r.T.snapshot();
      assert.equal(s.counts.clientCancelled, 1, when);
      assert.equal(s.engine, "confirming", when);
      await r.clock.advance(5000);
      assert.equal(r.T.engineState(), "ready", `${when}: confirmed by /metrics (no request open, counters still)`);
    } finally { await r.done(); }
  }
});

test("non-stream, on: the 300 s total limit gives 504 ENGINE_TIMEOUT phase total (not before), aborts the engine request; the 600 s first-byte value doesn't apply", async (t) => {
  const r = await rig(); t.after(r.done);
  const c = r.send("hello", { stream: false });
  const e = await r.engine.next();
  await r.clock.advance(299_999);
  assert.equal(c.status, null);
  await r.clock.advance(1);
  await c.result;
  assert.equal(c.status, 504);
  assert.deepEqual((({ code, phase }) => ({ code, phase }))(JSON.parse(c.text)), { code: "ENGINE_TIMEOUT", phase: "total" });
  await waitFor(() => e.closed, 3000, "engine request destroyed");
  assert.equal(r.T.snapshot().counts.total, 1);
});

test("non-stream, on: a client disconnect aborts the engine request (new in on mode); a normal answer passes through unchanged", async (t) => {
  const r = await rig(); t.after(r.done);
  const c = r.send("hello", { stream: false });
  const e = await r.engine.next();
  c.abort();
  await waitFor(() => e.closed, 3000, "engine request destroyed");
  assert.equal(r.T.snapshot().counts.clientCancelled, 1);
  await r.clock.advance(5000);
  assert.equal(r.T.engineState(), "ready");
  const c2 = r.send("again", { stream: false });
  const e2 = await r.engine.next();
  const answer = { choices: [{ index: 0, message: { role: "assistant", content: "fine" }, finish_reason: "stop" }] };
  e2.res.writeHead(200, { "Content-Type": "application/json" }); e2.res.end(JSON.stringify(answer));
  await c2.result;
  assert.equal(c2.status, 200); assert.deepEqual(JSON.parse(c2.text), answer);
});

test("races: a timeout and the normal end in the same tick, and a timeout and an engine error, each give exactly one outcome, no late writes, no uncaught errors", async (t) => {
  const uncaught = [];
  const onErr = (e) => uncaught.push(e);
  process.on("uncaughtException", onErr);
  t.after(() => process.off("uncaughtException", onErr));
  // (a) The end bytes are on the wire when the idle timer fires first.
  {
    const r = await rig();
    try {
      const c = r.send("x"); const e = await r.engine.next();
      e.res.writeHead(200, SSE); e.res.write(chunk("x"));
      await waitFor(() => c.text.includes('"x"'), 3000, "chunk");
      await r.clock.advance(119_000);
      e.res.end(DONE);
      r.clock.advanceSync(1000); // the timer runs before the studio reads the end
      await c.result; await sleep(30);
      const timedOut = c.text.includes("ENGINE_TIMEOUT"); const completed = c.text.includes("[DONE]");
      assert.ok(timedOut !== completed, `exactly one outcome (timeout ${timedOut}, done ${completed})`);
    } finally { await r.done(); }
  }
  // (b) The end is processed first, then the timer time passes: completed, nothing counted.
  {
    const r = await rig();
    try {
      const c = r.send("x"); const e = await r.engine.next();
      e.res.writeHead(200, SSE); e.res.write(chunk("x")); e.res.end(DONE);
      await c.result;
      await r.clock.advance(1_000_000);
      assert.ok(c.text.endsWith("[DONE]\n\n")); assert.equal(r.T.snapshot().counts.idle, 0);
    } finally { await r.done(); }
  }
  // (c) An engine error status and the first-byte timer: one answer, whichever ran first.
  for (const timerFirst of [true, false]) {
    const r = await rig();
    try {
      const c = r.send("x"); const e = await r.engine.next();
      e.res.writeHead(500, { "Content-Type": "application/json" }); e.res.end(JSON.stringify({ error: { message: "engine failed", code: 500 } }));
      if (timerFirst) r.clock.advanceSync(600_000);
      await c.result;
      if (!timerFirst) await r.clock.advance(600_000);
      assert.equal(c.status, timerFirst ? 504 : 500, `timer first: ${timerFirst}`);
      assert.equal(r.T.snapshot().counts.firstByte, timerFirst ? 1 : 0);
    } finally { await r.done(); }
  }
  await sleep(20);
  assert.deepEqual(uncaught, []);
});

test("races with a model reload: a request cut by the reload is not a timeout; a timeout on the old engine process never gates the new one", async (t) => {
  // (a) The reload cuts the engine connection.
  {
    const r = await rig();
    try {
      const c = r.send("x"); const e = await r.engine.next();
      e.res.writeHead(200, SSE); e.res.write(chunk("x"));
      await waitFor(() => c.text.includes('"x"'), 3000, "chunk");
      r.state.llmProcSeq = 2; e.res.destroy();
      await c.result;
      await r.clock.advance(1_000_000);
      const s = r.T.snapshot();
      assert.deepEqual([s.counts.idle, s.engine], [0, "ready"]);
    } finally { await r.done(); }
  }
  // (b) The reload happens while the old engine hangs; its idle timeout then fires.
  {
    const r = await rig();
    try {
      const c = r.send("x"); const e = await r.engine.next();
      e.res.writeHead(200, SSE); e.res.write(chunk("x"));
      await waitFor(() => c.text.includes('"x"'), 3000, "chunk");
      r.state.llmProcSeq = 2;
      await r.clock.advance(120_000);
      await c.result;
      assert.equal(lastEvent(c.text).error.phase, "idle");
      assert.equal(r.T.engineState(), "ready", "the abort concerned a process that no longer serves chats");
      const c2 = r.send("next"); const e2 = await r.engine.next();
      assert.ok(e2, "the next chat reaches the (new) engine at once");
      e2.res.writeHead(200, SSE); e2.res.end(chunk("y") + DONE);
      await c2.result;
      assert.ok(c2.text.endsWith("[DONE]\n\n"));
      void e;
    } finally { await r.done(); }
  }
});

test("queue off, on: while the engine is still computing after an abort, a new chat waits at the gate and isn't sent; it goes once /metrics confirms", async (t) => {
  const r = await rig(); t.after(r.done);
  const a = r.send("a"); const ea = await r.engine.next();
  ea.res.writeHead(200, SSE); ea.res.write(chunk("a"));
  await waitFor(() => a.text.includes('"a"'), 3000, "chunk");
  r.engine.busy = 1; // the engine keeps computing after the transport abort
  await r.clock.advance(120_000);
  await a.result;
  assert.equal(r.T.engineState(), "confirming");
  const b = r.send("b");
  await sleep(50);
  await r.clock.advance(10_000);
  assert.equal(r.engine.requests.length, 1, "b was not sent while the engine was busy");
  assert.equal(b.status, null);
  r.engine.busy = 0;
  await r.clock.advance(5_000);
  const eb = await r.engine.next();
  assert.equal(r.T.engineState(), "ready");
  eb.res.writeHead(200, SSE); eb.res.end(chunk("b") + DONE);
  await b.result;
  assert.ok(b.text.endsWith("[DONE]\n\n"));
});

test("queue on, on: the slot stays owned until confirmation; three waiting chats then run first in, first out; one release per admitted chat", async (t) => {
  const r = await rig({ queue: true }); t.after(r.done);
  const a = r.send("a"); const ea = await r.engine.next();
  ea.res.writeHead(200, SSE); ea.res.write(chunk("a"));
  await waitFor(() => a.text.includes('"a"'), 3000, "chunk");
  const others = [];
  for (const n of ["b", "c", "d"]) { others.push(r.send(n)); await waitFor(() => r.queue.stats().waiting === others.length, 3000, `${n} queued`); }
  r.engine.busy = 1;
  await r.clock.advance(120_000);
  await a.result;
  assert.equal(lastEvent(a.text).error.phase, "idle");
  await r.clock.advance(20_000);
  assert.deepEqual(r.queue.stats(), { running: 1, waiting: 3, limit: 4 }, "the aborted request's slot is still owned (by the confirmation)");
  assert.equal(r.engine.requests.length, 1, "nothing new was sent");
  r.engine.busy = 0;
  const order = [];
  for (let i = 0; i < 3; i++) {
    await r.clock.advance(i === 0 ? 5_000 : 0);
    const e = await r.engine.next();
    order.push(e.body.messages.at(-1).content);
    e.res.writeHead(200, SSE); e.res.end(chunk("ok") + DONE);
    await others[i].result;
  }
  assert.deepEqual(order, ["b", "c", "d"], "FIFO");
  await waitFor(() => r.queue.stats().running === 0, 3000, "idle queue");
  assert.deepEqual(r.queue.stats(), { running: 0, waiting: 0, limit: 4 });
  assert.equal(r.releases(), 4, "exactly one release per admitted chat");
});

test("queue on, on: no confirmation → UNRESPONSIVE: waiting chats get 503 ENGINE_UNRESPONSIVE + Retry-After in order, new chats at once; recovery on quiet /metrics; the queue ends empty", async (t) => {
  const r = await rig({ queue: true }); t.after(r.done);
  const a = r.send("a"); const ea = await r.engine.next();
  ea.res.writeHead(200, SSE); ea.res.write(chunk("a"));
  await waitFor(() => a.text.includes('"a"'), 3000, "chunk");
  r.engine.metricsMode = "hang";
  const b = r.send("b"); await waitFor(() => r.queue.stats().waiting === 1, 3000, "b queued");
  const c = r.send("c"); await waitFor(() => r.queue.stats().waiting === 2, 3000, "c queued");
  await r.clock.advance(120_000); // idle timeout
  await a.result;
  const finished = [];
  b.result.then(() => finished.push("b")); c.result.then(() => finished.push("c"));
  await r.clock.advance(126_000); // confirmation window
  await Promise.all([b.result, c.result]);
  for (const x of [b, c]) {
    assert.equal(x.status, 503);
    assert.equal(JSON.parse(x.text).code, "ENGINE_UNRESPONSIVE");
    assert.equal(x.headers["retry-after"], "30");
  }
  assert.deepEqual(finished, ["b", "c"], "answered first in, first out");
  const d = r.send("d"); await d.result;
  assert.equal(d.status, 503, "refused at once while UNRESPONSIVE");
  assert.equal(r.engine.requests.length, 1, "nothing was sent to the engine");
  r.engine.metricsMode = "normal";
  await r.clock.advance(35_000);
  assert.equal(r.T.engineState(), "ready");
  const e = r.send("e"); const ee = await r.engine.next();
  ee.res.writeHead(200, SSE); ee.res.end(chunk("ok") + DONE);
  await e.result;
  assert.ok(e.text.endsWith("[DONE]\n\n"));
  await waitFor(() => r.queue.stats().running === 0, 3000, "idle queue");
  assert.deepEqual(r.queue.stats(), { running: 0, waiting: 0, limit: 4 });
  const s = r.T.snapshot();
  assert.ok(s.counts.refusedUnresponsive >= 3); assert.equal(s.counts.cancelUnconfirmed, 1); assert.equal(s.counts.recovered, 1);
});

test("out-of-memory retry: a fresh deadline after the engine restart (restart time not counted); the retry count stays 1", async (t) => {
  // (a) OOM at 500 s; the restart takes 200 s; the retry answers 550 s after its own write: no timeout.
  {
    let clockRef;
    const r = await rig({ startLlm: async () => { r2.state.llmProcSeq++; await clockRef.advance(200_000); } });
    const r2 = r; clockRef = r.clock;
    try {
      const c = r.send("x"); const e1 = await r.engine.next();
      await r.clock.advance(500_000);
      e1.res.writeHead(500, { "Content-Type": "application/json" }); e1.res.end(JSON.stringify({ error: { message: "ggml: failed to allocate buffer" } }));
      const e2 = await r.engine.next();
      await r.clock.advance(550_000);
      assert.equal(c.ended, false, "no timeout: the retry's deadline started at its own write");
      e2.res.writeHead(200, SSE); e2.res.end(chunk("ok") + DONE);
      await c.result;
      assert.ok(c.text.endsWith("[DONE]\n\n"));
      assert.equal(r.T.snapshot().counts.firstByte, 0);
    } finally { await r.done(); }
  }
  // (b) The retry stalls too: it times out on its own deadline, and there is no third attempt.
  {
    const r = await rig();
    try {
      const c = r.send("x"); const e1 = await r.engine.next();
      e1.res.writeHead(500, { "Content-Type": "application/json" }); e1.res.end(JSON.stringify({ error: { message: "out of memory" } }));
      await r.engine.next();
      await r.clock.advance(600_000);
      await c.result;
      assert.equal(c.status, 504);
      await r.clock.advance(1_000_000);
      assert.equal(r.engine.requests.length, 2, "no further attempt after the timeout");
    } finally { await r.done(); }
  }
});

test("observe: a stall is only recorded; the engine request stays open and completes normally; no probe, no gate, the queue slot is released at once", async (t) => {
  const r = await rig({ mode: "observe", queue: true }); t.after(r.done);
  const c = r.send("x"); const e = await r.engine.next();
  e.res.writeHead(200, SSE); e.res.write(chunk("x"));
  await waitFor(() => c.text.includes('"x"'), 3000, "chunk");
  await r.clock.advance(700_000);
  assert.equal(e.closed, false, "observe never aborts");
  e.res.end(DONE);
  await c.result;
  assert.ok(c.text.endsWith("[DONE]\n\n"));
  assert.ok(!c.text.includes("ENGINE_TIMEOUT"));
  const s = r.T.snapshot();
  assert.equal(s.wouldHaveTimedOut.idle, 1);
  assert.equal(r.engine.metricsCalls, 0);
  await waitFor(() => r.queue.stats().running === 0, 3000, "released");
  // A client cancel in observe: the legacy stream abort only.
  const c2 = r.send("y"); const e2 = await r.engine.next();
  c2.abort();
  await waitFor(() => e2.closed, 3000, "legacy stream abort");
  await r.clock.advance(60_000);
  assert.equal(r.engine.metricsCalls, 0);
  assert.equal(r.releases(), 2);
});

// ── 3. The real server with the fake engine ─────────────────────────────────────────────────────────────
async function serverWith(env, file) {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, "app", "llm-models", "t.gguf"), Buffer.from("GGUF\x03\x00\x00\x00"));
  if (file) { fs.mkdirSync(path.join(root, "app", "config"), { recursive: true }); fs.writeFileSync(path.join(root, "app", "config", "scheduler.json"), JSON.stringify(file)); }
  const srv = await startServer(root, env);
  const start = await request(srv.port, "POST", "/api/llm/start", { body: { model: "t.gguf", gpuLayers: 0 } });
  assert.equal(start.status, 200, start.text);
  await waitFor(async () => (await request(srv.port, "GET", "/api/llm/status")).json.ready, 20000, "ready");
  srv.enginePort = (await request(srv.port, "GET", "/api/llm/status")).json.port;
  return { root, srv };
}
async function close({ root, srv }) {
  try { await request(srv.port, "POST", "/api/llm/stop", { body: {} }); } catch (_) { /* down */ }
  stopServer(srv); await sleep(300);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* Windows may hold files briefly */ }
}
function chat(port, content, { stream = true, abortAfterMs } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/llm/chat", agent: false, headers: { "Content-Type": "application/json" } }, (res) => {
      let text = ""; res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
      res.on("aborted", () => resolve({ cut: true, status: res.statusCode, text }));
    });
    req.on("error", () => resolve({ cut: true }));
    req.end(JSON.stringify({ messages: [{ role: "user", content }], stream }));
    if (abortAfterMs) setTimeout(() => req.destroy(), abortAfterMs);
  });
}
const engineStats = async (s) => JSON.parse((await request(s.srv.enginePort, "GET", "/fake/stats")).text);
const resources = async (s) => (await request(s.srv.port, "GET", "/api/resources"));

test("server: off by default: no new /api/resources keys; a cancelled stream is the legacy abort; no /metrics probe; non-streaming cancel is not aborted (legacy)", async (t) => {
  const s = await serverWith({}); t.after(() => close(s));
  const r = (await resources(s)).json;
  assert.equal("chatTimeouts" in r, false);
  assert.equal("runningTimeouts" in r.limits, false);
  await chat(s.srv.port, "MODE:stall", { abortAfterMs: 300 });
  await chat(s.srv.port, "MODE:stall", { stream: false, abortAfterMs: 300 });
  await sleep(500);
  const st = await engineStats(s);
  assert.equal(st.metricsRequests, 0);
  assert.equal(st.aborted, 1, "only the streaming request was aborted, as before");
  assert.equal(st.open, 1, "the non-streaming request is left to the engine (legacy)");
});

test("server: observe answers byte-identically to off (streaming, non-streaming, engine error) and only adds the report", async (t) => {
  const bodies = {};
  for (const mode of ["off", "observe"]) {
    const s = await serverWith(mode === "off" ? {} : { USAP_CHAT_TIMEOUTS: "observe" });
    try {
      bodies[mode] = [await chat(s.srv.port, "hi"), await chat(s.srv.port, "hi", { stream: false }), await chat(s.srv.port, "MODE:http-error"), await chat(s.srv.port, "MODE:count=40")]
        .map((x) => ({ status: x.status, type: x.headers["content-type"], text: x.text }));
      const r = (await resources(s)).json;
      if (mode === "observe") { assert.equal(r.chatTimeouts.mode, "observe"); assert.equal(r.limits.runningTimeouts, "observe"); assert.equal(r.chatTimeouts.engine, undefined); }
      assert.equal((await engineStats(s)).metricsRequests, 0, `${mode}: no probe`);
    } finally { await close(s); }
  }
  assert.deepEqual(bodies.observe, bodies.off);
});

test("server: settings resolution end to end: file on with invalid values (ignored and logged, defaults kept); the environment wins; USAP_SCHEDULER=off restores legacy", async (t) => {
  {
    const s = await serverWith({ USAP_CHAT_IDLE_SECONDS: "15" }, { chatTimeouts: "on", chatIdleSeconds: 20, chatFirstByteSeconds: "abc", chatCancelConfirmSeconds: 5 });
    try {
      const r = (await resources(s)).json.chatTimeouts;
      assert.deepEqual([r.mode, r.idleSeconds, r.firstByteSeconds, r.cancelConfirmSeconds, r.nonStreamTotalSeconds, r.engine], ["on", 15, 600, 120, 300, "ready"]);
      const log = s.srv.log();
      assert.match(log, /\[timeouts\] ignored chatFirstByteSeconds from scheduler\.json/);
      assert.match(log, /\[timeouts\] ignored chatCancelConfirmSeconds from scheduler\.json/);
      assert.ok(!log.includes("abc"), "the rejected value is not logged");
    } finally { await close(s); }
  }
  {
    const s = await serverWith({ USAP_CHAT_TIMEOUTS: "off" }, { chatTimeouts: "on" });
    try { assert.equal("chatTimeouts" in (await resources(s)).json, false, "environment off over file on"); } finally { await close(s); }
  }
  {
    const s = await serverWith({ USAP_SCHEDULER: "off", USAP_CHAT_TIMEOUTS: "on" });
    try {
      assert.equal((await resources(s)).status, 404, "the resources route is gone, as before");
      await chat(s.srv.port, "MODE:stall", { stream: false, abortAfterMs: 300 });
      await sleep(500);
      const st = await engineStats(s);
      assert.deepEqual([st.metricsRequests, st.aborted, st.open], [0, 0, 1], "legacy: no probe, the non-streaming request not aborted");
    } finally { await close(s); }
  }
});

test("server, on with the smallest limits (idle 10 s, confirmation 10 s, probe 5 s): a stall ends with the in-stream error and no [DONE]; /metrics confirms; a hung /metrics leads to 503 ENGINE_UNRESPONSIVE and recovery", { timeout: 120000 }, async (t) => {
  const s = await serverWith({ USAP_CHAT_TIMEOUTS: "on", USAP_CHAT_IDLE_SECONDS: "10", USAP_CHAT_CANCEL_CONFIRM_SECONDS: "10", USAP_CHAT_UNRESPONSIVE_PROBE_SECONDS: "5" });
  t.after(() => close(s));
  const t0 = Date.now();
  const a = await chat(s.srv.port, "MODE:partial-stall");
  const took = Date.now() - t0;
  assert.ok(took >= 9500 && took < 20000, `idle limit ~10 s (took ${took} ms)`);
  assert.equal(a.status, 200);
  const ev = lastEvent(a.text);
  assert.deepEqual([ev.error.code, ev.error.phase], ["ENGINE_TIMEOUT", "idle"]);
  assert.ok(a.text.includes("partial-2") && !a.text.includes("[DONE]"));
  await waitFor(async () => (await resources(s)).json.chatTimeouts.engine === "ready", 15000, "confirmed");
  const snap = (await resources(s)).json.chatTimeouts;
  assert.deepEqual([snap.counts.idle, snap.counts.cancelConfirmed], [1, 1]);
  assert.ok(snap.last.confirmSeconds >= 3, "confirmation needs two quiet readings >= 3 s apart");
  assert.equal((await engineStats(s)).aborted, 1);
  assert.equal((await chat(s.srv.port, "hi")).status, 200, "chats work again");
  // Now /metrics hangs: the abort can't be confirmed.
  await request(s.srv.enginePort, "POST", "/fake/metrics", { body: { mode: "hang" } });
  await chat(s.srv.port, "MODE:stall", { abortAfterMs: 300 });
  await waitFor(async () => (await resources(s)).json.chatTimeouts.engine === "unresponsive", 25000, "unresponsive");
  const refused = await chat(s.srv.port, "hi");
  assert.equal(refused.status, 503);
  assert.equal(JSON.parse(refused.text).code, "ENGINE_UNRESPONSIVE");
  assert.equal(refused.headers["retry-after"], "30");
  await request(s.srv.enginePort, "POST", "/fake/metrics", { body: { mode: "normal" } });
  await waitFor(async () => (await resources(s)).json.chatTimeouts.engine === "ready", 25000, "recovered");
  assert.equal((await chat(s.srv.port, "hi")).status, 200);
  const privacy = JSON.stringify((await resources(s)).json.chatTimeouts);
  assert.ok(!/gguf|MODE:|partial|127\.0\.0\.1|\/home|\\\\/.test(privacy), "the report holds numbers and fixed words only");
});

test("the WebUI fixture for a streaming timeout has the shape the original WebUI treats as an error (data event with `error`, no [DONE])", () => {
  const text = fs.readFileSync(FIXTURE, "utf8");
  const events = sseEvents(text);
  assert.ok(events.length >= 2);
  const last = JSON.parse(events.at(-1).replace(/^data: /, ""));
  assert.equal(last.error.code, "ENGINE_TIMEOUT");
  assert.ok(!text.includes("[DONE]"));
  // The WebUI's parser (app/frontend/src/services/api.js) throws on parsed.error before anything else.
  const api = fs.readFileSync(path.join(REPO, "app", "frontend", "src", "services", "api.js"), "utf8");
  assert.match(api, /if \(parsed\.error\) \{\s*throw new Error/);
  void QUIESCE_GAP_MS;
});
