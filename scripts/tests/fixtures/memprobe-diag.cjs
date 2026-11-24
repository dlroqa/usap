// D6 probe diagnostics (test-only, messages only): what the test process and the probe each saw around one GC
// request, as one bounded, numbers-and-codes line for t.diagnostic(). It never decides a verdict; the tests keep their
// assertions and print this line before them. Times are ms relative to the request (requestedAt). Identifiers are
// printed only if they match the probe's id rule; error messages and paths are never printed, only error codes.
"use strict";
const fs = require("node:fs");
const { GC_ID } = require("../../ci/memprobe-gc.cjs");
const MAX_EVENTS = 16;
const safeId = (v) => (typeof v === "string" && GC_ID.test(v) ? v : v == null ? "none" : `?${String(v).length}`);

// A drop-in for the tests' read(): same return value (the parsed record or null), and it counts every outcome.
function observer() {
  const o = { reads: 0, ok: 0, missing: 0, errors: {}, parse: 0, last: null };
  o.read = (f) => {
    o.reads += 1;
    let text;
    try { text = fs.readFileSync(f, "utf8"); } catch (err) { const c = (err && err.code) || "?"; if (c === "ENOENT") o.missing += 1; else o.errors[c] = (o.errors[c] || 0) + 1; return null; }
    try { const p = JSON.parse(text); o.ok += 1; o.last = p; return p; } catch (_) { o.parse += 1; return null; }
  };
  return o;
}

// recordFile (optional): one more read after the wait, for this description only (the verdict was already taken), so
// the probe's events are still shown when the test's last reads failed; it is labelled as such.
function describeProbeWait({ req = {}, attempts = null, obs = null, child = null, triggerFile = null, recordFile = null } = {}) {
  const at = req.requestedAt;
  const rel = (t) => (Number.isFinite(t) && Number.isFinite(at) ? Math.round(t - at) : "?");
  const parts = [`request ${safeId(req.id)} published after ${attempts == null ? "?" : attempts} rename retries`];
  if (triggerFile) { let still; try { still = fs.existsSync(triggerFile); } catch (_) { still = "?"; } parts.push(`request file still present ${still}`); }
  if (obs) {
    const errs = Object.entries(obs.errors).map(([c, n]) => `${c}x${n}`).join(",") || "none";
    parts.push(`test reads ${obs.reads}: ok ${obs.ok}, missing ${obs.missing}, partial ${obs.parse}, errors ${errs}`);
    let p = obs.last, after = "";
    if (recordFile) { try { const q = JSON.parse(fs.readFileSync(recordFile, "utf8")); if (!p || (Number.isFinite(q.t) && q.t > p.t)) { p = q; after = " (read after the wait)"; } } catch (err) { parts.push(`read after the wait failed ${(err && err.code) || "parse"}`); } }
    parts.push(p ? `last record${after}: t ${rel(p.t)}, pid ${p.pid === (child && child.pid) ? "probe" : "other"}, gcId ${safeId(p.gcId)}, lastGc ${p.lastGc ? `${safeId(p.lastGc.id)} at ${rel(p.lastGc.t)}` : "none"}` : "no record seen");
    const d = p && p.diag;
    if (d && Array.isArray(d.events)) {
      const ev = d.events.filter(([t]) => !Number.isFinite(at) || t >= at - 1000).slice(-MAX_EVENTS).map(([t, kind, x]) => {
        const detail = kind === "request" ? safeId(x) : kind === "gc" ? `${safeId(x && x.id)} ${Number.isFinite(x && x.ms) ? x.ms : "?"}ms` : kind === "write-error" ? `${(x && x.code) || "?"}@${(x && x.stage) || "?"}${x && x.gcId ? ` marked ${safeId(x.gcId)}` : ""}` : String(x).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16);
        return `${rel(t)} ${kind} ${detail}`;
      });
      parts.push(`probe ticks ${d.ticks}, records published before this one ${d.writesOk}; probe events ${ev.length ? ev.join("; ") : "none"}`);
    } else parts.push("probe diagnostics: not recorded");
  }
  if (child) parts.push(`probe process ${child.exitCode === null && child.signalCode === null ? "running" : `exited ${child.exitCode} ${child.signalCode || ""}`.trim()}`);
  return parts.join("; ").slice(0, 1500);
}

module.exports = { observer, describeProbeWait };
