// Default-off R1 diagnostics (test-only, message only, never judged): the R1 block of engine-slot.test.cjs
// "default off: ... (R3 still answers 500; R1 can still overlap)". With the engine slot off, R1 (text load with its port
// held, image load 100 ms later) is expected to leave both engines resident. Three Windows runs instead ended with an
// engine missing after its load answered 200 (or, in R3, not seen as active). This describes, as one bounded, sanitized
// line for t.diagnostic(), the order of what happened and which engine processes existed and exited. It names no cause
// and decides no verdict; the test's assertions are unchanged and run after this line is printed.
//   o.t0       wall time just before the text load was sent (all times are relative to it)
//   o.text, o.image   { sentAt, doneAt, status, code } of each load
//   o.observedAt      time of the post-load reads (after the test's 500 ms wait)
//   o.engines         [{ label, pid }] the test's own live-engine read (supervised records whose PID is alive)
//   o.supervised      /api/diagnostics engines.processes.supervised ([{ label, guardPid, enginePid, startedAt }])
//   o.recentExits     /api/diagnostics engines.processes.recentExits ([{ label, enginePid, code, signal, at }])
//   o.backend, o.llm  /api/backend-status and /api/llm/status bodies (booleans used only)
//   o.diag            fake image engine records (start, listening, listen-error, told-to-exit, exit)
//   o.log             the studio server's log text (engine lines only, paths and addresses removed)
"use strict";
const MAX_ITEMS = 8;
const num = (v) => (Number.isFinite(v) ? v : "?");
const code = (c) => String(c ?? "?").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "?";
const words = (t) => String(t || "").replace(/[A-Za-z]:\\[^\s]*|\/[^\s]*|\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, " ")
  .replace(/[^A-Za-z0-9 _.,:()-]/g, " ").replace(/\s+/g, " ").trim();
const ms = (t) => (typeof t === "string" ? Date.parse(t) : t);

function describeLegacyR1(o = {}) {
  const t0 = o.t0, rel = (t) => { const v = ms(t); return t0 == null || !Number.isFinite(v) ? "?" : v - t0; };
  const answer = (r) => (!r ? "none" : r.status === undefined ? `client error ${code(r.error)}` : `HTTP ${r.status}${r.code ? ` ${code(r.code)}` : ""}`);
  // The order of the four events, by time.
  const ev = [["text sent", o.text && o.text.sentAt], ["image sent", o.image && o.image.sentAt], [`image answered ${answer(o.image)}`, o.image && o.image.doneAt], [`text answered ${answer(o.text)}`, o.text && o.text.doneAt], ["observed", o.observedAt]]
    .filter(([, t]) => Number.isFinite(ms(t))).sort((a, b) => ms(a[1]) - ms(b[1]));
  const parts = [`order ${ev.map(([k, t]) => `${k}@${rel(t)}`).join(", ") || "none"}`];
  const list = (e) => (Array.isArray(e) ? (e.length ? e.slice(0, MAX_ITEMS).map((x) => `${code(x.label)}:${num(x.pid)}`).join(",") : "none") : "unreadable");
  parts.push(`live engines at observation ${list(o.engines)}`);
  parts.push(`tracked ${Array.isArray(o.supervised) ? (o.supervised.length ? o.supervised.slice(0, MAX_ITEMS).map((r) => `${code(r.label)} guard ${num(r.guardPid)} engine ${r.enginePid == null ? "unreported" : num(r.enginePid)} since ${rel(r.startedAt)}`).join(", ") : "none") : "unreadable"}`);
  const exits = Array.isArray(o.recentExits) ? o.recentExits.filter((r) => t0 == null || !Number.isFinite(ms(r.at)) || ms(r.at) >= t0 - 1000) : null;
  parts.push(`exits seen by the supervisor ${exits ? (exits.length ? exits.slice(-MAX_ITEMS).map((r) => `${code(r.label)} engine ${r.enginePid == null ? "unreported" : num(r.enginePid)} code ${r.code == null ? "none" : code(r.code)} signal ${r.signal == null ? "none" : code(r.signal)}@${rel(r.at)}`).join(", ") : "none") : "unreadable"}`);
  const b = o.backend && typeof o.backend === "object" ? `image ready ${o.backend.ready === true} running ${o.backend.running === true} model set ${!!(o.backend.settings && o.backend.settings.model)}${o.backend.error ? " error set" : ""}` : "image status unreadable";
  const l = o.llm && typeof o.llm === "object" ? `text ready ${o.llm.ready === true} running ${o.llm.running === true}` : "text status unreadable";
  parts.push(`${b}; ${l}`);
  const diag = Array.isArray(o.diag) ? o.diag.filter((r) => t0 == null || !Number.isFinite(r.t) || r.t >= t0 - 1000) : null;
  if (diag) {
    const kinds = ["start", "listening", "listen-error", "told-to-exit", "exit"];
    const pids = [...new Set(diag.filter((r) => r.e === "start").map((r) => r.pid))];
    const evs = (pid) => diag.filter((r) => r.pid === pid && kinds.includes(r.e))
      .map((r) => `${r.e}${(r.e === "exit" || r.e === "told-to-exit" || r.e === "listen-error") && r.code != null ? ` ${code(r.code)}` : ""}@${rel(r.t)}`).join(" ");
    parts.push(`image engine processes ${pids.length}: ${pids.slice(-MAX_ITEMS).map((pid) => `${num(pid)}[${evs(pid)}]`).join(" ") || "none"}`);
  } else parts.push("image engine records: unavailable");
  const lines = String(o.log || "").split(/\r?\n/)
    .filter((x) => /\[backend\]|\[sd-err\]|\[llm\]|\[supervis|exited|stopp|kill|already loaded|ENGINE_START|MODEL_ALREADY_ACTIVE/i.test(x))
    .slice(-10).map((x) => words(x).slice(0, 120));
  parts.push(`server engine lines ${lines.length ? lines.join(" | ") : "none"}`);
  return parts.join("; ").slice(0, 2800);
}

module.exports = { describeLegacyR1 };
