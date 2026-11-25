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
// It also keeps (messages only) an ordered summary of the distinct records it parsed (at most MAX_SEEN, from the first
// read on; later ones are only counted) and the largest gap between two of its reads, so a GC-marked record that was
// never visible to the reader reads differently from one that was seen and not accepted, and from a reader that did
// not read while the marked record was there.
const MAX_SEEN = 16;
function observer() {
  const o = { reads: 0, ok: 0, missing: 0, errors: {}, parse: 0, last: null, seen: [], seenMore: 0, prevAt: null, firstAt: null, maxGap: 0, maxGapFrom: null, failAt: [] };
  const failed = (now) => { if (o.failAt.length >= 32) o.failAt.shift(); o.failAt.push(now); }; // C1: the LAST 32 failed reads (no I/O)
  const remember = (p, now) => {
    const key = `${p.pid}:${p.t}`;
    const e = o.seen.length ? o.seen[o.seen.length - 1] : null;
    if (e && e.key === key) { e.reads += 1; e.lastAt = now; return; }
    const older = o.seen.find((x) => x.key === key);
    if (older) { older.reads += 1; older.lastAt = now; return; } // an older record read again (not expected): its last read counts (C1 R2)
    if (o.seen.length >= MAX_SEEN) { o.seenMore += 1; return; }
    o.seen.push({ key, t: p.t, pid: p.pid, gcId: p.gcId, lastGcId: p.lastGc ? p.lastGc.id : undefined, firstAt: now, lastAt: now, reads: 1 });
  };
  o.read = (f) => {
    const now = Date.now();
    if (o.prevAt === null) o.firstAt = now; else if (now - o.prevAt > o.maxGap) { o.maxGap = now - o.prevAt; o.maxGapFrom = o.prevAt; }
    o.prevAt = now;
    o.reads += 1;
    let text;
    try { text = fs.readFileSync(f, "utf8"); } catch (err) { const c = (err && err.code) || "?"; if (c === "ENOENT") o.missing += 1; else o.errors[c] = (o.errors[c] || 0) + 1; failed(now); return null; }
    try { const p = JSON.parse(text); o.ok += 1; o.last = p; try { remember(p, now); } catch (_) { /* messages only */ } return p; } catch (_) { o.parse += 1; failed(now); return null; }
  };
  return o;
}

// The reader's view, one entry per distinct record: when the probe wrote it, when the reader first and last read it,
// how often, and what it was for this request: "ACCEPTED" (marked for this request: the test's gcId rule), "rejected:
// marked for <id>" (another request's marked record), "rejected: other process", or "plain" (with the GC it carries).
function describeSeen(obs, req, probePid, rel) {
  if (!obs || !Array.isArray(obs.seen)) return "reader view: not recorded";
  const kind = (e) => (probePid != null && e.pid !== probePid ? "rejected: other process"
    : e.gcId === undefined ? `plain lastGc ${e.lastGcId === undefined ? "none" : safeId(e.lastGcId)}`
    : e.gcId === req.id ? "ACCEPTED" : `rejected: marked for ${safeId(e.gcId)}`);
  const marked = obs.seen.filter((e) => e.gcId !== undefined && e.gcId === req.id).length;
  const list = obs.seen.map((e) => `${rel(e.t)} read ${rel(e.firstAt)}..${rel(e.lastAt)} x${e.reads} ${kind(e)}`).join(", ");
  const verdict = marked ? "this request's marked record was seen" : obs.seen.some((e) => e.gcId !== undefined) ? "only other requests' marked records were seen" : "no marked record was ever visible to the reader";
  return `reader view (${verdict}): distinct records ${obs.seen.length}${obs.seenMore ? ` (+${obs.seenMore} more)` : ""} [${list || "none"}]; reads from ${rel(obs.firstAt)}, largest gap between reads ${obs.maxGap} ms from ${obs.maxGapFrom === null ? "-" : rel(obs.maxGapFrom)}`;
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
        const detail = kind === "request" ? safeId(x) : kind === "gc" ? `${safeId(x && x.id)} ${Number.isFinite(x && x.ms) ? x.ms : "?"}ms` : (kind === "published-marked" || kind === "replaced-marked") ? safeId(x) : kind === "write-error" ? `${(x && x.code) || "?"}@${(x && x.stage) || "?"}${x && x.gcId ? ` marked ${safeId(x.gcId)}` : ""}` : String(x).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16);
        return `${rel(t)} ${kind} ${detail}`;
      });
      parts.push(`probe ticks ${d.ticks}, records published before this one ${d.writesOk}; probe events ${ev.length ? ev.join("; ") : "none"}`);
      const sw = d.errors && typeof d.errors === "object" ? Object.entries(d.errors).map(([k, n]) => `${String(k).slice(0, 40)}x${n}`).join(",") : "";
      parts.push(`probe write errors swallowed (cumulative) ${sw || "none"}`); // C1
    } else parts.push("probe diagnostics: not recorded");
  }
  if (obs) parts.push(describeSeen(obs, req, child ? child.pid : null, rel));
  if (child) parts.push(`probe process ${child.exitCode === null && child.signalCode === null ? "running" : `exited ${child.exitCode} ${child.signalCode || ""}`.trim()}`);
  return parts.join("; ").slice(0, 2500);
}

// C1 (round 15): one fixed reading of an exact-id wait, rules in order (messages only; never a verdict). Inputs: req
// { id, requestedAt }, attempts (writeTrigger's retries, null when it threw), obs (observer), probeRunning, triggerPresent,
// record (the last record, with diag): its events [t, kind, detail] and errors.
function readProbeWait({ req = {}, attempts = null, obs = null, probeRunning = true, triggerPresent = false, record = null } = {}) {
  const d = record && record.diag;
  const ev = d && Array.isArray(d.events) ? d.events : [];
  const has = (kind, id) => ev.filter(([, k, x]) => k === kind && (id === undefined || x === id || (x && x.gcId === id)));
  const pub = has("published-marked", req.id), rep = has("replaced-marked", req.id);
  const accepted = obs && obs.seen.some((e) => e.gcId !== undefined && e.gcId === req.id);
  if (attempts === null) return "request not published (writeTrigger failed)";
  if (!probeRunning) return "probe dead";
  if (accepted) return "marked record seen by the reader";
  if (!d) return "undecidable: probe diagnostics not recorded";
  if (!has("request", req.id).length) {
    const terr = ev.filter(([, k]) => /^trigger-.*-error$/.test(k)).map(([, k, x]) => `${k} ${x}`).slice(0, 4).join(",");
    return triggerPresent ? `request never consumed (trigger still present${terr ? `; ${terr}` : ""})` : `request taken but not traced (trigger gone, no request event${terr ? `; ${terr}` : ""})`;
  }
  const markedErr = Object.keys(d.errors || {}).some((k) => /:marked$/.test(k)) || ev.some(([, k, x]) => k === "write-error" && x && x.gcId === req.id);
  if (!pub.length) return markedErr ? "lost marked write (F1: the marked record's write failed)" : "request seen, marked record not published (unexplained)";
  const t1 = pub[pub.length - 1][0], t2 = rep.length ? rep[rep.length - 1][0] : Infinity;
  if (!obs) return `marked record published at ${t1}; reader view not recorded`;
  const inWin = (t) => t >= t1 && t <= t2;
  const readsIn = obs.seen.filter((e) => Number.isFinite(e.t) && e.t < t1 && e.lastAt > t1); // an OLDER record read after the marked one was published (also across the whole window)
  const failsIn = (obs.failAt || []).filter(inWin).length;
  if (readsIn.length) return "R2 published but unseen: reads inside the marked window returned other records (visibility anomaly)";
  if (failsIn) return `read errors: ${failsIn} read(s) failed inside the marked window`;
  return `R1 reader gap: no read inside the marked window (${Number.isFinite(t2) ? t2 - t1 : "open"} ms; largest gap ${obs.maxGap} ms)`;
}

module.exports = { observer, describeProbeWait, describeSeen, readProbeWait, MAX_SEEN };
