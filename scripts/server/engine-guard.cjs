// engine-guard.cjs — runs one engine process and makes sure it never outlives the studio server
// (Step 9.6). Started by supervisor.cjs as:  node engine-guard.cjs <command> [args...]
//
// The server talks to the guard over Node's IPC channel. When the server goes away for any reason
// (normal exit, crash, SIGKILL, Windows TerminateProcess, closed console), the OS closes that channel,
// the guard sees "disconnect" and stops the engine: a polite stop first, then a forced one after
// USAP_ENGINE_STOP_GRACE_MS (default 3 s). A parent-PID check every second is a second safety net.
//
// Transparent to the server: stdin is passed through (the TTS worker reads its job from stdin),
// stdout/stderr are the engine's own, and the guard exits with the engine's exit code, or re-raises
// the engine's signal (so crash detection such as Metal's SIGABRT keeps working).
"use strict";

const { spawn, spawnSync } = require("child_process");

const IS_WIN = process.platform === "win32";
// By absolute path: another "taskkill" (e.g. from a Unix toolset) can come first on PATH.
const TASKKILL = require("path").join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "taskkill.exe");
const GRACE_MS = Math.max(100, Number(process.env.USAP_ENGINE_STOP_GRACE_MS) || 3000);
const [command, ...args] = process.argv.slice(2);
const parentPid = process.ppid;

let engine = null;
let stopping = false;
let forceTimer = null;

function tell(message) {
  try { if (process.connected) process.send(message); } catch (_) { /* parent already gone */ }
}

function engineRunning() {
  return engine && engine.pid && engine.exitCode === null && engine.signalCode === null;
}

// Windows has no signals: end the engine and anything it started (taskkill /T). POSIX: signal it.
function signalEngine(force) {
  if (!engineRunning()) return;
  if (IS_WIN) {
    spawnSync(TASKKILL, ["/PID", String(engine.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try { engine.kill(force ? "SIGKILL" : "SIGTERM"); } catch (_) { /* already gone */ }
}

function stop(force = false) {
  if (!engineRunning()) {
    if (!engine || engine.exitCode !== null || engine.signalCode !== null) process.exit(0);
    return;
  }
  if (force) { signalEngine(true); return; }
  if (stopping) return;
  stopping = true;
  signalEngine(false);
  forceTimer = setTimeout(() => signalEngine(true), GRACE_MS);
}

if (!command) {
  process.stderr.write("[engine-guard] no engine command given\n");
  process.exit(2);
}

try {
  engine = spawn(command, args, { stdio: ["pipe", "inherit", "inherit"], windowsHide: true, env: process.env });
} catch (err) {
  tell({ type: "spawn-error", code: err.code || "", message: err.message });
  process.stderr.write(`[engine-guard] could not start ${command}: ${err.message}\n`);
  process.exit(127);
}

engine.on("error", (err) => {
  tell({ type: "spawn-error", code: err.code || "", message: err.message });
  process.stderr.write(`[engine-guard] could not start ${command}: ${err.message}\n`);
  process.exit(127);
});
if (engine.pid) tell({ type: "started", pid: engine.pid });

process.stdin.on("error", () => {});
engine.stdin.on("error", () => {});
process.stdin.pipe(engine.stdin);

engine.on("exit", (code, signal) => {
  if (forceTimer) clearTimeout(forceTimer);
  tell({ type: "exit", code, signal });
  if (signal && !IS_WIN) {
    for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.removeAllListeners(s);
    try { process.kill(process.pid, signal); } catch (_) { /* fall through */ }
    setTimeout(() => process.exit(1), 1000);
    return;
  }
  process.exit(code === null ? 1 : code);
});

for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => stop(false));
process.on("message", (m) => { if (m && m.type === "stop") stop(Boolean(m.force)); });
process.on("disconnect", () => stop(false));

// Second safety net: the parent process no longer exists.
setInterval(() => {
  try { process.kill(parentPid, 0); } catch (err) { if (err.code === "ESRCH") stop(false); }
}, 1000).unref();
