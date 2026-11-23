// #179 diagnostics (test-only, message only, never judged): the 700 ms observation in the image-queue test
// "server: on (with engineSlot) — one at a time, FIFO, ...". When /api/resources does not show the expected
// 1 running / 2 waiting, this describes, as one bounded, sanitized line for t.diagnostic(), what had happened by then:
// when each request was sent and answered, the queue and engine counts sampled during the 700 ms, and the engine
// process lifecycle. It decides no verdict and names no cause (the Windows 502 with the scheduler off is a separate
// observation; nothing here assumes the two are related).
//   o.t0       wall time just before the first request was scheduled (all times are relative to it)
//   o.sent     wall time at which each request was sent (index = request)
//   o.results  each request's txt2img result ({ status, ms, json, doneAt } or { error, ms, doneAt }); undefined if
//              it had not settled when the line was written
//   o.observedAt, o.rs   time and body of the 700 ms /api/resources read (rs null if it failed)
//   o.samples  [{ t, running, waiting, known, engineRequests, engineCompleted, engineAborted }] taken during the wait
//   o.diag     fake engine records (api-contract/fake-sd-server.cjs: start, listening, listen-error, exit, told-to-exit)
//   o.log      the studio server's log text (only "[backend]"/"[sd-err]"/"not reachable" lines, paths and addresses removed)
"use strict";
const { errorWords } = require("./rollback-diag.cjs");

const MAX_ITEMS = 8, MAX_SAMPLES = 12;
const num = (v) => (Number.isFinite(v) ? v : "?");
const code = (c) => String(c ?? "?").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "?";
const words = (t) => String(t || "").replace(/[A-Za-z]:\\[^\s]*|\/[^\s]*|\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, " ")
  .replace(/[^A-Za-z0-9 _.,:-]/g, " ").replace(/\s+/g, " ").trim();

function describeQueueOnObservation(o = {}) {
  const t0 = o.t0, rel = (t) => (t0 == null || !Number.isFinite(t) ? "?" : t - t0);
  const q = o.rs && o.rs.engines && o.rs.engines.image && o.rs.engines.image.queue;
  const parts = [q && typeof q === "object"
    ? `queue at ${rel(o.observedAt)} ms: running ${num(q.running)} waiting ${num(q.waiting)} limit ${num(q.limit)} known ${q.known === true} (expected running 1 waiting 2)`
    : `queue at ${rel(o.observedAt)} ms: /api/resources gave no engine queue`];
  const sent = Array.isArray(o.sent) ? o.sent : [];
  const results = Array.isArray(o.results) ? o.results : [];
  const n = Math.min(MAX_ITEMS, Math.max(sent.length, results.length));
  const reqs = [];
  let answeredBefore = 0;
  for (let i = 0; i < n; i++) {
    const r = results[i];
    let a;
    if (!r) a = "not settled";
    else {
      const done = Number.isFinite(r.doneAt) ? r.doneAt : null;
      if (done != null && Number.isFinite(o.observedAt) && done <= o.observedAt) answeredBefore += 1;
      const what = r.status === undefined ? `client error ${code(r.error)}` : `HTTP ${r.status}`;
      const err = r.status !== 200 && r.json && typeof r.json === "object" ? `; studio error words ${errorWords(r.json.error || r.json.detail)}${r.json.code ? ` code ${code(r.json.code)}` : ""}` : "";
      a = `${what} at ${rel(done)}${err}`;
    }
    reqs.push(`${i}: sent ${rel(sent[i])}, ${a}`);
  }
  parts.push(`requests ${reqs.join(" | ") || "none"}`);
  parts.push(`answered before the observation ${answeredBefore} of ${n}`);
  const samples = Array.isArray(o.samples) ? o.samples.slice(-MAX_SAMPLES) : [];
  parts.push(`samples (t: running|waiting, engine requests|completed|aborted) ${samples.length ? samples.map((s) => `${rel(s.t)}: ${num(s.running)}/${num(s.waiting)}${s.known === false ? " unknown" : ""}, ${num(s.engineRequests)}/${num(s.engineCompleted)}/${num(s.engineAborted)}`).join("; ") : "none"}`);
  const diag = Array.isArray(o.diag) ? o.diag : null;
  if (diag) {
    const kinds = ["start", "listening", "listen-error", "told-to-exit", "exit"];
    const pids = [...new Set(diag.filter((r) => r.e === "start").map((r) => r.pid))];
    const ev = (pid) => diag.filter((r) => r.pid === pid && kinds.includes(r.e))
      .map((r) => `${r.e}${(r.e === "exit" || r.e === "told-to-exit" || r.e === "listen-error") && r.code != null ? ` ${code(r.code)}` : ""}@${rel(r.t)}`).join(" ");
    parts.push(`engine processes ${pids.length}: ${pids.slice(-MAX_ITEMS).map((pid) => `[${ev(pid)}]`).join(" ") || "none"}`);
  } else parts.push("engine records: unavailable");
  const lines = String(o.log || "").split(/\r?\n/).filter((l) => /\[backend\]|\[sd-err\]|not reachable/.test(l)).slice(-MAX_ITEMS).map((l) => words(l).slice(0, 120));
  parts.push(`server backend lines ${lines.length ? lines.join(" | ") : "none"}`);
  return parts.join("; ").slice(0, 2400);
}

module.exports = { describeQueueOnObservation };
