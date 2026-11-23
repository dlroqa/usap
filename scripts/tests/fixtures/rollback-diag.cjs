// Image-queue rollback diagnostics (test-only, message only, never judged): describes the generations of the
// "USAP_SCHEDULER=off ... (rollback)" test that did not answer 200, as one bounded, sanitized line for t.diagnostic().
// It never decides a verdict: the test keeps its assertions and prints this line before them.
//   results  the test's txt2img results ({ status, ms, json } or { error, ms }), in request order
//   o.t0     wall time just before the requests were sent (times are printed relative to it)
//   o.diag   fake engine records (api-contract/fake-sd-server.cjs: start, listening, listen-error, exit)
//   o.stats  the fake engine's own /fake/stats ({ requests, completed, ... }) or null
//   o.log    the studio server's log text (only "[backend]" lines are used, paths and addresses removed)
// The studio answers 502 when its request to the engine fails ("Image backend is not reachable: <message>"); the line
// keeps only the error's code words from that message (for example ECONNRESET, socket hang up), never the full text.
"use strict";
const MAX_ITEMS = 8;

const words = (t) => String(t || "").replace(/[A-Za-z]:\\[^\s]*|\/[^\s]*|\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, " ")
  .replace(/[^A-Za-z0-9 _.,:-]/g, " ").replace(/\s+/g, " ").trim();
function errorWords(msg) {
  const s = String(msg || "");
  const codes = s.match(/\bE[A-Z]{3,}\b/g) || [];
  const phrases = ["socket hang up", "timed out", "not reachable", "aborted"].filter((p) => s.includes(p));
  return [...new Set([...codes, ...phrases])].slice(0, 4).join(",") || "none";
}

function describeRollbackFailures(results, o = {}) {
  const bad = results.map((r, i) => ({ r, i })).filter(({ r }) => r.status !== 200);
  const parts = [`${bad.length} of ${results.length} not 200`];
  parts.push(`answers ${results.slice(0, MAX_ITEMS).map((r, i) => `${i}:${r.status ?? cleanCode(r.error)}@${r.ms}`).join(",")}`);
  for (const { r, i } of bad.slice(0, MAX_ITEMS)) {
    const err = r.json && typeof r.json === "object" ? r.json.error : null;
    parts.push(`request ${i}: ${r.status === undefined ? `client error ${cleanCode(r.error)}` : `HTTP ${r.status}`} after ${r.ms} ms; studio error words ${errorWords(err)}${r.json && r.json.code ? ` code ${cleanCode(r.json.code)}` : ""}`);
  }
  const t0 = o.t0, rel = (t) => (t0 == null || t == null ? "?" : t - t0);
  const diag = Array.isArray(o.diag) ? o.diag : null;
  if (diag) {
    const pids = [...new Set(diag.filter((r) => r.e === "start").map((r) => r.pid))];
    const ev = (pid) => diag.filter((r) => r.pid === pid && ["start", "listening", "listen-error", "exit"].includes(r.e))
      .map((r) => `${r.e === "listen-error" ? `listen-error ${cleanCode(r.code)}` : r.e}${r.e === "exit" && r.code != null ? ` ${cleanCode(r.code)}` : ""}@${rel(r.t)}`).join(" ");
    parts.push(`engine processes ${pids.length}: ${pids.slice(-MAX_ITEMS).map((pid) => `[${ev(pid)}]`).join(" ") || "none"}`);
  } else parts.push("engine records: unavailable");
  parts.push(o.stats && typeof o.stats === "object" ? `engine stats requests ${o.stats.requests ?? "?"} completed ${o.stats.completed ?? "?"}` : "engine stats: unavailable");
  const lines = String(o.log || "").split(/\r?\n/).filter((l) => /\[backend\]|\[sd-err\]|not reachable/.test(l)).slice(-MAX_ITEMS).map((l) => words(l).slice(0, 120));
  parts.push(`server backend lines ${lines.length ? lines.join(" | ") : "none"}`);
  return parts.join("; ").slice(0, 2400);
}
function cleanCode(c) { return String(c ?? "?").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "?"; }

module.exports = { describeRollbackFailures, errorWords };
