"use strict";
// #181 diagnostics for the native validators (message only, never judged). Each studio server a validator starts gets
// the test-only preload scripts/tests/api-contract/resources-timing-preload.cjs, which writes the server's own times
// for every GET /api/resources (connection accepted, request received, handler entry = scheduler.snapshot() start,
// snapshot done, res.end, finish, socket close) and its event-loop gaps and delay to a per-server file in the logs
// folder. When one of the validator's own /api/resources requests fails or takes >= SLOW_MS, the validator prints one
// bounded line describing what the server recorded for it; when the server is stopped, it prints the same for any
// recorded request that was slow or never answered. Numbers and fixed words only. The validators' requests, client
// timeouts and verdicts are unchanged: no retry, no longer timeout, and a missing record is said as missing.
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
  return `${steps}; status ${Number.isFinite(r.status) ? r.status : "none"}; bytes written ${Number.isFinite(r.bytesWritten) ? r.bytesWritten : "?"}; ${loop}`;
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
      return { ...env, USAP_TEST_RESOURCES_TIMING: file, NODE_OPTIONS: `${base} --require "${PRELOAD.replace(/\\/g, "/")}"`.trim() };
    },
    // After one of the validator's own GET /api/resources: prints only if it failed or was slow.
    note(sentAt, status, endedAt = Date.now()) {
      if (status === 200 && endedAt - sentAt < SLOW_MS) return;
      print(`#181 /api/resources timing (${status === 200 ? `HTTP 200 after ${endedAt - sentAt} ms` : `status ${Number.isFinite(status) ? status : "none"} after ${endedAt - sentAt} ms`}): ${safe(() => describeRequest(readRecords(file), sentAt, endedAt)).slice(0, 2400)}`);
    },
    // After the server has exited (every record flushed).
    stopped(label) {
      if (!file) return;
      const s = safe(() => describeSlow(readRecords(file)));
      if (s) print(`#181 /api/resources timing at stop of ${String(label).replace(/[^A-Za-z0-9_-]/g, "")}: ${s}`);
    },
  };
}

module.exports = { createResourcesTiming, describeRequest, describeSlow, readRecords, SLOW_MS, PRELOAD };
