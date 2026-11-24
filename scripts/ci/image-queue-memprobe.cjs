"use strict";
// Validator-only preload for the D6 memory measurement (scripts/ci/image-queue-validate.cjs); never loaded by the
// product. image-queue-validate.cjs starts its D6 studio with NODE_OPTIONS="--expose-gc --require <this file>" and
// USAP_IQ_MEMPROBE=<file>. Active only in serve.cjs (the engine guard inherits the environment and stays untouched).
// Every 200 ms it writes the studio's process.memoryUsage() to <file> (write + rename). When the validator creates
// <file>.gc, it runs a full garbage collection, removes the trigger and writes a sample marked with that request's
// id, so "after release" can be read with dead buffers collected: arrayBuffers then counts only buffers still
// referenced. It never writes to stdout/stderr and its timer is unref'd.
// The sample taken right after a forced GC is also kept as `lastGc` ({ id, pid, t, memory figures }) in every later
// record until the next GC request replaces it, so a validator that reads the file late still finds it (the plain
// per-tick record overwrites the GC-marked one 200 ms later). `lastGc` exists only when a GC actually ran.
// Diagnostics (test-only, opt-in with USAP_IQ_MEMPROBE_DIAG=1; without it every record is byte-for-byte as before):
// each record then also carries `diag` = { ticks, writesOk, events }, where events (at most 32, oldest dropped) are
// [time, kind, detail] for what the probe otherwise swallows, plus `errors`, cumulative counts of failed record writes by
// "stage:code[:marked]" (not capped by the event window): a trigger read or unlink error (its code; ENOENT, the
// normal "no request", is not recorded), an empty or invalid request (length only), an accepted request (its id, which
// matched the id rule), the GC (id and duration ms), and a failed write or rename of a record (code, stage, and the
// gcId if that record was GC-marked). An event noted while a write fails is carried by the next record that
// publishes. Recording never changes what the probe does.
const out = process.env.USAP_IQ_MEMPROBE;
const path = require("path");
if (out && path.basename(process.argv[1] || "") === "serve.cjs") {
  const fs = require("fs");
  const trigger = `${out}.gc`;
  let lastGc = null;
  const diag = process.env.USAP_IQ_MEMPROBE_DIAG === "1" ? { ticks: 0, writesOk: 0, errors: {}, events: [] } : null;
  let markedLive = null; // diagnostics only: id of the marked record currently published
  const note = (kind, detail) => { if (!diag) return; if (diag.events.length >= 32) diag.events.shift(); diag.events.push([Date.now(), kind, detail]); };
  const write = (extra) => {
    const m = process.memoryUsage();
    const rec = { t: Date.now(), pid: process.pid, rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers, gcAvailable: typeof global.gc === "function", ...(lastGc ? { lastGc } : {}), ...extra, ...(diag ? { diag } : {}) };
    let stage = "write";
    try {
      fs.writeFileSync(`${out}.tmp`, JSON.stringify(rec)); stage = "rename"; fs.renameSync(`${out}.tmp`, out);
      // diagnostics only: when a GC-marked record became visible, and when a later record replaced it
      if (diag) { diag.writesOk += 1; if (extra.gcId) note("published-marked", extra.gcId); else if (markedLive) note("replaced-marked", markedLive); markedLive = extra.gcId || null; }
    }
    catch (err) {
      const code = (err && err.code) || "?";
      if (diag) { const k = `${stage}:${code}${extra.gcId ? ":marked" : ""}`; diag.errors[k] = (diag.errors[k] || 0) + 1; }
      note("write-error", { code, stage, ...(extra.gcId ? { gcId: extra.gcId } : {}) }); /* best effort */
    }
  };
  const tick = () => {
    let gcId = null;
    if (diag) diag.ticks += 1;
    // An empty trigger is a request still being written (a non-atomic writer): leave it for the next tick. A request
    // that is not a valid id (1-128 of A-Z a-z 0-9 . _ -) is removed unanswered: the waiting validator records a
    // missing sample (FAIL). Read errors (a rename in progress on Windows) are retried on the next tick.
    let stage = "read";
    try {
      const t = fs.readFileSync(trigger, "utf8").trim();
      if (t) {
        stage = "unlink"; fs.unlinkSync(trigger);
        if (/^[A-Za-z0-9._-]{1,128}$/.test(t)) { gcId = t; note("request", t); } else note("request-invalid", t.length);
      } else note("request-empty", 0);
    } catch (err) { gcId = null; if (!err || err.code !== "ENOENT") note(`trigger-${stage}-error`, (err && err.code) || "?"); }
    if (gcId !== null && typeof global.gc === "function") {
      const g0 = Date.now();
      global.gc(); global.gc();
      const m = process.memoryUsage();
      lastGc = { id: gcId, pid: process.pid, t: Date.now(), rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers };
      note("gc", { id: gcId, ms: lastGc.t - g0 });
    }
    write(gcId !== null ? { gcId } : {});
  };
  setInterval(tick, 200).unref();
}
