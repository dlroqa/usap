// Step 9.9e: thread budget, whisper only (services/thread-budget.cjs). Off by default. When on, a transcription that
// starts while a chat runs, an image generates or a voice job runs gets max(1, min(requested, 2, logical CPUs - 1))
// whisper threads; alone it gets the requested count, as before. The text and image engines, Kokoro, the chat queue,
// the memory check and model loading are untouched. Busy flags come from server state only.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { makeRoot, startServer, stopServer, request, fakeLlamaPath, installFakeSdServer, IS_WIN } = require("./api-contract/harness.cjs");
const { createThreadBudget, perJobThreads, threadsSetting, SHARE } = require("../server/services/thread-budget.cjs");
const { createScheduler } = require("../server/services/scheduler.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000, label = "condition") {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${label}`); await sleep(50); }
}
const made = [];
test.after(() => { for (const d of made) try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* Windows */ } });

// ── Unit: the rule ────────────────────────────────────────────────────────────
test("rule: alone, the requested count is used unchanged on every machine size", () => {
  for (const cpus of [1, 2, 3, 4, 8, 16, 64, null]) {
    for (const requested of [1, 2, 4, 8, 32]) {
      assert.deepEqual(perJobThreads({ requested, logicalCpus: cpus, othersBusy: false }), { threads: requested, reduced: false, reason: "alone" });
    }
  }
});

test("rule: with another workload busy, max(1, min(requested, 2, cpus - 1)); low-core machines never get capacity they don't have", () => {
  const table = [
    // cpus, requested, threads
    [1, 4, 1], [2, 4, 1], [3, 4, 2], [4, 4, 2], [16, 8, 2], [64, 32, 2],
    [4, 1, 1], [4, 2, 2], [2, 1, 1], [1, 1, 1],
  ];
  for (const [cpus, requested, threads] of table) {
    const d = perJobThreads({ requested, logicalCpus: cpus, othersBusy: true });
    assert.equal(d.threads, threads, `cpus ${cpus}, requested ${requested}`);
    assert.equal(d.reduced, threads < requested);
    assert.equal(d.reason, threads < requested ? "other-workload-busy" : "within-share");
    assert.ok(d.threads <= requested, "never more than requested");
    assert.ok(d.threads <= Math.max(1, cpus - 1) || cpus === 1, "never the whole machine");
  }
  assert.equal(SHARE, 2);
  assert.deepEqual(perJobThreads({ requested: 4, logicalCpus: null, othersBusy: true }), { threads: 4, reduced: false, reason: "cpu-count-unknown" });
  assert.deepEqual(perJobThreads({ requested: 4, logicalCpus: 0, othersBusy: true }), { threads: 4, reduced: false, reason: "cpu-count-unknown" });
  assert.equal(perJobThreads({ requested: 0, logicalCpus: 4, othersBusy: true }).reason, "requested-invalid");
});

test("setting: off by default; on through USAP_THREADS or scheduler.json; the environment wins; USAP_SCHEDULER=off turns it off", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "usap-threads-")); made.push(d);
  assert.equal(threadsSetting({ env: {}, configDir: d }).mode, "off");
  assert.equal(threadsSetting({ env: { USAP_THREADS: "on" }, configDir: d }).mode, "on");
  assert.equal(threadsSetting({ env: { USAP_THREADS: "max" }, configDir: d }).mode, "off");
  fs.writeFileSync(path.join(d, "scheduler.json"), JSON.stringify({ threads: "on" }));
  assert.equal(threadsSetting({ env: {}, configDir: d }).mode, "on");
  assert.equal(threadsSetting({ env: { USAP_THREADS: "off" }, configDir: d }).mode, "off", "the environment wins");
  assert.equal(threadsSetting({ env: { USAP_THREADS: "on" }, configDir: d, schedulerMode: "off" }).mode, "off");
});

test("budget: off returns the request and records nothing; on records each decision and logs only reductions; failures fall back to the request", () => {
  const lines = [];
  const off = createThreadBudget({ setting: { mode: "off" }, logicalCpus: () => 4, activity: () => ({ chat: true }), log: (l) => lines.push(l) });
  assert.equal(off.forTranscription(4), 4);
  assert.equal(off.snapshot(), null);
  let busy = {};
  const on = createThreadBudget({ setting: { mode: "on" }, logicalCpus: () => 4, activity: () => busy, log: (l) => lines.push(l), now: () => 0 });
  assert.equal(on.forTranscription(4), 4);
  assert.deepEqual(on.snapshot().lastTranscription, { job: "transcription", requested: 4, threads: 4, reduced: false, reason: "alone", busy: [], logicalCpus: 4, at: "1970-01-01T00:00:00.000Z" });
  assert.deepEqual(lines, []);
  busy = { chat: true, image: false, voice: "yes" }; // only === true counts
  assert.equal(on.forTranscription(6), 2);
  assert.deepEqual(on.snapshot().lastTranscription.busy, ["chat"]);
  assert.deepEqual(lines, ["  [threads] Transcription: 2 threads instead of 6 (chat busy). Other engines unchanged."]);
  const broken = createThreadBudget({ setting: { mode: "on" }, logicalCpus: () => { throw new Error("x"); }, activity: () => { throw new Error("x"); }, log: () => { throw new Error("x"); } });
  assert.equal(broken.forTranscription(4), 4);
  assert.equal(broken.snapshot().lastTranscription.reason, "activity-unknown");
  const noCpus = createThreadBudget({ setting: { mode: "on" }, logicalCpus: () => { throw new Error("x"); }, activity: () => ({ chat: true }), log: () => { throw new Error("x"); } });
  assert.equal(noCpus.forTranscription(4), 4);
  assert.equal(noCpus.snapshot().lastTranscription.reason, "cpu-count-unknown");
  const tiny = createThreadBudget({ setting: { mode: "on" }, logicalCpus: () => 1, activity: () => ({ image: true }), log: () => {} });
  assert.equal(tiny.forTranscription(4), 1, "a 1-CPU machine still runs the job with 1 thread");
});

test("scheduler snapshot: threads on adds limits.threads 'on' and the budget report; off is exactly the previous snapshot", () => {
  const cpu = { logicalCores: () => 4, physicalCores: () => 2 };
  const eng = { text: () => ({ state: "stopped", loaded: false }), image: () => ({ state: "stopped", loaded: false }), speech: () => ({ state: "stopped" }), voice: () => ({ state: "stopped" }), download: () => ({}), heavyModel: () => null };
  const budget = { totalRamBytes: () => 1, freeRamBytes: () => 1, totalVramBytes: () => 0, freeVramBytes: () => null };
  const base = createScheduler({ cpu, budget, engines: eng, memoryCheck: { mode: "warn" }, memoryChecks: () => null, now: () => 0 }).snapshot();
  const off = createScheduler({ cpu, budget, engines: eng, memoryCheck: { mode: "warn" }, memoryChecks: () => null, threads: { mode: "off" }, threadBudget: () => ({ x: 1 }), now: () => 0 }).snapshot();
  assert.deepEqual(off, base, "off: identical to the 9.9d snapshot");
  assert.equal(off.limits.threads, "off");
  assert.equal("threads" in off, false);
  const on = createScheduler({ cpu, budget, engines: eng, memoryCheck: { mode: "warn" }, threads: { mode: "on" }, threadBudget: () => ({ mode: "on", lastTranscription: null }), now: () => 0 }).snapshot();
  assert.equal(on.limits.threads, "on");
  assert.deepEqual(on.scheduler, { mode: "observe", stage: "9.9e", decisions: true });
  assert.deepEqual(on.threads, { mode: "on", lastTranscription: null });
  const broken = createScheduler({ cpu, budget, engines: eng, threads: { mode: "on" }, threadBudget: () => { throw new Error("x"); } }).snapshot();
  assert.equal(broken.threads, null);
});

// ── The real server: fake llama-server, fake sd-server and a whisper-cli stand-in that records its -t ──────────
const FAKE_WHISPER = `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
const arg = (k) => { const i = a.indexOf(k); return i === -1 ? null : a[i + 1]; };
const log = process.env.FAKE_WHISPER_LOG;
if (log) fs.appendFileSync(log, "t=" + arg("-t") + "\\n");
if (/crash/.test(String(arg("-m")))) process.abort();
fs.writeFileSync(arg("-of") + ".txt", " fake transcript\\n");
fs.writeFileSync(arg("-of") + ".json", JSON.stringify({ result: { language: "en" }, transcription: [{ text: "fake transcript" }] }));
process.exit(0);
`;
function installFakeWhisper(root) {
  const dir = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
  const cli = path.join(root, "app", "speech-backend", dir, "cpu", IS_WIN ? "whisper-cli.exe" : "whisper-cli");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  if (IS_WIN) {
    fs.copyFileSync(fakeLlamaPath(root), cli);
    fs.writeFileSync(path.join(path.dirname(cli), "fake-llama-server.cjs"), FAKE_WHISPER);
  } else {
    fs.writeFileSync(cli, FAKE_WHISPER);
    fs.chmodSync(cli, 0o755);
  }
  for (const m of ["ggml-test.bin", "ggml-crash.bin"]) fs.writeFileSync(path.join(root, "app", "speech-models", m), "fake whisper model");
}
function wav() {
  const data = Buffer.alloc(3200); const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
function sdModel(root, name) {
  const kv = (key, type, val) => {
    const k = Buffer.from(key); const head = Buffer.alloc(8 + k.length + 4); head.writeBigUInt64LE(BigInt(k.length)); k.copy(head, 8); head.writeUInt32LE(type, 8 + k.length);
    if (type === 8) { const v = Buffer.from(val); const b = Buffer.alloc(8 + v.length); b.writeBigUInt64LE(BigInt(v.length)); v.copy(b, 8); return Buffer.concat([head, b]); }
    const b = Buffer.alloc(4); b.writeUInt32LE(val); return Buffer.concat([head, b]);
  };
  const h = Buffer.alloc(24); h.write("GGUF"); h.writeUInt32LE(3, 4); h.writeBigUInt64LE(0n, 8); h.writeBigUInt64LE(2n, 16);
  const file = path.join(root, "app", "models", name);
  fs.writeFileSync(file, Buffer.concat([h, kv("general.architecture", 8, "sd1"), kv("general.file_type", 4, 2)]));
  fs.truncateSync(file, 130 * 1024 * 1024);
}

async function server(env = {}, { image = false } = {}) {
  const root = makeRoot();
  installFakeWhisper(root);
  if (image) { installFakeSdServer(root); sdModel(root, "sd1-slow-generate-q4_0.gguf"); }
  fs.writeFileSync(path.join(root, "app", "llm-models", "threads.gguf"), Buffer.from("GGUF\x03\x00\x00\x00"));
  const whisperLog = path.join(root, "whisper-threads.log");
  const srv = await startServer(root, { FAKE_WHISPER_LOG: whisperLog, ...env });
  return { root, srv, whisperLog };
}
async function close({ root, srv }) {
  for (const p of ["/api/llm/stop", "/api/stop-backend"]) { try { await request(srv.port, "POST", p, { body: {} }); } catch (_) { /* down */ } }
  stopServer(srv); await sleep(300);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* Windows may hold files briefly */ }
}
async function loadText(s) {
  const r = await request(s.srv.port, "POST", "/api/llm/start", { body: { model: "threads.gguf", contextSize: 512, gpuLayers: 0 } });
  assert.equal(r.status, 200, r.text);
  await waitFor(async () => (await request(s.srv.port, "GET", "/api/llm/status")).json.ready, 20000, "text ready");
  s.enginePort = (await request(s.srv.port, "GET", "/api/llm/status")).json.port;
}
function chat(port, content) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/llm/chat", headers: { "Content-Type": "application/json" } }, (res) => {
      let text = ""; res.on("data", (c) => { text += c; }); res.on("end", () => resolve({ status: res.statusCode, text })); res.on("aborted", () => resolve({ cut: true, text }));
    });
    req.on("error", () => resolve({ cut: true }));
    req.end(JSON.stringify({ messages: [{ role: "user", content }], stream: true }));
  });
}
const transcribe = (s, { threads = null, model = "ggml-test.bin" } = {}) => request(s.srv.port, "POST",
  `/api/speech/transcribe?model=${model}&language=en&save=false&filename=a.wav${threads ? `&threads=${threads}` : ""}`, { body: wav(), headers: { "Content-Type": "audio/wav" } });
const usedThreads = (s) => fs.readFileSync(s.whisperLog, "utf8").trim().split("\n").map((l) => Number(l.replace("t=", "")));
const lastThreads = (s) => usedThreads(s).at(-1);
const engineStats = async (s) => JSON.parse((await request(s.enginePort, "GET", "/fake/stats")).text);
const release = (s) => request(s.enginePort, "POST", "/fake/release", { body: {} }).catch(() => {});
// Returns { done } (not the promise itself: an async function returning a promise would wait for the chat to end).
async function holdChat(s) {
  const done = chat(s.srv.port, "MODE:hold TAG:busy");
  await waitFor(async () => (await engineStats(s)).held === 1, 10000, "chat held in the engine");
  return { done };
}
const expectedBusy = (requested) => perJobThreads({ requested, logicalCpus: os.cpus().length, othersBusy: true }).threads;

test("server, default (off): whisper gets the requested threads even while a chat runs; nothing new is reported", async (t) => {
  const s = await server();
  t.after(() => close(s));
  await loadText(s);
  assert.equal((await transcribe(s)).status, 200);
  assert.equal((await transcribe(s, { threads: 6 })).status, 200);
  const held = await holdChat(s);
  assert.equal((await transcribe(s, { threads: 4 })).status, 200);
  await release(s);
  assert.equal((await held.done).status, 200);
  assert.deepEqual(usedThreads(s), [Math.max(1, Math.min(8, os.cpus().length)), 6, 4], "requested counts, as before 9.9e");
  const r = (await request(s.srv.port, "GET", "/api/resources")).json;
  assert.equal(r.limits.threads, "off");
  assert.equal("threads" in r, false);
  assert.ok(!s.srv.log().includes("[threads]"));
});

test("server, USAP_THREADS=on: alone unchanged; while a chat runs the job gets the reduced count; the chat itself is untouched", async (t) => {
  const s = await server({ USAP_THREADS: "on" });
  t.after(() => close(s));
  await loadText(s);
  assert.equal((await transcribe(s, { threads: 4 })).status, 200);
  assert.equal(lastThreads(s), 4, "alone: requested");
  assert.equal((await transcribe(s, { threads: 1 })).status, 200);
  assert.equal(lastThreads(s), 1);
  const held = await holdChat(s);
  const busy = await transcribe(s, { threads: 4 });
  assert.equal(busy.status, 200);
  assert.equal(busy.json.ok, true);
  assert.equal(lastThreads(s), expectedBusy(4), "chat running: reduced");
  const r = (await request(s.srv.port, "GET", "/api/resources")).json;
  assert.equal(r.limits.threads, "on");
  assert.deepEqual({ requested: r.threads.lastTranscription.requested, threads: r.threads.lastTranscription.threads, busy: r.threads.lastTranscription.busy },
    { requested: 4, threads: expectedBusy(4), busy: ["chat"] });
  await release(s);
  const finished = await held.done;
  assert.equal(finished.status, 200);
  assert.ok(finished.text.trimEnd().endsWith("data: [DONE]"), "the chat completes normally");
  assert.equal((await transcribe(s, { threads: 4 })).status, 200);
  assert.equal(lastThreads(s), 4, "after the chat: requested again");
  const st = (await request(s.srv.port, "GET", "/api/llm/status")).json;
  assert.equal(st.settings.threads, Math.max(1, Math.min(16, os.cpus().length)), "the text engine's own threads are unchanged");
  assert.ok(s.srv.log().includes("[threads] Transcription:"));
});

test("server, USAP_THREADS=on: an image generating counts as busy; the image engine's own threads are unchanged", async (t) => {
  const s = await server({ USAP_THREADS: "on" }, { image: true });
  t.after(() => close(s));
  const load = await request(s.srv.port, "POST", "/api/restart-backend", { body: { model: "sd1-slow-generate-q4_0.gguf", backend_type: "cpu", use_gpu: false, width: 64, height: 64, steps: 4 } });
  assert.equal(load.status, 200, load.text);
  await waitFor(async () => (await request(s.srv.port, "GET", "/api/backend-status")).json.ready, 20000, "image ready");
  const threadsBefore = (await request(s.srv.port, "GET", "/api/backend-status")).json.settings.threads;
  const gen = request(s.srv.port, "POST", "/sdapi/v1/txt2img", { body: { prompt: "x", steps: 4, width: 64, height: 64, seed: 1, batch_size: 1 } });
  await sleep(300); // the request is in flight (the fake takes 3 s)
  assert.equal((await transcribe(s, { threads: 4 })).status, 200);
  assert.equal(lastThreads(s), expectedBusy(4));
  assert.equal((await gen).status, 200, "the image is generated normally");
  assert.equal((await transcribe(s, { threads: 4 })).status, 200);
  assert.equal(lastThreads(s), 4, "after the image: requested again");
  assert.equal((await request(s.srv.port, "GET", "/api/backend-status")).json.settings.threads, threadsBefore);
});

test("server, chat queue on + threads on: queue admission is unchanged and a waiting chat isn't double-counted", async (t) => {
  const s = await server({ USAP_THREADS: "on", USAP_CHAT_QUEUE: "on" });
  t.after(() => close(s));
  await loadText(s);
  const held = await holdChat(s);
  const waiting = [];
  for (let i = 1; i <= 4; i++) {
    waiting.push(chat(s.srv.port, `MODE:delay=20 TAG:w${i}`));
    await waitFor(async () => (await request(s.srv.port, "GET", "/api/resources")).json.engines.text.chat.waitingForEngineConnection === i, 10000, `w${i} waiting`);
  }
  const refused = await chat(s.srv.port, "MODE:delay=20 TAG:full");
  assert.equal(refused.status, 429);
  assert.equal(JSON.parse(refused.text).code, "QUEUE_FULL");
  assert.equal((await transcribe(s, { threads: 4 })).status, 200);
  assert.equal(lastThreads(s), expectedBusy(4));
  await release(s);
  assert.deepEqual((await Promise.all([held.done, ...waiting])).map((r) => r.status), [200, 200, 200, 200, 200]);
});

test("server: an engine crash while busy, a whisper crash, and USAP_SCHEDULER=off all leave the legacy behaviour", async (t) => {
  const s = await server({ USAP_THREADS: "on" });
  t.after(() => close(s));
  await loadText(s);
  const { pid } = await engineStats(s);
  const held = await holdChat(s);
  process.kill(pid, "SIGKILL");
  await held.done; // the chat ends (cut) with the engine
  await waitFor(async () => (await request(s.srv.port, "GET", "/api/resources")).json.engines.text.chat.active === 0, 10000, "chat no longer active");
  assert.equal((await transcribe(s, { threads: 4 })).status, 200);
  assert.equal(lastThreads(s), 4, "after the crash nothing is busy: requested");
  const crashed = await transcribe(s, { threads: 4, model: "ggml-crash.bin" });
  assert.equal(crashed.status, 500, "a crashing whisper fails as before");
  assert.equal((await transcribe(s, { threads: 4 })).status, 200, "and the next job works");

  const off = await server({ USAP_THREADS: "on", USAP_SCHEDULER: "off" });
  t.after(() => close(off));
  await loadText(off);
  const held2 = await holdChat(off);
  assert.equal((await transcribe(off, { threads: 4 })).status, 200);
  assert.equal(lastThreads(off), 4, "scheduler off: requested");
  assert.equal((await request(off.srv.port, "GET", "/api/resources")).status, 404);
  await release(off);
  await held2.done;
});
