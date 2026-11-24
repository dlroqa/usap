// #151 diagnostics: an independent process that only observes scheduling. It runs a 10 ms interval timer and records
// the gaps of at least GAP_MS between consecutive runs, so a failure message can tell "the client process did not run"
// from "no process on this machine ran". Started by a test, stopped by closing its stdin; it then prints one JSON line
//   { startAt, endAt, samples, maxGapMs, gaps: [[atMs (wall clock, gap start), gapMs], ...] }
// and exits. Bounded: at most MAX_GAPS gaps (the longest are kept), and it exits on its own after CAP_MS. It reads
// nothing and writes nothing else.
// Optional argument --ready-after=N (test synchronization only): once its interval timer has run N times, it writes
// one line "sampler-ready" to stderr, so a test can act on a sampler proven to be running instead of guessing with a
// fixed startup sleep. Without the argument nothing is written to stderr and the output is unchanged.
"use strict";
const GAP_MS = 50, MAX_GAPS = 50, CAP_MS = 120000;
const readyArg = process.argv.slice(2).find((a) => a.startsWith("--ready-after="));
const READY_AFTER = readyArg ? Number(readyArg.slice("--ready-after=".length)) : null;
const startAt = Date.now();
let last = startAt, samples = 0, maxGapMs = 0, done = false;
const gaps = [];
const timer = setInterval(() => {
  const now = Date.now(); const gap = now - last; samples += 1;
  if (gap > maxGapMs) maxGapMs = gap;
  if (gap >= GAP_MS) {
    gaps.push([last, gap]);
    if (gaps.length > MAX_GAPS) { gaps.sort((a, b) => b[1] - a[1]); gaps.length = MAX_GAPS; }
  }
  last = now;
  if (READY_AFTER !== null && samples === READY_AFTER) process.stderr.write("sampler-ready\n");
}, 10);
function finish() {
  if (done) return; done = true; clearInterval(timer);
  gaps.sort((a, b) => a[0] - b[0]);
  process.stdout.write(JSON.stringify({ startAt, endAt: Date.now(), samples, maxGapMs, gaps }) + "\n", () => process.exit(0));
}
process.stdin.on("end", finish); process.stdin.on("error", finish); process.stdin.resume();
setTimeout(finish, CAP_MS).unref();
