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

// A process's parent pid and start time (ms since the epoch), each null if unknown. Windows: one CIM query (keeps the
// ORIGINAL parent's id even after that parent exited); Linux: /proc (a survivor is re-parented, so its parent then is
// init or a subreaper); macOS: ps (likewise re-parented; start time has 1 s resolution).
let clkTck = null;
async function procInfo(pid, platform = process.platform) {
  try {
    if (platform === "linux") {
      const st = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); const f = st.slice(st.lastIndexOf(")") + 2).split(" ");
      if (clkTck === null) clkTck = Number((await run("getconf", ["CLK_TCK"])).trim()) || 100;
      // start = now - (uptime - starttime/CLK_TCK); /proc/uptime has 10 ms resolution (btime in /proc/stat only 1 s)
      const uptime = Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]);
      const startedAt = Number.isFinite(uptime) ? Date.now() - (uptime - Number(f[19]) / clkTck) * 1000 : null;
      return { ppid: Number(f[1]) || null, startedAt, resolutionMs: Math.ceil(1000 / clkTck) + 10 };
    }
    if (platform === "win32") {
      const out = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}'; if ($p) { "$($p.ParentProcessId) $($p.CreationDate.ToUniversalTime().ToString('o'))" }`]);
      const [pp, iso] = out.trim().split(/\s+/);
      return { ppid: Number(pp) || null, startedAt: iso ? Date.parse(iso) || null : null, resolutionMs: 16 };
    }
    const out = await run("ps", ["-o", "ppid=,lstart=", "-p", String(pid)]);
    const m = /^\s*(\d+)\s+(.+)$/.exec(out.trim());
    return { ppid: m ? Number(m[1]) : null, startedAt: m ? Date.parse(m[2]) || null : null, resolutionMs: 1000 };
  } catch (_) { return { ppid: null, startedAt: null, resolutionMs: null }; }
}
const parentOf = async (pid, platform) => (await procInfo(pid, platform)).ppid;

// "<ms> <pid> <port> <what>" lines for `port` -> [{ t, pid, what }], last MAX_LOG.
function reservationLog(port, logFile = LOG_FILE, max = MAX_LOG) {
  let text = "";
  for (const f of [`${logFile}.1`, logFile]) { try { text += fs.readFileSync(f, "utf8"); } catch (_) { /* absent */ } }
  const out = [];
  for (const l of text.split(/\r?\n/)) { const f = l.split(" "); if (f.length === 4 && Number(f[2]) === port) out.push({ t: Number(f[0]), pid: Number(f[1]), what: f[3].replace(/[^a-z-]/g, "") }); }
  return out.slice(-max);
}
// Reservation windows [{ pid, from, to|null }] from the full log of one port (a reserve until the same pid's release).
function windowsOf(entries) {
  const open = new Map(), out = [];
  for (const e of entries) {
    if (e.what === "reserve") open.set(e.pid, { pid: e.pid, from: e.t, to: null });
    else if (e.what === "release" && open.has(e.pid)) { const w = open.get(e.pid); w.to = e.t; out.push(w); open.delete(e.pid); }
  }
  return [...out, ...open.values()];
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
  // Reservations and locks are the tests' bookkeeping; only "holders" (the OS socket table) say who owns the port.
  const parts = [`port ${port} reservation sequence (bookkeeping, not socket ownership): ${seq}`, `locks now: ${locks}`, `in dynamic range ${inDyn}, in an excluded range ${inEx}`];
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
      const [img, info] = await Promise.all([imageName(pid, platform), procInfo(pid, platform)]);
      const ppid = info.ppid;
      const parent = ppid ? `${procRoleOrOther(ppid, roles, testPid, others)}${alive(ppid) ? "" : " (gone)"}` : "unknown";
      // which test process held the reservation when this holder started (start-time resolution allowed for)
      let during = "start time unknown";
      if (info.startedAt) {
        const tol = info.resolutionMs || 0;
        const w = windowsOf(reservationLog(port, logFile, 1000)).filter((x) => info.startedAt >= x.from - tol && info.startedAt <= (x.to === null ? Infinity : x.to + tol));
        during = `started ${rel(info.startedAt)} (+-${tol} ms) ${w.length ? `during ${w.map((x) => `${procRole(x.pid)}'s reservation`).join(" and ")}` : "outside every reservation in the log"}`;
      }
      holders.push(`${procRoleOrOther(pid, roles, testPid, others)} ${img} ${alive(pid) ? "alive" : "gone"}, parent ${parent}, ${during}: ${how.join(" + ")}`);
    }
    parts.push(`holders: ${holders.join(" | ") || "none seen"}`);
  }
  return parts.join("; ").slice(0, 1800);
}
const procRoleOrOther = (pid, roles, testPid, others) => (pid === testPid ? "this test process" : roles.has(pid) ? roles.get(pid) : others.has(pid) ? others.get(pid) : "another process");

module.exports = { describePortRecord, reservationLog, parentOf, procInfo, windowsOf };
