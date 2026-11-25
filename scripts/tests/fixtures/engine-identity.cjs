// #170 engine identity diagnostics (test-only, messages only, never judged). Windows CI once failed
// engine-supervision.test.cjs "an engine crash after loading is detected and restarted" with "a new engine process":
// after the fake engine was hard-killed, the studio reported a crash, a restart and ready, yet the engine port still
// answered /fake/stats with the old PID (8436). A PID alone cannot tell these apart:
//   surviving old child   the killed process (same PID AND same creation time / instance) still answers;
//   PID reuse             a NEW process (new instance, later creation time) got the same PID (Windows reuses freed
//                         PIDs quickly; the assertion compares PIDs only);
//   wrong listener        the process answering is not the one that owns the listening socket (a relay, or the
//                         owner lookup disagrees with the answer);
//   wrong-generation readiness  the studio published ready for a new engine generation while the old one answered;
//   test-fixture error    the answer has no identity to compare (a fake without instance ids) or no answer.
// Identity is (PID, process creation time from the OS) plus the fake's own random instance id per start. The chain the
// studio exposes is guardPid -> enginePid (the C# launcher on Windows, the fake itself elsewhere) -> the fake's ppid/pid.
// Every lookup is bounded (5 s per OS command, one command per snapshot on Windows); output is numbers, hex ids,
// process image names and fixed words only.
"use strict";
const fs = require("node:fs");
const http = require("node:http");
const { execFile } = require("node:child_process");

const run = (cmd, args, ms = 5000) => new Promise((resolve) => {
  try { execFile(cmd, args, { timeout: ms, windowsHide: true, maxBuffer: 1 << 20 }, (e, out) => resolve(out ? String(out) : e ? null : "")); }
  catch (_) { resolve(null); }
});
const clean = (s, n = 40) => String(s == null ? "" : s).replace(/[^A-Za-z0-9_.+-]/g, "").slice(0, n);

function getJson(port, urlPath, ms = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: urlPath, timeout: ms }, (res) => {
      let text = ""; res.on("data", (c) => { if (text.length < 65536) text += c; });
      res.on("end", () => { try { resolve(JSON.parse(text)); } catch (_) { resolve(null); } });
    });
    req.on("timeout", () => req.destroy()); req.on("error", () => resolve(null));
  });
}
const engineStats = async (port) => {
  const s = await getJson(port, "/fake/stats");
  return s && Number.isInteger(s.pid) ? { pid: s.pid, instance: s.instance ? clean(s.instance, 24) : null, startedAt: Number.isFinite(s.startedAt) ? s.startedAt : null, ppid: Number.isInteger(s.ppid) ? s.ppid : null, requests: s.requests } : null;
};
function alive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }

// Linux: /proc start time (clock ticks since boot) -> wall ms (+-10 ms at 100 Hz)
function linuxProc(pid) {
  try {
    const st = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); const r = st.slice(st.lastIndexOf(")") + 2).split(" ");
    const up = Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    const name = st.slice(st.indexOf("(") + 1, st.lastIndexOf(")"));
    return { pid, ppid: Number(r[1]), startedAt: Math.round(Date.now() - (up - Number(r[19]) / 100) * 1000), name: clean(name), resMs: 10 };
  } catch (_) { return { pid, gone: true }; }
}
function linuxListeners(port) {
  const inodes = new Set();
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try { for (const l of fs.readFileSync(f, "utf8").split("\n").slice(1)) { const c = l.trim().split(/\s+/); if (c.length > 9 && c[3] === "0A" && parseInt(c[1].split(":").pop(), 16) === port) inodes.add(c[9]); } } catch (_) { /* none */ }
  }
  const pids = new Set();
  if (inodes.size) {
    let n = 0;
    for (const d of fs.readdirSync("/proc").filter((x) => /^\d+$/.test(x))) {
      if (++n > 4000) break;
      try { for (const fd of fs.readdirSync(`/proc/${d}/fd`)) { const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${d}/fd/${fd}`)); if (m && inodes.has(m[1])) pids.add(Number(d)); } } catch (_) { /* not ours */ }
    }
  }
  return { pids: [...pids], sockets: inodes.size };
}

/** { owners: [{pid, ppid, startedAt, name}], procs: {pid: {...}}, lookup } for the listener on `port` and `pids`. */
async function osView(port, pids, platform = process.platform) {
  const want = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))].slice(0, 12);
  if (platform === "win32") {
    const ps = `$o=@(Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess });` +
      `$all=@($o)+@(${want.join(",") || "0"}) | Sort-Object -Unique;` +
      `foreach($i in $all){ if($i -le 0){continue}; $p=Get-CimInstance Win32_Process -Filter "ProcessId=$i"; $own= if($o -contains $i){'L'}else{'-'};` +
      `if($p){ "$own $i $($p.ParentProcessId) $($p.CreationDate.ToUniversalTime().ToString('o')) $($p.Name)" } else { "$own $i gone" } }`;
    const out = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], 8000);
    if (out === null) return { owners: [], procs: {}, lookup: "unavailable" };
    const procs = {}, owners = [];
    for (const l of out.split(/\r?\n/).filter(Boolean)) {
      const f = l.trim().split(/\s+/); const pid = Number(f[1]);
      const info = f[2] === "gone" ? { pid, gone: true } : { pid, ppid: Number(f[2]) || null, startedAt: Date.parse(f[3]) || null, name: clean(f[4]), resMs: 16 };
      procs[pid] = info; if (f[0] === "L") owners.push(info);
    }
    return { owners, procs, lookup: "netstat+cim" };
  }
  if (platform === "linux") {
    const l = linuxListeners(port), procs = {};
    for (const p of new Set([...want, ...l.pids])) procs[p] = linuxProc(p);
    return { owners: l.pids.map((p) => procs[p]), procs, lookup: l.sockets ? "proc" : "proc (no listening socket)" };
  }
  const lo = await run("lsof", ["-nP", `-iTCP:${Number(port)}`, "-sTCP:LISTEN", "-t"]);
  const ownerPids = lo === null ? [] : lo.split(/\s+/).filter(Boolean).map(Number);
  const procs = {};
  for (const p of new Set([...want, ...ownerPids])) {
    const o = await run("ps", ["-o", "ppid=,lstart=,comm=", "-p", String(p)]);
    const m = o && /^\s*(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/.exec(o.trim());
    procs[p] = m ? { pid: p, ppid: Number(m[1]), startedAt: Date.parse(m[2]) || null, name: clean(m[3].split("/").pop()), resMs: 1000 } : { pid: p, gone: true };
  }
  return { owners: ownerPids.map((p) => procs[p]), procs, lookup: lo === null ? "unavailable" : "lsof" };
}

/**
 * One snapshot: the engine's own answer, the studio's view (status + supervised records + recent exits), and the OS
 * view (listener owners, creation identity of every PID in the chain). studio: async () => ({ status, diagnostics })
 */
async function snapshot({ label, enginePort, studio = null, extraPids = [], platform = process.platform }) {
  const at = Date.now();
  const stats = await engineStats(enginePort);
  let st = null, sup = [], exits = [];
  if (studio) {
    try {
      const v = await studio();
      st = v.status ? { state: v.status.engine && v.status.engine.state, ready: Boolean(v.status.ready), port: v.status.port, restarts: v.status.engine && v.status.engine.restartsInWindow } : null;
      const pr = v.diagnostics && v.diagnostics.engines && v.diagnostics.engines.processes;
      sup = ((pr && pr.supervised) || []).filter((r) => r.label === "llm").map((r) => ({ guardPid: r.guardPid, enginePid: r.enginePid, startedAt: Date.parse(r.startedAt) || null }));
      exits = ((pr && pr.recentExits) || []).filter((r) => r.label === "llm").slice(-3).map((r) => ({ enginePid: r.enginePid, code: r.code, signal: clean(r.signal, 12) || null, at: Date.parse(r.at) || null }));
    } catch (_) { st = null; }
  }
  const pids = [stats && stats.pid, stats && stats.ppid, ...sup.flatMap((r) => [r.guardPid, r.enginePid]), ...exits.map((r) => r.enginePid), ...extraPids];
  const os = await osView(enginePort, pids, platform);
  return { label, at, stats, studio: st, supervised: sup, exits, ...os };
}

/** Polls the engine's identity and the studio's state every intervalMs until stop(); keeps transitions only (<= 60). */
function startSampler({ enginePort, status = null, intervalMs = 100, t0 = Date.now() }) {
  const out = []; let last = "", stopped = false;
  const loop = (async () => {
    while (!stopped && out.length < 60) {
      const [s, st] = await Promise.all([engineStats(enginePort), status ? status().catch(() => null) : null]);
      const key = `${s ? `${s.instance || "?"}/${s.pid}` : "no answer"} ${st ? `${(st.engine && st.engine.state) || "?"}${st.ready ? " ready" : ""}` : ""}`.trim();
      if (key !== last) { out.push(`${Date.now() - t0} ${key}`); last = key; }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  })();
  return { stop: async () => { stopped = true; await loop; return out; } };
}

const sameProc = (a, b) => a && b && !a.gone && !b.gone && a.startedAt && b.startedAt && Math.abs(a.startedAt - b.startedAt) <= Math.max(a.resMs || 0, b.resMs || 0, 1) * 2;

/**
 * Reading for "the port still answers with the old PID". before/after: snapshot(); kill: { pid, status, aliveAfter, at }.
 * -> { verdict, line } (line <= 1500 characters)
 */
function readEngineIdentity({ before, after, kill = null, samples = [], t0 = before ? before.at : Date.now() }) {
  const rel = (w) => (Number.isFinite(w) ? Math.round(w - t0) : "?");
  const b = before && before.stats, a = after && after.stats;
  const proc = (snap, pid) => (snap && snap.procs && snap.procs[pid]) || null;
  const who = (snap, p) => { const i = proc(snap, p); return i ? (i.gone ? `${p} gone` : `${p} ${i.name || "?"} created ${rel(i.startedAt)}${i.ppid ? ` parent ${i.ppid}` : ""}`) : `${p} ?`; };
  const chain = (snap) => (snap && snap.supervised.length ? snap.supervised.map((r) => `guard ${who(snap, r.guardPid)} -> engine ${r.enginePid ? who(snap, r.enginePid) : "not reported"} (record ${rel(r.startedAt)})`).join(" | ") : "no supervised llm record");
  const owners = (snap) => (snap ? `${snap.lookup}: ${snap.owners.map((o) => who(snap, o.pid)).join(", ") || "no owner"}` : "?");
  let verdict;
  if (!a) verdict = "no engine answer after the restart (test-fixture or engine down)";
  else if (!b) verdict = "no identity before the kill (test-fixture)";
  else if (!a.instance || !b.instance) verdict = "identity unavailable: the fake reported no instance id (test-fixture)";
  else if (after.lookup !== "unavailable" && after.owners.length && !after.owners.some((o) => o.pid === a.pid)) verdict = `wrong listener: the answer came from pid ${a.pid} but the listening socket is owned by ${after.owners.map((o) => o.pid).join("/")}`;
  else if (a.instance === b.instance) {
    const stillSame = sameProc(proc(before, b.pid), proc(after, a.pid));
    verdict = kill && kill.aliveAfter ? `surviving old child: the killed process (same instance${stillSame ? ", same creation time" : ""}) was alive right after the kill (kill status ${kill.status}) and still answers`
      : `old instance still answering although the kill reported pid ${b.pid} gone (kill status ${kill ? kill.status : "?"}; unexplained)`;
    const newGen = after.supervised.find((r) => !before.supervised.some((x) => x.guardPid === r.guardPid));
    if (after.studio && after.studio.ready && newGen) verdict += `; wrong-generation readiness: the studio reports ready for a new generation (guard ${newGen.guardPid}) while the old instance answers`;
  } else if (a.pid === b.pid) {
    const p = proc(after, a.pid), parent = after.supervised.find((r) => r.enginePid === a.ppid || r.enginePid === a.pid);
    verdict = `PID reuse: a new process (instance ${a.instance}, started ${rel(a.startedAt)}${kill ? `, ${Math.round(a.startedAt - kill.at)} ms after the kill` : ""}${p && !p.gone ? `, OS creation ${rel(p.startedAt)}` : ""}) got the old pid ${a.pid}${parent ? ", child of the studio's current engine record" : ", NOT under the studio's current engine record"}`;
  } else verdict = "new process";
  const parts = [
    `before: answer ${b ? `pid ${b.pid} instance ${b.instance} started ${rel(b.startedAt)} parent ${b.ppid}` : "none"}; chain ${chain(before)}; listener ${owners(before)}`,
    kill ? `kill ${kill.pid} at ${rel(kill.at)}: status ${kill.status}, alive right after ${kill.aliveAfter}` : "kill not recorded",
    `after: studio ${after && after.studio ? `${after.studio.state}${after.studio.ready ? " ready" : ""} restarts ${after.studio.restarts}` : "?"}; answer ${a ? `pid ${a.pid} instance ${a.instance} started ${rel(a.startedAt)} parent ${a.ppid}` : "none"}; chain ${chain(after)}; listener ${owners(after)}; old pid now ${b ? who(after, b.pid) : "?"}`,
    `exits ${after && after.exits.length ? after.exits.map((e) => `${e.enginePid} ${e.code ?? e.signal} ${rel(e.at)}`).join(", ") : "none"}`,
    `samples ${samples.slice(0, 20).join(", ") || "none"}`,
  ];
  return { verdict, line: `${verdict}. ${parts.join("; ")}`.slice(0, 1500) };
}

module.exports = { engineStats, osView, snapshot, startSampler, readEngineIdentity, alive, sameProc };
