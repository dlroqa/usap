// Step 9.9f-2: memory-aware text-model load admission (services/memory-admission.cjs, docs/roadmap/
// STEP9_9F_MEMORY_ADMISSION.md). Off by default. observe only records; enforce refuses a text-model load
// (409 MEMORY_INSUFFICIENT) only on "may-not-fit" with every high-confidence condition C1-C8 positively established.
// No request override exists: memoryOverride is ignored in every mode. Recovery paths are never refused.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { makeRoot, startServer, stopServer, request, installFakeSdServer } = require("./api-contract/harness.cjs");
const { memoryAdmissionSetting, createMemoryAdmission, cgroupMemoryLimit, describe, MAX_READING_AGE_MS } = require("../server/services/memory-admission.cjs");
const { createScheduler } = require("../server/services/scheduler.cjs");

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const TIB = 1024 * GIB;
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "usap-admission-")); made.push(d); return d; };
test.after(() => { for (const d of made) try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* Windows may hold files briefly */ } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000, label = "condition") {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${label}`); await sleep(50); }
}

// ── Unit: the decision ────────────────────────────────────────────────────────────────────────────────────────
// A context in which every condition holds (high confidence) and the verdict is may-not-fit.
const assessment = (o = {}) => ({
  workload: "text-model-load", verdict: "may-not-fit", memoryPool: "system-ram", reasons: [],
  available: { ramBytes: { value: 2 * GIB, known: true, source: "mem-available" }, totalRamBytes: { value: 8 * GIB, known: true } },
  required: { lowerBoundBytes: { value: 6 * GIB, known: true } },
  ...o,
});
const NOW = 100000;
const ctx = (o = {}) => ({
  assessment: assessment(), path: "start", release: { confirmed: true, releasedAt: NOW - 500 }, measuredAt: NOW - 100,
  loadMode: "none", activity: { chatActive: false, imageGenerating: false, imageLoading: false, transcribing: false }, attemptCurrent: true, overrideRequested: false,
  ...o,
});
function make(mode, o = {}) {
  const lines = [];
  const a = createMemoryAdmission({ setting: { mode }, platform: "linux", now: () => NOW, cgroup: () => ({ state: "none" }), log: (l) => lines.push(l), ...o });
  a.lines = lines;
  return a;
}
const withAvailable = (free, total = 8 * GIB, source = "mem-available") => ({ ramBytes: { value: free, known: true, source }, totalRamBytes: { value: total, known: true } });

test("decision: only may-not-fit with high confidence in enforce refuses; observe records would-refuse; nothing else is ever refused", () => {
  for (const verdict of ["likely-fits", "tight", "may-not-fit", "unknown"]) {
    for (const mode of ["observe", "enforce"]) {
      const d = make(mode).decide(ctx({ assessment: assessment({ verdict }) }));
      const expected = verdict !== "may-not-fit" ? "allowed" : mode === "enforce" ? "refused" : "would-refuse";
      assert.equal(d.report.decision, expected, `${verdict} × ${mode}`);
      assert.equal(d.refuse, expected === "refused", `${verdict} × ${mode}: refuse`);
      assert.equal(d.report.verdict, verdict);
    }
  }
  const high = make("enforce").decide(ctx());
  assert.equal(high.report.confidence, "high");
  assert.deepEqual(high.report.confidenceReasons, []);
  assert.match(high.message, /6\.0 GB.*2\.0 GB.*memory mapping is off/);
});

test("confidence: each of C1-C8 failing on its own gives low confidence and no refusal", () => {
  const cases = [
    ["c1-memory-pool", { assessment: assessment({ memoryPool: "unified" }) }],
    ["c1-memory-pool", { assessment: assessment({ memoryPool: "gpu-offload-not-assessed" }) }],
    ["c2-release-unconfirmed", { release: { confirmed: false, releasedAt: NOW - 500 } }],
    ["c2-release-unconfirmed", { release: null }],
    ["c3-source-unvalidated", { assessment: assessment({ available: withAvailable(2 * GIB, 8 * GIB, "available-physical") }) }],
    ["c3-source-unvalidated", { assessment: assessment({ available: withAvailable(2 * GIB, 8 * GIB, "vm-stat") }) }],
    ["c3-source-unvalidated", { assessment: assessment({ available: withAvailable(2 * GIB, 8 * GIB, "os-free-pages") }) }],
    ["c3-reading-stale", { measuredAt: NOW - MAX_READING_AGE_MS - 1 }],
    ["c3-reading-stale", { measuredAt: NOW - 600 }], // taken before the release (releasedAt NOW-500)
    ["c3-reading-stale", { measuredAt: null }],
    ["c4-reading-implausible", { assessment: assessment({ available: withAvailable(9 * GIB, 8 * GIB) }) }],
    ["c4-reading-implausible", { assessment: assessment({ available: { ramBytes: { value: 2 * GIB, known: true, source: "mem-available" }, totalRamBytes: { value: null, known: false } } }) }],
    ["c4-reading-implausible", { assessment: assessment({ reasons: ["available-memory-implausible"] }) }],
    ["c5-other-workload", { activity: { chatActive: false, imageLoading: true } }],
    ["c5-activity-unknown", { activity: null }],
    ["c5-activity-unknown", { activity: { imageLoading: undefined } }],
    ["c5-activity-unknown", { activity: { imageLoading: "no" } }],
    ["c7-shortfall-small", { assessment: assessment({ available: withAvailable(6 * GIB - GIB + 1) }) }],
    ["c8-memory-mapped", { loadMode: "mmap" }],
    ["c8-memory-mapped", { loadMode: "mmap+mlock" }],
    ["c8-memory-mapped", { loadMode: undefined }],
    ["attempt-not-current", { attemptCurrent: false }],
    ["assessment-missing", { assessment: assessment({ workload: "image-model-load" }) }],
  ];
  for (const [reason, o] of cases) {
    const d = make("enforce").decide(ctx(o));
    assert.equal(d.refuse, false, `${reason}: never refused`);
    assert.equal(d.report.decision, "allowed", reason);
    assert.equal(d.report.confidence, "low", reason);
    assert.ok(d.report.confidenceReasons.includes(reason), `${reason}: got ${d.report.confidenceReasons}`);
  }
  // C6 (Linux): a limit, an unreadable hierarchy, or a reader that throws.
  for (const [reason, cgroup] of [["c6-cgroup-limit", () => ({ state: "limited" })], ["c6-cgroup-unknown", () => ({ state: "unknown" })], ["c6-cgroup-unknown", () => { throw new Error("EACCES"); }]]) {
    const d = make("enforce", { cgroup }).decide(ctx());
    assert.equal(d.refuse, false, reason);
    assert.ok(d.report.confidenceReasons.includes(reason), reason);
  }
});

test("confidence boundaries: C7 shortfall (1 GiB or 10 %), C3 age, and the resident load modes", () => {
  const refusedWith = (o, extra = {}) => make("enforce", extra).decide(ctx(o)).refuse;
  // Small model: 1 GiB minimum applies.
  assert.equal(refusedWith({ assessment: assessment({ available: withAvailable(5 * GIB) }) }), true, "exactly 1 GiB short");
  assert.equal(refusedWith({ assessment: assessment({ available: withAvailable(5 * GIB + 1) }) }), false, "1 byte less than 1 GiB short");
  // Large model: 10 % of the lower bound applies (40 GiB files → 4 GiB).
  const big = (free) => ({ assessment: assessment({ available: withAvailable(free, 64 * GIB), required: { lowerBoundBytes: { value: 40 * GIB, known: true } } }) });
  assert.equal(refusedWith(big(36 * GIB)), true, "exactly 10 % short");
  assert.equal(refusedWith(big(36 * GIB + 1)), false, "just under 10 % short");
  assert.equal(refusedWith({ measuredAt: NOW - MAX_READING_AGE_MS, release: { confirmed: true, releasedAt: NOW - MAX_READING_AGE_MS } }), true, "2000 ms old, taken right at the release");
  assert.equal(refusedWith({ loadMode: "mlock" }), true, "mlock without mmap is resident");
  assert.equal(refusedWith({ loadMode: "none" }), true);
});

test("platforms: Windows and macOS readings are never high confidence (not validated); only Linux MemAvailable is", () => {
  for (const [platform, source] of [["win32", "available-physical"], ["darwin", "vm-stat"], ["darwin", "os-free-pages"], ["freebsd", "os-freemem"], ["win32", "mem-available"]]) {
    const d = make("enforce", { platform }).decide(ctx({ assessment: assessment({ available: withAvailable(2 * GIB, 8 * GIB, source) }) }));
    assert.equal(d.refuse, false, `${platform}/${source}`);
    assert.ok(d.report.confidenceReasons.includes("c3-source-unvalidated"), `${platform}/${source}`);
    assert.equal(d.report.measurement.state, "unvalidated");
  }
  assert.equal(make("enforce", { platform: "linux" }).decide(ctx()).refuse, true);
});

test("recovery paths are assessed but never refused, even with may-not-fit and high confidence", () => {
  for (const p of ["restart", "oom-retry", "profile-fallback", "benchmark-restore"]) {
    const d = make("enforce").decide(ctx({ path: p }));
    assert.equal(d.refuse, false, p);
    assert.equal(d.report.decision, "exempt", p);
    assert.equal(d.report.confidence, "high", `${p}: still assessed`);
    assert.equal(d.report.path, p);
  }
  // A user benchmark is an ordinary load; an unknown path name counts as a start (never as an exemption).
  assert.equal(make("enforce").decide(ctx({ path: "benchmark" })).refuse, true);
  assert.equal(make("enforce").decide(ctx({ path: "made-up" })).report.path, "start");
});

test("override: memoryOverride is ignored in every mode and decision; it is only reported", () => {
  for (const mode of ["observe", "enforce"]) {
    for (const o of [ctx(), ctx({ loadMode: "mmap" }), ctx({ assessment: assessment({ verdict: "tight" }) })]) {
      const a = make(mode).decide(o);
      const b = make(mode).decide({ ...o, overrideRequested: true });
      assert.equal(b.refuse, a.refuse, `${mode}: same refusal with and without the field`);
      assert.equal(b.report.decision, a.report.decision);
      assert.deepEqual(b.report.override, { requested: true, accepted: false, reason: "unavailable" });
      assert.equal(a.report.override, null);
    }
  }
  const m = make("enforce");
  m.decide(ctx({ overrideRequested: true }));
  assert.equal(m.snapshot().counts.overrideIgnored, 1);
  assert.match(m.lines[0], /memoryOverride ignored/);
});

test("fail open: a broken assessment never escapes and never refuses", () => {
  const evil = {};
  Object.defineProperty(evil, "workload", { get() { throw new Error("boom"); } });
  for (const mode of ["observe", "enforce"]) {
    const d = make(mode).decide(ctx({ assessment: evil }));
    assert.equal(d.refuse, false);
    assert.equal(d.report.decision, "allowed");
    assert.deepEqual(d.report.confidenceReasons, ["admission-error"]);
  }
  assert.equal(make("enforce").decide().refuse, false, "no context at all");
  assert.equal(make("enforce", { log: () => { throw new Error("log down"); } }).decide(ctx()).refuse, true, "a failing log doesn't change a valid decision");
});

test("reporting: counts, low-confidence reasons, last decision; reports and log lines carry no names or paths", () => {
  const m = make("observe");
  m.decide(ctx());
  m.decide(ctx({ loadMode: "mmap" }));
  m.decide(ctx({ path: "restart" }));
  const snap = m.snapshot();
  assert.equal(snap.mode, "observe");
  assert.deepEqual(snap.counts, { allowed: 1, wouldRefuse: 1, refused: 0, exempt: 1, overrideIgnored: 0 });
  assert.deepEqual(snap.lowConfidenceByReason, { "c8-memory-mapped": 1 });
  assert.equal(snap.last.path, "restart");
  assert.equal(m.lines.length, 3);
  assert.match(m.lines[0], /admission \(observe\): would-refuse; may-not-fit, high confidence; path start\./);
  const text = JSON.stringify(snap) + m.lines.join("\n") + describe(snap.last);
  for (const secret of [os.homedir(), os.userInfo().username, ".gguf", "/", "\\"]) {
    if (secret === "/") { assert.ok(!/[A-Za-z]:\\|\/[a-z]+\//.test(text), "no paths"); continue; }
    if (secret === "\\") continue;
    assert.ok(!text.includes(secret), `leaks ${secret}`);
  }
});

test("setting: off by default; env over scheduler.json; invalid values ignored, never coerced; USAP_SCHEDULER=off and memoryCheck off force off", () => {
  const dir = tmp();
  const cfg = (o) => fs.writeFileSync(path.join(dir, "scheduler.json"), JSON.stringify(o));
  assert.equal(memoryAdmissionSetting({ env: {} }).mode, "off");
  assert.equal(memoryAdmissionSetting({ env: { USAP_MEMORY_ADMISSION: "observe" } }).mode, "observe");
  assert.equal(memoryAdmissionSetting({ env: { USAP_MEMORY_ADMISSION: " ENFORCE " } }).mode, "enforce");
  cfg({ memoryAdmission: "enforce" });
  assert.equal(memoryAdmissionSetting({ env: {}, configDir: dir }).mode, "enforce", "scheduler.json");
  assert.equal(memoryAdmissionSetting({ env: { USAP_MEMORY_ADMISSION: "observe" }, configDir: dir }).mode, "observe", "the environment wins");
  const bad = memoryAdmissionSetting({ env: { USAP_MEMORY_ADMISSION: "on" }, configDir: dir });
  assert.equal(bad.mode, "enforce", "an invalid env value is skipped, the file applies");
  assert.deepEqual(bad.ignored.map((x) => x.name), ["USAP_MEMORY_ADMISSION"]);
  cfg({ memoryAdmission: true });
  const bad2 = memoryAdmissionSetting({ env: {}, configDir: dir });
  assert.equal(bad2.mode, "off");
  assert.deepEqual(bad2.ignored.map((x) => x.source), ["scheduler.json"]);
  cfg({ memoryAdmission: "enforce" });
  const sched = memoryAdmissionSetting({ env: {}, configDir: dir, schedulerMode: "off" });
  assert.equal(sched.mode, "off"); assert.equal(sched.forcedOffBy, "scheduler-off");
  const mc = memoryAdmissionSetting({ env: { USAP_MEMORY_ADMISSION: "observe" }, memoryCheckMode: "off" });
  assert.equal(mc.mode, "off"); assert.equal(mc.forcedOffBy, "memory-check-off");
  // The test-only inflation: a positive whole number, only when admission is on; never a reduction.
  assert.equal(memoryAdmissionSetting({ env: { USAP_MEMORY_ADMISSION: "observe", USAP_TEST_MEMORY_ADMISSION_INFLATE_BYTES: "1024" } }).inflateBytes, 1024);
  assert.equal(memoryAdmissionSetting({ env: { USAP_TEST_MEMORY_ADMISSION_INFLATE_BYTES: "1024" } }).inflateBytes, 0, "off: no inflation");
  for (const v of ["-1", "0", "1e9", "12.5", "abc", "99999999999999999"]) {
    const s = memoryAdmissionSetting({ env: { USAP_MEMORY_ADMISSION: "observe", USAP_TEST_MEMORY_ADMISSION_INFLATE_BYTES: v } });
    assert.equal(s.inflateBytes, 0, v);
    assert.ok(s.ignored.some((x) => x.name === "USAP_TEST_MEMORY_ADMISSION_INFLATE_BYTES"), v);
  }
});

test("cgroup reader: v2 and v1 limits, parents, unlimited, unreadable and missing hierarchies", () => {
  const fsMap = (files) => (p) => { if (p in files) { if (files[p] instanceof Error) throw files[p]; return files[p]; } throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
  const total = 16 * GIB;
  const v2 = (extra) => fsMap({ "/proc/self/cgroup": "0::/user.slice/app.scope\n", "/sys/fs/cgroup/cgroup.controllers": "cpu memory", ...extra });
  assert.equal(cgroupMemoryLimit({ totalBytes: total, readFile: v2({ "/sys/fs/cgroup/user.slice/app.scope/memory.max": "max", "/sys/fs/cgroup/user.slice/memory.max": "max" }) }).state, "none");
  assert.equal(cgroupMemoryLimit({ totalBytes: total, readFile: v2({ "/sys/fs/cgroup/user.slice/app.scope/memory.max": String(4 * GIB) }) }).state, "limited");
  assert.equal(cgroupMemoryLimit({ totalBytes: total, readFile: v2({ "/sys/fs/cgroup/user.slice/app.scope/memory.max": "max", "/sys/fs/cgroup/user.slice/memory.max": String(2 * GIB) }) }).state, "limited", "a parent's limit counts");
  assert.equal(cgroupMemoryLimit({ totalBytes: total, readFile: v2({ "/sys/fs/cgroup/user.slice/app.scope/memory.max": String(32 * GIB) }) }).state, "none", "a limit above the total");
  assert.equal(cgroupMemoryLimit({ totalBytes: total, readFile: v2({ "/sys/fs/cgroup/user.slice/app.scope/memory.max": "lots" }) }).state, "unknown", "unparsable");
  assert.equal(cgroupMemoryLimit({ totalBytes: total, readFile: v2({ "/sys/fs/cgroup/user.slice/app.scope/memory.max": Object.assign(new Error("EACCES"), { code: "EACCES" }) }) }).state, "unknown", "unreadable");
  assert.equal(cgroupMemoryLimit({ totalBytes: total, readFile: fsMap({ "/proc/self/cgroup": "0::/\n" }) }).state, "unknown", "no cgroup2 mount");
  const v1 = (limit) => fsMap({ "/proc/self/cgroup": "5:memory:/docker/abc\n4:cpu,cpuacct:/docker/abc\n", "/sys/fs/cgroup/memory/docker/abc/memory.limit_in_bytes": limit });
  assert.equal(cgroupMemoryLimit({ totalBytes: total, readFile: v1("9223372036854771712") }).state, "none");
  assert.equal(cgroupMemoryLimit({ totalBytes: total, readFile: v1(String(GIB)) }).state, "limited");
  assert.equal(cgroupMemoryLimit({ totalBytes: total, readFile: fsMap({ "/proc/self/cgroup": "5:memory:/x\n" }) }).state, "unknown", "v1 without any readable limit");
  assert.equal(cgroupMemoryLimit({ totalBytes: total, readFile: fsMap({}) }).state, "unknown", "no /proc/self/cgroup");
  assert.equal(cgroupMemoryLimit({ totalBytes: 0, readFile: v2({}) }).state, "unknown", "no total");
});

test("scheduler snapshot: memoryAdmission and limits.memoryAdmission appear only when a reporter is given", () => {
  const engines = { text: () => ({ state: "stopped", loaded: false }), image: () => ({ state: "stopped", loaded: false }), speech: () => ({ state: "stopped" }), voice: () => ({ state: "stopped" }), download: () => ({}), heavyModel: () => null };
  const base = { budget: { totalRamBytes: () => 8 * GIB, freeRamBytes: () => 4 * GIB, freeRamSource: () => "mem-available" }, cpu: { logicalCores: () => 4, physicalCores: () => 4 }, engines };
  const off = createScheduler(base).snapshot();
  assert.equal("memoryAdmission" in off, false);
  assert.equal("memoryAdmission" in off.limits, false);
  const m = make("observe");
  const on = createScheduler({ ...base, memoryAdmission: () => m.snapshot() }).snapshot();
  assert.equal(on.limits.memoryAdmission, "observe");
  assert.deepEqual(on.memoryAdmission, m.snapshot());
  assert.equal(on.scheduler.decisions, off.scheduler.decisions, "observe makes no decisions");
  const e = make("enforce");
  assert.equal(createScheduler({ ...base, memoryAdmission: () => e.snapshot() }).snapshot().scheduler.decisions, true, "enforce does");
  const broken = createScheduler({ ...base, memoryAdmission: () => { throw new Error("x"); } }).snapshot();
  assert.equal("memoryAdmission" in broken, false);
});

// ── Server: the studio with the contract tests' fake llama-server ─────────────────────────────────────────────
function gguf(kv) {
  const parts = [];
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); parts.push(b); };
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); parts.push(b); };
  const str = (s) => { const b = Buffer.from(s, "utf8"); u64(b.length); parts.push(b); };
  parts.push(Buffer.from("GGUF")); u32(3); u64(0); u64(kv.length);
  for (const [key, type, value] of kv) { str(key); if (type === "str") { u32(8); str(value); } else { u32(4); u32(value); } }
  parts.push(Buffer.alloc(64));
  return Buffer.concat(parts);
}
const MODEL = "secret-admit-model-q4_0.gguf";
const header = () => gguf([
  ["general.architecture", "str", "llama"], ["general.name", "str", "SecretAdmitName"],
  ["llama.block_count", "u32", 2], ["llama.attention.head_count", "u32", 4], ["llama.attention.head_count_kv", "u32", 4], ["llama.embedding_length", "u32", 64],
]);
const INFLATE = { USAP_TEST_MEMORY_ADMISSION_INFLATE_BYTES: String(64 * TIB) }; // never fits anywhere
const LOAD_MODE = { FAKE_LLAMA_HELP_LOAD_MODE: "1" }; // the fake advertises --load-mode, like a current llama.cpp
// Whether this host can produce high confidence at all (C3 Linux MemAvailable, C6 no cgroup limit).
const HOST_HIGH = process.platform === "linux" && cgroupMemoryLimit({ totalBytes: os.totalmem() }).state === "none";

async function server(env = {}, { auth = false } = {}) {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, "app", "llm-models", MODEL), header());
  const srv = await startServer(root, { ...LOAD_MODE, ...env }, auth ? { readyPath: "/api/auth/status" } : {});
  return { root, srv };
}
async function close(s) {
  if (!s) return;
  await stopServer(s.srv);
  await sleep(300);
  try { fs.rmSync(s.root, { recursive: true, force: true }); } catch (_) { /* Windows may hold files briefly */ }
}
const start = (s, body = {}, headers = {}) => request(s.srv.port, "POST", "/api/llm/start", { body: { model: MODEL, contextSize: 2048, gpuLayers: 0, ...body }, headers });
const status = async (s, headers = {}) => (await request(s.srv.port, "GET", "/api/llm/status", { headers })).json;
const resources = async (s) => (await request(s.srv.port, "GET", "/api/resources")).json;
async function ready(s, headers = {}) {
  await waitFor(async () => (await status(s, headers)).ready, 20000, "ready");
  s.srv.enginePort = (await status(s, headers)).port;
}
const chat = (s, content, stream = false) => request(s.srv.port, "POST", "/api/llm/chat", { body: { messages: [{ role: "user", content }], stream } });
const stable = (r) => ({ status: r.status, text: (r.text || "").replace(/"created":\d+/g, "").replace(/"id":"[^"]*"/g, "") });
const fakeArgs = async (s) => JSON.parse((await request(s.srv.enginePort, "GET", "/fake/args")).text);
const normArgs = (s, args) => args.map((a) => a.split(s.root).join("<root>")).map((a, i, all) => (all[i - 1] === "--port" ? "<port>" : a));
const admissionLines = (s) => s.srv.log().split(/\r?\n/).filter((l) => l.includes("[memory] admission"));

test("server, off (default): no admission field, report or log line; a memoryOverride field is ignored and not echoed", async (t) => {
  const s = await server({ ...INFLATE });
  t.after(() => close(s));
  const r = await start(s, { mmap: false, memoryOverride: true });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(r.json).sort(), ["memoryCheck", "ok", "port", "ready", "settings"], "the 9.9d response shape");
  assert.equal("admission" in r.json.memoryCheck, false);
  assert.ok(!r.text.includes("memoryOverride"));
  assert.ok(!r.json.memoryCheck.reasons.includes("test-inflation"), "off: the test-only inflation isn't applied");
  const res = await resources(s);
  assert.equal("memoryAdmission" in res, false);
  assert.equal("memoryAdmission" in res.limits, false);
  assert.equal(admissionLines(s).length, 0);
  assert.ok(!s.srv.log().includes("Memory admission"));
});

test("server, observe: same outcomes as off (status, settings, spawn arguments, chats); only the additive report differs", async (t) => {
  const run = async (env) => {
    const s = await server(env);
    t.after(() => close(s));
    const r = await start(s, { mmap: false });
    await ready(s);
    const { port: _p, ...settings } = r.json.settings;
    const chats = [];
    for (const [content, stream] of [["hello", false], ["hello", true], ["MODE:http-error", false]]) chats.push(stable(await chat(s, content, stream)));
    return { s, r, settings, args: normArgs(s, await fakeArgs(s)), chats, res: await resources(s) };
  };
  const off = await run({});
  const obs = await run({ USAP_MEMORY_ADMISSION: "observe" });
  const obsInflated = await run({ USAP_MEMORY_ADMISSION: "observe", ...INFLATE });
  for (const o of [obs, obsInflated]) {
    assert.equal(o.r.status, off.r.status);
    assert.equal(o.r.json.ready, off.r.json.ready);
    assert.deepEqual(o.settings, off.settings, "same settings chosen");
    assert.deepEqual(o.args, off.args, "same llama-server arguments");
    assert.deepEqual(o.chats, off.chats, "same chat outcomes");
  }
  assert.ok(off.args.includes("--load-mode") && off.args[off.args.indexOf("--load-mode") + 1] === "none", "the fake was started with --load-mode none");
  // Without inflation the 9.9d result is the same apart from the additive admission object.
  const { admission, ...rest } = obs.r.json.memoryCheck;
  const strip = (m) => ({ ...m, at: null, available: null });
  assert.deepEqual(strip(rest), strip(off.r.json.memoryCheck));
  assert.equal(admission.mode, "observe");
  assert.equal(admission.path, "start");
  assert.equal(admission.release, "confirmed");
  assert.equal(admission.loadMode, "none");
  // Inflated: the model "may not fit". On a host that can be high-confidence this is would-refuse; elsewhere low.
  const inf = obsInflated.r.json.memoryCheck;
  assert.equal(inf.verdict, "may-not-fit");
  assert.equal(inf.admission.testInflation, true);
  assert.equal(inf.admission.decision, HOST_HIGH ? "would-refuse" : "allowed", JSON.stringify(inf.admission));
  if (!HOST_HIGH) t.diagnostic(`host can't be high confidence: ${inf.admission.confidenceReasons.join(", ")}`);
  assert.equal(obsInflated.res.limits.memoryAdmission, "observe");
  assert.equal(obsInflated.res.memoryAdmission.counts[HOST_HIGH ? "wouldRefuse" : "allowed"], 1);
  assert.deepEqual(obsInflated.res.memory.checks.text.admission, inf.admission, "/api/resources carries the same report");
});

test("server, enforce: a high-confidence may-not-fit load is refused with 409 MEMORY_INSUFFICIENT, nothing is spawned, state is that of a failed start", async (t) => {
  const s = await server({ USAP_MEMORY_ADMISSION: "enforce", ...INFLATE });
  t.after(() => close(s));
  const r = await start(s, { mmap: false });
  if (!HOST_HIGH) {
    // Windows, macOS, or a Linux host with a cgroup limit: never refused (recorded, not passed as a refusal test).
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.memoryCheck.admission.decision, "allowed");
    assert.ok(r.json.memoryCheck.admission.confidenceReasons.some((x) => /^c3-|^c6-/.test(x)), JSON.stringify(r.json.memoryCheck.admission));
    t.diagnostic(`refusal not exercised on this host (${process.platform}): ${r.json.memoryCheck.admission.confidenceReasons.join(", ")}`);
    return;
  }
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.code, "MEMORY_INSUFFICIENT");
  assert.match(r.json.error, /larger than the memory available now.*memory mapping on/);
  assert.equal(r.json.admission.decision, "refused");
  assert.equal(r.json.admission.confidence, "high");
  assert.deepEqual(r.json.admission, r.json.memoryCheck.admission, "the same report in both places");
  for (const secret of [s.root, MODEL, "SecretAdmitName", os.homedir()]) assert.ok(!r.text.includes(secret), `leaks ${secret}`);
  // Nothing spawned, no engine, the heavy-model slot is free, the error is recorded like a failed start.
  const st = await status(s);
  assert.equal(st.ready, false);
  assert.equal(st.running, false);
  assert.match(st.error, /larger than the memory available now/);
  const res = await resources(s);
  assert.equal(res.heavyModel, null);
  assert.equal(res.memoryAdmission.counts.refused, 1);
  assert.equal(admissionLines(s).length, 1, "one decision: no other profile or backend was tried");
  assert.ok(!s.srv.log().includes("[llm] Starting:"), "llama-server was never spawned");
  const settingsFile = path.join(s.root, "app", "config", "llm-model-settings.json");
  assert.ok(!fs.existsSync(settingsFile) || !JSON.parse(fs.readFileSync(settingsFile, "utf8")).models[MODEL], "nothing persisted for the refused model");
  // The override field changes nothing, in any shape, or as a header.
  for (const extra of [{ memoryOverride: true }, { memoryOverride: "true" }, { memoryOverride: 1 }, { options: { memoryOverride: true } }]) {
    const again = await start(s, { mmap: false, ...extra });
    assert.equal(again.status, 409, JSON.stringify(extra));
    if ("memoryOverride" in extra) assert.deepEqual(again.json.admission.override, { requested: true, accepted: false, reason: "unavailable" });
  }
  const viaHeader = await request(s.srv.port, "POST", "/api/llm/start", { body: { model: MODEL, mmap: false, gpuLayers: 0 }, headers: { "X-Memory-Override": "true", "X-Forwarded-For": "127.0.0.1" } });
  assert.equal(viaHeader.status, 409);
  assert.equal(viaHeader.json.admission.override, null, "headers are never read");
  assert.equal((await status(s)).running, false);
  // The refused attempts left no setting behind: an ordinary (memory-mapped) load right after them is allowed and works.
  const normal = await start(s, {});
  assert.equal(normal.status, 200, normal.text);
  assert.equal(normal.json.memoryCheck.admission.loadMode, "mmap");
  await ready(s);
  assert.equal((await chat(s, "hello")).status, 200);
});

test("server, enforce: memory-mapped loads (the default) are never refused; a later load works normally", async (t) => {
  const s = await server({ USAP_MEMORY_ADMISSION: "enforce", ...INFLATE });
  t.after(() => close(s));
  const r = await start(s, {});
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.memoryCheck.verdict, "may-not-fit");
  assert.equal(r.json.memoryCheck.admission.decision, "allowed");
  assert.equal(r.json.memoryCheck.admission.loadMode, "mmap");
  assert.ok(r.json.memoryCheck.admission.confidenceReasons.includes("c8-memory-mapped"));
  await ready(s);
  assert.equal((await chat(s, "hello")).status, 200);
});

test("server, observe: recovery paths are tagged and exempt (crash restart, out-of-memory retry); the override never reaches a restart", async (t) => {
  const s = await server({ USAP_MEMORY_ADMISSION: "observe", ...INFLATE });
  t.after(() => close(s));
  const r = await start(s, { mmap: false, memoryOverride: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.memoryCheck.admission.path, "start");
  assert.deepEqual(r.json.memoryCheck.admission.override, { requested: true, accepted: false, reason: "unavailable" });
  await ready(s);
  const { pid } = JSON.parse((await request(s.srv.enginePort, "GET", "/fake/stats")).text);
  process.kill(pid, "SIGKILL");
  await waitFor(async () => { const st = await status(s); return st.ready && st.engine.restartsInWindow === 1; }, 30000, "bounded restart");
  const afterRestart = (await resources(s)).memoryAdmission.last;
  assert.equal(afterRestart.path, "restart");
  assert.equal(afterRestart.decision, "exempt");
  assert.equal(afterRestart.override, null, "the restart didn't inherit memoryOverride");
  await ready(s);
  // Out-of-memory chat error → the existing one-time retry with a smaller context, assessed as oom-retry.
  const oom = await chat(s, "MODE:oom", false);
  await waitFor(async () => (await resources(s)).memoryAdmission.last.path === "oom-retry", 20000, "oom retry assessed");
  const last = (await resources(s)).memoryAdmission.last;
  assert.equal(last.decision, "exempt");
  assert.ok([200, 500, 503].includes(oom.status));
});

test("server, enforce, sign-in required: ordinary loads behave the same for signed-in callers; unauthenticated calls are refused before admission; spoofed forwarding headers change nothing", async (t) => {
  const s = await server({ USAP_MEMORY_ADMISSION: "enforce", ...INFLATE, UAIS_AUTH: "on" }, { auth: true });
  t.after(() => close(s));
  const token = fs.readFileSync(path.join(s.root, "app", "config", "lan-access-token"), "utf8").trim();
  const auth = { Authorization: `Bearer ${token}` };
  const anon = await start(s, { mmap: false, memoryOverride: true });
  assert.equal(anon.status, 401);
  assert.equal(admissionLines(s).length, 0, "admission never ran for an unauthenticated request");
  const expected = HOST_HIGH ? 409 : 200;
  const signedIn = await start(s, { mmap: false, memoryOverride: true }, auth);
  assert.equal(signedIn.status, expected, signedIn.text);
  if (expected === 409) {
    const spoofed = await start(s, { mmap: false, memoryOverride: true }, { ...auth, "X-Forwarded-For": "127.0.0.1", Forwarded: "for=127.0.0.1" });
    assert.equal(spoofed.status, 409, "a forwarding header is no authorization");
  }
  // An ordinary (memory-mapped) load by the signed-in caller works as before.
  await request(s.srv.port, "POST", "/api/llm/stop", { body: {}, headers: auth });
  const normal = await start(s, {}, auth);
  assert.equal(normal.status, 200, normal.text);
});

test("server: USAP_SCHEDULER=off and memoryCheck off force admission off (legacy responses), with one log line", async (t) => {
  for (const env of [{ USAP_SCHEDULER: "off" }, { USAP_MEMORY_CHECK: "off" }]) {
    const s = await server({ USAP_MEMORY_ADMISSION: "enforce", ...INFLATE, ...env });
    t.after(() => close(s));
    const r = await start(s, { mmap: false });
    assert.equal(r.status, 200, r.text);
    assert.equal("memoryCheck" in r.json, false);
    assert.equal(admissionLines(s).length, 0);
    assert.match(s.srv.log(), /memory admission "enforce" is off because/);
  }
});

// An sd1 image model for the fake image engine (header only, padded).
function imageModel(root) {
  const kv = (key, type, val) => {
    const k = Buffer.from(key); const head = Buffer.alloc(8 + k.length + 4); head.writeBigUInt64LE(BigInt(k.length)); k.copy(head, 8); head.writeUInt32LE(type, 8 + k.length);
    if (type === 8) { const v = Buffer.from(val); const b = Buffer.alloc(8 + v.length); b.writeBigUInt64LE(BigInt(v.length)); v.copy(b, 8); return Buffer.concat([head, b]); }
    const b = Buffer.alloc(4); b.writeUInt32LE(val); return Buffer.concat([head, b]);
  };
  const h = Buffer.alloc(24); h.write("GGUF"); h.writeUInt32LE(3, 4); h.writeBigUInt64LE(0n, 8); h.writeBigUInt64LE(2n, 16);
  const file = path.join(root, "app", "models", "sd1-test-q4_0.gguf");
  fs.writeFileSync(file, Buffer.concat([h, kv("general.architecture", 8, "sd1"), kv("general.file_type", 4, 2)]));
  fs.truncateSync(file, 130 * MIB);
}

test("server, enforce: concurrent text/image loads. An image engine still loaded blocks the text load before admission (unchanged); right after it stops, a refusal only happens with its exit confirmed and no other workload", async (t) => {
  const root = makeRoot();
  installFakeSdServer(root);
  imageModel(root);
  fs.writeFileSync(path.join(root, "app", "llm-models", MODEL), header());
  const srv = await startServer(root, { ...LOAD_MODE, USAP_MEMORY_ADMISSION: "enforce", ...INFLATE });
  const s = { root, srv };
  t.after(async () => { try { await request(srv.port, "POST", "/api/stop-backend", { body: {} }); } catch (_) { /* down */ } await close(s); });
  const img = await request(srv.port, "POST", "/api/restart-backend", { body: { model: "sd1-test-q4_0.gguf", backend_type: "cpu", use_gpu: false, width: 64, height: 64, steps: 4 } });
  assert.equal(img.status, 200, img.text);
  await waitFor(async () => (await request(srv.port, "GET", "/api/backend-status")).json.ready, 20000, "image engine ready");
  const blocked = await start(s, { mmap: false });
  // Unchanged pre-existing behaviour (main 29e015a, see #105): the heavy-model check's error is caught by the profile
  // loop, so the route answers 500 ENGINE_START_FAILED with the "already loaded" message.
  assert.equal(blocked.status, 500, blocked.text);
  assert.equal(blocked.json.code, "ENGINE_START_FAILED");
  assert.match(blocked.json.error, /already loaded as a Image model/, "decision B still applies first");
  assert.equal(admissionLines(s).length, 0, "admission didn't run for a load the heavy-model check refused");
  // Stop the image engine (2 s, then SIGKILL, without waiting for the exit) and load text at once.
  await request(srv.port, "POST", "/api/stop-backend", { body: {} });
  const r = await start(s, { mmap: false });
  const a = (await resources(s)).memoryAdmission.last;
  assert.ok(a, "assessed");
  if (a.decision === "refused") {
    assert.equal(r.status, 409);
    assert.equal(a.release, "confirmed", "a refusal needs the earlier engine's exit to be confirmed");
    assert.ok(!a.confidenceReasons.some((x) => x.startsWith("c5-")), "and no other heavy workload");
  } else {
    assert.equal(r.status, 200, r.text);
    assert.equal(a.confidence, "low");
    assert.ok(a.confidenceReasons.some((x) => /^c2-|^c5-|^c3-|^c6-/.test(x)), JSON.stringify(a));
  }
  t.diagnostic(`after image stop: ${a.decision}, release ${a.release}, reasons ${a.confidenceReasons.join(",") || "none"}`);
});

test("server, observe: reloading a running model releases the old engine first (exit confirmed before the reading); a benchmark is assessed as benchmark and its restore as an exempt recovery", async (t) => {
  const s = await server({ USAP_MEMORY_ADMISSION: "observe", ...INFLATE });
  t.after(() => close(s));
  assert.equal((await start(s, { mmap: false })).status, 200);
  await ready(s);
  const { pid } = JSON.parse((await request(s.srv.enginePort, "GET", "/fake/stats")).text);
  const again = await start(s, { mmap: false });
  assert.equal(again.status, 200, again.text);
  const a = again.json.memoryCheck.admission;
  assert.equal(a.release, "confirmed", "the previous engine was seen to exit before the decision");
  assert.equal(a.measurement.state === "fresh" || a.measurement.state === "unvalidated", true);
  let alive = true; try { process.kill(pid, 0); } catch (_) { alive = false; }
  assert.equal(alive, false, "the previous engine process is gone");
  await ready(s);
  const bench = await request(s.srv.port, "POST", "/api/llm/benchmark", { body: { model: MODEL, gpuLayers: 0 } });
  assert.equal(bench.status, 200, bench.text);
  const paths = admissionLines(s).map((l) => (l.match(/path ([a-z-]+)/) || [])[1]);
  assert.ok(paths.includes("benchmark"), paths.join(","));
  if (bench.json.winner) {
    assert.equal(paths[paths.length - 1], "benchmark-restore");
    assert.match(admissionLines(s).at(-1), /: exempt;/);
  }
});
