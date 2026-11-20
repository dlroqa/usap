"use strict";
// Issue #120 part A: the image engine tells a stop the studio asked for from an engine that went away on its own.
// Unit tests of the classifier, then the real server with the fake sd-server (engineSlot off, the default, and on),
// where the engine exits on cue ("exit-when-told": exits with the code written to "<model>.exit").
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const test = require("node:test");
const { makeRoot, startServer, stopServer, request, installFakeSdServer } = require("./api-contract/harness.cjs");
const { classifyImageExit, imageExitOutcome } = require("../server/services/image-exit.cjs");

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
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; } };

// ── classifier ─────────────────────────────────────────────────────────────────────────────────────────────────
test("#120 classifier: a requested stop is never an error, whatever the code or signal", () => {
  for (const [code, signal] of [[0, null], [1, null], [3221225786, null], [null, "SIGTERM"], [null, "SIGKILL"], [null, "SIGABRT"], [null, null]]) {
    for (const wasReady of [true, false]) {
      const c = classifyImageExit({ stopRequested: true, wasReady, code, signal });
      assert.equal(c.kind, "requested", `${code}/${signal}/${wasReady}`);
      assert.equal(c.message, null);
    }
  }
});

test("#120 classifier: an exit nobody asked for is unexpected after READY and a start-up failure before it", () => {
  const cases = [
    // code, signal, reason, message pattern (null: the caller keeps its existing text)
    [0, null, "clean-exit", /exit code 0/],
    [3, null, "exit-code", null],
    [1, null, "exit-code", null],
    [null, "SIGABRT", "signal", null],
    [null, "SIGKILL", "terminated", /signal SIGKILL/],
    [null, "SIGTERM", "terminated", /signal SIGTERM/],
    [null, null, "terminated", /no exit code/],
  ];
  for (const [code, signal, reason, pattern] of cases) {
    const after = classifyImageExit({ stopRequested: false, wasReady: true, code, signal });
    const before = classifyImageExit({ stopRequested: false, wasReady: false, code, signal });
    assert.equal(after.kind, "unexpected-after-ready", `${code}/${signal}`);
    assert.equal(before.kind, "startup-failure", `${code}/${signal}`);
    assert.equal(after.reason, reason); assert.equal(before.reason, reason);
    if (pattern) {
      assert.match(after.message, pattern); assert.match(before.message, pattern);
      assert.match(after.message, /after it was ready/); assert.match(before.message, /during start-up/);
    } else { assert.equal(after.message, null); assert.equal(before.message, null); }
  }
  // Only a strict boolean counts as "asked to stop" or "was ready"; anything else is the safe reading.
  assert.equal(classifyImageExit({ stopRequested: "yes", code: 0 }).kind, "startup-failure");
  assert.equal(classifyImageExit({ stopRequested: false, wasReady: 1, code: 0 }).kind, "startup-failure");
});

test("#120 classifier: messages are bounded and carry no input text beyond a valid signal name", () => {
  const c = classifyImageExit({ wasReady: true, code: null, signal: "SIG<script>alert(1)</script>".repeat(50) });
  assert.equal(c.reason, "signal"); // not SIGTERM/SIGKILL: the caller's existing signal message applies
  const t = classifyImageExit({ wasReady: true, code: null, signal: "SIGKILL" });
  assert.ok(t.message.length < 300);
  for (const s of ["", "SIG", "sigkill", "SIGKILL\n", 42]) {
    const u = classifyImageExit({ wasReady: false, code: null, signal: s || null });
    assert.ok(!/[<>\n]/.test(u.message || ""), JSON.stringify(s));
  }
});

test("#120 a stale exit (the process is no longer the current engine) is never classified and never touches the current one", () => {
  const oldProc = { usapStopRequested: false }; const current = { usapStopRequested: false };
  for (const [code, signal] of [[0, null], [3, null], [null, "SIGKILL"], [null, "SIGABRT"]]) {
    for (const wasReady of [true, false]) {
      const o = imageExitOutcome({ current, proc: oldProc, wasReady, code, signal });
      assert.equal(o.stale, true, `${code}/${signal}`); assert.equal(o.kind, "stale"); assert.equal(o.message, null);
      const n = imageExitOutcome({ current: null, proc: oldProc, wasReady, code, signal });
      assert.equal(n.stale, true, "an exit after the engine was already cleared is stale too");
    }
  }
  assert.equal(imageExitOutcome({ current, proc: null, code: 0 }).stale, true);
  // The current engine's own exit is classified.
  assert.equal(imageExitOutcome({ current, proc: current, wasReady: true, code: 0 }).kind, "unexpected-after-ready");
});

test("#120 the stop marker belongs to one process: an old engine's requested stop is never read as the replacement's", () => {
  const oldProc = { usapStopRequested: true }; const replacement = {};
  assert.equal(imageExitOutcome({ current: oldProc, proc: oldProc, wasReady: true, code: 1 }).kind, "requested");
  assert.equal(imageExitOutcome({ current: replacement, proc: oldProc, wasReady: true, code: 1 }).stale, true);
  const r = imageExitOutcome({ current: replacement, proc: replacement, wasReady: true, code: 0 });
  assert.equal(r.kind, "unexpected-after-ready", "the replacement's own unrequested exit is still reported");
  assert.match(r.message, /exit code 0/);
});

// ── real server, fake engine ───────────────────────────────────────────────────────────────────────────────────
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
  return file;
}
const MODEL_NAMES = ["sd1-plain-q4_0.gguf", "sd1-hold-load-ignore-sigterm-q4_0.gguf", "sd1-exit-when-told-q4_0.gguf", "sd1-hold-load-exit-when-told-q4_0.gguf", "sd1-fail-load-q4_0.gguf", "sd1-ignore-sigterm-q4_0.gguf"];

function suite(label, env) {
  let srv; let root; const pids = new Set();
  const models = () => path.join(root, "app", "models");
  const load = (model) => request(srv.port, "POST", "/api/restart-backend", { body: { model, backend_type: "cpu", use_gpu: false, width: 64, height: 64, steps: 4 } });
  const status = async () => (await request(srv.port, "GET", "/api/backend-status")).json;
  const stop = () => request(srv.port, "POST", "/api/stop-backend", { body: {} });
  const enginePid = async () => {
    const st = await status();
    const pid = await new Promise((resolve) => {
      http.get({ host: "127.0.0.1", port: st.port, path: "/fake/stats" }, (res) => { let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => { try { resolve(JSON.parse(b).pid); } catch (_) { resolve(null); } }); }).on("error", () => resolve(null));
    });
    if (pid) pids.add(pid);
    return pid;
  };
  const tell = (model, code) => fs.writeFileSync(path.join(models(), `${model}.exit`), String(code));
  const untell = () => { for (const n of MODEL_NAMES) for (const s of [".exit", ".release"]) { try { fs.rmSync(path.join(models(), n + s), { force: true }); } catch (_) { /* gone */ } } };
  const gone = async () => { await stop(); await waitFor(async () => !(await status()).running, 15000, "engine stopped"); untell(); };

  test.describe(`#120 image engine exits (${label})`, () => {
    test.before(async () => {
      root = makeRoot();
      installFakeSdServer(root);
      for (const name of MODEL_NAMES) writeModel(models(), name);
      srv = await startServer(root, env);
    });
    test.after(async () => {
      try { await stop(); } catch (_) { /* server may be gone */ }
      stopServer(srv);
      for (const pid of pids) if (pidAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch (_) { /* gone */ } }
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* Windows may hold files briefly */ }
    });

    test("1 a requested stop of a ready engine leaves no error (Windows: the guard's taskkill ends it with code 1)", async (t) => {
      t.after(gone);
      await load("sd1-plain-q4_0.gguf");
      await waitFor(async () => (await status()).ready, 30000, "ready");
      const pid = await enginePid();
      await stop();
      const s = await waitFor(async () => { const st = await status(); return st.running ? null : st; }, 15000, "stopped");
      assert.equal(s.ready, false);
      assert.equal(s.error, null, `a requested stop is not an engine error: ${s.error}`);
      await waitFor(() => !pidAlive(pid), 10000, "engine process gone");
    });

    test("2 an exit with code 0 after READY that nobody asked for is reported, and the engine is shown as not loaded", async (t) => {
      t.after(gone);
      await load("sd1-exit-when-told-q4_0.gguf");
      await waitFor(async () => (await status()).ready, 30000, "ready");
      const pid = await enginePid();
      tell("sd1-exit-when-told-q4_0.gguf", 0);
      const s = await waitFor(async () => { const st = await status(); return st.running ? null : st; }, 15000, "exit seen");
      assert.equal(s.ready, false);
      assert.match(String(s.error), /stopped unexpectedly after it was ready \(exit code 0\)/);
      await waitFor(() => !pidAlive(pid), 10000, "engine process gone");
    });

    test("3 a non-zero exit after READY keeps today's description", async (t) => {
      t.after(gone);
      await load("sd1-exit-when-told-q4_0.gguf");
      await waitFor(async () => (await status()).ready, 30000, "ready");
      await enginePid();
      tell("sd1-exit-when-told-q4_0.gguf", 3);
      const s = await waitFor(async () => { const st = await status(); return st.running ? null : st; }, 15000, "exit seen");
      assert.equal(s.ready, false);
      assert.equal(s.error, "exited with code 3");
    });

    test("4 an exit with code 0 during start-up (before READY) is a start-up failure, not a silent unload", async (t) => {
      t.after(gone);
      await load("sd1-hold-load-exit-when-told-q4_0.gguf");
      await waitFor(async () => (await status()).running, 15000, "spawned");
      await sleep(300);
      assert.equal((await status()).ready, false, "still loading");
      tell("sd1-hold-load-exit-when-told-q4_0.gguf", 0);
      const s = await waitFor(async () => { const st = await status(); return st.running ? null : st; }, 15000, "exit seen");
      assert.equal(s.ready, false);
      assert.match(String(s.error), /exited during start-up \(exit code 0\) before it was ready/);
    });

    test("5 a load that fails with a non-zero code keeps the engine's own error (unchanged)", async (t) => {
      t.after(gone);
      await load("sd1-fail-load-q4_0.gguf");
      const s = await waitFor(async () => { const st = await status(); return st.error && !st.running ? st : null; }, 20000, "load error");
      assert.equal(s.ready, false);
      assert.doesNotMatch(String(s.error), /exit code 0|did not ask/);
      assert.match(String(s.error), /load|failed|exited/i);
    });

    test("6 an engine that ignores SIGTERM is stopped by force; that requested stop leaves no error, and the next model loads cleanly", async (t) => {
      t.after(gone);
      await load("sd1-ignore-sigterm-q4_0.gguf");
      await waitFor(async () => (await status()).ready, 30000, "first ready");
      const first = await enginePid();
      await stop();
      const s0 = await waitFor(async () => { const st = await status(); return st.running ? null : st; }, 15000, "first stopped");
      assert.equal(s0.error, null, `a forced, requested stop is not an engine error: ${s0.error}`);
      await waitFor(() => !pidAlive(first), 10000, "first engine gone");
      await load("sd1-plain-q4_0.gguf");
      await waitFor(async () => { const st = await status(); return st.ready && /plain/.test(String(st.settings && st.settings.model)) ? st : null; }, 30000, "next model ready");
      const second = await enginePid();
      assert.notEqual(second, first);
      const s = await status();
      assert.equal(s.error, null, `no error carried over: ${s.error}`);
    });

    test("7 a stop racing the engine's own exit ends with no engine and either no error or the honest unexpected-exit error", async (t) => {
      t.after(gone);
      for (let i = 0; i < 3; i += 1) {
        await load("sd1-exit-when-told-q4_0.gguf");
        await waitFor(async () => (await status()).ready, 30000, "ready");
        const pid = await enginePid();
        tell("sd1-exit-when-told-q4_0.gguf", 0);
        await sleep(i * 20);
        await stop();
        const s = await waitFor(async () => { const st = await status(); return st.running ? null : st; }, 15000, "stopped");
        assert.ok(s.error === null || /stopped unexpectedly after it was ready \(exit code 0\)/.test(s.error), `round ${i}: ${s.error}`);
        assert.doesNotMatch(String(s.error), /exited with code 1/, "never the false 'code 1' of a requested stop");
        await waitFor(() => !pidAlive(pid), 10000, "engine process gone");
        untell();
      }
    });
  });
}

suite("engineSlot off, the default", {});
suite("engineSlot on (test servers only)", { USAP_ENGINE_SLOT: "on" });
