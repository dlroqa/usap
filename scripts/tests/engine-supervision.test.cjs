// Step 9.6: engine supervision. Engines must never outlive the studio server, stop cleanly, report
// crashes, restart a bounded number of times, and handle cancelled, failed and timed-out starts.
// Uses the contract tests' fake llama-server (a compiled stand-in .exe on Windows), never real models.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawn, spawnSync } = require("node:child_process");

const { makeRoot, startServer, stopServer, request, fakeLlamaPath } = require("./api-contract/harness.cjs");
const supervisor = require("../server/supervisor.cjs");
const { decideRestart, isOutOfMemory } = require("../server/restart-policy.cjs");

const IS_WIN = process.platform === "win32";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function get(port, urlPath) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: urlPath, timeout: 1500 }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}
const engineUp = async (port) => Boolean(await get(port, "/v1/models"));
const enginePid = async (port) => { const r = await get(port, "/fake/stats"); return r ? JSON.parse(r.text).pid : null; };

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; }
}

// Hard kill of exactly one process: no handlers run, children are not touched.
function hardKill(pid) {
  if (IS_WIN) spawnSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(pid), "/F"], { stdio: "ignore" });
  else process.kill(pid, "SIGKILL");
}

async function waitFor(check, ms, what) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) assert.fail(`timed out after ${ms} ms waiting for: ${what}`);
    await sleep(100);
  }
}

function exitOf(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve({ code: proc.exitCode, signal: proc.signalCode });
    proc.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

let root;
let engine;
test.before(() => { root = makeRoot(); engine = fakeLlamaPath(root); });
test.after(() => { fs.rmSync(root, { recursive: true, force: true }); });

const engineEnv = () => ({ ...process.env, USAP_TEST_NODE: process.execPath });

// ── The supervisor on its own ───────────────────────────────────────────────
// A stand-in "server" process that starts one engine and then waits.
function parentScript() {
  const file = path.join(root, "parent.cjs");
  fs.writeFileSync(file, `
    const { spawn } = require("child_process");
    const supervisor = require(${JSON.stringify(path.join(__dirname, "..", "server", "supervisor.cjs"))});
    const [mode, engine, port] = process.argv.slice(2);
    const opts = { stdio: "ignore", env: process.env };
    const p = mode === "supervised" ? supervisor.spawnSupervised(engine, ["--port", port], opts) : spawn(engine, ["--port", port], opts);
    p.on("exit", () => {});
    setInterval(() => {}, 1000);
  `);
  return file;
}

// The original problem exists on Linux and macOS. On Windows, Node (libuv) already puts its direct
// children in a kill-on-close job object, so a plainly spawned engine dies with its parent there.
for (const mode of ["unsupervised", "supervised"]) {
  const title = mode === "supervised" ? "a supervised engine stops too (fixed)"
    : IS_WIN ? "a plainly spawned engine stops too on Windows (Node's job object), the baseline"
      : "a plainly spawned engine keeps running (the original problem)";
  test(`orphans: when the server is killed outright, ${title}`, async () => {
    const port = await freePort();
    const parent = spawn(process.execPath, [parentScript(), mode, engine, String(port)], { stdio: "ignore", env: engineEnv() });
    try {
      await waitFor(() => engineUp(port), 15000, "engine up");
      const pid = await enginePid(port);
      hardKill(parent.pid);
      await exitOf(parent);
      if (mode === "unsupervised" && IS_WIN) {
        await waitFor(async () => !(await engineUp(port)), 10000, "Windows ends direct children with their parent");
      } else if (mode === "unsupervised") {
        await sleep(3000);
        assert.equal(await engineUp(port), true, "without supervision the engine survives its parent");
        hardKill(pid);
        await waitFor(async () => !(await engineUp(port)), 10000, "manual cleanup");
      } else {
        await waitFor(async () => !(await engineUp(port)), 10000, "the engine stops after its server is killed");
        await waitFor(() => !pidAlive(pid), 10000, "engine process gone");
      }
    } finally {
      try { hardKill(parent.pid); } catch (_) { /* already gone */ }
    }
  });
}

test("supervisor: a polite stop ends the engine, frees its port and mirrors the exit", async () => {
  const port = await freePort();
  const p = supervisor.spawnSupervised(engine, ["--port", String(port)], { stdio: "pipe", env: engineEnv() }, { label: "t" });
  assert.equal(p.supervised, true);
  await waitFor(() => engineUp(port), 15000, "engine up");
  const pid = await enginePid(port);
  assert.ok(supervisor.snapshot().supervised.some((r) => r.guardPid === p.pid));
  p.kill("SIGTERM");
  const exit = await exitOf(p);
  if (!IS_WIN) assert.equal(exit.signal, "SIGTERM", "the engine's signal is mirrored");
  assert.equal(pidAlive(pid), false);
  assert.equal(await engineUp(port), false);
  assert.ok(!supervisor.snapshot().supervised.some((r) => r.guardPid === p.pid));
  assert.ok(supervisor.snapshot().recentExits.some((r) => r.label === "t"));
});

test("supervisor: an engine that ignores the polite stop is forced after the grace period; SIGKILL is immediate", async () => {
  const port = await freePort();
  const env = { ...engineEnv(), USAP_ENGINE_STOP_GRACE_MS: "500" };
  let p = supervisor.spawnSupervised(engine, ["--port", String(port), "--fake-ignore-sigterm"], { stdio: "pipe", env });
  await waitFor(() => engineUp(port), 15000, "engine up");
  let pid = await enginePid(port);
  const t0 = Date.now();
  p.kill("SIGTERM");
  await exitOf(p);
  assert.ok(Date.now() - t0 < 5000, "forced within the grace period plus margin");
  await waitFor(() => !pidAlive(pid), 5000, "engine gone");

  p = supervisor.spawnSupervised(engine, ["--port", String(port), "--fake-ignore-sigterm"], { stdio: "pipe", env: engineEnv() });
  await waitFor(() => engineUp(port), 15000, "engine up again");
  pid = await enginePid(port);
  p.kill("SIGKILL");
  await exitOf(p);
  await waitFor(() => !pidAlive(pid), 5000, "engine gone after SIGKILL");
  assert.equal(await engineUp(port), false);
});

test("supervisor: an engine's own exit code and crash signal reach the server unchanged", async () => {
  let p = supervisor.spawnSupervised(engine, ["--port", String(await freePort()), "--fake-exit-after-ms", "300", "--fake-exit-code", "7"], { stdio: "pipe", env: engineEnv() });
  assert.deepEqual(await exitOf(p), { code: 7, signal: null });
  p = supervisor.spawnSupervised(engine, ["--port", String(await freePort()), "--fake-abort-after-ms", "300"], { stdio: "pipe", env: engineEnv() });
  const exit = await exitOf(p);
  if (IS_WIN) assert.notEqual(exit.code, 0);
  else assert.equal(exit.signal, "SIGABRT", "e.g. Metal's abort stays recognisable");
});

test("supervisor: a missing engine fails the same way as before (spawn error event)", async () => {
  const p = supervisor.spawnSupervised(path.join(root, "no-such-engine"), [], { stdio: "pipe" });
  const err = await new Promise((resolve) => p.once("error", resolve));
  assert.equal(err.code, "ENOENT");
  assert.equal(p.supervised, undefined, "not wrapped");
});

test("supervisor: stdin is passed through to the engine (the voice worker reads its job from stdin)", async () => {
  const p = supervisor.spawnSupervised(process.execPath, ["-e", "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(d.toUpperCase()))"], { stdio: "pipe" });
  assert.equal(p.supervised, true);
  let out = "";
  p.stdout.on("data", (c) => { out += c; });
  p.stdin.end('{"text":"hello"}');
  assert.deepEqual(await exitOf(p), { code: 0, signal: null });
  assert.equal(out, '{"TEXT":"HELLO"}');
});

test("supervisor: repeated start/stop cycles leave no process behind and always free the port", async () => {
  const port = await freePort();
  const before = supervisor.snapshot().supervised.length;
  for (let i = 0; i < 5; i++) {
    const p = supervisor.spawnSupervised(engine, ["--port", String(port)], { stdio: "pipe", env: engineEnv() });
    await waitFor(() => engineUp(port), 15000, `cycle ${i}: up`);
    const pid = await enginePid(port);
    p.kill("SIGTERM");
    await exitOf(p);
    assert.equal(pidAlive(pid), false, `cycle ${i}: engine gone`);
    assert.equal(await engineUp(port), false, `cycle ${i}: port free`);
  }
  assert.equal(supervisor.snapshot().supervised.length, before);
});

// ── Restart policy (pure) ────────────────────────────────────────────────────
test("restart policy: bounded, backed off, and never after running out of memory or without free memory", () => {
  const now = 1_000_000_000;
  const GB = 1073741824;
  assert.deepEqual(decideRestart({ now }), { restart: true, delayMs: 1000 });
  assert.deepEqual(decideRestart({ now, attempts: [now - 1000] }), { restart: true, delayMs: 2000 });
  assert.deepEqual(decideRestart({ now, attempts: [now - 2000, now - 1000] }), { restart: true, delayMs: 4000 });
  assert.equal(decideRestart({ now, attempts: [now - 3000, now - 2000, now - 1000] }).reason, "limit");
  assert.equal(decideRestart({ now, attempts: [now - 11 * 60000, now - 11 * 60000, now - 11 * 60000] }).restart, true, "old restarts age out of the window");
  assert.equal(decideRestart({ now, autoRestart: false }).reason, "disabled");
  for (const line of [
    "ggml_backend_cpu_buffer_type_alloc_buffer: failed to allocate buffer of size 4294967296",
    "CUDA error: out of memory", "cudaMalloc failed: out of memory", "terminate called after throwing an instance of 'std::bad_alloc'",
    "vk::Device::allocateMemory: ErrorOutOfDeviceMemory", "llama_model_load: error loading model: unable to allocate CPU buffer",
  ]) {
    assert.equal(isOutOfMemory({ stderrTail: line }), true, line);
    assert.equal(decideRestart({ now, stderrTail: `load ok\n${line}` }).reason, "out-of-memory", line);
  }
  assert.equal(decideRestart({ now, code: 3221225495 }).reason, "out-of-memory", "Windows STATUS_NO_MEMORY");
  assert.equal(decideRestart({ now, code: -1073741801 }).reason, "out-of-memory");
  assert.equal(isOutOfMemory({ code: 1, stderrTail: "srv  update_slots: all slots are idle" }), false);
  assert.equal(decideRestart({ now, modelBytes: 8 * GB, freeBytes: 2 * GB }).reason, "low-memory", "e.g. after a Linux OOM-killer SIGKILL");
  assert.match(decideRestart({ now, modelBytes: 8 * GB, freeBytes: 2 * GB }).message, /2\.0 GB.*\(8\.0 GB\)/);
  assert.equal(decideRestart({ now, modelBytes: 2 * GB, freeBytes: 8 * GB }).restart, true);
});

// ── Through the real server ──────────────────────────────────────────────────
const GGUF = Buffer.from("GGUF\x03\x00\x00\x00");
function model(name) { fs.writeFileSync(path.join(root, "app", "llm-models", name), GGUF); return name; }
const llmStatus = async (srv) => (await request(srv.port, "GET", "/api/llm/status")).json;
const startLlm = (srv, name) => request(srv.port, "POST", "/api/llm/start", { body: { model: name, contextSize: 512, gpuLayers: 0 } });
const supervisedLlm = async (srv) => (await request(srv.port, "GET", "/api/diagnostics")).json.engines.processes.supervised.filter((r) => r.label === "llm");

test("server: killing the server outright stops its text engine (no orphan, port released)", async () => {
  const srv = await startServer(root);
  try {
    assert.equal((await startLlm(srv, model("plain.gguf"))).status, 200, srv.log().slice(-1500));
    const { port } = await llmStatus(srv);
    const pid = await enginePid(port);
    assert.ok(pid && pidAlive(pid));
    hardKill(srv.proc.pid); // the server only, not its process group or tree
    await exitOf(srv.proc);
    await waitFor(async () => !(await engineUp(port)), 10000, "engine stops with the server");
    await waitFor(() => !pidAlive(pid), 10000, "engine process gone");
  } finally { stopServer(srv); }
});

if (!IS_WIN) {
  test("server: a normal shutdown (SIGTERM) stops the engine", async () => {
    const srv = await startServer(root);
    try {
      assert.equal((await startLlm(srv, model("plain.gguf"))).status, 200);
      const { port } = await llmStatus(srv);
      process.kill(srv.proc.pid, "SIGTERM");
      await exitOf(srv.proc);
      assert.equal(await engineUp(port), false);
    } finally { stopServer(srv); }
  });
}

test("server: an engine crash after loading is detected and restarted with backoff, up to 3 times", async () => {
  const srv = await startServer(root);
  try {
    assert.equal((await startLlm(srv, model("plain.gguf"))).status, 200);
    let st = await llmStatus(srv);
    assert.equal(st.engine.state, "ready");
    assert.equal(st.engine.supervised, true);
    for (let n = 1; n <= 3; n++) {
      const pid = await enginePid(st.port);
      hardKill(pid);
      await waitFor(async () => (await llmStatus(srv)).engine.state === "restarting", 10000, `crash ${n} detected`);
      const chat = await request(srv.port, "POST", "/api/llm/chat", { body: { messages: [{ role: "user", content: "hi" }] } });
      assert.equal(chat.status, 409);
      assert.match(chat.json.code, /^ENGINE_(RESTARTING|STARTING)$/);
      st = await waitFor(async () => { const s = await llmStatus(srv); return s.ready && s.engine.state === "ready" ? s : null; }, 30000, `restart ${n}`);
      assert.equal(st.engine.restartsInWindow, n);
      assert.equal(st.engine.lastExit.unexpected, true);
      assert.notEqual(await enginePid(st.port), pid, "a new engine process");
      const ok = await request(srv.port, "POST", "/api/llm/chat", { body: { messages: [{ role: "user", content: "hi" }], stream: false } });
      assert.notEqual(ok.status, 409, `chat works after restart ${n}`);
    }
    // A 4th crash within 10 minutes is not restarted: a clear, structured error instead.
    hardKill(await enginePid(st.port));
    st = await waitFor(async () => { const s = await llmStatus(srv); return s.engine.state === "crashed" ? s : null; }, 10000, "gave up");
    assert.match(st.error, /stopped unexpectedly .*restarted 3 times/s);
    const chat = await request(srv.port, "POST", "/api/llm/chat", { body: { messages: [{ role: "user", content: "hi" }] } });
    assert.equal(chat.status, 409);
    assert.equal(chat.json.code, "ENGINE_CRASHED");
    assert.equal(typeof chat.json.error, "string");
    assert.deepEqual(await supervisedLlm(srv), [], "nothing left running");
    // Loading again by hand works and resets the counter.
    assert.equal((await startLlm(srv, "plain.gguf")).status, 200);
    st = await llmStatus(srv);
    assert.equal(st.engine.state, "ready");
    assert.equal(st.engine.crash, null);
  } finally { stopServer(srv); }
});

test("server: an engine that runs out of memory is not restarted, and says why", async () => {
  const srv = await startServer(root);
  try {
    assert.equal((await startLlm(srv, model("oom-after-ready.gguf"))).status, 200, srv.log().slice(-1500));
    const st = await waitFor(async () => { const s = await llmStatus(srv); return s.engine.state === "crashed" ? s : null; }, 15000, "crash recorded");
    assert.equal(st.engine.crash.reason, "out-of-memory");
    assert.equal(st.engine.restartsInWindow, 0, "no restart attempt");
    assert.match(st.error, /ran out of memory/);
    await sleep(2500); // longer than the first backoff: still nothing restarted
    assert.equal((await llmStatus(srv)).engine.state, "crashed");
    assert.deepEqual(await supervisedLlm(srv), []);
    const chat = await request(srv.port, "POST", "/api/llm/chat", { body: { messages: [{ role: "user", content: "hi" }] } });
    assert.equal(chat.json.code, "ENGINE_CRASHED");
  } finally { stopServer(srv); }
});

test("server: an intentional stop never triggers an automatic restart", async () => {
  const srv = await startServer(root);
  try {
    assert.equal((await startLlm(srv, model("plain.gguf"))).status, 200);
    const { port } = await llmStatus(srv);
    assert.equal((await request(srv.port, "POST", "/api/llm/stop")).status, 200);
    await sleep(3000); // past the first restart backoff
    const st = await llmStatus(srv);
    assert.equal(st.engine.state, "stopped");
    assert.equal(st.running, false);
    assert.equal(st.engine.restartsInWindow, 0);
    assert.equal(await engineUp(port), false);
    assert.deepEqual(await supervisedLlm(srv), []);
    assert.doesNotMatch(srv.log(), /restarting in/);
  } finally { stopServer(srv); }
});

test("server: stopping during a slow startup cancels it at once, without trying other profiles", async () => {
  const srv = await startServer(root);
  try {
    const name = model("slow-start.gguf");
    const logStart = srv.log().length;
    const pending = startLlm(srv, name);
    await waitFor(async () => (await supervisedLlm(srv)).length === 1, 15000, "engine process started");
    const t0 = Date.now();
    const stop = await request(srv.port, "POST", "/api/llm/stop");
    assert.equal(stop.status, 200);
    assert.ok(Date.now() - t0 < 10000, `stop returned in ${Date.now() - t0} ms, not after the whole startup`);
    const start = await pending;
    assert.equal(start.status, 409);
    assert.equal(start.json.code, "ENGINE_START_CANCELLED");
    assert.equal((srv.log().slice(logStart).match(/\[llm\] Starting:/g) || []).length, 1, "no fallback attempts after a stop");
    assert.deepEqual(await supervisedLlm(srv), []);
    assert.equal((await llmStatus(srv)).engine.state, "stopped");
  } finally { stopServer(srv); }
});

test("server: a failed launch is reported, recorded and leaves nothing running", async () => {
  const srv = await startServer(root);
  try {
    const r = await startLlm(srv, model("fail-start.gguf"));
    assert.ok(r.status >= 400, r.text);
    assert.equal(r.json.ok, false);
    assert.equal(typeof r.json.error, "string");
    const st = await llmStatus(srv);
    assert.equal(st.running, false);
    assert.equal(st.engine.state, "stopped");
    assert.equal(st.engine.lastExit.code, 3);
    assert.equal(st.engine.lastExit.unexpected, false, "a failed start is not a crash and is not restarted");
    assert.deepEqual(await supervisedLlm(srv), []);
  } finally { stopServer(srv); }
});

test("server: concurrent start and stop requests never leave two engines or an inconsistent state", async () => {
  const srv = await startServer(root);
  try {
    const name = model("plain.gguf");
    await Promise.allSettled([startLlm(srv, name), startLlm(srv, name), request(srv.port, "POST", "/api/llm/stop"), startLlm(srv, name)]);
    await sleep(500);
    const live = await supervisedLlm(srv);
    assert.ok(live.length <= 1, `${live.length} engines running`);
    const st = await llmStatus(srv);
    assert.equal(st.running, live.length === 1);
    if (st.ready) assert.equal(await engineUp(st.port), true);
    assert.equal((await request(srv.port, "POST", "/api/llm/stop")).status, 200);
    assert.deepEqual(await supervisedLlm(srv), []);
    assert.equal(await engineUp(st.port), false);
  } finally { stopServer(srv); }
});

test("server: a startup that never becomes ready times out and its engine is stopped", async () => {
  const srv = await startServer(root, { USAP_LLM_READY_TIMEOUT_MS: "1500" });
  try {
    const r = await startLlm(srv, model("never-ready.gguf"));
    assert.ok(r.status >= 400);
    assert.match(r.json.error, /did not become ready within 2 seconds/);
    assert.deepEqual(await supervisedLlm(srv), []);
    assert.equal((await llmStatus(srv)).running, false);
  } finally { stopServer(srv); }
});

test("server: diagnostics describe engines additively, without secrets", async () => {
  const srv = await startServer(root, { UAIS_AUTH: "on" }, { readyPath: "/api/auth/status" });
  try {
    const token = fs.readFileSync(path.join(root, "app", "config", "lan-access-token"), "utf8").trim();
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    model("plain.gguf");
    assert.equal((await request(srv.port, "POST", "/api/llm/start", { ...auth, body: { model: "plain.gguf", contextSize: 512, gpuLayers: 0 } })).status, 200);
    const raw = await request(srv.port, "GET", "/api/diagnostics", auth);
    const status = await request(srv.port, "GET", "/api/llm/status", auth);
    for (const r of [raw, status]) {
      assert.ok(!r.text.includes(token), "no access token in diagnostics");
      assert.doesNotMatch(r.text, /usap_[A-Za-z0-9_-]{43}/);
      assert.doesNotMatch(r.text, /authorization|cookie|password|secret/i);
    }
    const d = raw.json;
    assert.equal(d.engines.processes.supervised.length, 1);
    assert.deepEqual(Object.keys(d.engines.processes.supervised[0]).sort(), ["enginePid", "guardPid", "label", "startedAt"], "no command lines, arguments or environment");
    assert.equal(typeof d.engines.llm.state, "string");
    assert.equal(d.engines.llm.restartLimit, 3);
    assert.ok(Array.isArray(d.engines.processes.supervised));
    assert.ok(Array.isArray(d.engines.processes.recentExits));
    for (const k of ["health", "download", "llm", "speech", "hardware"]) assert.ok(k in d, `existing field ${k} kept`);
  } finally { stopServer(srv); }
});
