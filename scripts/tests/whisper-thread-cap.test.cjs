// Whisper logical-CPU cap (services/whisper-thread-cap.cjs). On by default: a transcription passes whisper.cpp
// min(requested, logical CPUs) threads; a request at or below the CPU count is unchanged; an unknown CPU count changes
// nothing. It runs before the optional 9.9e budget. USAP_WHISPER_THREAD_CAP=off, scheduler.json
// "whisperThreadCap": "off" and USAP_SCHEDULER=off restore the previous behaviour exactly. The text and image engines,
// Kokoro, saved settings and the transcription response are untouched.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { makeRoot, startServer, stopServer, request, fakeLlamaPath, installFakeSdServer, IS_WIN } = require("./api-contract/harness.cjs");
const { createWhisperThreadCap, capWhisperThreads, whisperThreadCapSetting } = require("../server/services/whisper-thread-cap.cjs");
const { createThreadBudget, perJobThreads } = require("../server/services/thread-budget.cjs");
const { createScheduler } = require("../server/services/scheduler.cjs");

const CPUS = os.cpus().length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000, label = "condition") {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${label}`); await sleep(50); }
}
const made = [];
test.after(() => { for (const d of made) try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* Windows */ } });

// ── Unit: the rule ────────────────────────────────────────────────────────────
test("rule: min(requested, logical CPUs) on 1, 2, 3, 4 and larger machines; never raised; at or below the CPUs unchanged", () => {
  for (const cpus of [1, 2, 3, 4, 6, 8, 16, 64, 128]) {
    for (const requested of [1, 2, 3, 4, 5, 6, 8, 16, 32]) {
      const d = capWhisperThreads({ requested, logicalCpus: cpus });
      assert.equal(d.threads, Math.min(requested, cpus), `cpus ${cpus}, requested ${requested}`);
      assert.ok(d.threads <= requested, "never more than requested");
      assert.ok(d.threads >= 1);
      assert.equal(d.capped, requested > cpus);
      assert.equal(d.reason, requested > cpus ? "above-logical-cpus" : "within-cpus");
    }
  }
  // The measured case: 4 requested on a 3-vCPU machine.
  assert.deepEqual(capWhisperThreads({ requested: 4, logicalCpus: 3 }), { threads: 3, capped: true, reason: "above-logical-cpus" });
  assert.deepEqual(capWhisperThreads({ requested: 3, logicalCpus: 3 }), { threads: 3, capped: false, reason: "within-cpus" });
  assert.deepEqual(capWhisperThreads({ requested: 32, logicalCpus: 1 }), { threads: 1, capped: true, reason: "above-logical-cpus" });
});

test("rule: missing, zero or invalid CPU information changes nothing (no capacity invented, none taken away)", () => {
  for (const logicalCpus of [null, undefined, 0, -1, 1.5, NaN, Infinity, "4", {}, []]) {
    assert.deepEqual(capWhisperThreads({ requested: 8, logicalCpus }), { threads: 8, capped: false, reason: "cpu-count-unknown" }, String(logicalCpus));
  }
  for (const requested of [0, -2, 2.5, NaN, null, "4"]) {
    const d = capWhisperThreads({ requested, logicalCpus: 4 });
    assert.equal(d.reason, "requested-invalid");
    assert.equal(d.capped, false);
    assert.ok(Object.is(d.threads, requested), "passed through untouched");
  }
});

test("setting: on by default; off through USAP_WHISPER_THREAD_CAP or scheduler.json; the environment wins; other values are ignored; USAP_SCHEDULER=off turns it off", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "usap-wcap-")); made.push(d);
  assert.equal(whisperThreadCapSetting({ env: {}, configDir: d }).mode, "on", "default on");
  assert.equal(whisperThreadCapSetting({ env: {} }).mode, "on", "no config folder: default on");
  assert.equal(whisperThreadCapSetting({ env: { USAP_WHISPER_THREAD_CAP: "off" }, configDir: d }).mode, "off");
  assert.equal(whisperThreadCapSetting({ env: { USAP_WHISPER_THREAD_CAP: " OFF " }, configDir: d }).mode, "off", "trimmed, case-insensitive");
  for (const v of ["0", "false", "no", "max", ""]) assert.equal(whisperThreadCapSetting({ env: { USAP_WHISPER_THREAD_CAP: v }, configDir: d }).mode, "on", `ignored: ${JSON.stringify(v)}`);
  fs.writeFileSync(path.join(d, "scheduler.json"), JSON.stringify({ whisperThreadCap: "off" }));
  assert.equal(whisperThreadCapSetting({ env: {}, configDir: d }).mode, "off", "scheduler.json off");
  assert.equal(whisperThreadCapSetting({ env: { USAP_WHISPER_THREAD_CAP: "on" }, configDir: d }).mode, "on", "the environment wins");
  fs.writeFileSync(path.join(d, "scheduler.json"), JSON.stringify({ whisperThreadCap: false }));
  assert.equal(whisperThreadCapSetting({ env: {}, configDir: d }).mode, "on", "only the strings on/off count");
  fs.writeFileSync(path.join(d, "scheduler.json"), "{ not json");
  assert.equal(whisperThreadCapSetting({ env: {}, configDir: d }).mode, "on", "unreadable config: default");
  fs.writeFileSync(path.join(d, "scheduler.json"), "null");
  assert.equal(whisperThreadCapSetting({ env: {}, configDir: d }).mode, "on");
  assert.equal(whisperThreadCapSetting({ env: { USAP_WHISPER_THREAD_CAP: "on" }, configDir: d, schedulerMode: "off" }).mode, "off", "USAP_SCHEDULER=off wins");
  assert.ok(Object.isFrozen(whisperThreadCapSetting({ env: {} })));
});

test("cap object: off passes everything through and reports nothing; on records numbers only and logs only capped jobs; failures fall back to the request", () => {
  const lines = [];
  const off = createWhisperThreadCap({ setting: { mode: "off" }, logicalCpus: () => 2, log: (l) => lines.push(l) });
  assert.equal(off.mode, "off");
  assert.equal(off.forTranscription(32), 32);
  assert.equal(off.snapshot(), null);
  assert.deepEqual(lines, []);

  const on = createWhisperThreadCap({ setting: { mode: "on" }, logicalCpus: () => 3, log: (l) => lines.push(l), now: () => 0 });
  assert.equal(on.forTranscription(2), 2);
  assert.equal(on.forTranscription(3), 3);
  assert.deepEqual(lines, [], "nothing logged when nothing is capped");
  assert.equal(on.forTranscription(4), 3);
  assert.deepEqual(on.snapshot(), { mode: "on", scope: "transcription", rule: "min(requested, logical CPUs)", cappedJobs: 1,
    lastTranscription: { requested: 4, threads: 3, capped: true, reason: "above-logical-cpus", logicalCpus: 3, at: "1970-01-01T00:00:00.000Z" } });
  assert.deepEqual(lines, ["  [threads] Transcription: 3 threads instead of 4 (the server has 3 logical CPUs). Saved settings unchanged."]);
  const snapText = JSON.stringify(on.snapshot());
  assert.ok(!/[\\/]/.test(snapText.replace(/"rule":"[^"]*"/, "")), "no paths in the report");

  for (const bad of [() => { throw new Error("x"); }, () => 0, () => NaN, () => undefined]) {
    const c = createWhisperThreadCap({ setting: { mode: "on" }, logicalCpus: bad, log: () => { throw new Error("log"); } });
    assert.equal(c.forTranscription(16), 16, "unknown CPUs: unchanged");
    assert.equal(c.snapshot().lastTranscription.reason, "cpu-count-unknown");
    assert.equal(c.snapshot().cappedJobs, 0);
  }
  const one = createWhisperThreadCap({ setting: { mode: "on" }, logicalCpus: () => 1, log: () => { throw new Error("log"); } });
  assert.equal(one.forTranscription(4), 1, "a 1-CPU machine runs the job with 1 thread; a failing logger doesn't matter");
});

test("composition with the 9.9e budget: the cap runs first and the budget can only lower its result; both off is the request", () => {
  // The same composition as speech-engine.cjs: budget(cap(requested)), each step lower-only.
  const lowerOnly = (step, n) => { if (!step) return n; try { const t = step.forTranscription(n); return Number.isInteger(t) && t >= 1 && t <= n ? t : n; } catch (_) { return n; } };
  for (const cpus of [1, 2, 3, 4, 8, 16]) {
    for (const requested of [1, 2, 3, 4, 6, 8, 32]) {
      for (const busy of [false, true]) {
        for (const capOn of [false, true]) {
          for (const budgetOn of [false, true]) {
            const cap = createWhisperThreadCap({ setting: { mode: capOn ? "on" : "off" }, logicalCpus: () => cpus, log: () => {} });
            const budget = createThreadBudget({ setting: { mode: budgetOn ? "on" : "off" }, logicalCpus: () => cpus, activity: () => ({ chat: busy }), log: () => {} });
            const got = lowerOnly(budget, lowerOnly(cap, requested));
            const afterCap = capOn ? Math.min(requested, cpus) : requested;
            const want = budgetOn ? perJobThreads({ requested: afterCap, logicalCpus: cpus, othersBusy: busy }).threads : afterCap;
            assert.equal(got, want, `cpus ${cpus} req ${requested} busy ${busy} cap ${capOn} budget ${budgetOn}`);
            assert.ok(got <= requested);
            if (capOn) assert.ok(got <= cpus, "with the cap on, never more than the CPUs");
            if (!capOn && !budgetOn) assert.equal(got, requested, "both off: the request, exactly");
          }
        }
      }
    }
  }
});

test("scheduler snapshot: no reporter is exactly the previous snapshot; a report adds one top-level key and leaves limits and scheduler unchanged", () => {
  const cpu = { logicalCores: () => 4, physicalCores: () => 2 };
  const eng = { text: () => ({ state: "stopped", loaded: false }), image: () => ({ state: "stopped", loaded: false }), speech: () => ({ state: "stopped" }), voice: () => ({ state: "stopped" }), download: () => ({}), heavyModel: () => null };
  const budget = { totalRamBytes: () => 1, freeRamBytes: () => 1, totalVramBytes: () => 0, freeVramBytes: () => null };
  const base = createScheduler({ cpu, budget, engines: eng, memoryCheck: { mode: "warn" }, memoryChecks: () => null, now: () => 0 }).snapshot();
  const none = createScheduler({ cpu, budget, engines: eng, memoryCheck: { mode: "warn" }, memoryChecks: () => null, whisperThreadCap: null, now: () => 0 }).snapshot();
  assert.deepEqual(none, base);
  assert.equal("whisperThreadCap" in base, false);
  const report = { mode: "on", scope: "transcription", rule: "min(requested, logical CPUs)", cappedJobs: 0, lastTranscription: null };
  const on = createScheduler({ cpu, budget, engines: eng, memoryCheck: { mode: "warn" }, memoryChecks: () => null, whisperThreadCap: () => report, now: () => 0 }).snapshot();
  const { whisperThreadCap, ...rest } = on;
  assert.deepEqual(rest, base, "everything else identical");
  assert.deepEqual(whisperThreadCap, report);
  assert.deepEqual(on.limits, base.limits);
  const broken = createScheduler({ cpu, budget, engines: eng, whisperThreadCap: () => { throw new Error("x"); }, now: () => 0 }).snapshot();
  assert.equal("whisperThreadCap" in broken, false, "a failing reporter adds nothing");
  const both = createScheduler({ cpu, budget, engines: eng, threads: { mode: "on" }, threadBudget: () => ({ mode: "on" }), whisperThreadCap: () => report, now: () => 0 }).snapshot();
  assert.deepEqual(both.whisperThreadCap, report);
  assert.deepEqual(both.threads, { mode: "on" });
});

// ── The real server: fake engines and a whisper-cli stand-in that records its -t ──────────────────────────────
const FAKE_WHISPER = `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
const arg = (k) => { const i = a.indexOf(k); return i === -1 ? null : a[i + 1]; };
const log = process.env.FAKE_WHISPER_LOG;
if (log) fs.appendFileSync(log, "t=" + arg("-t") + "\\n");
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
  fs.writeFileSync(path.join(root, "app", "speech-models", "ggml-test.bin"), "fake whisper model");
}
function wav() {
  const data = Buffer.alloc(3200); const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
async function server(env = {}, { schedulerJson = null } = {}) {
  const root = makeRoot();
  installFakeWhisper(root);
  if (schedulerJson) { fs.mkdirSync(path.join(root, "app", "config"), { recursive: true }); fs.writeFileSync(path.join(root, "app", "config", "scheduler.json"), JSON.stringify(schedulerJson)); }
  fs.writeFileSync(path.join(root, "app", "llm-models", "wcap.gguf"), Buffer.from("GGUF\x03\x00\x00\x00"));
  const whisperLog = path.join(root, "whisper-threads.log");
  const srv = await startServer(root, { FAKE_WHISPER_LOG: whisperLog, ...env });
  return { root, srv, whisperLog };
}
async function close({ root, srv }) {
  for (const p of ["/api/llm/stop", "/api/stop-backend"]) { try { await request(srv.port, "POST", p, { body: {} }); } catch (_) { /* down */ } }
  stopServer(srv); await sleep(300);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* Windows may hold files briefly */ }
}
const transcribe = (s, threads = null) => request(s.srv.port, "POST",
  `/api/speech/transcribe?model=ggml-test.bin&language=en&save=false&filename=a.wav${threads !== null ? `&threads=${threads}` : ""}`, { body: wav(), headers: { "Content-Type": "audio/wav" } });
const usedThreads = (s) => (fs.existsSync(s.whisperLog) ? fs.readFileSync(s.whisperLog, "utf8").trim().split("\n").filter(Boolean).map((l) => Number(l.replace("t=", ""))) : []);
const resources = async (s) => (await request(s.srv.port, "GET", "/api/resources")).json;
const SERVER_DEFAULT = Math.max(1, Math.min(8, CPUS));

test("server, default (cap on): API-selected counts above the CPUs are capped, at or below are unchanged; -t matches; numbers-only report", async (t) => {
  const s = await server();
  t.after(() => close(s));
  for (const n of [1, CPUS, CPUS + 1, 32]) assert.equal((await transcribe(s, n)).status, 200);
  assert.equal((await transcribe(s)).status, 200, "no threads value: the server default");
  assert.deepEqual(usedThreads(s), [1, CPUS, CPUS, CPUS, SERVER_DEFAULT], "-t passed to whisper-cli = min(requested, logical CPUs)");
  const r = await resources(s);
  assert.equal(r.whisperThreadCap.mode, "on");
  assert.equal(r.whisperThreadCap.cappedJobs, 2);
  assert.deepEqual({ ...r.whisperThreadCap.lastTranscription, at: "x" }, { requested: SERVER_DEFAULT, threads: SERVER_DEFAULT, capped: false, reason: "within-cpus", logicalCpus: CPUS, at: "x" });
  assert.deepEqual(r.limits, { chatQueue: "off", memoryCheck: "warn", threads: "off", queueTimeouts: "off" }, "limits unchanged");
  assert.ok(!JSON.stringify(r.whisperThreadCap).includes(s.root), "no paths");
  assert.ok(s.srv.log().includes(`[threads] Transcription: ${CPUS} thread${CPUS === 1 ? "" : "s"} instead of 32 (the server has ${CPUS} logical CPU`));
});

test("server, default (cap on): a user-selected saved setting above the CPUs stays saved; only the job's -t is capped", async (t) => {
  const s = await server();
  t.after(() => close(s));
  const start = await request(s.srv.port, "POST", "/api/speech/start", { body: { model: "ggml-test.bin", threads: 32, language: "en", backendPreference: "cpu" } });
  assert.equal(start.status, 200, start.text);
  assert.equal(start.json.settings.threads, 32, "the saved setting is the user's value");
  assert.equal((await transcribe(s)).status, 200, "uses the saved setting");
  assert.equal((await request(s.srv.port, "GET", "/api/speech/status")).json.settings.threads, 32, "still saved as 32");
  assert.deepEqual(usedThreads(s), [CPUS]);
});

test("rollback: USAP_WHISPER_THREAD_CAP=off and scheduler.json off restore the uncapped request exactly; the environment wins over the file", async (t) => {
  const envOff = await server({ USAP_WHISPER_THREAD_CAP: "off" });
  t.after(() => close(envOff));
  for (const n of [CPUS + 1, 32]) assert.equal((await transcribe(envOff, n)).status, 200);
  assert.deepEqual(usedThreads(envOff), [CPUS + 1, 32], "uncapped, as before the cap");
  assert.equal("whisperThreadCap" in (await resources(envOff)), false, "no report when off");
  assert.ok(!envOff.srv.log().includes("logical CPU"), "no cap log line");

  const fileOff = await server({}, { schedulerJson: { whisperThreadCap: "off" } });
  t.after(() => close(fileOff));
  assert.equal((await transcribe(fileOff, 32)).status, 200);
  assert.deepEqual(usedThreads(fileOff), [32]);

  const envWins = await server({ USAP_WHISPER_THREAD_CAP: "on" }, { schedulerJson: { whisperThreadCap: "off" } });
  t.after(() => close(envWins));
  assert.equal((await transcribe(envWins, 32)).status, 200);
  assert.deepEqual(usedThreads(envWins), [CPUS]);
});

test("rollback: USAP_SCHEDULER=off turns the cap off (legacy behaviour; /api/resources absent as before)", async (t) => {
  const s = await server({ USAP_SCHEDULER: "off" });
  t.after(() => close(s));
  assert.equal((await transcribe(s, 32)).status, 200);
  assert.deepEqual(usedThreads(s), [32]);
  assert.equal((await request(s.srv.port, "GET", "/api/resources")).status, 404);
});

test("compatibility: transcription responses are identical with the cap on and off; /api/resources off is the previous shape", async (t) => {
  const on = await server();
  const off = await server({ USAP_WHISPER_THREAD_CAP: "off" });
  t.after(() => Promise.all([close(on), close(off)]));
  const norm = (j) => JSON.parse(JSON.stringify(j, (k, v) => (/^(createdAt|durationMs|metadata|id|filename|savedAt|timestamp)$/.test(k) ? "_" : v)));
  for (const n of [1, 32]) {
    const a = await transcribe(on, n); const b = await transcribe(off, n);
    assert.equal(a.status, b.status);
    assert.deepEqual(norm(a.json), norm(b.json), `threads=${n}: same response body (time fields masked)`);
  }
  const ra = await resources(on); const rb = await resources(off);
  assert.deepEqual(Object.keys(ra).filter((k) => k !== "whisperThreadCap").sort(), Object.keys(rb).sort(), "on adds exactly one key");
  assert.deepEqual(ra.limits, rb.limits);
  assert.deepEqual(ra.scheduler, rb.scheduler);
});

// The fake llama-server answers deterministically, so a streaming and a non-streaming chat give the same bodies with
// the cap on and off; the text engine's thread count is the same.
function chatRaw(port, body) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/llm/chat", headers: { "Content-Type": "application/json" } }, (res) => {
      let text = ""; res.on("data", (c) => { text += c; }); res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", (e) => resolve({ status: 0, text: String(e) }));
    req.end(JSON.stringify(body));
  });
}
test("unrelated engines: text engine threads, streaming and non-streaming chat, and image engine threads are the same with the cap on and off", async (t) => {
  const results = {};
  for (const mode of ["on", "off"]) {
    const s = await server({ USAP_WHISPER_THREAD_CAP: mode });
    installFakeSdServer(s.root);
    t.after(() => close(s));
    const st = await request(s.srv.port, "POST", "/api/llm/start", { body: { model: "wcap.gguf", contextSize: 512, gpuLayers: 0 } });
    assert.equal(st.status, 200, st.text);
    await waitFor(async () => (await request(s.srv.port, "GET", "/api/llm/status")).json.ready, 20000, "text ready");
    const llmThreads = (await request(s.srv.port, "GET", "/api/llm/status")).json.settings.threads;
    const stream = await chatRaw(s.srv.port, { messages: [{ role: "user", content: "hello" }], stream: true });
    const plain = await chatRaw(s.srv.port, { messages: [{ role: "user", content: "hello" }], stream: false });
    assert.equal(stream.status, 200); assert.equal(plain.status, 200);
    const strip = (txt) => txt.replace(/"(created|id|system_fingerprint)":("[^"]*"|\d+)/g, '"$1":"_"').replace(/"timings":\{[^}]*\}/g, '"timings":"_"');
    results[mode] = { llmThreads, stream: strip(stream.text), plain: strip(plain.text), imageThreads: (await request(s.srv.port, "GET", "/api/backend-status")).json.settings.threads };
    assert.equal((await transcribe(s, 32)).status, 200, "a capped (or uncapped) transcription does not disturb the text engine");
    assert.equal((await request(s.srv.port, "GET", "/api/llm/status")).json.settings.threads, llmThreads, "text engine threads unchanged after a transcription");
  }
  assert.equal(results.on.llmThreads, Math.max(1, Math.min(16, CPUS)));
  assert.deepEqual(results.on, results.off);
  assert.ok(results.on.stream.trimEnd().endsWith("data: [DONE]"));
});

test("with the 9.9e budget on: the budget receives the capped count; alone the job runs at min(requested, CPUs)", async (t) => {
  const s = await server({ USAP_THREADS: "on" });
  t.after(() => close(s));
  assert.equal((await transcribe(s, 32)).status, 200);
  assert.deepEqual(usedThreads(s), [CPUS], "alone: capped, no budget reduction");
  const r = await resources(s);
  assert.equal(r.limits.threads, "on");
  assert.equal(r.threads.lastTranscription.requested, CPUS, "the budget sees the capped count");
  assert.equal(r.threads.lastTranscription.reason, "alone");
  assert.equal(r.whisperThreadCap.lastTranscription.requested, 32, "the cap reports the original request");
  assert.equal(r.whisperThreadCap.lastTranscription.threads, CPUS);
});
