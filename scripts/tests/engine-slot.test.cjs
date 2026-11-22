// Issue #105: cross-engine model-load coordination (services/engine-slot.cjs, docs/roadmap/STEP9_9F_ENGINE_LIFECYCLE.md).
// Unit tests for the setting, the slot and process termination, then the R1–R5 reproductions and the lifecycle
// cases through the real server with the fake engines (api-contract/fake-llama-server.cjs, fake-sd-server.cjs).
// Every scenario samples the live engine processes (supervisor records + PID liveness) and checks that at most one
// heavy engine process is ever alive. With engineSlot off (the default) the old behaviour, race included, is kept.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { makeRoot, startServer, stopServer, request, installFakeSdServer, fakeSdDiag, IS_WIN, processesUnder } = require("./api-contract/harness.cjs");
// #142: the fake sd-server's last start / listen / exit records, appended to failure messages.
const sdDiag = () => JSON.stringify(fakeSdDiag(root).slice(-12));
// Engine processes running from a test root, wherever their parent is (#136: a re-parented engine is invisible to the
// server's own process list).
const enginesUnder = (root) => processesUnder(root).filter((p) => /sd-server|llama-server/i.test(p.cmd));
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

// ── #136: an engine must never outlive its guard ──────────────────────────────────────────────────────────────
const POSIX = process.platform !== "win32";
const groupMembers = (pgid) => { const r = spawnSync("pgrep", ["-g", String(pgid)], { encoding: "utf8" }); return (r.stdout || "").trim().split("\n").filter(Boolean).map(Number); };
function fakeEngineDir() {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "usap-guard136-"));
  const engine = path.join(dir, "fake-engine.sh");
  fs.writeFileSync(engine, "#!/bin/sh\nexec sleep 30\n"); fs.chmodSync(engine, 0o755);
  return { dir, engine };
}
// Start a guard, send SIGTERM the moment it reports its engine started, and return the processes left in its group.
async function stopRightAfterStart(guardFile, engine) {
  const { spawn } = require("node:child_process");
  const g = spawn(process.execPath, [guardFile, engine], { stdio: ["pipe", "ignore", "ignore", "ipc"], detached: true });
  await new Promise((r) => { const t = setTimeout(r, 5000); g.on("message", (m) => { if (m && m.type === "started") { clearTimeout(t); r(); } }); });
  try { process.kill(g.pid, "SIGTERM"); } catch (_) { /* gone */ }
  await new Promise((r) => { const t = setTimeout(r, 5000); g.once("exit", () => { clearTimeout(t); r(); }); });
  await sleep(50);
  return groupMembers(g.pid);
}

test("guard (#136): a stop that arrives as soon as the guard reports its engine started never leaves the engine running", { skip: !POSIX && "Windows: the guard stops engines with taskkill /T; no signals" }, async () => {
  const { GUARD } = require("../server/supervisor.cjs");
  const { dir, engine } = fakeEngineDir();
  const leftovers = [];
  try {
    for (let i = 0; i < 20; i++) leftovers.push(...await stopRightAfterStart(GUARD, engine));
    assert.deepEqual(leftovers, [], "no engine outlived its guard");
    // Negative control: the same guard with its stop handlers installed only after the engine starts (the order
    // before #136) leaves engines running.
    const src = fs.readFileSync(GUARD, "utf8");
    const block = src.match(/for \(const s of \["SIGTERM", "SIGINT", "SIGHUP"\]\) process\.on\(s, \(\) => stop\(false\)\);\nprocess\.on\("message"[^\n]*\nprocess\.on\("disconnect"[^\n]*\n/);
    assert.ok(block, "the handler block is found in engine-guard.cjs");
    // Exactly where they were before #136: after the stdin pipe and the engine's exit handler.
    const late = src.replace(block[0], "").replace("// Second safety net: the parent process no longer exists.", `${block[0]}\n// Second safety net: the parent process no longer exists.`);
    assert.notEqual(late, src.replace(block[0], ""), "the old position is found");
    const lateFile = path.join(dir, "engine-guard-late-handlers.cjs");
    fs.writeFileSync(lateFile, late);
    const lateLeft = [];
    for (let i = 0; i < 20; i++) lateLeft.push(...await stopRightAfterStart(lateFile, engine));
    leftovers.push(...lateLeft);
    assert.ok(lateLeft.length > 0, "negative control: handlers installed after the start leave engines running");
  } finally {
    for (const p of leftovers) { try { process.kill(p, "SIGKILL"); } catch (_) { /* gone */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("slot (#136, #160): an engine still running after its guard died is stopped through the guard's process group; the slot is never idle while that engine is alive and is released only after its exit is seen", { skip: !POSIX && "Windows: the guard stops engines with taskkill /T; no process groups" }, async () => {
  const { spawnSupervised } = require("../server/supervisor.cjs");
  const { defaultReapOrphan } = require("../server/services/engine-slot.cjs");
  const { dir, engine } = fakeEngineDir();
  const started = [];
  const orphan = async () => {
    const g = spawnSupervised(engine, [], { stdio: ["pipe", "ignore", "ignore"] }, { label: "fake" });
    await new Promise((r) => { const t = setTimeout(r, 5000); g.on("message", (m) => { if (m && m.type === "started") { clearTimeout(t); r(); } }); });
    started.push(g.pid);
    process.kill(g.pid, "SIGKILL"); // the guard alone dies; its engine keeps running in the guard's process group
    return g;
  };
  // Engine liveness exactly as the product checks it (engine-slot.cjs defaultIsAlive: signal 0), with every answer the
  // slot acts on recorded. The slot can release only in the callback that just got a liveness answer (confirmGone), and
  // it does so synchronously; a microtask queued here runs right after that callback, so each recorded decision carries
  // the phase it produced. Every point at which the slot could release is checked: no sampling between them (#160).
  const realAlive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; } };
  try {
    for (const reaping of [true, false]) {
      const decisions = []; let slot = null, g = null;
      const isAlive = (pid) => {
        const alive = realAlive(pid);
        const d = { t: Date.now(), pid, alive, phaseAfter: null, groupAfter: null };
        decisions.push(d);
        queueMicrotask(() => { d.phaseAfter = slot.current().phase; if (d.phaseAfter === "idle") d.groupAfter = groupMembers(g.pid); });
        return alive;
      };
      // reaping: the product's own reaper; negative control: nothing stops the orphan
      // The product's own reaper, run unchanged; the wrapper only records that it ran, with which PIDs, and its result.
      // The slot counts a stopped orphan when the reaper's promise settles, which can be after the release: the reaper
      // polls the engine every 50 ms after its SIGTERM, while the slot's own liveness check may see the exit first (#160).
      const reaps = [];
      const reaper = async (a) => { const call = { guardPid: a.guardPid, enginePid: a.enginePid, result: undefined }; reaps.push(call); call.result = await defaultReapOrphan(a); return call.result; };
      slot = createEngineSlot({ log: quietLog, pidGoneTimeoutMs: 200, recheckMs: 50, isAlive, reapOrphan: reaping ? reaper : async () => false });
      const e = slot.begin("image", "i.gguf");
      g = await orphan();
      const enginePid = g.enginePid;
      assert.ok(enginePid > 0 && enginePid !== g.pid, "the guard reported its engine (a process other than itself)");
      assert.ok(groupMembers(g.pid).includes(enginePid), "that engine runs in the guard's process group");
      slot.track("image", g, e);
      slot.end("image", { live: false });
      await new Promise((r) => g.once("exit", r));
      const ev = () => JSON.stringify(decisions.slice(-8).map((d) => ({ ms: d.t - decisions[0].t, pid: d.pid === enginePid ? "engine" : d.pid, alive: d.alive, phase: d.phaseAfter, group: d.groupAfter })));
      if (reaping) {
        const end = Date.now() + 8000;
        while (slot.current().phase !== "idle" && Date.now() < end) await sleep(20);
        await sleep(0);
        assert.equal(slot.current().phase, "idle", `released after the engine's exit was seen ${ev()}`);
        assert.ok(decisions.length > 0 && decisions.every((d) => d.pid === enginePid), `the slot judged liveness by the engine's own PID ${ev()}`);
        assert.ok(decisions.some((d) => d.alive), `the slot saw the orphan alive first (the clean-up path ran) ${ev()}`);
        assert.ok(decisions.filter((d) => d.alive).every((d) => d.phaseAfter !== "idle"), `never idle right after the engine was seen alive ${ev()}`);
        const release = decisions.find((d) => d.phaseAfter === "idle");
        assert.ok(release && release.alive === false, `idle first appeared right after an 'exited' answer ${ev()}`);
        assert.ok(decisions.slice(0, decisions.indexOf(release)).every((d) => d.phaseAfter !== "idle"), `reserved for the whole clean-up ${ev()}`);
        assert.deepEqual(release.groupAfter, [], `the engine's process group was empty at the moment of release ${ev()}`);
        // The genuine reaper ran once, for this guard and its engine, and reported success; the slot then counted it.
        // Bounded by the same 8 s deadline; the counter is diagnostic and may settle after the release (#160).
        assert.equal(reaps.length, 1, `the reaper ran exactly once ${ev()}`);
        assert.deepEqual({ guardPid: reaps[0].guardPid, enginePid: reaps[0].enginePid }, { guardPid: g.pid, enginePid }, "the reaper was given the guard and its own engine");
        while ((reaps[0].result === undefined || slot.snapshot().counts.orphansStopped < 1) && Date.now() < end) await sleep(10);
        assert.equal(reaps[0].result, true, `the reaper reported that it stopped the orphan ${ev()}`);
        assert.equal(slot.snapshot().counts.orphansStopped, 1, "the slot counted the stopped orphan once");
        assert.deepEqual(groupMembers(g.pid), [], "the engine is gone");
      } else {
        await sleep(1500);
        assert.notEqual(slot.current().phase, "idle", "negative control: still reserved");
        assert.ok(groupMembers(g.pid).length > 0, "negative control: the engine is still running");
        assert.ok(decisions.every((d) => d.phaseAfter !== "idle"), `negative control: never released ${ev()}`);
      }
    }
  } finally {
    for (const pgid of started) { try { process.kill(-pgid, "SIGKILL"); } catch (_) { /* gone */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("process stop (#136): the server waits longer than the guard's own grace before forcing", async () => {
  const { GUARD_GRACE_MS } = require("../server/services/engine-slot.cjs");
  const p = fakeProc({ ignoreTerm: true });
  const t0 = Date.now();
  const r = await stopProcess(p, { killWaitMs: 200, waitForChildExit: fakeWait });
  assert.deepEqual(r, { exited: true, forced: true });
  assert.ok(Date.now() - t0 >= GUARD_GRACE_MS, `SIGKILL only after the guard's ${GUARD_GRACE_MS} ms grace (${Date.now() - t0} ms)`);
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
const IMAGE_MODELS = ["sd1-img-q4_0.gguf", "sd1-hold-load-q4_0.gguf", "sd1-ignore-sigterm-q4_0.gguf", "sd1-fail-load-q4_0.gguf", "sd1-linger1500-q4_0.gguf", "sd1-linger6500-q4_0.gguf"];
const TEXT_MODELS = ["plain.gguf", "other.gguf", "hold-start.gguf", "crash-once.gguf", "crash-once-hold-start.gguf", "ignore-sigterm.gguf"];

let root;
test.before(() => {
  root = makeRoot();
  installFakeSdServer(root);
  for (const m of IMAGE_MODELS) imageModel(path.join(root, "app", "models"), m);
  for (const m of TEXT_MODELS) fs.writeFileSync(path.join(root, "app", "llm-models", m), GGUF);
});

const SLOT_ON = { USAP_ENGINE_SLOT: "on" };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; } };
// #121: `alive` is true for an exited process its parent hasn't reaped yet (a zombie, state Z), which can't compute.
// `running` is false for a zombie too: Linux reads /proc, macOS `ps`; Windows has no zombies (same as `alive`).
function running(pid) {
  if (!alive(pid)) return false;
  if (process.platform === "linux") {
    try { return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop().split(" ")[0] !== "Z"; } catch (_) { return false; }
  }
  if (process.platform === "darwin") {
    const r = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
    const st = (r.stdout || "").trim();
    return st !== "" && !st.startsWith("Z");
  }
  return true;
}
// The real engine process of `label` (never its guard): waits until the guard has reported the engine PID.
async function enginePidOf(srv, label) {
  return waitFor(async () => {
    const d = (await request(srv.port, "GET", "/api/diagnostics")).json;
    const r = ((d && d.engines && d.engines.processes && d.engines.processes.supervised) || []).find((x) => x.label === label && x.enginePid);
    return r ? r.enginePid : null;
  }, 10000, `${label} engine PID reported`);
}
async function engines(srv) {
  const d = (await request(srv.port, "GET", "/api/diagnostics")).json;
  const sup = (d && d.engines && d.engines.processes && d.engines.processes.supervised) || [];
  return sup.filter((r) => r.label === "llm" || r.label === "image")
    .map((r) => ({ label: r.label, pid: r.enginePid || r.guardPid }))
    .filter((r) => r.pid && alive(r.pid));
}
// Samples every ~40 ms until stopped: the most heavy engine processes seen alive at once.
// #125: every sampler is also stopped by withServer's `finally`, so a failed assertion can't leave its loop running
// (a leaked loop keeps the test process alive and hangs the whole run).
const samplers = new Set();
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
  const stop = async () => { running = false; samplers.delete(stop); await loop; return seen; };
  samplers.add(stop);
  return stop;
}
const textLoad = (srv, model, extra = {}) => request(srv.port, "POST", "/api/llm/start", { body: { model, contextSize: 512, gpuLayers: 0, ...extra } });
const imageLoad = (srv, model = "sd1-img-q4_0.gguf", extra = {}) => request(srv.port, "POST", "/api/restart-backend", { body: { model, backend_type: "cpu", use_gpu: false, width: 64, height: 64, steps: 4, ...extra } });
const imageStop = (srv) => request(srv.port, "POST", "/api/stop-backend", { body: {} });
const textStop = (srv) => request(srv.port, "POST", "/api/llm/stop", { body: {} });
const resources = async (srv) => (await request(srv.port, "GET", "/api/resources")).json;
const slotState = async (srv) => (await resources(srv)).engineSlot;
const backendStatus = async (srv) => (await request(srv.port, "GET", "/api/backend-status")).json;
const llmStatus = async (srv) => (await request(srv.port, "GET", "/api/llm/status")).json;
// Image engine ready, or fail with the server log tail (so a CI failure says why).
async function imageReady(srv, ms = 20000, label = "image ready") {
  try { return await waitFor(async () => (await backendStatus(srv)).ready, ms, label); }
  catch (err) { throw new Error(`${err.message}; backend-status ${JSON.stringify(await backendStatus(srv))}\n${srv.log().slice(-2500)}`); }
}
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
  try { return await fn(srv); }
  finally {
    for (const stop of [...samplers]) await stop();
    stopServer(srv); await sleep(200);
  }
}
// #125: test servers whose automatic text restart waits for a file instead of the product's fixed 1 s
// (scripts/tests/api-contract/restart-gate-preload.cjs, test-only). The restart stays pending until openGate().
const gatePath = () => path.join(root, "restart.gate");
const openGate = () => fs.writeFileSync(gatePath(), "1");
const closeGate = () => { for (const f of [gatePath(), `${gatePath()}.cancelled`, `${gatePath()}.fired`]) { try { fs.unlinkSync(f); } catch (_) {} } };
const gateCancelled = () => fs.existsSync(`${gatePath()}.cancelled`);
const gateFired = () => fs.existsSync(`${gatePath()}.fired`);
const gatedEnv = () => ({ ...SLOT_ON, USAP_TEST_RESTART_GATE: gatePath(),
  NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require "${path.join(root, "scripts", "tests", "api-contract", "restart-gate-preload.cjs").replace(/\\/g, "/")}"`.trim() });
const uncrash = (model) => { try { fs.unlinkSync(path.join(root, "app", "llm-models", `${model}.crashed`)); } catch (_) {} };
const release = (dir, name) => fs.writeFileSync(path.join(root, "app", dir, `${name}.release`), "1");
const unrelease = (dir, name) => { try { fs.unlinkSync(path.join(root, "app", dir, `${name}.release`)); } catch (_) {} };

test("R1 (slot on): text load, image load 100 ms later while text is before its spawn: image 409, never both resident", async () => {
  await withServer(SLOT_ON, async (srv) => {
    const free = await holdTextPort(srv);
    const done = sampler(srv);
    const pText = textLoad(srv, "plain.gguf");
    // Order by state, not by a delay: under load the text request may not have claimed the slot 100 ms later.
    await waitFor(async () => { const s = await slotState(srv); return s.owner === "text" && s.phase === "loading"; }, 10000, "text owns the slot before its spawn");
    assert.equal((await engines(srv)).length, 0, "the text load is still before its spawn (port held)");
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
    await waitFor(async () => (await slotState(srv)).owner === "image", 10000, "image owns the slot");
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
    assert.equal(live.length, 1, `one tracked image engine (#142: fake sd-server records ${sdDiag()}; backend ${JSON.stringify(await backendStatus(srv))})`);
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
    await imageReady(srv, 20000, "image ready");
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
      assert.deepEqual(await engines(srv), [], `offset ${offset}: nothing left running (#142: fake sd-server records ${sdDiag()})`);
      const left = await waitFor(async () => (enginesUnder(srv.root).length === 0 ? [] : null), 5000, `offset ${offset}: no engine process left under the test root`).catch(() => enginesUnder(srv.root));
      assert.deepEqual(left, [], `offset ${offset}: no engine process left under the test root (#136)`);
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
    await imageReady(srv, 20000, "image ready");
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
    await imageReady(srv, 20000, "image ready again");
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
    await imageReady(srv, 20000, "image ready");
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
    await imageReady(srv, 20000, "image ready");
    const p = { pid: await enginePidOf(srv, "image") };
    const t0 = Date.now();
    const st = await imageStop(srv);
    const ms = Date.now() - t0;
    assert.equal(st.status, 200, st.text);
    // POSIX: SIGTERM is ignored, so the stop escalates to SIGKILL after 2.5 s. Windows: the supervisor's stop is
    // already a forced termination (taskkill /F through the guard), so the exit comes at once.
    if (IS_WIN) assert.ok(ms < 9000, `stopped (${ms} ms)`);
    else assert.ok(ms >= 2000 && ms < 9000, `escalated to SIGKILL (${ms} ms)`);
    // The stop answers after the guard's exit; the engine died with it (process-group SIGKILL) but may not be reaped
    // yet. It must not be running; the slot is released only once its PID is gone, and then it must be gone (#121).
    assert.equal(running(p.pid), false, "the image engine is not running when the stop answers");
    await waitIdle(srv);
    assert.equal(alive(p.pid), false, "the image engine PID is gone once the slot is idle");

    assert.equal((await textLoad(srv, "ignore-sigterm.gguf")).status, 200);
    const q = { pid: await enginePidOf(srv, "llm") };
    assert.equal((await textStop(srv)).status, 200);
    assert.equal(running(q.pid), false, "the text engine is not running when the stop answers");
    await waitIdle(srv);
    assert.equal(alive(q.pid), false, "the text engine PID is gone once the slot is idle");
  });
});

test("benchmark (slot on): the slot is held for the whole benchmark; an image load during it gets 409", async () => {
  unrelease("llm-models", "hold-start.gguf");
  await withServer(SLOT_ON, async (srv) => {
    const b = request(srv.port, "POST", "/api/llm/benchmark", { body: { model: "hold-start.gguf", includeCpu: true } });
    await waitFor(async () => (await engines(srv)).length === 1, 10000, "benchmark engine spawned");
    const during = await slotState(srv);
    assert.equal(during.owner, "text", "the benchmark keeps the slot while its engine runs (stops inside it don't release it)");
    assert.equal(during.phase, "loading");
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
    const p1 = { pid: (await llmStatus(srv)).running ? ((await engines(srv))[0] || {}).pid : undefined };
    assert.ok(p1.pid, "the first engine process was seen before it crashed");
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

// The three tests below hold the automatic restart at a file gate (see gatedEnv), so "while the restart is pending"
// and "after the restart has started" are states the test controls, not a 1 s window it has to win (#125). The real
// 1 s wait is covered by the test above, which doesn't use the gate.
test("crash auto-restart (slot on): an image load while the restart is pending cancels it through the text chain, then loads", async () => {
  uncrash("crash-once.gguf"); closeGate();
  await withServer(gatedEnv(), async (srv) => {
    assert.equal((await textLoad(srv, "crash-once.gguf")).status, 200);
    await waitFor(async () => (await slotState(srv)).phase === "restart-pending", 15000, "restart pending");
    await sleep(1500); // well past the product's 1 s: the restart is held at the gate
    const held = await slotState(srv);
    assert.deepEqual([held.owner, held.phase], ["text", "restart-pending"], "still pending, still owned by text");
    assert.deepEqual(await engines(srv), [], "no engine process while the restart is pending");
    const done = sampler(srv);
    const img = await imageLoad(srv);
    assert.equal(img.status, 200, img.text);
    // The image load cancels the held restart through the text chain; the gate records it (no timing involved).
    await waitFor(async () => gateCancelled(), 15000, "the pending restart was cancelled");
    assert.equal(gateFired(), false, "the restart never ran before it was cancelled");
    openGate(); // a restart that was not cancelled would be released now
    await waitFor(async () => (await engines(srv)).some((e) => e.label === "image"), 30000, "the image engine is running");
    assert.equal(gateFired(), false, "the cancelled restart never ran, even with its gate open");
    const seen = await done();
    assert.equal(seen.maxText, 0, "no text engine process was started after the image load");
    assert.ok(seen.max <= 1, `at most one heavy engine (saw ${seen.max})`);
    assert.deepEqual((await engines(srv)).map((e) => e.label), ["image"]);
    assert.equal((await llmStatus(srv)).running, false, "the restart did not happen");
    // A restart whose wait was not cancelled is refused by the slot, but leaves "restarting it failed" behind.
    assert.doesNotMatch(String((await llmStatus(srv)).error || ""), /restarting it failed/, "the cancelled restart was never attempted");
    assert.equal((await slotState(srv)).owner, "image");
  });
});

test("crash auto-restart (slot on, control): with no image load, the pending restart runs when its wait ends", async () => {
  uncrash("crash-once.gguf"); closeGate();
  await withServer(gatedEnv(), async (srv) => {
    assert.equal((await textLoad(srv, "crash-once.gguf")).status, 200);
    await waitFor(async () => (await slotState(srv)).phase === "restart-pending", 15000, "restart pending");
    await sleep(1500);
    assert.equal((await slotState(srv)).phase, "restart-pending", "held at the gate");
    assert.deepEqual(await engines(srv), []);
    openGate(); // the same moment at which the test above expects nothing to happen
    await waitFor(async () => gateFired(), 15000, "the held restart was released and ran");
    assert.equal(gateCancelled(), false, "nothing cancelled it");
    const s = await waitFor(async () => { const st = await slotState(srv); return st.phase === "loaded" && (await llmStatus(srv)).ready ? st : null; }, 15000, "restarted");
    assert.equal(s.owner, "text");
    assert.deepEqual((await engines(srv)).map((e) => e.label), ["llm"]);
  });
});

test("crash auto-restart (slot on): an image load after the restart has started gets 409 (text loading); the restart completes", async () => {
  const model = "crash-once-hold-start.gguf";
  uncrash(model); closeGate(); release("llm-models", model);
  try {
    await withServer(gatedEnv(), async (srv) => {
      assert.equal((await textLoad(srv, model)).status, 200);
      await waitFor(async () => (await llmStatus(srv)).ready, 15000, "first engine ready");
      unrelease("llm-models", model); // the restarted engine will be held before it listens
      await waitFor(async () => (await slotState(srv)).phase === "restart-pending", 15000, "restart pending");
      openGate();
      await waitFor(async () => { const st = await slotState(srv); return st.owner === "text" && st.phase === "loading" && (await engines(srv)).length === 1; }, 15000, "restart started (loading)");
      const done = sampler(srv);
      const img = await imageLoad(srv);
      assert.equal(img.status, 409, img.text);
      assert.equal(img.json.code, "MODEL_ALREADY_ACTIVE");
      assert.deepEqual([img.json.activeRuntime.type, img.json.activeRuntime.phase], ["text", "loading"], "refused because the restart is loading, not pending");
      assert.deepEqual((await engines(srv)).map((e) => e.label), ["llm"], "the image load started nothing and stopped nothing");
      release("llm-models", model);
      await waitFor(async () => { const st = await slotState(srv); return st.phase === "loaded" && (await llmStatus(srv)).ready; }, 15000, "restart completed");
      const seen = await done();
      assert.equal(seen.maxImage, 0, "no image engine process was ever started");
      assert.ok(seen.max <= 1, `at most one heavy engine (saw ${seen.max})`);
      assert.equal((await slotState(srv)).owner, "text");
    });
  } finally { unrelease("llm-models", model); }
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
    await imageReady(srv, 20000, "image ready");
    const t = await textLoad(srv, "plain.gguf");
    assert.equal(t.status, 409);
    const m2 = (await resources(srv)).memoryAdmission;
    assert.deepEqual(m2.counts, m1.counts, "no admission decision for a load the slot refused");
  });
});

// #170: a replacement image engine's port. The fake's linger<ms> mode (POSIX) hands the stopped engine's listening socket
// to a detached holder that keeps the port busy until <ms> after the engine's exit: a port still in use with no engine
// process left (the Windows hypothesis of #170, made deterministic). Windows stops engines with taskkill /F, so the
// hand-over can't happen there; Windows is covered by R2 above, the unit tests (image-port.test.cjs) and native validation.
const LINGER_SKIP = IS_WIN ? "Windows stops engines with taskkill /F (no SIGTERM), so the fake can't hand its port over" : false;
// The fake's load progress line marks a generation as active until one runs (as in R1b): run one, so a settings
// change (which replaces the engine) is accepted.
async function settleGeneration(srv) {
  const gen = await request(srv.port, "POST", "/sdapi/v1/txt2img", { body: { prompt: "x", steps: 4, width: 64, height: 64, seed: 1, batch_size: 1 } });
  assert.equal(gen.status, 200, gen.text);
  await waitFor(async () => (await request(srv.port, "GET", "/api/generation-progress")).json.active === false, 5000, "generation done");
}
const diagSince = (t0) => fakeSdDiag(root).filter((r) => r.t >= t0);
// Every holder started since t0 has released its port (or hit its 20 s cap), so no later test meets a held port.
async function holdersReleased(t0, ms = 15000) {
  return waitFor(async () => {
    const d = diagSince(t0);
    const held = d.filter((r) => r.e === "holder-holding").map((r) => r.pid);
    return held.every((pid) => d.some((r) => r.pid === pid && (r.e === "holder-released" || r.e === "holder-cap")) && !alive(pid));
  }, ms, "port holders released");
}

test("#170 (slot on): a replacement image engine waits for the previous engine's port to be released, then uses it", { skip: LINGER_SKIP }, async () => {
  const t0 = Date.now();
  try {
    await withServer(SLOT_ON, async (srv) => {
      assert.equal((await imageLoad(srv, "sd1-linger1500-q4_0.gguf")).status, 200);
      await imageReady(srv);
      assert.equal((await backendStatus(srv)).port, srv.sdPort);
      await settleGeneration(srv);
      const r = await imageLoad(srv, "sd1-linger1500-q4_0.gguf", { steps: 5 }); // new settings: the engine is replaced
      assert.equal(r.status, 200, r.text);
      await imageReady(srv);
      const d = diagSince(t0);
      const released = d.find((x) => x.e === "holder-released");
      const starts = d.filter((x) => x.e === "start");
      const msg = `records ${JSON.stringify(d)}`;
      assert.ok(d.some((x) => x.e === "holder-holding"), `the old port was held after the engine's exit; ${msg}`);
      assert.equal((await backendStatus(srv)).port, srv.sdPort, `the preferred port, after its release (not a backup port); ${msg}`);
      assert.ok(released && starts.length === 2 && starts[1].t >= released.t, `the replacement started after the release; ${msg}`);
      assert.equal(d.filter((x) => x.e === "listen-error").length, 0, msg);
      assert.equal((await engines(srv)).length, 1);
      assert.equal((await imageStop(srv)).status, 200);
      await waitNoEngines(srv);
      await waitIdle(srv);
    });
  } finally { await holdersReleased(t0); }
});

test("#170 (slot on): a port still busy after the bounded wait → a verified backup port; an occupied backup port is skipped", { skip: LINGER_SKIP }, async () => {
  const t0 = Date.now();
  const blocker = net.createServer();
  const blocked = await new Promise((r) => { blocker.once("error", () => r(false)); blocker.listen(28088, "127.0.0.1", () => r(true)); });
  try {
    await withServer(SLOT_ON, async (srv) => {
      assert.equal((await imageLoad(srv, "sd1-linger6500-q4_0.gguf")).status, 200);
      await imageReady(srv);
      await settleGeneration(srv);
      const began = Date.now();
      const r = await imageLoad(srv, "sd1-linger6500-q4_0.gguf", { steps: 5 });
      assert.equal(r.status, 200, r.text);
      await imageReady(srv);
      const took = Date.now() - began;
      const port = (await backendStatus(srv)).port;
      const msg = `port ${port}, load ${took} ms, 28088 held by the test ${blocked}; records ${JSON.stringify(diagSince(t0))}`;
      assert.ok(port >= 28088 && port <= 28120 && port !== srv.sdPort, `a backup port; ${msg}`);
      assert.notEqual(port, 28088, `the occupied backup port was skipped; ${msg}`);
      assert.ok(took >= 5000, `the release was awaited (bounded, 5 s) before the backup range; ${msg}`);
      assert.ok(took < 6500, `not until the old port's release; ${msg}`);
      assert.equal((await engines(srv)).length, 1);
      assert.equal((await imageStop(srv)).status, 200);
      await waitNoEngines(srv);
    });
  } finally {
    await new Promise((r) => (blocked ? blocker.close(r) : r()));
    await holdersReleased(t0);
  }
});

test("#170 (slot on): a stop during the release wait cancels the load at once; no engine starts", { skip: LINGER_SKIP }, async () => {
  const t0 = Date.now();
  try {
    await withServer(SLOT_ON, async (srv) => {
      assert.equal((await imageLoad(srv, "sd1-linger6500-q4_0.gguf")).status, 200);
      await imageReady(srv);
      await settleGeneration(srv);
      const load = imageLoad(srv, "sd1-linger6500-q4_0.gguf", { steps: 5 });
      await waitFor(() => diagSince(t0).some((x) => x.e === "holder-engine-gone"), 10000, "old engine gone, port still held");
      await sleep(600); // inside the release wait (5 s)
      const stoppedAt = Date.now();
      assert.equal((await imageStop(srv)).status, 200);
      const r = await load;
      const msg = `records ${JSON.stringify(diagSince(t0))}`;
      assert.equal(r.status, 409, r.text);
      assert.equal(r.json.code, "ENGINE_START_CANCELLED");
      assert.ok(Date.now() - stoppedAt < 2000, `cancelled promptly (${Date.now() - stoppedAt} ms); ${msg}`);
      assert.equal(diagSince(t0).filter((x) => x.e === "start").length, 1, `no replacement engine started; ${msg}`);
      await waitNoEngines(srv);
      await waitIdle(srv);
    });
  } finally { await holdersReleased(t0); }
});

test("#170 (slot on): concurrent loads after a lingering engine: never two image processes, the survivor is tracked on a free port", { skip: LINGER_SKIP }, async () => {
  const t0 = Date.now();
  try {
    await withServer(SLOT_ON, async (srv) => {
      assert.equal((await imageLoad(srv, "sd1-linger1500-q4_0.gguf")).status, 200);
      await imageReady(srv);
      await settleGeneration(srv);
      const done = sampler(srv);
      const first = (await engines(srv))[0];
      const rs = await Promise.all([5, 6, 7].map((steps) => imageLoad(srv, "sd1-linger1500-q4_0.gguf", { steps })));
      await imageReady(srv);
      await sleep(400);
      const seen = await done();
      const msg = `statuses ${rs.map((x) => x.status)}; records ${JSON.stringify(diagSince(t0))}`;
      for (const x of rs) assert.ok([200, 409].includes(x.status), x.text);
      assert.ok(rs.some((x) => x.status === 200), `at least one replacement loaded; ${msg}`);
      const live = await engines(srv);
      assert.ok(live.length === 1 && live[0].pid !== first.pid && !alive(first.pid), `the first engine was replaced; ${msg}`);
      assert.equal(seen.maxImage, 1, `never two image processes alive (saw ${seen.maxImage}); ${msg}`);
      assert.equal(diagSince(t0).filter((x) => x.e === "listen-error").length, 0, `no engine met a busy port; ${msg}`);
      assert.equal((await engines(srv)).length, 1, msg);
      assert.equal((await backendStatus(srv)).running, true);
      assert.equal((await imageStop(srv)).status, 200);
      assert.deepEqual(await engines(srv), [], "no orphan after a normal stop");
      await waitIdle(srv);
    });
  } finally { await holdersReleased(t0); }
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
