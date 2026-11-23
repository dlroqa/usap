// image-queue-observe.cjs — failure detail for the image-queue validator's "Default: imageQueue off" check (test-only).
//
// The check itself is unchanged: one GET /api/resources with the validator's existing 10 s timeout, judged by the same
// condition as before (no imageQueue report, no limits.imageQueue, engines.image.queue.known === false). This module
// only says what was observed, so a FAIL can be told apart:
//   timeout              the request timed out (the existing 10 s timeout)
//   request error        no answer for another reason (connection refused or reset; error code only)
//   invalid response     an answer that is not HTTP 200 with a JSON object body
//   missing measurement  a JSON answer without engines.image.queue
//   state mismatch       the queue is reported, but not as off (imageQueue present, or known !== false)
//   as expected          the state the check requires
// Everything printed is bounded and sanitized: numbers, fixed words, key names and a short letters-and-digits excerpt
// of an invalid body (no slashes or backslashes, so no paths). No retry: one request, one verdict.
"use strict";

const MAX_KEYS = 12;
const keyName = (k) => String(k).replace(/[^A-Za-z0-9_]/g, "").slice(0, 24);
const excerpt = (t) => String(t || "").replace(/[^A-Za-z0-9 _.,:=-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);

// The pass condition the validator always used, on the same parsed body ({} when there was none).
function defaultOffOk(r) {
  const q = r.engines && r.engines.image && r.engines.image.queue;
  return Boolean(!("imageQueue" in r) && !("imageQueue" in (r.limits || {})) && q && q.known === false);
}

// res: the validator's call() result { status, text, json }; ms: elapsed; server: { alive, upMs } or null
function classifyDefaultOff(res, ms, server) {
  const r = (res && res.json && typeof res.json === "object") ? res.json : {};
  const ok = defaultOffOk(r);
  const q = r.engines && r.engines.image && r.engines.image.queue;
  let kind;
  if (!res || res.status === 0) kind = /client timeout/.test(String(res && res.text)) ? "timeout" : "request error";
  else if (res.status !== 200 || !res.json || typeof res.json !== "object") kind = "invalid response";
  else if (!q) kind = "missing measurement";
  else kind = ok ? "as expected" : "state mismatch";
  const parts = [`observed: ${kind}`, `after ${ms} ms (timeout 10000 ms)`];
  if (!res || res.status === 0) {
    if (kind === "request error") { const code = /\b(E[A-Z]{3,})\b/.exec(String(res && res.text)); parts.push(`error ${code ? code[1] : "unknown"}`); }
  } else {
    parts.push(`HTTP ${res.status}`, `body ${String(res.text || "").length} B`);
    if (!res.json || typeof res.json !== "object") parts.push(`not a JSON object: "${excerpt(res.text)}"`);
    else {
      const keys = Object.keys(r);
      parts.push(`keys ${keys.slice(0, MAX_KEYS).map(keyName).join(",") || "none"}${keys.length > MAX_KEYS ? ",..." : ""}`);
      parts.push(`imageQueue key ${"imageQueue" in r ? "present" : "absent"}`, `limits.imageQueue ${"imageQueue" in (r.limits || {}) ? "present" : "absent"}`);
      parts.push(`engines.image ${r.engines && r.engines.image ? "present" : "absent"}`, `image queue known ${q ? keyName(q.known) : "absent"}`);
    }
  }
  if (server) parts.push(`server process ${server.alive ? "running" : "exited"}, up ${server.upMs} ms`);
  return { ok, kind, detail: parts.join("; ") };
}

module.exports = { classifyDefaultOff, defaultOffOk };
