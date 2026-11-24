// #170 R2 diagnostics (scripts/ci/r2-diag.cjs): message-only describer for the native check "R2 three image loads at
// once". These tests pin that a start failure, an early exit (including replaced engines) and a loss of tracking read
// differently, and that the line is bounded and sanitized. It never decides R2's verdict.
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { describeR2 } = require("../ci/r2-diag.cjs");

const T = 1_700_000_000_000;
const iso = (ms) => new Date(T + ms).toISOString();
const loads = [1, 2, 3].map((steps, i) => ({ steps, sentAt: T + i, answeredAt: T + 900 + i * 300, status: 200 }));
const sup = (enginePid, guardPid, startMs) => ({ enginePid, guardPid, startedAt: iso(startMs) });
const exit = (enginePid, atMs, code = null, signal = null) => ({ enginePid, code, signal, at: iso(atMs) });
const okStatus = { running: true, ready: true, loading: "idle", unloading: "idle", settings: { steps: 3 }, error: null, port: 21002 };
const downStatus = { running: false, ready: false, loading: "idle", unloading: "idle", settings: { steps: 3 }, error: null, port: 21002 };

test("R2 diag: start failure — no engine recorded after the loads", () => {
  const s = describeR2({ t0: T, loads, samples: [{ t: T + 100, sup: [], exits: [] }], final: { status: downStatus, sup: [], exits: [], alive: {}, portOpen: false } });
  assert.match(s, /^loads steps 1: sent 0, 200 at 900; steps 2: sent 1, 200 at 1200; steps 3: sent 2, 200 at 1500/);
  assert.match(s, /image engines none recorded/);
  assert.match(s, /reading: no image engine process was recorded after the loads: consistent with a failure to start/);
});

test("R2 diag: early exit — replaced engines and the current one all exited, with their codes and signals", () => {
  const samples = [
    { t: T + 200, sup: [sup(9001, 8001, 150)], exits: [] },
    { t: T + 700, sup: [sup(9002, 8002, 650)], exits: [exit(9001, 600, null, "SIGTERM")] },
    { t: T + 1300, sup: [sup(9003, 8003, 1250)], exits: [exit(9001, 600, null, "SIGTERM"), exit(9002, 1200, 1, null)] },
    { t: T + 2400, sup: [], exits: [exit(9001, 600, null, "SIGTERM"), exit(9002, 1200, 1, null), exit(9003, 2300, 3221225477, null)] },
  ];
  const s = describeR2({ t0: T, loads, samples, final: { status: downStatus, sup: [], exits: samples[3].exits, alive: { 9001: false, 9002: false, 9003: false }, portOpen: false } });
  assert.match(s, /e1\/g1 started 150, supervised 200\.\.200, exited 600 code none signal SIGTERM; e2\/g2 started 650, supervised 700\.\.700, exited 1200 code 1 signal none; e3\/g3 started 1250, supervised 1300\.\.1300, exited 2300 code 3221225477 signal none/);
  assert.match(s, /after the check: backend running false, ready false, .*current steps 3.*supervised now none; OS e1 gone,e2 gone,e3 gone/);
  assert.match(s, /reading: every engine recorded during the check exited \(codes above\): consistent with an early exit or a stop after the loads/);
  assert.doesNotMatch(s, /900[0-9]|800[0-9]/, "no process ids");
});

test("R2 diag: loss of tracking — an engine alive but not supervised, or supervised but the backend not running", () => {
  const samples = [{ t: T + 200, sup: [sup(9001, 8001, 150)], exits: [] }];
  const a = describeR2({ t0: T, loads, samples, final: { status: downStatus, sup: [], exits: [], alive: { 9001: true }, portOpen: true } });
  assert.match(a, /reading: an engine process is still alive but no longer supervised: consistent with a loss of tracking/);
  const b = describeR2({ t0: T, loads, samples, final: { status: downStatus, sup: [sup(9001, 8001, 150)], exits: [], alive: { 9001: true }, portOpen: true } });
  assert.match(b, /reading: an engine process is alive and supervised but the backend is not marked running: consistent with a loss of tracking in the image state/);
  const ok = describeR2({ t0: T, loads, samples, final: { status: okStatus, sup: [sup(9001, 8001, 150)], exits: [], alive: { 9001: true }, portOpen: true } });
  assert.match(ok, /reading: an engine is alive and tracked/);
  const unknown = describeR2({ t0: T, loads, samples, final: { status: downStatus, sup: [], exits: [], alive: { 9001: false }, portOpen: false } });
  assert.match(unknown, /reading: no engine alive and not every exit recorded: not determined from these records/);
});

test("R2 diag: failed answers keep code words only; log lines sanitized; bounded; missing input is said", () => {
  const bad = [{ steps: 1, sentAt: T, answeredAt: T + 50, status: 409, code: "ENGINE_START_CANCELLED", error: "Engine start cancelled: C:\\\\Users\\\\someone\\\\app\\\\sd.exe EADDRINUSE 127.0.0.1:21002" }];
  const log = ["  [backend] Starting: C:\\Users\\someone\\app\\sd-cpu.exe --listen-port 21002 --model C:\\Users\\someone\\m.gguf", "  [engine-slot] image engine process 4321 exited after all", "  [api] Restart backend request: { model: 'x' }", "unrelated line"].join("\n");
  const s = describeR2({ t0: T, loads: bad, samples: [], final: { status: { ...downStatus, error: "spawn C:\\Users\\someone\\sd.exe ENOENT" }, sup: [], exits: [], alive: {}, portOpen: false }, log });
  assert.match(s, /steps 1: sent 0, 409 ENGINE_START_CANCELLED at 50 \(EADDRINUSE,cancel\)/);
  assert.match(s, /error ENOENT/);
  assert.doesNotMatch(s, /Users|someone|\\\\|127\.0\.0\.1|4321|21002/, s);
  assert.match(s, /server lines .*\[backend\] Starting/);
  const many = Array.from({ length: 300 }, (_, i) => ({ t: T + i, sup: [sup(10000 + i, 20000 + i, i)], exits: [] }));
  assert.ok(describeR2({ t0: T, loads, samples: many, final: {} }).length <= 3000);
  assert.match(describeR2({}), /^loads none; image engines none recorded; after the check: backend running undefined/);
});
