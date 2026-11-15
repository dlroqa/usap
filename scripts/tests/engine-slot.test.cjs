// Issue #105: cross-engine model-load coordination (services/engine-slot.cjs, docs/roadmap/STEP9_9F_ENGINE_LIFECYCLE.md).
// Unit tests for the setting, the slot and process termination, then the R1–R5 reproductions and the lifecycle
// cases through the real server with the fake engines (api-contract/fake-llama-server.cjs, fake-sd-server.cjs).
// Every scenario samples the live engine processes (supervisor records + PID liveness) and checks that at most one
// heavy engine process is ever alive. With engineSlot off (the default) the old behaviour, race included, is kept.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { makeRoot, startServer, stopServer, request, installFakeSdServer, IS_WIN } = require("./api-contract/harness.cjs");
const { engineSlotSetting, createEngineSlot, stopProcess } = require("../server/services/engine-slot.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000, label = "condition") {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(50);
  }
}
const WEBUI_TEXT_BLOCK = /already loaded as a text model/i; // app/frontend/src/components/Generator.jsx

// ── Unit: setting ────────────────────────────────────────────────────────────
test("setting: off by default; USAP_ENGINE_SLOT and scheduler.json turn it on; the environment wins; invalid values ignored", () => {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "usap-slot-cfg-"));
  try {
    assert.equal(engineSlotSetting({ env: {}, configDir: dir }).mode, "off");
    assert.equal(engineSlotSetting({ env: { USAP_ENGINE_SLOT: "on" }, configDir: dir }).mode, "on");
    assert.equal(engineSlotSetting({ env: { USAP_ENGINE_SLOT: " ON " }, configDir: dir }).mode, "on");
    fs.writeFileSync(path.join(dir, "scheduler.json"), JSON.stringify({ engineSlot: "on" }));
    assert.equal(engineSlotSetting({ env: {}, configDir: dir }).mode, "on");
    assert.equal(engineSlotSetting({ env: { USAP_ENGINE_SLOT: "off" }, configDir: dir }).mode, "off", "environment wins");
    const bad = engineSlotSetting({ env: { USAP_ENGINE_SLOT: "yes" }, configDir: dir });
    assert.equal(bad.mode, "on", "invalid environment value ignored; the file's value is used");
    assert.equal(bad.ignored[0].name, "USAP_ENGINE_SLOT");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("setting: USAP_SCHEDULER=off forces it off and says why", () => {
  const s = engineSlotSetting({ env: { USAP_ENGINE_SLOT: "on" }, schedulerMode: "off" });
  assert.equal(s.mode, "off");
  assert.equal(s.forcedOffBy, "scheduler-off");
  assert.equal(engineSlotSetting({ env: {}, schedulerMode: "off" }).forcedOffBy, null);
});

// ── Unit: the slot ───────────────────────────────────────────────────────────
function fakeProc({ pid = 1000 + Math.floor(Math.random() * 1000), supervised = false, enginePid = null, ignoreTerm = false, neverExit = false } = {}) {
  const p = new EventEmitter();
  Object.assign(p, { pid, supervised, enginePid, exitCode: null, signalCode: null, signals: [] });
  p.kill = (sig) => {
    p.signals.push(sig);
    if (neverExit || (sig === "SIGTERM" && ignoreTerm)) return true;
    setImmediate(() => { p.signalCode = sig; p.emit("exit", null, sig); });
    return true;
  };
  p.exitNow = (code = 0) => { p.exitCode = code; p.emit("exit", code, null); };
  return p;
}
const quietLog = { warn: () => {}, log: () => {} };
const fakeWait = (proc, ms) => new Promise((resolve) => {
  if (proc.exitCode !== null || proc.signalCode !== null) return resolve(true);
  const t = setTimeout(() => { proc.removeListener("exit", on); resolve(false); }, ms);
  const on = () => { clearTimeout(t); resolve(true); };
  proc.once("exit", on);
});

test("slot: the other kind is refused at once (409, existing wording + phase); the same kind keeps it with a new epoch", () => {
  const slot = createEngineSlot({ log: quietLog });
  const e1 = slot.begin("text", "/m/chat.gguf");
  assert.throws(() => slot.begin("image", "img.gguf"), (err) => {
    assert.equal(err.statusCode, 409);
    assert.equal(err.code, "MODEL_ALREADY_ACTIVE");
    assert.match(err.message, WEBUI_TEXT_BLOCK);
    assert.equal(err.message, '"chat.gguf" is already loaded as a Text model (still loading). Unload it before loading "img.gguf".');
    assert.deepEqual(err.activeRuntime, { type: "text", label: "Text", model: "chat.gguf", phase: "loading" });
    return true;
  });
  const e2 = slot.begin("text", "chat.gguf");
  assert.ok(e2 > e1);
  slot.end("text", { live: true, ready: true });
  assert.equal(slot.current().phase, "loading", "the outer operation is still running");
  slot.end("text", { live: true, ready: true });
  assert.equal(slot.current().phase, "loaded");
  assert.throws(() => slot.begin("image", "x"), (err) => err.message === '"chat.gguf" is already loaded as a Text model. Unload it before loading "x".');
});

test("slot: released only after every tracked process exits; a stale epoch can't mark or stop the current owner", async () => {
  const slot = createEngineSlot({ log: quietLog });
  const e1 = slot.begin("image", "a.gguf");
  const p1 = fakeProc();
  slot.track("image", p1, e1);
  slot.end("image", { live: true, ready: false });
  assert.equal(slot.current().phase, "loading");
  const e2 = slot.begin("image", "a.gguf"); // a reload
  assert.equal(slot.markLoaded("image", e1), false, "stale epoch ignored");
  assert.equal(slot.stopped("image", e1), false, "stale stop ignored");
  assert.equal(slot.current().phase, "loading");
  slot.end("image", { live: false });
  assert.equal(slot.current().phase, "unloading", "p1 hasn't exited: still reserved");
  assert.throws(() => slot.begin("text", "t.gguf"), /still stopping/);
  p1.exitNow(0);
  await sleep(5);
  assert.equal(slot.current().owner, null);
  assert.equal(slot.current().phase, "idle");
  assert.ok(e2 > e1);
  slot.begin("text", "t.gguf");
});

test("slot: a supervised engine counts as gone only when its engine PID is gone, not when its guard exits", async () => {
  let enginePidAlive = true;
  const slot = createEngineSlot({ log: quietLog, isAlive: () => enginePidAlive, pidGoneTimeoutMs: 100 });
  const e = slot.begin("text", "t.gguf");
  const p = fakeProc({ supervised: true, enginePid: 4242 });
  slot.track("text", p, e);
  slot.end("text", { live: false });
  p.exitNow(0);
  await sleep(200);
  assert.equal(slot.current().phase, "unloading", "guard exited, engine PID still alive");
  assert.equal(slot.snapshot().unconfirmedExits.length, 1, "reported after the bound");
  assert.equal(slot.snapshot().unconfirmedExits[0].reason, "engine-pid-alive-after-guard-exit");
  assert.throws(() => slot.begin("image", "i"), (err) => err.code === "ENGINE_EXIT_UNCONFIRMED" && err.statusCode === 503);
  enginePidAlive = false;
  await sleep(100);
  assert.equal(slot.current().phase, "idle");
});

test("process stop: SIGTERM, then SIGKILL when ignored; an engine that never exits is reported, keeps the slot, and a late exit releases it", async () => {
  const ignoring = fakeProc({ ignoreTerm: true });
  const r1 = await stopProcess(ignoring, { termWaitMs: 50, killWaitMs: 200, waitForChildExit: fakeWait });
  assert.deepEqual(r1, { exited: true, forced: true });
  assert.deepEqual(ignoring.signals, ["SIGTERM", "SIGKILL"]);

  const slot = createEngineSlot({ log: quietLog });
  const e = slot.begin("image", "i.gguf");
  const stuck = fakeProc({ neverExit: true });
  slot.track("image", stuck, e);
  slot.end("image", { live: true, ready: true });
  const r2 = await stopProcess(stuck, { termWaitMs: 50, killWaitMs: 50, waitForChildExit: fakeWait });
  assert.deepEqual(r2, { exited: false, forced: true });
  slot.noteStopUnconfirmed("image", stuck);
  slot.stopped("image");
  assert.equal(slot.current().phase, "unloading");
  assert.equal(slot.hasStuck("image"), true);
  assert.deepEqual(slot.snapshot().unconfirmedExits, [{ kind: "image", reason: "no-exit-after-sigkill" }]);
  assert.throws(() => slot.begin("text", "t"), (err) => err.code === "ENGINE_EXIT_UNCONFIRMED");
  assert.throws(() => slot.begin("image", "i"), (err) => err.code === "ENGINE_EXIT_UNCONFIRMED", "the same kind can't stack a second engine either");
  assert.equal(await slot.waitForExits("image", 50), false);
  stuck.exitNow(137);
  await sleep(5);
  assert.equal(slot.current().phase, "idle");
  assert.equal(await slot.waitForExits("image", 50), true);
});

test("slot: text restart pending keeps ownership without a process; a stop request releases it", () => {
  const slot = createEngineSlot({ log: quietLog });
  const e = slot.begin("text", "t.gguf");
  slot.end("text", { live: true, ready: true });
  assert.equal(slot.markRestartPending("text", e), true);
  assert.equal(slot.current().phase, "restart-pending");
  assert.throws(() => slot.begin("image", "i"), /restarting after a crash/);
  slot.stopped("text");
  assert.equal(slot.current().phase, "idle");
});

// ── Through the real server ──────────────────────────────────────────────────
const GGUF = Buffer.from("GGUF\x03\x00\x00\x00");
function imageModel(dir, name) {
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
const IMAGE_MODELS = ["sd1-img-q4_0.gguf", "sd1-hold-load-q4_0.gguf", "sd1-ignore-sigterm-q4_0.gguf", "sd1-fail-load-q4_0.gguf"];
const TEXT_MODELS = ["plain.gguf", "other.gguf", "hold-start.gguf", "crash-once.gguf", "ignore-sigterm.gguf"];

let root;
test.before(() => {
  root = makeRoot();
  installFakeSdServer(root);
  for (const m of IMAGE_MODELS) imageModel(path.join(root, "app", "models"), m);
  for (const m of TEXT_MODELS) fs.writeFileSync(path.join(root, "app", "llm-models", m), GGUF);
});

const SLOT_ON = { USAP_ENGINE_SLOT: "on" };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; } };
async function engines(srv) {
  const d = (await request(srv.port, "GET", "/api/diagnostics")).json;
  const sup = (d && d.engines && d.engines.processes && d.engines.processes.supervised) || [];
  return sup.filter((r) => r.label === "llm" || r.label === "image")
    .map((r) => ({ label: r.label, pid: r.enginePid || r.guardPid }))
    .filter((r) => r.pid && alive(r.pid));
}
// Samples every ~40 ms until stopped: the most heavy engine processes seen alive at once.
function sampler(srv) {
  const seen = { max: 0, maxImage: 0, maxText: 0, samples: 0 };
  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        const e = await engines(srv);
        seen.samples += 1;
        seen.max = Math.max(seen.max, e.length);
        seen.maxImage = Math.max(seen.maxImage, e.filter((x) => x.label === "image").length);
        seen.maxText = Math.max(seen.maxText, e.filter((x) => x.label === "llm").length);
      } catch (_) { /* server busy or gone */ }
      await sleep(40);
    }
  })();
  return async () => { running = false; await loop; return seen; };
}
const textLoad = (srv, model, extra = {}) => request(srv.port, "POST", "/api/llm/start", { body: { model, contextSize: 512, gpuLayers: 0, ...extra } });
const imageLoad = (srv, model = "sd1-img-q4_0.gguf", extra = {}) => request(srv.port, "POST", "/api/restart-backend", { body: { model, backend_type: "cpu", use_gpu: false, width: 64, height: 64, steps: 4, ...extra } });
const imageStop = (srv) => request(srv.port, "POST", "/api/stop-backend", { body: {} });
const textStop = (srv) => request(srv.port, "POST", "/api/llm/stop", { body: {} });
const resources = async (srv) => (await request(srv.port, "GET", "/api/resources")).json;
const slotState = async (srv) => (await resources(srv)).engineSlot;
const backendStatus = async (srv) => (await request(srv.port, "GET", "/api/backend-status")).json;
const llmStatus = async (srv) => (await request(srv.port, "GET", "/api/llm/status")).json;
const waitIdle = (srv, ms = 15000) => waitFor(async () => { const s = await slotState(srv); return s && s.phase === "idle" && s.owner === null ? s : null; }, ms, "slot idle");
const waitNoEngines = (srv, ms = 15000) => waitFor(async () => (await engines(srv)).length === 0, ms, "no engine processes");
// Holds a text load between its heavy-model decision and its spawn for a fixed 1.5 s (issue #105 §4): with the
// preferred text port busy, killLlm() with no process waits 1.5 s for it, then another port is used.
async function holdTextPort(srv) {
  const blocker = net.createServer().listen(srv.llmPort, "127.0.0.1");
  await new Promise((r) => blocker.once("listening", r));
  return () => new Promise((r) => blocker.close(r));
}
async function withServer(env, fn) {
  const srv = await startServer(root, env);
  try { return await fn(srv); } finally { stopServer(srv); await sleep(200); }
}
const release = (dir, name) => fs.writeFileSync(path.join(root, "app", dir, `${name}.release`), "1");
const unrelease = (dir, name) => { try { fs.unlinkSync(path.join(root, "app", dir, `${name}.release`)); } catch (_) {} };

test("R1 (slot on): text load, image load 100 ms later while text is before its spawn: image 409, never both resident", async () => {
  await withServer(SLOT_ON, async (srv) => {
    const free = await holdTextPort(srv);
    const done = sampler(srv);
    const pText = textLoad(srv, "plain.gguf");
    await sleep(100);
    const img = await imageLoad(srv);
    const txt = await pText;
    await sleep(800);
    const seen = await done();
    await free();
    assert.equal(txt.status, 200, txt.text);
    assert.equal(img.status, 409, img.text);
    assert.equal(img.json.code, "MODEL_ALREADY_ACTIVE");
    assert.match(img.json.error, WEBUI_TEXT_BLOCK, "the original WebUI's text-model check still matches");
    assert.equal(img.json.activeRuntime.type, "text");
    assert.equal(img.json.activeRuntime.phase, "loading");
    assert.ok(seen.samples > 10);
    assert.ok(seen.max <= 1, `at most one heavy engine alive (saw ${seen.max})`);
    assert.deepEqual((await engines(srv)).map((e) => e.label), ["llm"]);
    assert.equal((await resources(srv)).heavyModel.type, "text");
  });
});

test("R5 (slot on): image load, text load 100 ms later: text 409 (image loading), never both resident", async () => {
  await withServer(SLOT_ON, async (srv) => {
    const free = await holdTextPort(srv);
    const done = sampler(srv);
    const pImg = imageLoad(srv);
    await sleep(100);
    const txt = await textLoad(srv, "plain.gguf");
    const img = await pImg;
    await sleep(800);
    const seen = await done();
    await free();
    assert.equal(img.status, 200, img.text);
    assert.equal(txt.status, 409, txt.text);
    assert.equal(txt.json.code, "MODEL_ALREADY_ACTIVE");
    assert.equal(txt.json.activeRuntime.type, "image");
    assert.ok(seen.max <= 1, `at most one heavy engine alive (saw ${seen.max})`);
    assert.deepEqual((await engines(srv)).map((e) => e.label), ["image"]);
  });
});

test("R2 (slot on): four image loads at once run one after another: never two image processes, the survivor is tracked, a stop leaves none", async () => {
  await withServer(SLOT_ON, async (srv) => {
    const done = sampler(srv);
    const rs = await Promise.all([4, 5, 6, 7].map((steps) => imageLoad(srv, "sd1-img-q4_0.gguf", { steps })));
    await sleep(800);
    const seen = await done();
    for (const r of rs) assert.ok([200, 409].includes(r.status), r.text);
    assert.ok(rs.filter((r) => r.status === 200).length >= 1);
    assert.equal(seen.maxImage, 1, `never two image processes alive (saw ${seen.maxImage})`);
    const live = await engines(srv);
    assert.equal(live.length, 1);
    assert.equal((await backendStatus(srv)).running, true, "the live process is the tracked one");
    const st = await imageStop(srv);
    assert.equal(st.status, 200, st.text);
    assert.deepEqual(await engines(srv), [], "no orphan after a normal stop");
    await waitIdle(srv);
  });
});

test("R4 (slot on): a stop during an image load cancels it: the load answers 409 ENGINE_START_CANCELLED and no engine starts", async () => {
  await withServer(SLOT_ON, async (srv) => {
    const pImg = imageLoad(srv);
    await sleep(150);
    const st = await imageStop(srv);
    const img = await pImg;
    assert.equal(st.status, 200);
    assert.equal(img.status, 409, img.text);
    assert.equal(img.json.code, "ENGINE_START_CANCELLED");
    await sleep(800);
    assert.deepEqual(await engines(srv), []);
    assert.equal((await backendStatus(srv)).running, false);
    await waitIdle(srv);
  });
});

test("queue (slot on): a stop cancels image loads still waiting in the image chain; a load after the stop works", async () => {
  await withServer(SLOT_ON, async (srv) => {
    const a = imageLoad(srv, "sd1-img-q4_0.gguf", { steps: 4 });
    const b = imageLoad(srv, "sd1-img-q4_0.gguf", { steps: 5 });
    await sleep(100);
    const st = await imageStop(srv);
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(st.status, 200);
    assert.equal(ra.json.code, "ENGINE_START_CANCELLED");
    assert.equal(rb.json.code, "ENGINE_START_CANCELLED", "the waiting load was cancelled too");
    assert.deepEqual(await engines(srv), []);
    const c = await imageLoad(srv);
    assert.equal(c.status, 200, c.text);
    await waitFor(async () => (await backendStatus(srv)).ready, 10000, "image ready");
  });
});

test("cancel after spawn, before ready (slot on): the held engine is stopped, never becomes ready, and the slot is released", async () => {
  unrelease("models", "sd1-hold-load-q4_0.gguf");
  await withServer(SLOT_ON, async (srv) => {
    const r = await imageLoad(srv, "sd1-hold-load-q4_0.gguf");
    assert.equal(r.status, 200, r.text);
    assert.equal((await engines(srv)).length, 1, "spawned, waiting to listen");
    assert.equal((await slotState(srv)).phase, "loading");
    const st = await imageStop(srv);
    assert.equal(st.status, 200);
    assert.deepEqual(await engines(srv), []);
    release("models", "sd1-hold-load-q4_0.gguf");
    await sleep(600);
    assert.equal((await backendStatus(srv)).ready, false, "a cancelled load never completes");
    await waitIdle(srv);
    const t = await textLoad(srv, "plain.gguf");
    assert.equal(t.status, 200, "the other kind can load once the exit is confirmed");
  });
  unrelease("models", "sd1-hold-load-q4_0.gguf");
});

test("stop racing startup (slot on): at any offset the end state is consistent: no engine, no orphan, slot idle", async () => {
  await withServer(SLOT_ON, async (srv) => {
    for (const offset of [0, 30, 120, 300, 520, 700, 1200]) {
      const done = sampler(srv);
      const p = imageLoad(srv);
      await sleep(offset);
      const st = await imageStop(srv);
      const r = await p;
      assert.equal(st.status, 200, `offset ${offset}: ${st.text}`);
      assert.ok([200, 409].includes(r.status), `offset ${offset}: ${r.text}`);
      // A load that answered 200 before the stop is stopped by it; a later one was cancelled.
      await sleep(300);
      const seen = await done();
      assert.ok(seen.maxImage <= 1, `offset ${offset}`);
      assert.deepEqual(await engines(srv), [], `offset ${offset}: nothing left running`);
      await waitIdle(srv, 5000);
    }
  });
});

test("crash during load (slot on): an image engine that fails to load releases the slot after its exit", async () => {
  await withServer(SLOT_ON, async (srv) => {
    await imageLoad(srv, "sd1-fail-load-q4_0.gguf");
    await waitIdle(srv);
    assert.deepEqual(await engines(srv), []);
    const t = await textLoad(srv, "plain.gguf");
    assert.equal(t.status, 200, t.text);
  });
});

test("R1b (slot on): with an image engine loaded, a text load gets 409 and the image engine keeps running; a settings change still works", async () => {
  await withServer(SLOT_ON, async (srv) => {
    assert.equal((await imageLoad(srv)).status, 200);
    await waitFor(async () => (await backendStatus(srv)).ready, 10000, "image ready");
    const before = await engines(srv);
    const t = await textLoad(srv, "plain.gguf");
    assert.equal(t.status, 409, t.text);
    assert.deepEqual(await engines(srv), before, "the image engine was not touched");
    // The fake's load progress line sets generationState.active until a generation runs (separate finding).
    const gen = await request(srv.port, "POST", "/sdapi/v1/txt2img", { body: { prompt: "x", steps: 4, width: 64, height: 64, seed: 1, batch_size: 1 } });
    assert.equal(gen.status, 200);
    await waitFor(async () => (await request(srv.port, "GET", "/api/generation-progress")).json.active === false, 5000, "generation done");
    const done = sampler(srv);
    const r = await imageLoad(srv, "sd1-img-q4_0.gguf", { steps: 6 });
    assert.equal(r.status, 200, r.text);
    await waitFor(async () => (await backendStatus(srv)).ready, 10000, "image ready again");
    const seen = await done();
    assert.ok(seen.maxImage <= 1);
    const after = await engines(srv);
    assert.equal(after.length, 1);
    assert.notEqual(after[0].pid, before[0].pid, "replaced, after the old exit was confirmed");
    assert.equal(alive(before[0].pid), false);
  });
});

test("R3 (slot on): a text load while an image model is loaded answers 409 MODEL_ALREADY_ACTIVE with the original body fields", async () => {
  await withServer(SLOT_ON, async (srv) => {
    assert.equal((await imageLoad(srv)).status, 200);
    await waitFor(async () => (await backendStatus(srv)).ready, 10000, "image ready");
    const r = await textLoad(srv, "plain.gguf");
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.code, "MODEL_ALREADY_ACTIVE");
    assert.equal(r.json.error, '"sd1-img-q4_0.gguf" is already loaded as a Image model. Unload it before loading "plain.gguf".');
    assert.deepEqual(Object.keys(r.json.activeRuntime).sort(), ["label", "model", "phase", "type"]);
    assert.deepEqual(r.json.activeRuntime, { type: "image", label: "Image", model: "sd1-img-q4_0.gguf", phase: "loaded" });
    assert.equal((await llmStatus(srv)).running, false);
  });
});

test("reload (slot on): a text reload with new settings replaces the engine under a new epoch, old process confirmed gone", async () => {
  await withServer(SLOT_ON, async (srv) => {
    assert.equal((await textLoad(srv, "plain.gguf")).status, 200);
    const s1 = await slotState(srv);
    const [p1] = await engines(srv);
    assert.equal(s1.phase, "loaded");
    assert.equal((await textLoad(srv, "plain.gguf", { contextSize: 1024 })).status, 200);
    const s2 = await slotState(srv);
    const live = await engines(srv);
    assert.equal(live.length, 1);
    assert.notEqual(live[0].pid, p1.pid);
    assert.equal(alive(p1.pid), false);
    assert.ok(s2.epoch > s1.epoch);
    assert.equal(s2.phase, "loaded");
    assert.equal(s2.owner, "text");
  });
});

test("forced termination (slot on): engines that ignore SIGTERM are killed, the stop answers after the exit, the slot is released", async () => {
  await withServer(SLOT_ON, async (srv) => {
    assert.equal((await imageLoad(srv, "sd1-ignore-sigterm-q4_0.gguf")).status, 200);
    await waitFor(async () => (await backendStatus(srv)).ready, 10000, "image ready");
    const [p] = await engines(srv);
    const t0 = Date.now();
    const st = await imageStop(srv);
    const ms = Date.now() - t0;
    assert.equal(st.status, 200, st.text);
    assert.ok(ms >= 2000 && ms < 9000, `escalated to SIGKILL (${ms} ms)`);
    assert.equal(alive(p.pid), false);
    await waitIdle(srv);

    assert.equal((await textLoad(srv, "ignore-sigterm.gguf")).status, 200);
    const [q] = await engines(srv);
    assert.equal((await textStop(srv)).status, 200);
    assert.equal(alive(q.pid), false);
    await waitIdle(srv);
  });
});

test("benchmark (slot on): the slot is held for the whole benchmark; an image load during it gets 409", async () => {
  unrelease("llm-models", "hold-start.gguf");
  await withServer(SLOT_ON, async (srv) => {
    const b = request(srv.port, "POST", "/api/llm/benchmark", { body: { model: "hold-start.gguf", includeCpu: true } });
    await waitFor(async () => (await engines(srv)).length === 1, 10000, "benchmark engine spawned");
    const img = await imageLoad(srv);
    assert.equal(img.status, 409, img.text);
    assert.equal(img.json.activeRuntime.type, "text");
    release("llm-models", "hold-start.gguf");
    const r = await b;
    assert.equal(r.status, 200, r.text);
    assert.equal((await engines(srv)).filter((e) => e.label === "image").length, 0);
  });
  unrelease("llm-models", "hold-start.gguf");
});

test("crash auto-restart (slot on): a crashed text engine restarts as before and keeps the slot", async () => {
  try { fs.unlinkSync(path.join(root, "app", "llm-models", "crash-once.gguf.crashed")); } catch (_) {}
  await withServer(SLOT_ON, async (srv) => {
    assert.equal((await textLoad(srv, "crash-once.gguf")).status, 200);
    const [p1] = await engines(srv);
    await waitFor(async () => !alive(p1.pid), 10000, "crash");
    // The engine PID is gone a moment before the studio sees its guard exit, so wait for a new engine process.
    const { s, e } = await waitFor(async () => {
      const st = await slotState(srv); const live = await engines(srv); const ls = await llmStatus(srv);
      return st.phase === "loaded" && live.length === 1 && live[0].pid !== p1.pid && ls.ready ? { s: st, e: live } : null;
    }, 15000, "restarted under a new process");
    assert.equal(s.owner, "text");
    assert.equal(e[0].label, "llm");
    assert.ok(s.counts.reserved >= 2, "the restart claimed the slot again (same kind)");
  });
});

test("crash auto-restart (slot on): an image load while the restart is pending cancels it through the text chain, then loads", async () => {
  try { fs.unlinkSync(path.join(root, "app", "llm-models", "crash-once.gguf.crashed")); } catch (_) {}
  await withServer(SLOT_ON, async (srv) => {
    assert.equal((await textLoad(srv, "crash-once.gguf")).status, 200);
    await waitFor(async () => (await slotState(srv)).phase === "restart-pending", 10000, "restart pending");
    const done = sampler(srv);
    const img = await imageLoad(srv);
    assert.equal(img.status, 200, img.text);
    await sleep(2500); // past the 1 s restart delay
    const seen = await done();
    assert.ok(seen.max <= 1, `at most one heavy engine (saw ${seen.max})`);
    assert.deepEqual((await engines(srv)).map((e) => e.label), ["image"]);
    assert.equal((await llmStatus(srv)).running, false, "the restart did not happen");
    assert.equal((await slotState(srv)).owner, "image");
  });
});

test("out-of-memory retry (slot on): a chat that runs out of memory is retried with a smaller context, unchanged", async () => {
  await withServer(SLOT_ON, async (srv) => {
    assert.equal((await textLoad(srv, "plain.gguf", { contextSize: 4096 })).status, 200);
    const r = await request(srv.port, "POST", "/api/llm/chat", { body: { messages: [{ role: "user", content: "MODE:oom" }], stream: false }, raw: true });
    assert.equal(r.status, 500);
    const s = await waitFor(async () => { const x = await llmStatus(srv); return x.ready && x.settings.contextSize === 2048 ? x : null; }, 15000, "restarted smaller");
    assert.ok(s);
    assert.equal((await slotState(srv)).owner, "text");
    assert.equal((await engines(srv)).length, 1);
  });
});

test("9.9f-1 (slot on, chat timeouts on): a cancelled chat is confirmed as before; image loads stay refused while text owns the slot", async () => {
  await withServer({ ...SLOT_ON, USAP_CHAT_TIMEOUTS: "on" }, async (srv) => {
    assert.equal((await textLoad(srv, "plain.gguf")).status, 200);
    const ac = new AbortController();
    const http = require("node:http");
    await new Promise((resolve) => {
      const data = JSON.stringify({ messages: [{ role: "user", content: "MODE:slow" }], stream: true });
      const req = http.request({ host: "127.0.0.1", port: srv.port, method: "POST", path: "/api/llm/chat", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }, signal: ac.signal }, (res) => { res.once("data", () => { ac.abort(); resolve(); }); res.on("error", () => {}); });
      req.on("error", () => resolve());
      req.end(data);
    });
    const img = await imageLoad(srv);
    assert.equal(img.status, 409);
    const r = await resources(srv);
    assert.equal(r.limits.runningTimeouts, "on");
    assert.equal(r.limits.engineSlot, "on");
    await waitFor(async () => (await resources(srv)).chatTimeouts.engine === "ready", 20000, "engine confirmed idle");
    assert.equal((await textStop(srv)).status, 200);
    await waitIdle(srv);
    assert.equal((await imageLoad(srv)).status, 200);
  });
});

test("9.9f-2 (slot on, memory admission observe): text loads are assessed as before; a refused cross-engine load makes no decision", async () => {
  await withServer({ ...SLOT_ON, USAP_MEMORY_ADMISSION: "observe" }, async (srv) => {
    assert.equal((await textLoad(srv, "plain.gguf")).status, 200);
    const m1 = (await resources(srv)).memoryAdmission;
    assert.ok(m1, "admission report present");
    assert.equal((await imageLoad(srv)).status, 409);
    assert.equal((await textStop(srv)).status, 200);
    await waitIdle(srv);
    assert.equal((await imageLoad(srv)).status, 200);
    await waitFor(async () => (await backendStatus(srv)).ready, 10000, "image ready");
    const t = await textLoad(srv, "plain.gguf");
    assert.equal(t.status, 409);
    const m2 = (await resources(srv)).memoryAdmission;
    assert.deepEqual(m2.counts, m1.counts, "no admission decision for a load the slot refused");
  });
});

test("delete model (slot on): deleting the loaded text model stops its engine through the text chain and releases the slot", async () => {
  fs.writeFileSync(path.join(root, "app", "llm-models", "doomed.gguf"), GGUF);
  await withServer(SLOT_ON, async (srv) => {
    assert.equal((await textLoad(srv, "doomed.gguf")).status, 200);
    const r = await request(srv.port, "POST", "/api/llm/delete-model", { body: { filename: "doomed.gguf" } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(await engines(srv), []);
    await waitIdle(srv);
  });
});

test("server shutdown (slot on): SIGTERM to the server stops its engines", { skip: IS_WIN ? "Windows has no SIGTERM to a process; supervision covers hard kills (engine-supervision tests)" : false }, async () => {
  const srv = await startServer(root, SLOT_ON);
  try {
    assert.equal((await imageLoad(srv)).status, 200);
    const [p] = await engines(srv);
    process.kill(srv.proc.pid, "SIGTERM");
    await waitFor(() => srv.proc.exitCode !== null || srv.proc.signalCode !== null, 15000, "server exit");
    await waitFor(() => !alive(p.pid), 10000, "engine gone");
  } finally { stopServer(srv); }
});

// An empty value means "not set" (the default), even when the test run itself exports USAP_ENGINE_SLOT=on.
const DEFAULT = { USAP_ENGINE_SLOT: "" };
test("default off: no engineSlot report, and the earlier behaviour is kept (R3 still answers 500; R1 can still overlap)", async () => {
  await withServer(DEFAULT, async (srv) => {
    const r = await resources(srv);
    assert.equal("engineSlot" in r, false);
    assert.equal("engineSlot" in r.limits, false);
    // R1, the known race, unchanged with the slot off: both loads succeed and both engines are resident.
    const free = await holdTextPort(srv);
    const pText = textLoad(srv, "plain.gguf");
    await sleep(100);
    const img = await imageLoad(srv);
    const txt = await pText;
    await free();
    assert.equal(img.status, 200);
    assert.equal(txt.status, 200);
    await sleep(500);
    assert.deepEqual((await engines(srv)).map((e) => e.label).sort(), ["image", "llm"], "legacy overlap (no exclusivity guarantee when off)");
  });
  await withServer(DEFAULT, async (srv) => {
    assert.equal((await imageLoad(srv)).status, 200);
    await sleep(800);
    const t = await textLoad(srv, "plain.gguf");
    assert.equal(t.status, 500, "legacy R3 contract when off");
    assert.equal(t.json.code, "ENGINE_START_FAILED");
    assert.match(t.json.error, /already loaded as a Image model/);
  });
});

test("rollback: USAP_SCHEDULER=off turns the slot off even with USAP_ENGINE_SLOT=on", async () => {
  await withServer({ ...SLOT_ON, USAP_SCHEDULER: "off" }, async (srv) => {
    assert.match(srv.log(), /engine slot "on" is off because USAP_SCHEDULER=off/);
    assert.equal((await request(srv.port, "GET", "/api/resources")).status, 404);
    assert.equal((await imageLoad(srv)).status, 200);
    await sleep(800);
    const t = await textLoad(srv, "plain.gguf");
    assert.equal(t.status, 500, "legacy path");
  });
});

test("report (slot on): /api/resources gains engineSlot (fixed words and numbers only) and limits.engineSlot", async () => {
  await withServer(SLOT_ON, async (srv) => {
    const r = await resources(srv);
    assert.equal(r.limits.engineSlot, "on");
    assert.deepEqual(Object.keys(r.engineSlot).sort(), ["counts", "epoch", "imageOperations", "lastRefusal", "mode", "operations", "owner", "phase", "processes", "sinceSeconds", "unconfirmedExits"]);
    assert.equal(r.engineSlot.phase, "idle");
    assert.equal(JSON.stringify(r.engineSlot).includes(".gguf"), false, "no model names");
    assert.match(srv.log(), /\[engine-slot\] Engine slot on/);
  });
});

test.after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
});
