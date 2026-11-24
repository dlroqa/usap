// #170-adjacent diagnostics (test-only, messages only, never judged): Windows CI once failed to start a test studio
// server with "listen EADDRINUSE" on a port that fixtures/test-ports.cjs had reserved (the reservation assumes its
// range 21000-23999 is outside every OS ephemeral range). This reads, passively, the OS's dynamic (ephemeral) port
// range and excluded ranges, and who holds a given port, so a failure can tell apart: the port lies in the dynamic
// or an excluded range; another process owns it (and which kind: this test process, the failed studio, another test
// process holding a reservation lock, or a named other program); nobody owns it any more (a transient holder).
// Nothing here binds, connects or retries. Commands are bounded; any failure gives a short reason, never a throw.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { portOwners } = require("../../ci/port-owner.cjs");

const run = (cmd, args, timeout = 4000) => new Promise((resolve) => {
  try { execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err && !stdout ? { error: (err && err.code) || "ERROR" } : { stdout: String(stdout || "") })); }
  catch (e) { resolve({ error: (e && e.code) || "ERROR" }); }
});

// `netsh int ipv4 show dynamicport tcp` -> { first, last } (English output: "Start Port : 49152", "Number of Ports : 16384").
function parseNetshDynamic(text) {
  const s = /Start Port\s*:\s*(\d+)/i.exec(String(text)), n = /Number of Ports\s*:\s*(\d+)/i.exec(String(text));
  return s && n ? { first: Number(s[1]), last: Number(s[1]) + Number(n[1]) - 1 } : null;
}
// `netsh int ipv4 show excludedportrange protocol=tcp` -> [[first, last], ...] (lines "  50000  50059" or "...  *").
function parseNetshExcluded(text) {
  const out = [];
  for (const l of String(text).split(/\r?\n/)) { const m = /^\s*(\d+)\s+(\d+)\s*\*?\s*$/.exec(l); if (m) out.push([Number(m[1]), Number(m[2])]); }
  return out.slice(0, 64);
}
const overlap = (a, b) => (a && b ? Math.max(0, Math.min(a.last, b.last) - Math.max(a.first, b.first) + 1) : 0);
const inRange = (p, r) => Boolean(r && p >= r.first && p <= r.last);

/** @returns {Promise<{ platform, dynamic: {first,last}|null, excluded: number[][], error?: string }>} */
async function portRanges(platform = process.platform) {
  try {
    if (platform === "win32") {
      const [d, e] = await Promise.all([run("netsh", ["int", "ipv4", "show", "dynamicport", "tcp"]), run("netsh", ["int", "ipv4", "show", "excludedportrange", "protocol=tcp"])]);
      return { platform, dynamic: d.stdout ? parseNetshDynamic(d.stdout) : null, excluded: e.stdout ? parseNetshExcluded(e.stdout) : [], ...(d.error ? { error: `dynamicport ${d.error}` } : {}) };
    }
    if (platform === "linux") {
      const t = fs.readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/).map(Number);
      let reserved = "";
      try { reserved = fs.readFileSync("/proc/sys/net/ipv4/ip_local_reserved_ports", "utf8").trim(); } catch (_) { /* absent */ }
      const excluded = reserved ? reserved.split(",").map((x) => x.split("-").map(Number)).map((x) => [x[0], x[1] ?? x[0]]) : [];
      return { platform, dynamic: { first: t[0], last: t[1] }, excluded: excluded.slice(0, 64) };
    }
    if (platform === "darwin") {
      const r = await run("sysctl", ["-n", "net.inet.ip.portrange.first", "net.inet.ip.portrange.last"]);
      const v = r.stdout ? r.stdout.trim().split(/\s+/).map(Number) : [];
      return { platform, dynamic: v.length === 2 ? { first: v[0], last: v[1] } : null, excluded: [], ...(r.error ? { error: `sysctl ${r.error}` } : {}) };
    }
    return { platform, dynamic: null, excluded: [], error: "unsupported" };
  } catch (e) { return { platform, dynamic: null, excluded: [], error: (e && e.code) || "ERROR" }; }
}

function describeRanges(r, testRange) {
  const ex = r.excluded.filter(([a, b]) => overlap({ first: a, last: b }, testRange) > 0);
  return `${r.platform}: dynamic ${r.dynamic ? `${r.dynamic.first}-${r.dynamic.last}` : "unknown"}${r.error ? ` (${String(r.error).replace(/[^A-Za-z0-9 _-]/g, "")})` : ""}; test range ${testRange.first}-${testRange.last} overlaps dynamic by ${overlap(r.dynamic, testRange)} ports; excluded ranges ${r.excluded.length}, overlapping the test range: ${ex.length ? ex.map(([a, b]) => `${a}-${b}`).join(",") : "none"}`;
}

// The process image name of a pid, reduced to a short word (e.g. node.exe, svchost.exe); never a path or arguments.
async function imageName(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0) return pid === 0 ? "system (pid 0)" : "unknown";
  const r = platform === "win32" ? await run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]) : await run("ps", ["-o", "comm=", "-p", String(pid)]);
  if (!r.stdout) return "gone";
  const raw = platform === "win32" ? ((/^"([^"]+)"/.exec(r.stdout.trim()) || [])[1] || "") : r.stdout.trim();
  return (path.basename(raw.replace(/\\/g, "/")) || "gone").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 24) || "gone";
}

// Reservation locks for one port (fixtures/test-ports.cjs: <port>.<pid>.lock in lockDir) -> [{ pid, alive }].
function lockOwners(lockDir, port) {
  let names = []; try { names = fs.readdirSync(lockDir); } catch (_) { return []; }
  return names.map((n) => /^(\d+)\.(\d+)\.lock$/.exec(n)).filter((m) => m && Number(m[1]) === port)
    .map((m) => { const pid = Number(m[2]); let alive; try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === "EPERM"; } return { pid, alive }; });
}

/**
 * One bounded line for a studio start that failed with EADDRINUSE on a reserved port.
 * @param {{ port:number, role:string, reservedAt:number, failedAt:number, lockDir:string, testRange:{first,last}, testPid?:number, serverPid?:number, platform?:string }} o
 */
async function describeStartFailure({ port, role, reservedAt, failedAt, lockDir, testRange, testPid = process.pid, serverPid = null, platform = process.platform }) {
  const [ranges, owners] = await Promise.all([portRanges(platform), portOwners(port, platform)]);
  const locks = lockOwners(lockDir, port);
  const lockPids = new Set(locks.map((l) => l.pid));
  const who = async (pid) => (pid === testPid ? "this test process" : pid === serverPid ? "the failed studio" : lockPids.has(pid) ? "a test process holding this port's lock" : `other program ${await imageName(pid, platform)}`);
  let ownerText;
  if (owners.error) ownerText = `owners unavailable (${String(owners.error).replace(/[^A-Za-z0-9_-]/g, "")})`;
  else {
    const parts = [];
    for (const s of owners.sockets.slice(0, 8)) parts.push(`${s.state} ${s.pids.length ? (await Promise.all(s.pids.slice(0, 2).map(who))).join("/") : "owner not visible"}`);
    ownerText = `owners now: ${parts.join(", ") || "none (no socket on this local port)"}`;
  }
  const inEx = ranges.excluded.find(([a, b]) => port >= a && port <= b);
  return [`port ${port} (${role}) reserved ${Math.round(failedAt - reservedAt)} ms before the failure`,
    `locks ${locks.length ? locks.map((l) => `${l.pid === testPid ? "this test process" : "other"}${l.alive ? "" : " (dead)"}`).join(",") : "none"}`,
    `in dynamic range ${ranges.dynamic ? inRange(port, ranges.dynamic) : "unknown"}${ranges.dynamic ? ` (${ranges.dynamic.first}-${ranges.dynamic.last})` : ""}`,
    `in an excluded range ${inEx ? `yes ${inEx[0]}-${inEx[1]}` : "no"}`,
    ownerText,
    describeRanges(ranges, testRange)].join("; ").slice(0, 1200);
}

module.exports = { portRanges, describeRanges, describeStartFailure, parseNetshDynamic, parseNetshExcluded, lockOwners, imageName, overlap };
