// #179 queue-on delivery diagnostics (test-only, message only, never judged): the image-queue test "server: on (with
// engineSlot) ..." once had one of its three queued generations end without an HTTP status (a client-side error) on
// Windows (#190 e147fe1). This describes, as one bounded, sanitized line, what happened to each request and around it.
// It never decides a verdict; the test prints it before its unchanged assertions.
//   results    the test's txt2img results ({ status, ms, json } or { error, ms }), in request order
//   o.tLoad    wall time when the engine was ready; request i was sent about i * o.sendGapMs later
//   o.samples  [{ t, running, waiting, req, done, ab, err }]: image queue counts (/api/resources) and the fake engine's
//              requests / completed / aborted (/fake/stats), every 250 ms from the test's first /api/resources call
//   o.diag     fake engine records (start, listening, listen-error, exit) for engine identity and lifecycle
//   o.log      the studio's log (only [backend], [sd-err], "not reachable" and [engine-slot] lines; paths, addresses and
//              process ids removed)
// Per-request errors, engine processes and backend lines come from rollback-diag's describeRollbackFailures.
"use strict";
const { describeRollbackFailures } = require("./rollback-diag.cjs");
const MAX_SAMPLES = 24;
const clean = (v) => String(v ?? "?").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "?";

function describeQueueOnDelivery(results, o = {}) {
  const t0 = o.tLoad, gap = Number.isFinite(o.sendGapMs) ? o.sendGapMs : 0;
  const rel = (t) => (Number.isFinite(t) && Number.isFinite(t0) ? Math.round(t - t0) : "?");
  const parts = [];
  // send and answer times relative to the engine being ready (sent ≈ i * gap; answered = sent + the request's ms)
  parts.push(`requests ${results.map((r, i) => `${i}: sent ~${i * gap}, ${r.status !== undefined ? `HTTP ${r.status}` : `client error ${clean(r.error)}`} at ~${Number.isFinite(r.ms) ? i * gap + r.ms : "?"}`).join("; ")}`);
  const s = Array.isArray(o.samples) ? o.samples.slice(0, MAX_SAMPLES) : [];
  parts.push(`queue/engine samples ${s.length ? s.map((x) => `${rel(x.t)}:${x.err ? "err" : `${x.running ?? "?"}r/${x.waiting ?? "?"}w`}${x.req != null ? ` e${x.req}/${x.done ?? "?"}/${x.ab ?? "?"}` : ""}`).join(" ") : "none"}`);
  parts.push(describeRollbackFailures(results, { t0, diag: o.diag, stats: null, log: o.log }).replace(/; engine stats: unavailable/, ""));
  const slot = String(o.log || "").split(/\r?\n/).filter((l) => /\[engine-slot\]/.test(l)).slice(-6)
    .map((l) => l.replace(/\b(process|pid)\s+\d+/gi, "$1 N").replace(/[A-Za-z]:\\[^\s]*|\/[^\s]*/g, " ").replace(/[^A-Za-z0-9 _.,:()-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 140));
  parts.push(`engine-slot lines ${slot.length ? slot.join(" | ") : "none"}`);
  return parts.join("; ").slice(0, 3000);
}

module.exports = { describeQueueOnDelivery };
