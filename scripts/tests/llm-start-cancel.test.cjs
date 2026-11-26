// #197/#181 round 20: a text-engine start that needs the GPU information (automatic context size) waits for the
// bounded GPU discovery BEFORE it stops the old engine or chooses a port, and a stop ends that wait at once. Unit
// harness: the real services/llm-engine.cjs with injected fakes - a controllable gpuReady(), a recording checkPort(),
// a recording supervisor.spawnSupervised() and an http.get that answers /v1/models - so no real port, process or
// timer is used and every step is deterministic.
"use strict";
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createLlmEngine } = require("../server/services/llm-engine.cjs");
const errors = require("../server/errors.cjs");

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async (n = 5) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };
function writeGguf(file) { // a minimal GGUF header: architecture llama, file type Q4_K_M
  const kv = (key, type, val) => {
    const k = Buffer.from(key); const head = Buffer.alloc(8 + k.length + 4); head.writeBigUInt64LE(BigInt(k.length)); k.copy(head, 8); head.writeUInt32LE(type, 8 + k.length);
    if (type === 8) { const v = Buffer.from(val); const b = Buffer.alloc(8 + v.length); b.writeBigUInt64LE(BigInt(v.length)); v.copy(b, 8); return Buffer.concat([head, b]); }
    const b = Buffer.alloc(4); b.writeUInt32LE(val); return Buffer.concat([head, b]);
  };
  const header = Buffer.alloc(24); header.write("GGUF"); header.writeUInt32LE(3, 4); header.writeBigUInt64LE(0n, 8); header.writeBigUInt64LE(2n, 16);
  fs.writeFileSync(file, Buffer.concat([header, kv("general.architecture", 8, "llama"), kv("general.file_type", 4, 15)]));
}

function harness({ gpuReady, checkPort, waitForPortAvailable, preferredBusy = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usap-llm-cancel-"));
  const models = path.join(root, "models"); fs.mkdirSync(models);
  writeGguf(path.join(models, "tiny.gguf"));
  const bin = path.join(root, process.platform === "win32" ? "llama-server.exe" : "llama-server"); fs.writeFileSync(bin, "");
  const events = [], spawns = [], ports = [];
  const proc = () => { const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.pid = 4242; p.exitCode = null; p.kill = () => { if (p.exitCode === null) { p.exitCode = 0; setImmediate(() => p.emit("exit", 0, null)); } return true; }; return p; };
  const http = { get: (url, cb) => {
    const req = new EventEmitter(); req.setTimeout = () => req; req.destroy = () => {};
    setImmediate(() => { const res = new EventEmitter(); res.statusCode = 200; res.setEncoding = () => {}; cb(res); res.emit("data", JSON.stringify({ data: [{ id: "tiny.gguf" }] })); res.emit("end"); });
    return req;
  } };
  const engine = createLlmEngine({
    ...errors, LLM_BACKEND_PATHS: { linuxCpu: bin, winCpu: bin, macX64: bin, macArm64: bin }, LLM_BENCHMARK_PATH: path.join(root, "bench.json"), LLM_MODELS: models,
    LLM_MODEL_SETTINGS_PATH: path.join(root, "settings.json"), PREFERRED_LLM_PORT: 28080, assertNoOtherActiveRuntime: () => {},
    checkPort: checkPort || (async (port) => { events.push(`checkPort ${port}`); ports.push(port); return { available: !(preferredBusy && port === 28080) }; }),
    decideRestart: () => ({ restart: false }), fs, getGpuInfo: () => ({ name: "Unavailable", vram_gb: 0 }), getStableSyclGpuLayers: (f, l) => l, http,
    isVisionModelFilename: () => false, killBackend: async () => {}, killOpenVinoWorker: async () => {}, os, osPlatform: "linux", path,
    pathInside: (c, p) => { const r = path.relative(p, c); return !!r && !r.startsWith("..") && !path.isAbsolute(r); },
    readJsonFile: (f, fb) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return fb; } }, writeJsonFile: () => {},
    readdirVisible: (d) => fs.readdirSync(d).filter((n) => !n.startsWith(".")), requestJson: async () => ({}),
    spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
    supervisor: { spawnSupervised: (file, args) => { events.push("spawn"); spawns.push(args); const p = proc(); return p; } },
    waitForChildExit: async (p) => { if (p && p.exitCode === null) await new Promise((r) => p.once("exit", r)); return true; },
    waitForPortAvailable: waitForPortAvailable || (async () => true),
    gpuReady: gpuReady ? (() => { events.push("gpuReady"); return gpuReady(); }) : undefined,
  });
  const cleanup = async () => { try { await engine.fns.killLlm(); } catch (_) {} fs.rmSync(root, { recursive: true, force: true }); };
  return { engine, f: engine.fns, st: engine.state, events, spawns, ports, cleanup };
}
// llmSettings without the four fields killLlm() always resets on any cancel (the existing cancel path), so a comparison
// shows only what the cancelled start itself would have written (its model, context, backend, port)
const startState = (st) => { const { supportsVision, visionMode, visionStatus, mmproj, ...rest } = st.llmSettings; return JSON.stringify({ port: st.PORT_LLM, ...rest }); };
const settled = (p) => { const s = { done: false, err: null, value: undefined }; p.then((v) => { s.done = true; s.value = v; }, (e) => { s.done = true; s.err = e; }); return s; };

test("without a stop: the GPU discovery is awaited before the first port check, then the engine starts (automatic context)", async (t) => {
  const g = deferred(); const h = harness({ gpuReady: () => g.promise }); t.after(h.cleanup);
  const s = settled(h.f.startLlm({ model: "tiny.gguf" }));
  await flush();
  assert.deepEqual(h.events, ["gpuReady"], "waiting for discovery; nothing stopped or checked yet");
  g.resolve(); await flush(20);
  assert.equal(s.err, null, s.err && s.err.message); assert.equal(s.done, true);
  assert.deepEqual(h.events.slice(0, 3), ["gpuReady", "checkPort 28080", "spawn"]);
  assert.equal(h.st.gpuWaitListeners, 0, "no listener left");
});

test("a stop during the GPU wait ends the start at once: ENGINE_START_CANCELLED, no port check, no spawn - also after discovery settles", async (t) => {
  const g = deferred(); const h = harness({ gpuReady: () => g.promise }); t.after(h.cleanup);
  const before = startState(h.st);
  const s = settled(h.f.startLlm({ model: "tiny.gguf" }));
  await flush(); assert.deepEqual(h.events, ["gpuReady"]); assert.equal(h.st.gpuWaitListeners, 1);
  await h.f.stopLlmNow(); await flush();
  assert.equal(s.done, true, "the start ended without waiting for discovery");
  assert.equal(s.err && s.err.code, "ENGINE_START_CANCELLED");
  assert.equal(h.st.gpuWaitListeners, 0);
  g.resolve(); await flush(20); // a late discovery restarts nothing
  assert.deepEqual(h.events, ["gpuReady"], "no port check and no spawn, before or after discovery settled");
  assert.equal(startState(h.st), before, "no state left behind"); assert.equal(h.st.llmSettings.model, null);
});

test("a stop during the old engine's stop (port release wait) or during the port check ends the start before any state changes, with no spawn", async (t) => {
  for (const where of ["release", "checkPort"]) {
    const gate = deferred(); let reached = null; const events = [];
    const h = harness({
      gpuReady: async () => {},
      waitForPortAvailable: where === "release" ? (async () => { reached && reached(); await gate.promise; return true; }) : undefined,
      checkPort: where === "checkPort" ? (async (port) => { events.push(port); reached && reached(); await gate.promise; return { available: port !== 28080 }; }) : undefined,
      preferredBusy: true, // the preferred port is busy, so a start that went on would choose 28121 (visible in PORT_LLM)
    });
    t.after(h.cleanup);
    const atGate = new Promise((r) => { reached = r; });
    const before = startState(h.st);
    const s = settled(h.f.startLlm({ model: "tiny.gguf" }));
    await atGate; await h.f.stopLlmNow(); reached = null; gate.resolve(); await flush(20);
    assert.equal(h.st.PORT_LLM, 28080, `${where}: the port of the earlier state`);
    assert.equal(s.err && s.err.code, "ENGINE_START_CANCELLED", where);
    assert.equal(h.spawns.length, 0, `${where}: no engine spawned after the stop`);
    assert.equal(startState(h.st), before, `${where}: PORT_LLM and llmSettings unchanged (the cancelled model is not shown)`);
    assert.equal(h.st.llmSettings.model, null, where);
  }
});

test("discovery that fails (rejects or throws) does not block the start (fail open, as before); an explicit context size never waits", async (t) => {
  for (const [label, gpuReady] of [["rejects", () => Promise.reject(new Error("x"))], ["throws", () => { throw new Error("y"); }]]) {
    const h = harness({ gpuReady }); t.after(h.cleanup);
    await h.f.startLlm({ model: "tiny.gguf" });
    assert.equal(h.spawns.length, 1, label); assert.equal(h.st.gpuWaitListeners, 0, label);
  }
  const g = deferred(); const h = harness({ gpuReady: () => g.promise }); t.after(h.cleanup);
  await h.f.startLlm({ model: "tiny.gguf", contextSize: 4096 });
  assert.ok(!h.events.includes("gpuReady"), "an explicit context does not read the GPU information, so it does not wait");
  assert.equal(h.spawns.length, 1);
});

test("many starts leave no stop listener behind; a stop right after a start reached its GPU wait (synchronously) cancels at once", async (t) => {
  const h = harness({ gpuReady: async () => {} }); t.after(h.cleanup);
  for (let i = 0; i < 25; i += 1) { await h.f.startLlm({ model: "tiny.gguf" }); assert.equal(h.st.gpuWaitListeners, 0, `start ${i}`); await h.f.killLlm(); }
  // a stop issued right after startLlm() returns: the start has already registered its wait (it is reached synchronously)
  const g = deferred(); const h2 = harness({ gpuReady: () => g.promise }); t.after(h2.cleanup);
  const p = h2.f.startLlm({ model: "tiny.gguf" }); const stop = h2.f.stopLlmNow();
  const s = settled(p); await stop; await flush();
  assert.equal(s.err && s.err.code, "ENGINE_START_CANCELLED"); assert.equal(h2.st.gpuWaitListeners, 0);
  g.resolve(); await flush(10); assert.equal(h2.spawns.length, 0);
});

test("graceful shutdown cancels a start in progress first and awaits that stop: SIGINT and SIGTERM (source guard)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server", "serve.cjs"), "utf8");
  for (const sig of ["SIGINT", "SIGTERM"]) {
    const m = src.match(new RegExp(`process\\.on\\("${sig}",\\s*async \\(\\) => \\{([^\\n]*)\\}\\);`));
    assert.ok(m, `${sig} handler found`);
    const body = m[1].trim();
    assert.ok(body.startsWith("const llmStop = stopLlmNow().catch(() => {});"), `${sig}: the first statement cancels a start in progress`);
    assert.ok(body.indexOf("await llmStop;") > body.indexOf("await killLlm();"), `${sig}: that stop is awaited after killLlm (engine exit confirmed)`);
  }
});
