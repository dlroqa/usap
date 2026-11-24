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
const out = process.env.USAP_IQ_MEMPROBE;
const path = require("path");
if (out && path.basename(process.argv[1] || "") === "serve.cjs") {
  const fs = require("fs");
  const trigger = `${out}.gc`;
  let lastGc = null;
  const write = (extra) => {
    const m = process.memoryUsage();
    const rec = { t: Date.now(), pid: process.pid, rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers, gcAvailable: typeof global.gc === "function", ...(lastGc ? { lastGc } : {}), ...extra };
    try { fs.writeFileSync(`${out}.tmp`, JSON.stringify(rec)); fs.renameSync(`${out}.tmp`, out); } catch (_) { /* best effort */ }
  };
  const tick = () => {
    let gcId = null;
    // An empty trigger is a request still being written (a non-atomic writer): leave it for the next tick.
    try { const t = fs.readFileSync(trigger, "utf8").trim(); if (t) { gcId = t; fs.unlinkSync(trigger); } } catch (_) { gcId = null; }
    if (gcId !== null && typeof global.gc === "function") {
      global.gc(); global.gc();
      const m = process.memoryUsage();
      lastGc = { id: gcId, pid: process.pid, t: Date.now(), rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers };
    }
    write(gcId !== null ? { gcId } : {});
  };
  setInterval(tick, 200).unref();
}
