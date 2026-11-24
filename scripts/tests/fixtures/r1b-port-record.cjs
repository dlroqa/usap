// #170 R1b diagnostics (test-only, messages only, never judged): the image port's record for the engine-slot tests R1b
// and R5, printed in the same line as the lifecycle trace (fixtures/lifecycle-trace.cjs). Windows CI failed R1b twice
// with the stand-in's "listen EADDRINUSE" on the same reserved port (21147), right after the studio's own check had
// found it free. This adds, for that port:
//   - the reservation sequence across all test processes (fixtures/test-ports.cjs shared log, beside the lock dir): who reserved,
//     released or found it busy, when (ms from the test's start), with process roles;
//   - the reservation locks now;
//   - whether the port lies in the OS dynamic or an excluded range (fixtures/port-range-diag.cjs);
//   - with `full` (the test failed or a stand-in bind failed): every holder process seen by the stand-in at its
//     EADDRINUSE (its own netstat/lsof record) and by a passive read now (scripts/ci/port-owner.cjs), each with its
//     state, image name, whether it is still alive, and its PARENT's role (e.g. "child of g1": a stand-in or launcher of
//     an earlier engine of this test; "child of test process B": an engine left by another test file).
// Nothing binds or connects. Pids, paths and addresses are never printed; the port's own number is (it is a test port).
"use strict";
const fs = require("node:fs");
const { execFile } = require("node:child_process");
const { portOwners } = require("../../ci/port-owner.cjs");
const { portRanges, lockOwners, imageName } = require("./port-range-diag.cjs");
const { LOCK_DIR, LOG_FILE } = require("./test-ports.cjs");
const { parseHolders, readJsonl } = require("./lifecycle-trace.cjs");

const MAX_LOG = 12, MAX_HOLDERS = 4;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const run = (cmd, args, timeout = 6000) => new Promise((resolve) => { try { execFile(cmd, args, { timeout, windowsHide: true }, (err, out) => resolve(err && !out ? "" : String(out || ""))); } catch (_) { resolve(""); } });

// Parent pid of a process, or null (Windows: one CIM query; Linux: /proc; macOS: ps).
async function parentOf(pid, platform = process.platform) {
  try {
    if (platform === "linux") { const st = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[1]) || null; }
    const out = platform === "win32"
      ? await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}').ParentProcessId`])
      : await run("ps", ["-o", "ppid=", "-p", String(pid)]);
    return Number(out.trim()) || null;
  } catch (_) { return null; }
}

// "<ms> <pid> <port> <what>" lines for `port` -> [{ t, pid, what }], last MAX_LOG.
function reservationLog(port, logFile = LOG_FILE) {
  let text = ""; try { text = fs.readFileSync(logFile, "utf8"); } catch (_) { return []; }
  const out = [];
  for (const l of text.split(/\r?\n/)) { const f = l.split(" "); if (f.length === 4 && Number(f[2]) === port) out.push({ t: Number(f[0]), pid: Number(f[1]), what: f[3].replace(/[^a-z-]/g, "") }); }
  return out.slice(-MAX_LOG);
}

/**
 * @param {object} o  port, t0, roles (Map pid -> role from the lifecycle trace), standInDiagFile, full, testPid, platform
 */
async function describePortRecord({ port, t0, roles = new Map(), standInDiagFile = null, full = false, testPid = process.pid, platform = process.platform, lockDir = LOCK_DIR, logFile = LOG_FILE }) {
  const rel = (t) => (Number.isFinite(t) ? Math.round(t - t0) : "?");
  const log = reservationLog(port, logFile);
  const others = new Map();
  const procRole = (pid) => {
    if (pid === testPid) return "this test process";
    if (roles.has(pid)) return roles.get(pid);
    if (!others.has(pid)) others.set(pid, `test process ${String.fromCharCode(65 + others.size)}`);
    return others.get(pid);
  };
  for (const e of log) procRole(e.pid); // name other test processes in order of appearance
  const seq = log.map((e) => `${rel(e.t)} ${procRole(e.pid)} ${e.what}`).join(", ") || "no entries";
  const locks = lockOwners(lockDir, port).map((l) => `${procRole(l.pid)}${l.alive ? "" : " (dead)"}`).join(", ") || "none";
  const ranges = await portRanges(platform);
  const inDyn = ranges.dynamic ? port >= ranges.dynamic.first && port <= ranges.dynamic.last : "unknown";
  const inEx = ranges.excluded.some(([a, b]) => port >= a && port <= b);
  const parts = [`port ${port} reservation sequence: ${seq}`, `locks now: ${locks}`, `in dynamic range ${inDyn}, in an excluded range ${inEx}`];
  if (full) {
    const seen = new Map(); // pid -> [source/state]
    for (const r of readJsonl(standInDiagFile).filter((x) => x.e === "listen-error" && x.t >= t0)) {
      const h = parseHolders(r.holders, port);
      if (h.unavailable) parts.push(`stand-in holder read ${h.unavailable}`);
      for (const x of h.rows) if (x.side === "local") seen.set(x.pid, [...(seen.get(x.pid) || []), `${x.state} at the stand-in's EADDRINUSE (${rel(r.t)})`]);
    }
    const now = await portOwners(port, platform);
    if (now.error) parts.push(`owners now unavailable (${String(now.error).replace(/[^A-Za-z0-9_-]/g, "")})`);
    else for (const s of now.sockets) for (const pid of s.pids) seen.set(pid, [...(seen.get(pid) || []), `${s.state} now`]);
    const holders = [];
    for (const [pid, how] of [...seen.entries()].slice(0, MAX_HOLDERS)) {
      if (!pid) { holders.push(`${how.join(" + ")} with no owning process (pid 0)`); continue; }
      const [img, ppid] = await Promise.all([imageName(pid, platform), parentOf(pid, platform)]);
      holders.push(`${procRoleOrOther(pid, roles, testPid, others)} ${img} ${alive(pid) ? "alive" : "gone"}, parent ${ppid ? procRoleOrOther(ppid, roles, testPid, others) : "unknown"}: ${how.join(" + ")}`);
    }
    parts.push(`holders: ${holders.join(" | ") || "none seen"}`);
  }
  return parts.join("; ").slice(0, 1800);
}
const procRoleOrOther = (pid, roles, testPid, others) => (pid === testPid ? "this test process" : roles.has(pid) ? roles.get(pid) : others.has(pid) ? others.get(pid) : "another process");

module.exports = { describePortRecord, reservationLog, parentOf };
