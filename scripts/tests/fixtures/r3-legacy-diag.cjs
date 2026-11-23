// #175 diagnostics (test-only, message only, never judged): the legacy R3 block of engine-slot.test.cjs
// "default off: ... (R3 still answers 500; R1 can still overlap)". With the engine slot off, the text load answers 500
// only because the server's own check (processHeavyRuntime in server/serve.cjs) sees the image runtime when the text
// load begins: the image engine ready or running, with a model set. One Windows run answered 200 instead; the test
// recorded nothing about that precondition. This describes, as one bounded, sanitized line for t.diagnostic(), what
// the test saw just before and after the text load. It names no cause and decides no verdict; the test asserts the
// precondition and the unchanged 500 contract itself, after printing this line.
//   o.t0        wall time just before the image load (all times are relative to it)
//   o.image     the image load answer { status, code }
//   o.pre       read just before the text load: { at, status: /api/backend-status body or null, engines: [{label,pid}] or null }
//   o.text      the text load answer { status, code, errorNamesImage, ms, at } or { error, ms, at }
//   o.post      read just after: { at, status, llm: /api/llm/status body or null, engines }
//   o.diag      fake image engine records (api-contract/fake-sd-server.cjs: start, listening, listen-error, exit, told-to-exit)
//   o.log       the studio server's log text (only engine lines are used, paths and addresses removed)
"use strict";
const MAX_ITEMS = 8;
const num = (v) => (Number.isFinite(v) ? v : "?");
const code = (c) => String(c ?? "?").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "?";
const words = (t) => String(t || "").replace(/[A-Za-z]:\\[^\s]*|\/[^\s]*|\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, " ")
  .replace(/[^A-Za-z0-9 _.,:-]/g, " ").replace(/\s+/g, " ").trim();

// The server's own precondition, read from outside: (ready or running) and a model set. null = could not be read.
function imageRuntimeActive(status) {
  if (!status || typeof status !== "object") return null;
  const model = !!(status.settings && typeof status.settings === "object" && status.settings.model);
  return (status.ready === true || status.running === true) && model;
}

function imageState(status) {
  if (!status || typeof status !== "object") return "backend-status unreadable";
  const model = !!(status.settings && typeof status.settings === "object" && status.settings.model);
  const loading = status.loading && typeof status.loading === "object" ? ` loading ${words(String(status.loading.phase || status.loading.state || "yes")).slice(0, 24)}` : "";
  return `ready ${status.ready === true} running ${status.running === true} model set ${model}${loading}${status.error ? " error set" : ""}`;
}
const engineList = (e) => (Array.isArray(e) ? (e.length ? e.slice(0, MAX_ITEMS).map((x) => `${code(x.label)}:${num(x.pid)}`).join(",") : "none") : "unreadable");

function describeLegacyR3(o = {}) {
  const t0 = o.t0, rel = (t) => (t0 == null || !Number.isFinite(t) ? "?" : t - t0);
  const pre = o.pre || {}, post = o.post || {}, text = o.text || {};
  const active = imageRuntimeActive(pre.status);
  const parts = [];
  parts.push(`image load HTTP ${num(o.image && o.image.status)}${o.image && o.image.code ? ` code ${code(o.image.code)}` : ""}`);
  parts.push(`before text load at ${rel(pre.at)} ms: image runtime active ${active === null ? "unknown" : active} (${imageState(pre.status)}); engines ${engineList(pre.engines)}`);
  const answer = text.status === undefined ? `client error ${code(text.error)}` : `HTTP ${text.status}${text.code ? ` code ${code(text.code)}` : ""}${text.status !== 200 ? `; error names the image model ${text.errorNamesImage === true}` : ""}`;
  parts.push(`text load (sent ${rel(text.at)}, ${num(text.ms)} ms): ${answer}`);
  const llm = post.llm && typeof post.llm === "object" ? `text engine ready ${post.llm.ready === true} running ${post.llm.running === true}` : "llm-status unreadable";
  parts.push(`after at ${rel(post.at)} ms: image ${imageState(post.status)}; ${llm}; engines ${engineList(post.engines)}`);
  // Image engine identity across the block: the fake engine's own records, by process.
  const diag = Array.isArray(o.diag) ? o.diag.filter((r) => t0 == null || !Number.isFinite(r.t) || r.t >= t0 - 1000) : null;
  if (diag) {
    const kinds = ["start", "listening", "listen-error", "told-to-exit", "exit"];
    const pids = [...new Set(diag.filter((r) => r.e === "start").map((r) => r.pid))];
    const ev = (pid) => diag.filter((r) => r.pid === pid && kinds.includes(r.e))
      .map((r) => `${r.e}${(r.e === "exit" || r.e === "told-to-exit" || r.e === "listen-error") && r.code != null ? ` ${code(r.code)}` : ""}@${rel(r.t)}`).join(" ");
    parts.push(`image engine processes ${pids.length}: ${pids.slice(-MAX_ITEMS).map((pid) => `${num(pid)}[${ev(pid)}]`).join(" ") || "none"}`);
  } else parts.push("image engine records: unavailable");
  const lines = String(o.log || "").split(/\r?\n/)
    .filter((l) => /\[backend\]|\[sd-err\]|\[llm\]|supervis|already loaded|ENGINE_START|MODEL_ALREADY_ACTIVE/i.test(l))
    .slice(-MAX_ITEMS).map((l) => words(l).slice(0, 120));
  parts.push(`server engine lines ${lines.length ? lines.join(" | ") : "none"}`);
  return parts.join("; ").slice(0, 2400);
}

module.exports = { describeLegacyR3, imageRuntimeActive };
