// supervisor.cjs — start engine processes so they can't be orphaned (Step 9.6).
//
// spawnSupervised() returns a normal ChildProcess (same events, stdio, exit code and signal) whose
// process is engine-guard.cjs running the engine. The guard stops the engine whenever this server
// goes away, including SIGKILL and crashes, which no exit handler can catch.
//
//   proc.kill("SIGTERM")  polite stop; the guard forces it after a grace period
//   proc.kill("SIGKILL")  immediate stop of the guard and the engine (POSIX process group / Windows tree)
//
// A command that is not an existing executable file (or not an absolute path) is spawned directly,
// unchanged, so launch failures keep their usual "error" event (ENOENT, EACCES).
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const IS_WIN = process.platform === "win32";
// By absolute path: another "taskkill" (e.g. from a Unix toolset) can come first on PATH.
const TASKKILL = require("path").join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "taskkill.exe");
const GUARD = path.join(__dirname, "engine-guard.cjs");
const MAX_HISTORY = 20;

const live = new Map(); // guard pid -> record
const history = [];     // recent exits, newest last

function isExecutableFile(command) {
  if (!path.isAbsolute(String(command || ""))) return false;
  try {
    if (!fs.statSync(command).isFile()) return false;
    if (!IS_WIN) fs.accessSync(command, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function stdioTriple(stdio) {
  if (Array.isArray(stdio)) return [0, 1, 2].map((i) => stdio[i] || "pipe");
  return [stdio || "pipe", stdio || "pipe", stdio || "pipe"];
}

function killTree(pid) {
  if (IS_WIN) spawnSync(TASKKILL, ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else { try { process.kill(-pid, "SIGKILL"); } catch (_) { try { process.kill(pid, "SIGKILL"); } catch (_) { /* gone */ } } }
}

/**
 * @param {string} command  absolute path of the engine executable
 * @param {string[]} args
 * @param {object} options  child_process.spawn options (stdio, env, cwd, windowsHide)
 * @param {{label?: string}} [meta]  name used in diagnostics
 */
function spawnSupervised(command, args = [], options = {}, { label = path.basename(String(command)) } = {}) {
  if (!isExecutableFile(command)) return spawn(command, args, options);
  const child = spawn(process.execPath, [GUARD, command, ...args], {
    ...options,
    stdio: [...stdioTriple(options.stdio), "ipc"],
    windowsHide: true,
    detached: !IS_WIN, // own process group, so SIGKILL can take the engine with it
  });
  const record = { label, guardPid: child.pid, enginePid: null, startedAt: new Date().toISOString() };
  child.supervised = true;
  child.enginePid = null;
  child.on("message", (m) => {
    if (m && m.type === "started") { child.enginePid = m.pid; record.enginePid = m.pid; }
  });
  child.on("error", () => {}); // the caller's own "error" listeners still run

  const directKill = child.kill.bind(child);
  child.kill = (signal = "SIGTERM") => {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    const force = signal === "SIGKILL" || signal === 9;
    if (force) { killTree(child.pid); return true; }
    if (IS_WIN) {
      // Killing the guard directly would skip its cleanup; ask it to stop the engine instead.
      try { child.send({ type: "stop" }); return true; } catch (_) { killTree(child.pid); return true; }
    }
    return directKill(signal);
  };

  if (child.pid) live.set(child.pid, record);
  child.on("exit", (code, signal) => {
    live.delete(child.pid);
    history.push({ label, enginePid: record.enginePid, code, signal, at: new Date().toISOString() });
    if (history.length > MAX_HISTORY) history.shift();
  });
  return child;
}

// For process "exit" handlers (synchronous): ask every engine to stop now. On Windows the guards
// notice the closed IPC channel as this process exits, so nothing else is needed there.
function stopAllSync() {
  if (IS_WIN) return;
  for (const pid of live.keys()) {
    try { process.kill(-pid, "SIGTERM"); } catch (_) { /* gone */ }
  }
}

function snapshot() {
  return {
    supervised: [...live.values()].map((r) => ({ ...r })),
    recentExits: history.slice(-10).map((r) => ({ ...r })),
  };
}

module.exports = { spawnSupervised, stopAllSync, snapshot, GUARD };
