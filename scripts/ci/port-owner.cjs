// #170 evidence (test-only, never judged): who holds a TCP port, read PASSIVELY from the operating system's socket
// table: nothing here binds, connects to or otherwise touches the port, so it cannot change whether an engine's own
// bind succeeds. Linux: /proc/net/tcp and tcp6 (state, socket inode) and /proc/<pid>/fd (inode -> process, own
// processes only). macOS: lsof. Windows: netstat -ano. Every command runs asynchronously and is bounded; any failure
// gives { error } instead of throwing.
"use strict";
const fs = require("fs");
const { execFile } = require("child_process");

const LINUX_STATES = { "01": "ESTABLISHED", "02": "SYN_SENT", "03": "SYN_RECV", "04": "FIN_WAIT1", "05": "FIN_WAIT2", "06": "TIME_WAIT", "07": "CLOSE", "08": "CLOSE_WAIT", "09": "LAST_ACK", "0A": "LISTEN", "0B": "CLOSING" };

// /proc/net/tcp text -> [{ state, inode }] for sockets whose LOCAL port is `port`.
function parseProcNet(text, port) {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  const out = [];
  for (const line of String(text).split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const local = f[1] || "";
    if (local.slice(local.lastIndexOf(":") + 1).toUpperCase() !== hex) continue;
    out.push({ state: LINUX_STATES[f[3]] || f[3], inode: f[9] });
  }
  return out;
}
// netstat -ano (Windows) text -> [{ state, pid }] for local port `port`.
function parseNetstat(text, port) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f[0] !== "TCP" || f.length < 5) continue;
    if (!new RegExp(`:${port}$`).test(f[1])) continue;
    out.push({ state: f[3], pid: Number(f[4]) });
  }
  return out;
}
// lsof -nP -iTCP:<port> -FpT (macOS) text -> [{ state, pid }].
function parseLsof(text) {
  const out = []; let pid = null;
  for (const line of String(text).split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("TST=") && pid) out.push({ state: line.slice(4), pid });
  }
  return out;
}
const run = (cmd, args, timeout = 3000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout) => resolve(err && !stdout ? { error: (err && err.code) || "ERROR" } : { stdout: String(stdout || "") }));
});
async function linuxOwners(port) {
  let socks = [];
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) { try { socks = socks.concat(parseProcNet(await fs.promises.readFile(f, "utf8"), port)); } catch (_) { /* absent */ } }
  const inodes = new Set(socks.filter((s) => s.state === "LISTEN").map((s) => s.inode));
  const pidOf = {};
  if (inodes.size) {
    let pids = []; try { pids = (await fs.promises.readdir("/proc")).filter((n) => /^\d+$/.test(n)); } catch (_) { /* none */ }
    for (const p of pids) {
      let fds = []; try { fds = await fs.promises.readdir(`/proc/${p}/fd`); } catch (_) { continue; } // other users' processes
      for (const fd of fds) {
        let l; try { l = await fs.promises.readlink(`/proc/${p}/fd/${fd}`); } catch (_) { continue; }
        const m = /^socket:\[(\d+)\]$/.exec(l);
        if (m && inodes.has(m[1])) (pidOf[m[1]] = pidOf[m[1]] || []).push(Number(p));
      }
    }
  }
  return socks.map((s) => ({ state: s.state, pids: s.state === "LISTEN" ? (pidOf[s.inode] || []) : [] }));
}
/** @returns {Promise<{ sockets: Array<{state:string, pids:number[]}> } | { error: string }>} */
async function portOwners(port, platform = process.platform) {
  try {
    if (platform === "linux") return { sockets: await linuxOwners(port) };
    if (platform === "darwin") { const r = await run("lsof", ["-nP", `-iTCP:${port}`, "-FpT"]); return r.error && !r.stdout ? { sockets: [] } : { sockets: parseLsof(r.stdout).map((s) => ({ state: s.state, pids: [s.pid] })) }; }
    if (platform === "win32") { const r = await run("netstat", ["-ano", "-p", "TCP"]); return r.error ? { error: r.error } : { sockets: parseNetstat(r.stdout, port).map((s) => ({ state: s.state, pids: [s.pid] })) }; }
    return { error: "unsupported" };
  } catch (e) { return { error: (e && e.code) || "ERROR" }; }
}

// One bounded line from the samples. `name(pid)` maps a PID to e1/g1/server/other (no raw ids are printed).
// samples: [{ t, owners: { sockets } | { error }, alive: { [enginePid]: bool } }]; exits: { [enginePid]: exitTimeMs }.
function describePortRelease({ t0, samples = [], exits = {}, name = () => "other", label = "preferred port" } = {}) {
  const rel = (t) => (Number.isFinite(t) && Number.isFinite(t0) ? Math.round(t - t0) : "?");
  const sig = (s) => {
    if (!s.owners || s.owners.error) return `unreadable ${s.owners ? String(s.owners.error).replace(/[^A-Z_]/g, "") : ""}`.trim();
    const listen = s.owners.sockets.filter((x) => x.state === "LISTEN" || x.state === "LISTENING");
    const others = {}; for (const x of s.owners.sockets) if (!(x.state === "LISTEN" || x.state === "LISTENING")) others[x.state] = (others[x.state] || 0) + 1;
    const l = listen.length ? `LISTEN by ${[...new Set(listen.flatMap((x) => (x.pids.length ? x.pids.map(name) : ["unknown owner"])))].join("+")}` : "not listening";
    const o = Object.entries(others).map(([k, v]) => `${String(k).replace(/[^A-Z_0-9]/g, "")} ${v}`).join(" ");
    return o ? `${l}, ${o}` : l;
  };
  // Changes only (bounded): the port's state over time.
  const changes = []; let prev = null;
  for (const s of samples) { const v = sig(s); if (v !== prev) { changes.push(`${rel(s.t)}: ${v}`); prev = v; } if (changes.length >= 16) break; }
  // Each engine whose exit was recorded: was its PID still alive afterwards, and until when?
  const after = Object.entries(exits).map(([pid, at]) => {
    const seenAlive = samples.filter((s) => s.t >= at && s.alive && s.alive[pid] === true);
    return `${name(Number(pid))} exit recorded ${rel(at)}: ${seenAlive.length ? `PID still alive in ${seenAlive.length} later sample(s), last ${rel(seenAlive[seenAlive.length - 1].t)}` : "PID not seen alive afterwards"}`;
  });
  return `${label}: ${changes.join("; ") || "no samples"}; ${after.length ? after.join("; ") : "no engine exits recorded"}`.slice(0, 2400);
}

module.exports = { portOwners, parseProcNet, parseNetstat, parseLsof, describePortRelease };
