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
//   - each port is claimed by creating a lock file exclusively (one per port, shared by all test processes on this
//     machine), so two test processes never get the same port;
//   - a port another process (not a test) is listening on, or that the OS refuses, is skipped (bind probe);
//   - releasePort() and process exit remove the lock; a lock whose process is gone is reclaimed.
// It does not hide a real failure: a child that still cannot bind its port fails exactly as before.
"use strict";
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const RANGE = { first: 21000, last: 23999 };
const LOCK_DIR = path.join(os.tmpdir(), "usap-test-ports");
const held = new Map(); // port -> lock file, for this process

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; }
}

// Claim the lock file for a port: true if this process now owns it.
function claim(file) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let owner = NaN;
      try { owner = Number(fs.readFileSync(file, "utf8")); } catch (_) { continue; } // removed meanwhile: retry
      // An empty file is a lock being written right now: it belongs to a live process.
      if (Number.isNaN(owner) || owner === 0 || pidAlive(owner)) return false;
      try { fs.unlinkSync(file); } catch (_) { /* another process reclaimed it first */ }
    }
  }
  return false;
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
    const file = path.join(lockDir, `${port}.lock`);
    if (!claim(file)) continue;
    if (!(await bindable(port, host))) { try { fs.unlinkSync(file); } catch (_) {} continue; }
    held.set(port, file);
    cursor = (cursor + i + 1) % span;
    return port;
  }
  throw new Error(`no free test port in ${range.first}-${range.last} (locks in ${lockDir})`);
}

function releasePort(port) {
  const file = held.get(port);
  if (!file) return;
  held.delete(port);
  try { fs.unlinkSync(file); } catch (_) { /* already gone */ }
}

process.on("exit", () => { for (const port of [...held.keys()]) releasePort(port); });

module.exports = { reservePort, releasePort, heldPorts: () => [...held.keys()], RANGE, LOCK_DIR };
