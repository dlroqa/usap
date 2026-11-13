// Step 9.9d: warn-only memory check before a model loads (services/memory-check.cjs). It compares a model's
// estimated needs with measured available memory and records an advisory result: it never refuses, delays or
// changes a load or a chat, and unknown memory never counts as enough. Off (USAP_MEMORY_CHECK=off, scheduler.json
// "memoryCheck": "off", or USAP_SCHEDULER=off) restores the responses from before 9.9d.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { makeRoot, startServer, stopServer, request, installFakeSdServer } = require("./api-contract/harness.cjs");
const { createMemoryAdvisor, assessModelLoad, memoryCheckSetting, describe, TEXT_OVERHEAD_BYTES, MIN_MARGIN_BYTES } = require("../server/services/memory-check.cjs");
const { inspectModel } = require("../server/model-metadata.cjs");
const { createScheduler } = require("../server/services/scheduler.cjs");

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "usap-memcheck-")); made.push(d); return d; };
test.after(() => { for (const d of made) try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* Windows may hold files briefly */ } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000, label = "condition") {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${label}`); await sleep(50); }
}

// Minimal GGUF v3 writer (metadata only). kv: [key, "str"|"u32", value].
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
// A llama-style header: layers, heads, kv heads and embedding size decide the KV cache.
const header = ({ layers = 22, heads = 32, kvHeads = 4, embedding = 2048, name = "SecretModelName" } = {}) => gguf([
  ["general.architecture", "str", "llama"], ["general.name", "str", name],
  ["llama.block_count", "u32", layers], ["llama.attention.head_count", "u32", heads],
  ["llama.attention.head_count_kv", "u32", kvHeads], ["llama.embedding_length", "u32", embedding],
]);
function modelFile(dir, name, buf, sizeBytes) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, buf);
  if (sizeBytes) fs.truncateSync(file, sizeBytes);
  return file;
}
// The KV cache formula: layers x context x kv heads x (key + value length) x bytes per value.
const kvBytes = ({ layers, kvHeads, keyLength, ctx, bytesPerValue }) => layers * ctx * kvHeads * 2 * keyLength * bytesPerValue;
const budget = (total, free, source = "mem-available") => ({ totalRamBytes: () => total, freeRamBytes: () => free, freeRamSource: () => source });
const assess = (o) => assessModelLoad({ kind: "text", inspectModel, platform: "linux", arch: "x64", now: () => 0, ...o });

let dir;
let small;     // 64 MiB file, 22 layers, 4 kv heads, key length 64
test.before(() => {
  dir = tmp();
  small = modelFile(dir, "secret-folder-model-q4_k_m.gguf", header(), 64 * MIB);
});
const cpuText = (o = {}) => ({ modelPath: small, contextSize: 4096, cacheTypeK: "q8_0", cacheTypeV: "q8_0", gpuLayers: 0, backendMode: "CPU", ...o });

// ── Unit: the assessment ──────────────────────────────────────────────────────
test("sufficient: measured file size + estimated KV cache + allowance, compared with measured available memory", () => {
  const a = assess({ info: cpuText(), budget: budget(16 * GIB, 8 * GIB) });
  const kv = kvBytes({ layers: 22, kvHeads: 4, keyLength: 2048 / 32, ctx: 4096, bytesPerValue: 34 / 32 });
  assert.equal(a.verdict, "likely-fits");
  assert.equal(a.warning, null);
  assert.deepEqual({ stage: a.stage, mode: a.mode, advisory: a.advisory, enforced: a.enforced, workload: a.workload, memoryPool: a.memoryPool },
    { stage: "9.9d", mode: "warn", advisory: true, enforced: false, workload: "text-model-load", memoryPool: "system-ram" });
  assert.deepEqual(a.required.parts.weightsBytes, { value: 64 * MIB, known: true, basis: "measured-file-size" });
  assert.equal(a.required.parts.kvCacheBytes.basis, "estimate-from-model-header");
  assert.equal(a.required.parts.kvCacheBytes.value, Math.round(kv / MIB) * MIB);
  assert.equal(a.required.parts.kvCacheBytes.cacheType, "q8_0/q8_0");
  assert.deepEqual(a.required.parts.overheadBytes, { value: TEXT_OVERHEAD_BYTES, known: true, basis: "fixed-allowance" });
  assert.equal(a.required.estimateBytes.value, Math.round((64 * MIB + Math.round(kv) + TEXT_OVERHEAD_BYTES) / MIB) * MIB);
  assert.equal(a.required.estimateBytes.basis, "estimate", "the total is labelled an estimate");
  assert.equal(a.required.contextSize, 4096);
  assert.deepEqual(a.available.ramBytes, { value: 8 * GIB, known: true, basis: "measured", source: "mem-available" });
  assert.deepEqual(a.available.marginBytes, { value: Math.round(16 * GIB * 0.05), known: true, basis: "fixed-rule" });
  assert.deepEqual(a.reasons, []);
});

test("insufficient: files larger than available memory → may-not-fit; estimate above available minus margin → tight", () => {
  const nofit = assess({ info: cpuText(), budget: budget(16 * GIB, 32 * MIB) });
  assert.equal(nofit.verdict, "may-not-fit");
  assert.equal(nofit.warning.code, "MEMORY_MAY_NOT_FIT");
  assert.match(nofit.warning.message, /larger than the memory available now/);
  // Available covers the files but not the files + cache + allowance + margin.
  const est = assess({ info: cpuText(), budget: budget(16 * GIB, 8 * GIB) }).required.estimateBytes.value;
  const tight = assess({ info: cpuText(), budget: budget(4 * GIB, est + MIN_MARGIN_BYTES - 1) });
  assert.equal(tight.verdict, "tight");
  assert.equal(tight.warning.code, "MEMORY_TIGHT");
  assert.equal(assess({ info: cpuText(), budget: budget(4 * GIB, est + MIN_MARGIN_BYTES) }).verdict, "likely-fits", "the margin boundary");
});

test("unknown or malformed memory readings are unknown, never 'likely-fits'", () => {
  const cases = [
    [budget(16 * GIB, null), "available-memory-unavailable"],
    [budget(16 * GIB, NaN), "available-memory-unavailable"],
    [budget(16 * GIB, -5), "available-memory-unavailable"],
    [budget(16 * GIB, "lots"), "available-memory-unavailable"],
    [{ totalRamBytes: () => 16 * GIB, freeRamBytes: () => { throw new Error("poll failed"); } }, "available-memory-unavailable"],
    [budget(8 * GIB, 64 * GIB), "available-memory-implausible"],
    [budget(0, 0), "total-memory-unavailable"],
    [budget(Infinity, 8 * GIB), "total-memory-unavailable"],
    [undefined, "available-memory-unavailable"],
  ];
  for (const [b, reason] of cases) {
    const a = assess({ info: cpuText(), budget: b });
    assert.notEqual(a.verdict, "likely-fits", reason);
    assert.ok(a.reasons.includes(reason), `${reason}: ${a.reasons}`);
    assert.equal(a.verdict, "unknown");
    if (reason !== "total-memory-unavailable") {
      assert.deepEqual({ value: a.available.ramBytes.value, known: a.available.ramBytes.known }, { value: null, known: false });
    }
  }
  // Without a readable total, an available reading can't be checked for plausibility: unknown, whatever it says.
  for (const free of [8 * GIB, 0]) assert.equal(assess({ info: cpuText(), budget: budget(0, free) }).verdict, "unknown");
  // macOS before the first vm_stat poll: free pages only, which reads low; said so.
  assert.ok(assess({ info: cpuText(), budget: budget(16 * GIB, 8 * GIB, "os-free-pages"), platform: "darwin", arch: "arm64" }).reasons.includes("macos-available-memory-pessimistic"));
});

test("missing or unreadable model metadata: the files still count as a lower bound; the total stays unknown", () => {
  const noLayers = modelFile(dir, "no-layers.gguf", gguf([["general.architecture", "str", "llama"]]), 2 * MIB);
  const a = assess({ info: cpuText({ modelPath: noLayers }), budget: budget(16 * GIB, 8 * GIB) });
  assert.equal(a.verdict, "unknown");
  assert.ok(a.reasons.includes("model-metadata-missing"));
  assert.deepEqual({ value: a.required.estimateBytes.value, known: a.required.estimateBytes.known }, { value: null, known: false });
  assert.equal(a.required.lowerBoundBytes.value, 2 * MIB);
  assert.equal(assess({ info: cpuText({ modelPath: noLayers }), budget: budget(16 * GIB, 1 * MIB) }).verdict, "may-not-fit", "files alone exceed memory");
  const garbage = modelFile(dir, "garbage.gguf", Buffer.from("GGUF\x03\x00\x00\x00"));
  assert.ok(assess({ info: cpuText({ modelPath: garbage }), budget: budget(16 * GIB, 8 * GIB) }).reasons.includes("model-metadata-missing"));
  const gone = assess({ info: cpuText({ modelPath: path.join(dir, "missing.gguf") }), budget: budget(16 * GIB, 8 * GIB) });
  assert.equal(gone.verdict, "unknown");
  assert.ok(gone.reasons.includes("model-size-unavailable"));
  assert.ok(assess({ info: cpuText({ contextSize: 0 }), budget: budget(16 * GIB, 8 * GIB) }).reasons.includes("context-size-unknown"));
  assert.ok(assess({ info: cpuText({ cacheTypeK: "zz9" }), budget: budget(16 * GIB, 8 * GIB) }).reasons.includes("cache-type-unknown"));
  const broken = assess({ info: cpuText(), budget: budget(16 * GIB, 8 * GIB), inspectModel: () => { throw new Error("header read failed"); } });
  assert.equal(broken.verdict, "unknown");
  assert.ok(broken.reasons.includes("model-metadata-missing"));
});

test("large models: a 70B-class header at 32k context is estimated without reading 40 GB (file size injected)", () => {
  const big = modelFile(dir, "big.gguf", header({ layers: 80, heads: 64, kvHeads: 8, embedding: 8192 }));
  const sizeOf = (p) => (p === big ? 40 * GIB : null);
  const info = cpuText({ modelPath: big, contextSize: 32768 });
  const kv = kvBytes({ layers: 80, kvHeads: 8, keyLength: 128, ctx: 32768, bytesPerValue: 34 / 32 });
  const a = assess({ info, sizeOf, budget: budget(64 * GIB, 60 * GIB) });
  assert.equal(a.required.parts.kvCacheBytes.value, Math.round(kv / MIB) * MIB);
  assert.equal(a.required.estimateBytes.value, Math.round((40 * GIB + Math.round(kv) + TEXT_OVERHEAD_BYTES) / MIB) * MIB);
  assert.ok(Number.isSafeInteger(a.required.estimateBytes.value));
  assert.equal(a.verdict, "likely-fits");
  assert.equal(assess({ info, sizeOf, budget: budget(64 * GIB, 45 * GIB) }).verdict, "tight");
  assert.equal(assess({ info, sizeOf, budget: budget(32 * GIB, 30 * GIB) }).verdict, "may-not-fit");
  // f16 cache doubles (34/32 → 2 bytes per value) the cache; q4_0 shrinks it.
  const f16 = assess({ info: { ...info, cacheTypeK: "f16", cacheTypeV: "f16" }, sizeOf, budget: budget(64 * GIB, 60 * GIB) });
  assert.equal(f16.required.parts.kvCacheBytes.value, Math.round(kvBytes({ layers: 80, kvHeads: 8, keyLength: 128, ctx: 32768, bytesPerValue: 2 }) / MIB) * MIB);
  // A vision projector counts as model files.
  const proj = modelFile(dir, "mmproj.gguf", Buffer.alloc(16), 3 * MIB);
  assert.equal(assess({ info: cpuText({ projectorPath: proj }), budget: budget(16 * GIB, 8 * GIB) }).required.parts.weightsBytes.value, 67 * MIB);
});

test("GPU offload: discrete GPU memory isn't assessed (unknown); Apple Silicon compares with the shared pool; CPU or 0 layers compare with RAM", () => {
  const b = budget(16 * GIB, 8 * GIB);
  const cuda = assess({ info: cpuText({ backendMode: "GPU (CUDA)", gpuLayers: -1 }), budget: b });
  assert.equal(cuda.memoryPool, "gpu-offload-not-assessed");
  assert.equal(cuda.verdict, "unknown");
  assert.ok(cuda.reasons.includes("gpu-memory-not-assessed"));
  assert.equal(assess({ info: cpuText({ backendMode: "GPU (Vulkan)", gpuLayers: 0 }), budget: b }).memoryPool, "system-ram");
  const metal = assess({ info: cpuText({ backendMode: "GPU (Metal)", gpuLayers: 99 }), budget: b, platform: "darwin", arch: "arm64" });
  assert.equal(metal.memoryPool, "unified");
  assert.equal(metal.verdict, "likely-fits");
  assert.ok(metal.reasons.includes("unified-memory"));
  assert.equal(assess({ info: cpuText({ backendMode: "GPU (Metal)", gpuLayers: 99 }), budget: b, platform: "darwin", arch: "x64" }).memoryPool, "gpu-offload-not-assessed", "Intel Macs have separate GPU memory");
  const image = assessModelLoad({ kind: "image", info: { modelPath: small, useGpu: false }, budget: b, platform: "win32", arch: "x64" });
  assert.equal(image.workload, "image-model-load");
  assert.equal(image.verdict, "unknown", "image working memory depends on resolution and isn't estimated");
  assert.ok(image.reasons.includes("compute-memory-unknown"));
  assert.equal(image.required.lowerBoundBytes.value, 64 * MIB);
  assert.equal(assessModelLoad({ kind: "image", info: { modelPath: small }, budget: budget(16 * GIB, MIB) }).verdict, "may-not-fit");
});

test("concurrent workloads are reported, and never change the verdict", () => {
  const b = budget(16 * GIB, 8 * GIB);
  const quiet = assess({ info: cpuText(), budget: b });
  const busy = assess({ info: cpuText(), budget: b, activity: { transcribing: true, chatActive: true, synthesizing: false, imageGenerating: "yes" } });
  assert.deepEqual(busy.otherWorkloads, ["chatActive", "transcribing"]);
  assert.ok(busy.reasons.includes("other-workloads-active"));
  assert.equal(busy.verdict, quiet.verdict);
  assert.deepEqual(busy.required, quiet.required);
});

test("never throws: bad inputs give an 'unknown' result", () => {
  for (const o of [{ kind: "text", info: null }, { kind: "text", info: undefined, budget: {} }, { kind: "video", info: {} }, { kind: "text", info: { modelPath: 42 }, budget: { totalRamBytes: null } }]) {
    const a = assessModelLoad({ inspectModel, ...o });
    assert.equal(a.verdict, "unknown", JSON.stringify(o));
    assert.equal(a.enforced, false);
  }
});

test("privacy: results and log lines carry sizes, codes and verdicts only: no paths, file or model names, user names", () => {
  const user = (() => { try { return os.userInfo().username; } catch (_) { return ""; } })();
  const outputs = [];
  for (const free of [8 * GIB, 32 * MIB, null]) {
    const a = assess({ info: cpuText({ projectorPath: small }), budget: budget(16 * GIB, free), activity: { chatActive: true } });
    outputs.push(JSON.stringify(a), describe(a));
  }
  for (const s of outputs) {
    for (const secret of [dir, path.basename(small), "secret-folder-model", "SecretModelName", os.tmpdir(), os.homedir()]) assert.ok(!s.includes(secret), `leaks ${secret}: ${s}`);
    if (user.length >= 4) assert.ok(!s.includes(user), "no user name");
    assert.ok(!/[\\/]/.test(s.replace(/q8_0\/q8_0/g, "").replace(/"at":"[^"]*"/, "")), `no path separators: ${s}`);
  }
  const keys = Object.keys(assess({ info: cpuText(), budget: budget(16 * GIB, 8 * GIB) })).sort();
  assert.deepEqual(keys, ["advisory", "at", "available", "enforced", "memoryPool", "mode", "otherWorkloads", "reasons", "required", "stage", "verdict", "warning", "workload"]);
});

test("setting: warn by default; off through USAP_MEMORY_CHECK or scheduler.json; the environment wins; USAP_SCHEDULER=off turns it off", () => {
  const d = tmp();
  assert.equal(memoryCheckSetting({ env: {}, configDir: d }).mode, "warn");
  assert.equal(memoryCheckSetting({ env: { USAP_MEMORY_CHECK: "off" }, configDir: d }).mode, "off");
  assert.equal(memoryCheckSetting({ env: { USAP_MEMORY_CHECK: "enforce" }, configDir: d }).mode, "warn", "no enforce mode exists in 9.9d");
  fs.writeFileSync(path.join(d, "scheduler.json"), JSON.stringify({ memoryCheck: "off" }));
  assert.equal(memoryCheckSetting({ env: {}, configDir: d }).mode, "off");
  assert.equal(memoryCheckSetting({ env: { USAP_MEMORY_CHECK: "warn" }, configDir: d }).mode, "warn", "the environment wins");
  assert.equal(memoryCheckSetting({ env: { USAP_MEMORY_CHECK: "warn" }, configDir: d, schedulerMode: "off" }).mode, "off");
  fs.writeFileSync(path.join(d, "scheduler.json"), "{ not json");
  assert.equal(memoryCheckSetting({ env: {}, configDir: d }).mode, "warn");
});

test("advisor: off does nothing; on records the latest result per engine and logs one line; its own failures never escape", () => {
  const lines = [];
  const off = createMemoryAdvisor({ setting: { mode: "off" }, budget: budget(16 * GIB, 8 * GIB), inspectModel, log: (l) => lines.push(l) });
  assert.equal(off.beforeLoad("text", cpuText()), null);
  assert.equal(off.last("text"), null);
  assert.equal(off.snapshot(), null);
  assert.deepEqual(lines, []);
  const on = createMemoryAdvisor({ budget: budget(16 * GIB, 8 * GIB), inspectModel, log: (l) => lines.push(l), activity: () => { throw new Error("x"); } });
  const a = on.beforeLoad("text", cpuText());
  assert.equal(a.verdict, "likely-fits");
  assert.equal(on.last("text"), a);
  assert.deepEqual(on.snapshot(), { text: a, image: null });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^ {2}\[memory\] Text model: likely-fits; needs about [\d.]+ GB \(estimate, 4096-token context\); [\d.]+ GB available \(measured\)\. Warning only, loading continues\.$/);
  const loud = createMemoryAdvisor({ budget: { totalRamBytes: () => { throw new Error("x"); }, freeRamBytes: () => { throw new Error("x"); } }, inspectModel: () => { throw new Error("x"); }, log: () => { throw new Error("log broke"); } });
  assert.equal(loud.beforeLoad("text", cpuText()).verdict, "unknown");
});

test("scheduler snapshot: memoryCheck warn adds memory.checks and limits.memoryCheck 'warn'; off is the 9.9c snapshot", () => {
  const cpu = { logicalCores: () => 4, physicalCores: () => 2 };
  const eng = { text: () => ({ state: "stopped", loaded: false }), image: () => ({ state: "stopped", loaded: false }), speech: () => ({ state: "stopped" }), voice: () => ({ state: "stopped" }), download: () => ({}), heavyModel: () => null };
  const b = budget(16 * GIB, 8 * GIB);
  const off = createScheduler({ cpu, budget: b, engines: eng }).snapshot();
  assert.equal(off.limits.memoryCheck, "off");
  assert.equal(off.scheduler.stage, "9.9c");
  assert.equal("checks" in off.memory, false);
  const checks = { text: { verdict: "tight" }, image: null };
  const on = createScheduler({ cpu, budget: b, engines: eng, memoryCheck: { mode: "warn" }, memoryChecks: () => checks }).snapshot();
  assert.equal(on.limits.memoryCheck, "warn");
  assert.deepEqual(on.memory.checks, checks);
  assert.deepEqual(on.scheduler, { mode: "observe", stage: "9.9d", decisions: false }, "warnings are not decisions");
  const broken = createScheduler({ cpu, budget: b, engines: eng, memoryCheck: { mode: "warn" }, memoryChecks: () => { throw new Error("x"); } }).snapshot();
  assert.deepEqual(broken.memory.checks, { text: null, image: null });
});

// ── The real server with the fake engines ────────────────────────────────────
// A header whose KV cache at 512 tokens is far larger than any computer's memory, while the file is tiny:
// every server below gets the MEMORY_TIGHT warning, deterministically, on every OS.
const HUGE = { layers: 200000, heads: 64, kvHeads: 64, embedding: 8192 };
async function textServer(env = {}) {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, "app", "llm-models", "huge-cache-q4_0.gguf"), header({ ...HUGE, name: "SecretModelName" }));
  const srv = await startServer(root, env);
  const start = await request(srv.port, "POST", "/api/llm/start", { body: { model: "huge-cache-q4_0.gguf", contextSize: 512, gpuLayers: 0 } });
  assert.equal(start.status, 200, start.text);
  await waitFor(async () => (await request(srv.port, "GET", "/api/llm/status")).json.ready, 20000, "ready");
  srv.enginePort = (await request(srv.port, "GET", "/api/llm/status")).json.port;
  return { root, srv, start };
}
async function close({ root, srv }) {
  try { await request(srv.port, "POST", "/api/llm/stop", { body: {} }); } catch (_) { /* down */ }
  stopServer(srv); await sleep(300);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* Windows may hold files briefly */ }
}
function chat(port, content, { stream = true } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/llm/chat", headers: { "Content-Type": "application/json" } }, (res) => {
      let text = ""; res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode, text, retryAfter: res.headers["retry-after"] || null }));
      res.on("aborted", () => resolve({ cut: true, text }));
    });
    req.on("error", () => resolve({ cut: true }));
    req.end(JSON.stringify({ messages: [{ role: "user", content }], stream }));
  });
}
const resources = async (s) => (await request(s.srv.port, "GET", "/api/resources")).json;
const engineStats = async (s) => JSON.parse((await request(s.srv.enginePort, "GET", "/fake/stats")).text);
// Strip what differs between two runs (time, ports) to compare answers.
const stable = (r) => ({ status: r.status, text: (r.text || "").replace(/"created":\d+/g, "").replace(/id=[0-9a-f]+/g, "") });

test("server, default (warn): a model estimated not to fit loads and chats exactly as with the check off; the warning is in the start response, /api/resources and the log", async (t) => {
  const warn = await textServer();
  t.after(() => close(warn));
  const mc = warn.start.json.memoryCheck;
  assert.equal(mc.verdict, "tight");
  assert.equal(mc.warning.code, "MEMORY_TIGHT");
  assert.equal(mc.enforced, false);
  assert.equal(mc.required.contextSize, 512, "assessed at the context size the engine was started with");
  assert.equal(warn.start.json.ok, true);
  assert.equal(warn.start.json.ready, true, "the warning didn't stop the load");
  const r = await resources(warn);
  assert.equal(r.limits.memoryCheck, "warn");
  assert.deepEqual(r.memory.checks.text, mc);
  assert.equal(r.memory.checks.image, null);
  assert.equal(r.scheduler.decisions, false);
  const lines = warn.srv.log().split(/\r?\n/).filter((l) => l.includes("[memory]"));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Text model: tight; .*Warning only, loading continues\./);

  const off = await textServer({ USAP_MEMORY_CHECK: "off" });
  t.after(() => close(off));
  assert.deepEqual(Object.keys(off.start.json).sort(), ["ok", "port", "ready", "settings"], "off: the start response from before 9.9d");
  assert.deepEqual(Object.keys(warn.start.json).sort(), ["memoryCheck", "ok", "port", "ready", "settings"], "warn: one additive field");
  const { port: _p1, ...warnSettings } = warn.start.json.settings; const { port: _p2, ...offSettings } = off.start.json.settings;
  assert.deepEqual(warnSettings, offSettings, "same settings chosen: context, threads, layers, cache, backend");
  const offRes = await resources(off);
  assert.equal(offRes.limits.memoryCheck, "off");
  assert.equal("checks" in offRes.memory, false);
  assert.equal(offRes.scheduler.stage, "9.9c");
  assert.ok(!off.srv.log().includes("[memory]"), "off: no log line");

  // Same chat outcomes, success and failure, streaming and not.
  for (const [content, stream] of [["hello", true], ["hello", false], ["MODE:count=5", true], ["MODE:http-error", true], ["MODE:http-error", false], ["MODE:oom", false]]) {
    const [a, b] = [await chat(warn.srv.port, content, { stream }), await chat(off.srv.port, content, { stream })];
    assert.deepEqual(stable(a), stable(b), `${content} stream=${stream}`);
  }
  // Privacy of the response and log line.
  const all = JSON.stringify(warn.start.json.memoryCheck) + lines.join("\n");
  for (const secret of [warn.root, "huge-cache", "SecretModelName", os.homedir()]) assert.ok(!all.includes(secret), `leaks ${secret}`);
});

test("server, chat queue on: queue admission is the same with a memory warning as with the check off", async (t) => {
  const outcome = async (env) => {
    const s = await textServer({ USAP_CHAT_QUEUE: "on", ...env });
    t.after(() => close(s));
    const release = () => request(s.srv.enginePort, "POST", "/fake/release", { body: {} }).catch(() => {});
    t.after(release);
    const sent = [chat(s.srv.port, "MODE:hold TAG:h0")];
    await waitFor(async () => (await engineStats(s)).held === 1, 10000, "h0 held");
    for (let i = 1; i <= 4; i++) {
      sent.push(chat(s.srv.port, `MODE:delay=20 TAG:h${i}`));
      await waitFor(async () => (await resources(s)).engines.text.chat.waitingForEngineConnection === i, 10000, `h${i} waiting`);
    }
    const refused = await chat(s.srv.port, "MODE:delay=20 TAG:h5");
    await release();
    const results = await Promise.all(sent);
    return { memory: (await resources(s)).limits.memoryCheck, statuses: [...results.map((r) => r.status), refused.status], order: (await engineStats(s)).order, code: JSON.parse(refused.text).code };
  };
  const warn = await outcome({});
  const off = await outcome({ USAP_MEMORY_CHECK: "off" });
  assert.equal(warn.memory, "warn"); assert.equal(off.memory, "off");
  assert.deepEqual(warn.statuses, [200, 200, 200, 200, 200, 429]);
  assert.deepEqual(warn.statuses, off.statuses);
  assert.deepEqual(warn.order, off.order);
  assert.equal(warn.code, "QUEUE_FULL");
});

test("server: an engine crash and automatic restart is assessed again and restarts as before", async (t) => {
  const s = await textServer();
  t.after(() => close(s));
  const first = (await resources(s)).memory.checks.text;
  const { pid } = await engineStats(s);
  process.kill(pid, "SIGKILL");
  await waitFor(async () => { const st = (await request(s.srv.port, "GET", "/api/llm/status")).json; return st.ready && st.engine.restartsInWindow === 1; }, 30000, "bounded restart");
  const second = (await resources(s)).memory.checks.text;
  assert.notEqual(second.at, first.at, "the restart was assessed again");
  assert.equal(second.verdict, "tight");
  assert.equal(s.srv.log().split(/\r?\n/).filter((l) => l.includes("[memory] Text model")).length, 2);
  s.srv.enginePort = (await request(s.srv.port, "GET", "/api/llm/status")).json.port;
  assert.equal((await chat(s.srv.port, "after restart")).status, 200);
});

test("server: a start that fails before loading carries no memory result; USAP_SCHEDULER=off turns the check off", async (t) => {
  const s = await textServer();
  t.after(() => close(s));
  const missing = await request(s.srv.port, "POST", "/api/llm/start", { body: { model: "not-there.gguf" } });
  assert.equal(missing.status, 404);
  assert.equal("memoryCheck" in missing.json, false, "no stale result from the earlier load");
  const root = makeRoot();
  fs.writeFileSync(path.join(root, "app", "llm-models", "huge-cache-q4_0.gguf"), header(HUGE));
  const srv = await startServer(root, { USAP_SCHEDULER: "off" });
  t.after(() => close({ root, srv }));
  const start = await request(srv.port, "POST", "/api/llm/start", { body: { model: "huge-cache-q4_0.gguf", contextSize: 512, gpuLayers: 0 } });
  assert.equal(start.status, 200);
  assert.equal("memoryCheck" in start.json, false);
  assert.equal((await request(srv.port, "GET", "/api/resources")).status, 404, "the scheduler route stays out, as before");
  assert.ok(!srv.log().includes("[memory]"));
});

test("server: an image model load is assessed (file size only; working memory unknown) and loads as before", async (t) => {
  const root = makeRoot();
  installFakeSdServer(root);
  const kv = (key, type, val) => {
    const k = Buffer.from(key); const head = Buffer.alloc(8 + k.length + 4); head.writeBigUInt64LE(BigInt(k.length)); k.copy(head, 8); head.writeUInt32LE(type, 8 + k.length);
    if (type === 8) { const v = Buffer.from(val); const b = Buffer.alloc(8 + v.length); b.writeBigUInt64LE(BigInt(v.length)); v.copy(b, 8); return Buffer.concat([head, b]); }
    const b = Buffer.alloc(4); b.writeUInt32LE(val); return Buffer.concat([head, b]);
  };
  const h = Buffer.alloc(24); h.write("GGUF"); h.writeUInt32LE(3, 4); h.writeBigUInt64LE(0n, 8); h.writeBigUInt64LE(2n, 16);
  const file = path.join(root, "app", "models", "sd1-test-q4_0.gguf");
  fs.writeFileSync(file, Buffer.concat([h, kv("general.architecture", 8, "sd1"), kv("general.file_type", 4, 2)]));
  fs.truncateSync(file, 130 * MIB);
  const srv = await startServer(root);
  t.after(async () => { try { await request(srv.port, "POST", "/api/stop-backend", { body: {} }); } catch (_) { /* down */ } stopServer(srv); await sleep(300); try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* Windows */ } });
  const r = await request(srv.port, "POST", "/api/restart-backend", { body: { model: "sd1-test-q4_0.gguf", backend_type: "cpu", use_gpu: false, width: 64, height: 64, steps: 4 } });
  assert.equal(r.status, 200, r.text);
  const mc = r.json.memoryCheck;
  assert.equal(mc.workload, "image-model-load");
  assert.equal(mc.required.lowerBoundBytes.value, 130 * MIB);
  assert.ok(mc.reasons.includes("compute-memory-unknown"));
  assert.ok(["unknown", "may-not-fit"].includes(mc.verdict), "never 'likely-fits' without a working-memory estimate");
  await waitFor(async () => (await request(srv.port, "GET", "/api/backend-status")).json.ready, 20000, "image engine ready");
  assert.deepEqual((await request(srv.port, "GET", "/api/resources")).json.memory.checks.image, mc);
  assert.ok(!JSON.stringify(mc).includes("sd1-test"), "no file name");
});
