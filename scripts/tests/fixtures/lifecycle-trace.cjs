// #170 diagnostics for the engine-slot tests R1b and R5 (test-only, messages only, never judged). Windows CI failed
// R1b once with the stand-in's "listen EADDRINUSE" on the preferred port right after the studio's port check had
// found it free, and R5 once with no tracked image engine 800 ms after a 200 load. On Windows an image engine is four
// processes: studio -> engine guard (node) -> launcher (sd-cpu.exe, the supervisor's engine pid) -> stand-in (node,
// the socket owner, in a kill-on-close Job Object). This module records, without extra requests to the server:
//   - the port trace written by fixtures/port-trace-preload.cjs (studio port checks, stand-in binds, with pid/ppid);
//   - the stand-in's own records (fake-sd-diag.jsonl: start, listening, listen-error with its port-holder reading);
//   - from each /api/diagnostics answer the existing sampler already fetches: the image guard/engine records and the
//     recent exits, and the liveness (signal 0) of every guard, launcher and stand-in seen so far;
//   - marks the test sets (load answered, ready).
// describe() prints one bounded line: process ids become roles (studio, test, g1.. engine guards, e1.. the process
// the supervisor reports as the engine (on Windows the launcher), s1.. a stand-in Node process that is not that
// process (Windows; on Linux/macOS the stand-in IS the engine process and keeps its e name), other), ports become
// "preferred"/"backup+k", paths and addresses are never printed. It decides nothing; the tests' assertions and timings are unchanged.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const PRELOAD = path.join(__dirname, "port-trace-preload.cjs");
const MAX_EVENTS = 80;

// Env for startServer(): the preload in every Node process of that server (forward slashes: NODE_OPTIONS treats a
// backslash inside quotes as an escape).
function portTraceEnv(traceFile) {
  const req = `--require "${PRELOAD.replace(/\\/g, "/")}"`;
  return { NODE_OPTIONS: [process.env.NODE_OPTIONS, req].filter(Boolean).join(" "), USAP_TEST_PORT_TRACE: traceFile };
}

const readJsonl = (f) => { try { return fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return []; } };
const aliveDefault = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; } };

// Parse the stand-in's port-holder text (Windows `netstat -ano -p TCP` lines or macOS `lsof -nP -iTCP:<port>`) into
// [{ state, pid, side }]; side: "local" when the port is the line's local address, "remote" otherwise.
function parseHolders(text, port) {
  const out = [];
  const s = String(text || "");
  if (/^unavailable/.test(s)) return { unavailable: s.replace(/[^A-Za-z :-]/g, "").slice(0, 40), rows: out };
  for (const line of s.split(/\r?\n/)) {
    let m = /^\s*TCP\s+(\S+)\s+(\S+)\s+([A-Z_]+)\s+(\d+)\s*$/.exec(line);
    if (m) { out.push({ state: m[3], pid: Number(m[4]), side: m[1].endsWith(`:${port}`) ? "local" : "remote" }); continue; }
    m = /^\S+\s+(\d+)\s+.*TCP\s+(\S+?)(?:->(\S+))?\s+\(([A-Z_]+)\)\s*$/.exec(line);
    if (m) out.push({ state: m[4], pid: Number(m[1]), side: m[2].endsWith(`:${port}`) ? "local" : "remote" });
    if (out.length >= 12) break;
  }
  return { rows: out };
}

function createLifecycleTrace({ traceFile, standInDiagFile, now = Date.now, alive = aliveDefault } = {}) {
  const t0 = now();
  const st = { t0, traceFile, standInDiagFile, marks: [], seen: new Map(), dead: new Map(), sup: new Map(), exits: [], lastSup: null, samples: 0, alive };
  const note = (pid, kind) => { if (pid && !st.seen.has(pid)) st.seen.set(pid, { kind, at: now() }); };
  // Called with each /api/diagnostics answer the test already fetched.
  st.onDiagnostics = (d) => {
    try {
      const p = (d && d.engines && d.engines.processes) || {};
      const sup = (p.supervised || []).filter((r) => r.label === "image");
      const at = now();
      st.samples += 1;
      st.lastSup = sup.map((r) => ({ guardPid: r.guardPid, enginePid: r.enginePid }));
      for (const r of sup) {
        note(r.guardPid, "guard"); note(r.enginePid, "engine");
        const k = r.guardPid;
        if (!st.sup.has(k)) st.sup.set(k, { firstAt: at, lastAt: at, enginePid: r.enginePid });
        else { const e = st.sup.get(k); e.lastAt = at; if (r.enginePid) e.enginePid = r.enginePid; }
      }
      for (const x of (p.recentExits || []).filter((r) => r.label === "image")) {
        const xa = Date.parse(x.at);
        if (!st.exits.some((y) => y.at === xa && y.enginePid === x.enginePid)) st.exits.push({ enginePid: x.enginePid, code: x.code, signal: x.signal, at: xa, seenAt: at });
      }
      for (const r of readJsonl(st.standInDiagFile)) if (r.e === "start" && r.t >= st.t0) note(r.pid, "stand-in"); // this test's only
      for (const [pid] of st.seen) if (!st.dead.has(pid) && !st.alive(pid)) st.dead.set(pid, at);
    } catch (_) { /* messages only */ }
  };
  st.mark = (what) => { if (st.marks.length < 20) st.marks.push({ what: String(what).slice(0, 40), at: now() }); };
  return st;
}

// Process roles in order of first appearance: exact spawn records first (preload), then guards and engines from the
// supervisor, stand-ins from their own records. Shared with fixtures/r1b-port-record.cjs.
function roleMap(st, srv, steps, standIn, testPid = process.pid) {
  const roles = new Map([[srv && srv.proc && srv.proc.pid, "studio"], [testPid, "test"]]);
  const counters = { g: 0, l: 0, e: 0, s: 0 };
  const name = (prefix, pid) => { if (!pid) return "none"; if (!roles.has(pid)) { counters[prefix] += 1; roles.set(pid, `${prefix}${counters[prefix]}`); } return roles.get(pid); };
  // Fix roles in order of first appearance: exact spawn records first (preload), then guards and engines from the
  // supervisor, stand-ins from their own records.
  for (const r of steps) if (r.ev === "spawned") name(r.what === "guard" ? "g" : "e", r.child);
  for (const r of steps) if (r.ev === "process-start" && r.kind === "stand-in" && !roles.has(r.pid)) name("s", r.pid);
  const firsts = [...st.seen.entries()].sort((a, b) => a[1].at - b[1].at);
  for (const [pid, v] of firsts) if (v.kind === "guard") name("g", pid); else if (v.kind === "engine") name("e", pid);
  for (const r of standIn) if (r.e === "start" && !roles.has(r.pid)) name("s", r.pid);
  return roles;
}
function rolesFor(st, srv, { testPid = process.pid } = {}) {
  const all = readJsonl(st.traceFile);
  const steps = all.filter((r) => !["listen-attempt", "listening", "listen-error", "closed"].includes(r.ev)).sort((a, b) => a.t - b.t);
  const standIn = readJsonl(st.standInDiagFile).filter((r) => Number.isFinite(r.t) && r.t >= st.t0);
  return roleMap(st, srv, steps, standIn, testPid);
}

// One bounded line. srv: { proc: { pid }, sdPort }.
function describeLifecycle(st, srv, { testPid = process.pid } = {}) {
  const rel = (t) => (Number.isFinite(t) ? Math.round(t - st.t0) : "?");
  const all = readJsonl(st.traceFile);
  const BIND = new Set(["listen-attempt", "listening", "listen-error", "closed"]);
  const trace = all.filter((r) => BIND.has(r.ev));
  const steps = all.filter((r) => !BIND.has(r.ev)).sort((a, b) => a.t - b.t);
  const standIn = readJsonl(st.standInDiagFile).filter((r) => Number.isFinite(r.t) && r.t >= st.t0);
  const roles = roleMap(st, srv, steps, standIn, testPid);
  const who = (pid) => (pid && roles.has(pid) ? roles.get(pid) : pid ? "other" : "none");
  const portName = (p) => (p === (srv && srv.sdPort) ? "preferred" : p >= 28088 && p <= 28120 ? `backup+${p - 28088}` : "other");
  const ev = [];
  for (const m of st.marks) ev.push([m.at, `mark ${m.what.replace(/[^A-Za-z0-9 _.-]/g, "")}`]);
  // One event per bind (attempt + result); a studio port check (bind, then close at once) is "check free/busy".
  const binds = new Map();
  for (const r of trace) { const k = `${r.pid}:${r.id}`; if (!binds.has(k)) binds.set(k, { pid: r.pid, ppid: r.ppid, port: r.port }); const b = binds.get(k); b[r.ev] = r; }
  const traced = new Set();
  for (const b of binds.values()) {
    const w = who(b.pid), port = b.port === "preferred" || /^backup\+\d+$/.test(b.port) ? b.port : "other";
    const t = (b["listen-attempt"] || b.listening || b["listen-error"] || b.closed || {}).t;
    const res = b["listen-error"] ? `busy ${String(b["listen-error"].code).replace(/[^A-Z]/g, "")}` : b.listening ? "free" : "no result";
    if (w === "studio") { ev.push([t, `studio check ${port} ${res}`]); continue; }
    traced.add(b.pid);
    ev.push([t, `${w} bind ${port} ${res === "free" ? "ok" : res}${w === "other" ? ` (parent ${who(b.ppid)})` : ""}`]);
    if (b.closed) ev.push([b.closed.t, `${w} closed ${port}`]);
  }
  for (const r of steps) {
    if (r.ev === "spawned") ev.push([r.t, `${who(r.pid)} spawned ${r.what} ${who(r.child)}`]);
    else if (r.ev === "process-start" && r.kind !== "other") ev.push([r.t, `${who(r.pid)} process started (${r.kind})`]);
    else if (r.ev === "process-exit" && r.kind !== "other") ev.push([r.t, `${who(r.pid)} process exited ${Number.isInteger(r.code) ? r.code : "?"} (${r.kind})`]);
    else if (r.ev === "answer") ev.push([r.t, `studio wrote restart-backend answer ${Number(r.status) || "?"}`]);
  }
  for (const r of standIn) {
    if (r.e === "start") ev.push([r.t, `${who(r.pid)} start (parent ${who(r.ppid)}) port ${portName(r.port)}`]);
    else if (r.e === "listening") { if (!traced.has(r.pid)) ev.push([r.t, `${who(r.pid)} listening (own record)`]); }
    else if (r.e === "listen-error") {
      const h = parseHolders(r.holders, r.port);
      const hs = h.unavailable ? `holders ${h.unavailable}` : `holders ${h.rows.map((x) => `${x.state} ${x.side} ${who(x.pid)}`).join(", ") || "none"}`;
      ev.push([r.t, `${who(r.pid)} listen-error ${String(r.code || "").replace(/[^A-Z]/g, "")} ${portName(r.port)}; ${hs}`]);
    } else if (r.e === "exit") ev.push([r.t, `${who(r.pid)} exit ${Number.isInteger(r.code) ? r.code : "?"}`]);
  }
  for (const [g, v] of st.sup) ev.push([v.firstAt, `supervisor tracks ${who(g)} engine ${who(v.enginePid)}`], [v.lastAt, `supervisor last tracked ${who(g)}`]);
  for (const x of st.exits) ev.push([x.at, `supervisor exit recorded engine ${who(x.enginePid)} code ${x.code === null ? "null" : x.code} signal ${x.signal || "none"}`]);
  for (const [pid, at] of st.dead) ev.push([at, `${who(pid)} gone (first seen not alive)`]);
  ev.sort((a, b) => a[0] - b[0]);
  // Consecutive identical events (the studio checks its port about every 50 ms) are folded: "text xN (from..to)".
  const folded = [];
  for (const [t, s] of ev) { const last = folded[folded.length - 1]; if (last && last.s === s) { last.n += 1; last.to = t; } else folded.push({ t, s, n: 1, to: t }); }
  const shown = folded.slice(0, MAX_EVENTS).map((e) => (e.n > 1 ? `${rel(e.t)}..${rel(e.to)} ${e.s} x${e.n}` : `${rel(e.t)} ${e.s}`));
  // Causal summary: the first loss event after the last restart-backend answer the studio wrote (or after the start).
  const lastAnswer = [...ev].reverse().find(([, x]) => /^studio wrote restart-backend answer/.test(x));
  const LOSS = /(bind \S+ busy|listen-error|process exited|exit recorded|gone \(first seen not alive\))/;
  const loss = ev.find(([t, x]) => (!lastAnswer || t >= lastAnswer[0]) && !/^studio /.test(x) && LOSS.test(x));
  const cause = `after the last restart-backend answer${lastAnswer ? ` (${rel(lastAnswer[0])})` : " (none written)"}: ${loss ? `first loss ${rel(loss[0])} ${loss[1]}` : "no loss event"}`;
  const fin = (st.lastSup || []).map((r) => `${who(r.guardPid)}/${who(r.enginePid)}`).join(" ") || "none";
  const line = `${cause}; roles: studio, ${[...new Set([...roles.values()].filter((v) => !["studio", "test"].includes(v)))].join(" ") || "no engines"}; samples ${st.samples}; last image records ${fin}; events ${shown.join("; ")}${folded.length > MAX_EVENTS ? `; +${folded.length - MAX_EVENTS} more` : ""}`;
  return line.slice(0, 3500);
}

module.exports = { portTraceEnv, createLifecycleTrace, describeLifecycle, parseHolders, rolesFor, readJsonl, PRELOAD };
