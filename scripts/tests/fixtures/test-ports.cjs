// test-ports.cjs — ports for test servers and engines that a child process binds later (test-only, #142).
//
// Tests used to pick such a port with "bind port 0, read it, close", then hand it to a child process that binds it
// later. Between the two, nothing owns the port. It is taken from the OS ephemeral range, which every other test
// process picking ports the same way (test files run in parallel) and every outgoing connection also draws from, so
// another process can hold it at the moment the child binds: the child then fails with EADDRINUSE (#142).
//
// reservePort() instead hands out ports that test processes own explicitly:
//   - from RANGE, which is outside the OS ephemeral ranges (Linux 32768-60999, macOS and Windows 49152-65535) and
//     outside the ports the product itself uses (1420, 8080, 10086-10089, 28088-28190);
//   - each port is claimed with a lock file named after its owner, <port>.<pid>.lock, in a directory shared by all
//     test processes on this machine. Creating it is one atomic step, so there is no half-written lock. After
//     creating its own, a process looks for other owners of that port: if another live process holds one, it
//     removes its own and moves on (if two claim at once, at least one sees the other, so at most one keeps the
//     port; both may back off, never both keep it);
//   - a port another process (not a test) is listening on, or that the OS refuses, is skipped (bind probe);
//   - a process only ever deletes its own lock (release, exit, failed probe) or a lock whose owner PID is no longer
//     running, so it can never remove a live owner's lock, and crashed test processes cannot exhaust the range. A
//     dead owner's PID reused by another running process only keeps that port unused while that process runs.
// It does not hide a real failure: a child that still cannot bind its port fails exactly as before.
"use strict";
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const RANGE = { first: 21000, last: 23999 };
const LOCK_DIR = path.join(os.tmpdir(), "usap-test-ports");
const held = new Map(); // port -> own lock file, for this process (set before the bind probe)
const LOCK_RE = /^(\d+)\.(\d+)\.lock$/;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; }
}

function ownersOf(lockDir, port) {
  const pids = [];
  for (const name of fs.readdirSync(lockDir)) {
    const m = LOCK_RE.exec(name);
    if (m && Number(m[1]) === port) pids.push(Number(m[2]));
  }
  return pids;
}

// Claim a port: the path of this process's lock file if it now owns the port, else null.
function claim(lockDir, port) {
  const mine = path.join(lockDir, `${port}.${process.pid}.lock`);
  try { fs.writeFileSync(mine, "", { flag: "wx" }); } catch (err) {
    // Already there with our PID: left by an earlier process that had this PID (it is gone), so it is ours now.
    if (err.code !== "EEXIST") throw err;
  }
  let liveOther = false;
  for (const pid of ownersOf(lockDir, port)) {
    if (pid === process.pid) continue;
    if (pidAlive(pid)) liveOther = true;
    else { try { fs.unlinkSync(path.join(lockDir, `${port}.${pid}.lock`)); } catch (_) { /* already removed */ } }
  }
  if (liveOther) { try { fs.unlinkSync(mine); } catch (_) {} return null; }
  return mine;
}

// Can a listener bind this port right now? (Detects listeners of other programs and ports the OS excludes.)
function bindable(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen({ port, host }, () => s.close(() => resolve(true)));
  });
}

let cursor = 0;
/**
 * A port this process owns until releasePort(port) or exit.
 * @param {{ host?: string, range?: { first: number, last: number }, lockDir?: string }} [o] range/lockDir: tests only
 */
async function reservePort({ host = "127.0.0.1", range = RANGE, lockDir = LOCK_DIR } = {}) {
  fs.mkdirSync(lockDir, { recursive: true });
  const span = range.last - range.first + 1;
  for (let i = 0; i < span; i += 1) {
    const port = range.first + ((cursor + i) % span);
    if (held.has(port)) continue;
    const file = claim(lockDir, port);
    if (!file) continue;
    held.set(port, file); // before the probe, so a concurrent call in this process skips it
    if (!(await bindable(port, host))) { releasePort(port); continue; }
    cursor = (cursor + i + 1) % span;
    return port;
  }
  throw new Error(`no free test port in ${range.first}-${range.last} (locks in ${lockDir})`);
}

function releasePort(port) {
  const file = held.get(port);
  if (!file) return;
  held.delete(port);
  try { fs.unlinkSync(file); } catch (_) { /* already gone */ } // our own lock file: no other process uses this name
}

process.on("exit", () => { for (const port of [...held.keys()]) releasePort(port); });

module.exports = { reservePort, releasePort, heldPorts: () => [...held.keys()], RANGE, LOCK_DIR };
