"use strict";
// #181 diagnostics for the native validators (message only, never judged). Each studio server a validator starts gets
// the test-only preload scripts/tests/api-contract/resources-timing-preload.cjs, which writes the server's own times
// for every GET /api/resources (connection accepted, request received, handler entry = scheduler.snapshot() start,
// snapshot done, res.end, finish, socket close) and its event-loop gaps and delay to a per-server file in the logs
// folder. When one of the validator's own /api/resources requests gets no answer or takes >= SLOW_MS, the validator prints one
// bounded line describing what the server recorded for it; when the server is stopped, it prints the same for any
// recorded request that was slow or never answered. Numbers and fixed words only. The validators' requests, client
// timeouts and verdicts are unchanged: no retry, no longer timeout, and a missing record is said as missing.
// GPU-probe measurement (#181, opt-in USAP_TEST_GPU_PROBE_TIMING=1, set for these validators' test servers only): the
// records also carry the time spent in each scheduler input during a request (parts), the GPU-memory calls (probe) and
// the synchronous child processes started inside it (program names only); at each server stop one line gives the first
// snapshot's time and its parts, the first GPU-memory call and the synchronous child processes of the GPU code.
const fs = require("fs");
const path = require("path");

const SLOW_MS = 2000;
const LOOP_GAP_MS = 1000; // a gap this long in the server's own timer around a request is reported at stop
const MAX_ITEMS = 6;
const PRELOAD = path.join(__dirname, "..", "tests", "api-contract", "resources-timing-preload.cjs");
const n = (v) => (Number.isFinite(v) ? Math.round(v) : null);

function readRecords(file) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter((r) => r && typeof r === "object");
  } catch (_) { return null; }
}

// One recorded request, times relative to `from` (the client's send time, or the record's own accept time).
function describeRecord(r, from) {
  const rel = (t) => (Number.isFinite(t) && Number.isFinite(from) ? `${n(t - from)}` : "?");
  const steps = [["accepted", r.acceptAt], ["received", r.receivedAt], ["handler", r.handlerAt], ["snapshot done", r.snapshotDoneAt], ["end", r.endAt], ["finish", r.finishAt], ["closed", r.closeAt]]
    .map(([k, t]) => `${k} ${Number.isFinite(t) ? rel(t) : "none"}`).join(", ");
  const loop = r.loop && typeof r.loop === "object"
    ? `loop gaps ${Array.isArray(r.loop.gaps) && r.loop.gaps.length ? r.loop.gaps.slice(-MAX_ITEMS).map((g) => `${rel(g && g[0])}+${n(g && g[1])}`).join(",") : "none"}; delay p99 ${n(r.loop.delayP99Ms)} ms max ${n(r.loop.delayMaxMs)} ms`
    : "loop not recorded";
  return `${steps}; status ${Number.isFinite(r.status) ? r.status : "none"}; bytes written ${Number.isFinite(r.bytesWritten) ? r.bytesWritten : "?"}; ${loop}${probeParts(r, from)}`;
}
const word = (v) => String(v ?? "?").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 32) || "?";
// The GPU-probe fields of one record, when present: parts (name ms), GPU-memory calls and child processes.
function probeParts(r, from) {
  const rel = (t) => (Number.isFinite(t) && Number.isFinite(from) ? n(t - from) : "?");
  const out = [];
  if (Array.isArray(r.parts)) out.push(`snapshot parts ${r.parts.length ? r.parts.slice(0, MAX_ITEMS).map((p) => `${word(p && p[0])} ${n(p && p[1])}`).join(", ") : "all < 1 ms"}`);
  if (Array.isArray(r.probe) && r.probe.length) out.push(`GPU-memory calls ${r.probe.slice(0, 4).map((p) => `${word(p.fn)} ${rel(p.entryAt)}..${rel(p.exitAt)}`).join(", ")}`);
  if (Array.isArray(r.children) && r.children.length) out.push(`sync child processes ${r.children.slice(0, MAX_ITEMS).map((c) => `${word(c.cmd)} ${n(c.ms)} ms code ${word(c.code)}${c.gpuInfo ? " (GPU code)" : ""}`).join(", ")}`);
  return out.length ? `; ${out.join("; ")}` : "";
}

// At server stop, with the GPU-probe measurement on: the first recorded /api/resources (handler to snapshot done, and
// its parts), the first call of each GPU-memory input and the GPU code's synchronous child processes. null when off.
function describeProbe(records) {
  if (!Array.isArray(records)) return null;
  const probes = records.filter((r) => r.e === "gpu-probe");
  const kids = records.filter((r) => r.e === "sync-child" && r.gpuInfo);
  const reqs = records.filter((r) => r.e === "resources" && Array.isArray(r.parts)).sort((a, b) => a.receivedAt - b.receivedAt);
  if (!probes.length && !reqs.length) return null;
  const first = reqs[0];
  const parts = [first ? `first /api/resources: snapshot ${Number.isFinite(first.snapshotDoneAt) && Number.isFinite(first.handlerAt) ? n(first.snapshotDoneAt - first.handlerAt) : "?"} ms${probeParts(first, first.handlerAt)}` : "no /api/resources record"];
  parts.push(`GPU-memory first calls ${probes.length ? probes.slice(0, 4).map((p) => `${word(p.fn)} ${n(p.ms)} ms${p.inResources ? " inside /api/resources" : " elsewhere"}`).join(", ") : "none"}`);
  parts.push(`GPU code sync child processes ${kids.length ? kids.slice(0, MAX_ITEMS).map((c) => `${word(c.cmd)} ${n(c.ms)} ms code ${word(c.code)}${c.inResources ? " inside /api/resources" : " elsewhere"}`).join(", ") : "none"}`);
  const later = reqs.slice(1).map((r) => (Number.isFinite(r.snapshotDoneAt) && Number.isFinite(r.handlerAt) ? r.snapshotDoneAt - r.handlerAt : null)).filter((v) => v !== null);
  parts.push(`later snapshots ${later.length ? `${later.length}, max ${n(Math.max(...later))} ms` : "none"}`);
  return parts.join("; ").slice(0, 2400);
}

// What the server recorded for one client request sent at `sentAt` that ended at `endedAt`.
function describeRequest(records, sentAt, endedAt) {
  if (records === null) return "timing file unreadable";
  if (!records.some((r) => r.e === "loaded")) return "instrumentation not loaded";
  const from = sentAt - 50, to = (Number.isFinite(endedAt) ? endedAt : Date.now()) + 50;
  const mine = records.filter((r) => r.e === "resources" && Number.isFinite(r.acceptAt ?? r.receivedAt) && (r.acceptAt ?? r.receivedAt) >= from && (r.acceptAt ?? r.receivedAt) <= to);
  const conns = records.filter((r) => r.e === "conn" && Number.isFinite(r.acceptAt) && r.acceptAt >= from && r.acceptAt <= to);
  const parts = [`times in ms from the client's send`];
  parts.push(mine.length ? mine.slice(0, 2).map((r) => describeRecord(r, sentAt)).join(" | ") : "no /api/resources record in the request's window yet (not received, or its socket not yet closed in the server)");
  parts.push(`connections closed without a request in the window ${conns.length}${conns.length ? ` (accepted ${conns.slice(0, MAX_ITEMS).map((c) => n(c.acceptAt - sentAt)).join(",")})` : ""}`);
  return parts.join("; ");
}

// At server stop: the recorded /api/resources requests that were slow (accept to finish >= SLOW_MS), never finished,
// or had a loop gap >= LOOP_GAP_MS in their window. "accepted" is when the server process handled the connection: a
// connection the kernel queued while the process was not running looks quick from inside, so the gap is what shows it.
function describeSlow(records) {
  if (records === null) return "timing file unreadable";
  if (!records.some((r) => r.e === "loaded")) return "instrumentation not loaded";
  const reqs = records.filter((r) => r.e === "resources");
  const gap = (r) => r.loop && Array.isArray(r.loop.gaps) && r.loop.gaps.some((g) => Array.isArray(g) && g[1] >= LOOP_GAP_MS);
  const slow = reqs.filter((r) => !Number.isFinite(r.finishAt) || (r.finishAt - (r.acceptAt ?? r.receivedAt)) >= SLOW_MS || gap(r));
  const conns = records.filter((r) => r.e === "conn").length;
  if (!slow.length) return null;
  return `${reqs.length} recorded, ${slow.length} slow, unanswered or with a loop gap >= ${LOOP_GAP_MS} ms (connections without a request ${conns}): ${slow.slice(0, MAX_ITEMS).map((r) => `[${describeRecord(r, r.acceptAt ?? r.receivedAt)}]`).join(" ")}`.slice(0, 2400);
}

// Per validator: the environment for each server and the two message points.
function createResourcesTiming(logDir, prefix, print = (s) => console.log(s)) {
  let file = null;
  const safe = (fn) => { try { return fn(); } catch (_) { return "description failed"; } };
  return {
    env(label, env = {}) {
      file = path.join(logDir, `${prefix}-${label}-resources-timing.jsonl`);
      try { fs.rmSync(file, { force: true }); } catch (_) { /* fresh file per server */ }
      const base = env.NODE_OPTIONS !== undefined ? env.NODE_OPTIONS : (process.env.NODE_OPTIONS || "");
      return { ...env, USAP_TEST_RESOURCES_TIMING: file, USAP_TEST_GPU_PROBE_TIMING: "1", NODE_OPTIONS: `${base} --require "${PRELOAD.replace(/\\/g, "/")}"`.trim() };
    },
    // After one of the validator's own GET /api/resources: prints only if no answer came (status 0 or none) or the
    // request took >= SLOW_MS. A prompt answer of any status is not #181's subject (with USAP_SCHEDULER=off the route
    // is left out and answers 404 at once, as before).
    note(sentAt, status, endedAt = Date.now()) {
      const answered = Number.isFinite(status) && status > 0;
      if (answered && endedAt - sentAt < SLOW_MS) return;
      print(`#181 /api/resources timing (${answered ? `HTTP ${status} after ${endedAt - sentAt} ms` : `no answer (status ${Number.isFinite(status) ? status : "none"}) after ${endedAt - sentAt} ms`}): ${safe(() => describeRequest(readRecords(file), sentAt, endedAt)).slice(0, 2400)}`);
    },
    // After the server has exited (every record flushed).
    stopped(label) {
      if (!file) return;
      const recs = readRecords(file);
      const s = safe(() => describeSlow(recs));
      if (s) print(`#181 /api/resources timing at stop of ${String(label).replace(/[^A-Za-z0-9_-]/g, "")}: ${s}`);
      const g = safe(() => describeProbe(recs));
      if (g) print(`#181 GPU probe at stop of ${String(label).replace(/[^A-Za-z0-9_-]/g, "")}: ${g}`);
    },
  };
}

module.exports = { createResourcesTiming, describeRequest, describeSlow, describeProbe, readRecords, SLOW_MS, PRELOAD };
