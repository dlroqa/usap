"use strict";
// Bench only (bench/164-macos-intel-contention; never merged). Loaded into every Node process of the unit suite via
// NODE_OPTIONS=--require. Passive: it never writes to stdout/stderr (tests parse child stdout), never changes timers
// the code under test uses, and all its timers are unref'd. It records per process: start/end, argv, event-loop delay
// histogram and every timer-lateness episode >= 100 ms (wall-clock start and length), to $BENCH164_DIR/<pid>.json.
const dir = process.env.BENCH164_DIR;
if (dir) {
  const fs = require("node:fs");
  const path = require("node:path");
  const { monitorEventLoopDelay } = require("node:perf_hooks");
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  const rec = { pid: process.pid, ppid: process.ppid, argv: process.argv.slice(1).map((a) => path.basename(a)).join(" ").slice(0, 200),
    start: Date.now(), end: null, stalls: [], stallsDropped: 0 };
  const TICK = 50;
  let last = Date.now();
  const iv = setInterval(() => {
    const t = Date.now(); const late = t - last - TICK; last = t;
    if (late >= 100) { if (rec.stalls.length < 400) rec.stalls.push([t - late, late]); else rec.stallsDropped += 1; }
  }, TICK);
  iv.unref();
  const file = path.join(dir, `${process.pid}.json`);
  const flush = () => {
    const ms = (n) => Math.round(n / 1e5) / 10;
    rec.end = Date.now();
    rec.eld = { p50: ms(h.percentile(50)), p99: ms(h.percentile(99)), max: ms(h.max), mean: ms(h.mean) };
    try { fs.writeFileSync(file, JSON.stringify(rec)); } catch (_) { /* best effort */ }
  };
  const fl = setInterval(flush, 3000); fl.unref();
  process.on("exit", flush);
}
