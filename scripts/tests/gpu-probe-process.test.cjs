// #197/#181 round 20: the bounded macOS GPU probe with REAL child processes, on every OS. The service is told it runs on
// an Intel Mac (osPlatform "darwin", an x64 Intel CPU) and its execFile runs a small Node script in place of
// system_profiler (same options: timeout, SIGKILL, 1 MiB output limit); synchronous child-process calls throw, so any
// synchronous probe fails the test. Each case checks the classified reason, that the GPU memory is reported as not
// known (0, never the machine's RAM), and that the child is gone afterwards (no orphan).
"use strict";
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createHardwareService } = require("../server/services/hardware.cjs");

const FAKE = {
  sleep: "setTimeout(() => {}, 30000)",
  overflow: "process.stdout.write('x'.repeat(2 * 1024 * 1024)); setTimeout(() => {}, 30000)",
  exit: "process.stdout.write('Graphics/Displays:\\n'); process.exit(1)",
  empty: "process.stdout.write('')",
};
function service(mode, { timeoutMs = 400 } = {}) {
  const children = [];
  const execFile = (file, args, opts, cb) => {
    assert.equal(file, "system_profiler"); // the probe's own command; replaced by a Node script here
    const c = cp.execFile(process.execPath, ["-e", FAKE[mode]], opts, cb); children.push(c); return c;
  };
  const noSync = (name) => () => { throw new Error(`synchronous ${name} called`); };
  const intel = { ...os, arch: () => "x64", cpus: () => [{ model: "Intel(R) Core(TM) i7 Test CPU", speed: 1, times: { user: 1, nice: 0, sys: 1, idle: 1, irq: 0 } }] };
  const hw = createHardwareService({
    os: intel, fs, path, execSync: noSync("execSync"), spawnSync: noSync("spawnSync"), exec: noSync("exec"), execFile, osPlatform: "darwin",
    LLM_BACKEND_PATHS: {}, getBackendProc: () => null, getOpenVinoPython: () => "", getCoreMLPythonPath: () => "", gpuProbeTimeoutMs: timeoutMs,
  });
  return { hw, children };
}
const exited = (c) => (c.exitCode !== null || c.signalCode !== null) ? Promise.resolve() : new Promise((r) => c.once("exit", r));
const gone = (pid) => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === "ESRCH"; } };

for (const [mode, reason] of [["sleep", "timeout"], ["overflow", "overflow"], ["exit", "exit"], ["empty", "none-listed"]]) {
  test(`real child (${mode}): reason ${reason}, GPU memory not known, the child is gone`, { timeout: 30000 }, async () => {
    // only the timeout case uses a short limit; the others end on their own, so a slow runner cannot turn them into a timeout
    const { hw, children } = service(mode, { timeoutMs: mode === "sleep" ? 400 : 10000 });
    await hw.prime();
    assert.equal(children.length, 1, "one probe");
    const st = hw.gpuProbeState();
    assert.deepEqual({ state: st.state, reason: st.reason, source: st.source }, { state: "fallback", reason, source: "unavailable" });
    assert.deepEqual(hw.fns.getGpuInfo(), { name: "Apple Metal GPU", vram_gb: 0 });
    await exited(children[0]);
    assert.ok(gone(children[0].pid), "no orphaned probe process");
  });
}

test("real child: stop() while the probe runs kills it at once; nothing probes afterwards", { timeout: 30000 }, async () => {
  const { hw, children } = service("sleep", { timeoutMs: 20000 });
  const p = hw.prime();
  await new Promise((r) => setTimeout(r, 100));
  const t0 = Date.now(); hw.stop(); await p;
  assert.deepEqual({ state: hw.gpuProbeState().state, reason: hw.gpuProbeState().reason }, { state: "stopped", reason: "cancelled" });
  await exited(children[0]);
  assert.ok(Date.now() - t0 < 5000, "killed at once, not after the 20 s timeout");
  assert.ok(gone(children[0].pid), "no orphaned probe process");
  assert.deepEqual(hw.fns.getGpuInfo(), { name: "Apple Metal GPU", vram_gb: 0 });
  await hw.ready(); await hw.prime();
  assert.equal(children.length, 1, "no new probe after stop");
});
