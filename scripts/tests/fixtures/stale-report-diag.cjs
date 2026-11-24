// Stale-file report diagnostics (test-only, messages only, never judged): the stale-file-report.test.cjs server test
// "server: report — counts after listening, …" twice found legacyTranscriptionTemporaries.matched 0 instead of 1
// (#176 720c899 macOS arm64; #194 b436fad windows-x64). Its assertion printed only the count. This describes, as one
// bounded line, everything the report recorded for that folder and what the test itself sees, so a truncated scan, a
// file-system error, an entry missing from the listing, a classification difference and an absent file read
// differently. Counts, states and error codes only: no file names, no paths.
//   s        the server's /api/diagnostics staleFiles snapshot
//   o.files  the test's own view: [{ category, present, unchanged }] for the files it created before the server started
//   o.entries  the transcriptions folder now, by category: { legacy, transcript, other } counts
//   o.log    the server's "[stale-files]" line, if any
//   o.waitMs how long the test waited for the report (ms)
"use strict";
const cnt = (o) => (o && typeof o === "object" ? Object.entries(o).map(([k, v]) => `${String(k).replace(/[^A-Za-z0-9_-]/g, "")} ${Number.isFinite(v) ? v : "?"}`).join(", ") || "none" : "none");
function describeStaleReport(s, o = {}) {
  const parts = [];
  if (!s || typeof s !== "object") return `report snapshot ${s === undefined ? "absent" : String(s).slice(0, 20)}`;
  parts.push(`report state ${String(s.state ?? "ok").replace(/[^A-Za-z-]/g, "")}, mode ${String(s.mode).replace(/[^a-z]/g, "")}, removed ${s.removed}, total ${Number.isFinite(s.durationMs) ? s.durationMs : "?"} ms, waited ${Number.isFinite(o.waitMs) ? o.waitMs : "?"} ms`);
  const l = s.legacyTranscriptionTemporaries;
  parts.push(l && typeof l === "object"
    ? `legacy folder: state ${String(l.state).replace(/[^A-Za-z-]/g, "")}, scanned ${l.scanned}, matched ${l.matched}, matchedBytes ${l.matchedBytes}, skippedNotFile ${l.skippedNotFile}, truncated ${l.truncated}, errors ${cnt(l.errors)}, ages ${cnt(l.age)}, ${l.durationMs} ms`
    : "legacy folder: not reported");
  const q = s.oldFormatQueueUploads;
  parts.push(q && typeof q === "object" ? `queue folder: state ${String(q.state).replace(/[^A-Za-z-]/g, "")}, scanned ${q.scanned}, matched ${q.matched}, truncated ${q.truncated}` : "queue folder: not reported");
  if (Array.isArray(o.files)) parts.push(`test's files now: ${o.files.map((f) => `${f.category} ${f.present ? (f.unchanged ? "present unchanged" : "present CHANGED") : "ABSENT"}`).join(", ")}`);
  if (o.entries) parts.push(`transcriptions folder now: ${cnt(o.entries)}`);
  parts.push(`server line ${o.log ? String(o.log).replace(/[^A-Za-z0-9 ()[\]:,.-]/g, " ").replace(/\s+/g, " ").slice(0, 160) : "none"}`);
  return parts.join("; ").slice(0, 1200);
}
module.exports = { describeStaleReport };
