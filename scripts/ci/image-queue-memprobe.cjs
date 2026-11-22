"use strict";
// Validator-only preload for the D6 memory measurement (scripts/ci/image-queue-validate.cjs); never loaded by the
// product. image-queue-validate.cjs starts its D6 studio with NODE_OPTIONS="--expose-gc --require <this file>" and
// USAP_IQ_MEMPROBE=<file>. Active only in serve.cjs (the engine guard inherits the environment and stays untouched).
// Every 200 ms it writes the studio's process.memoryUsage() to <file> (write + rename). When the validator creates
// <file>.gc, it runs a full garbage collection, removes the trigger and writes a sample marked with that request's
// id, so "after release" can be read with dead buffers collected: arrayBuffers then counts only buffers still
// referenced. It never writes to stdout/stderr and its timer is unref'd.
const out = process.env.USAP_IQ_MEMPROBE;
const path = require("path");
if (out && path.basename(process.argv[1] || "") === "serve.cjs") {
  const fs = require("fs");
  const trigger = `${out}.gc`;
  const write = (extra) => {
    const m = process.memoryUsage();
    const rec = { t: Date.now(), pid: process.pid, rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers, gcAvailable: typeof global.gc === "function", ...extra };
    try { fs.writeFileSync(`${out}.tmp`, JSON.stringify(rec)); fs.renameSync(`${out}.tmp`, out); } catch (_) { /* best effort */ }
  };
  const tick = () => {
    let gcId = null;
    try { gcId = fs.readFileSync(trigger, "utf8").trim() || "gc"; fs.unlinkSync(trigger); } catch (_) { gcId = null; }
    if (gcId !== null && typeof global.gc === "function") { global.gc(); global.gc(); }
    write(gcId !== null ? { gcId } : {});
  };
  setInterval(tick, 200).unref();
}
