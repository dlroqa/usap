// #151 diagnostics (test-only, messages only, opt-in): an INDEPENDENT process that records, every INTERVAL ms, the
// scheduler state of the main thread of the given processes (the json-413 client process and the studio), so a
// client stall can be read as: runnable but not running (R with little CPU: descheduled), waiting in the kernel
// (S: e.g. an event-loop wait or a blocking call), an uninterruptible OS wait (U on macOS, D on Linux: e.g. page-in
// or I/O), or stopped. It never signals, attaches to or slows the observed processes beyond reading their state:
//   macOS: `ps -M -p <pid>` (first thread row = main thread: STAT and %CPU; plus how many threads are runnable);
//   Linux: /proc/<pid>/task/<pid>/stat (state) and /proc/<pid>/task/<pid>/wchan (kernel wait point, a symbol name);
//   other platforms: "unsupported".
// Args: intervalMs pid [pid...]. Ends when stdin ends; prints one JSON object { platform, intervalMs, procs: { pid:
// { samples, runs: [[t, state, cpu, extra]] } } } where runs keep only changes (at most 300 per process).
"use strict";
const fs = require("node:fs");
const { execFile } = require("node:child_process");

const [intervalMs, ...pids] = process.argv.slice(2).map(Number);
const MAX_RUNS = 300;
const out = { platform: process.platform, intervalMs, procs: {} };
for (const p of pids) out.procs[p] = { samples: 0, runs: [] };
const note = (pid, state, cpu, extra) => {
  const o = out.procs[pid]; o.samples += 1;
  const last = o.runs[o.runs.length - 1];
  if (last && last[1] === state && last[3] === extra) return;
  if (o.runs.length < MAX_RUNS) o.runs.push([Date.now(), state, cpu, extra]);
};

function sampleMac(pid) {
  return new Promise((resolve) => {
    execFile("ps", ["-M", "-p", String(pid)], { timeout: 1000 }, (err, stdout) => {
      if (err && !stdout) { note(pid, "gone", null, ""); return resolve(); }
      const rows = String(stdout).split("\n").slice(1).filter((l) => l.trim());
      // First row (main thread): USER PID TT %CPU STAT ...; later thread rows omit USER/TT. In every row %CPU is the
      // first "N.N" token and STAT follows it.
      const parse = (l) => { const f = l.trim().split(/\s+/); const i = f.findIndex((x) => /^\d+\.\d+$/.test(x)); return i >= 0 ? { cpu: Number(f[i]), stat: f[i + 1] || "?" } : null; };
      const all = rows.map(parse).filter(Boolean);
      const main = all[0] || { cpu: null, stat: "?" };
      const runnable = all.filter((r) => /^R/.test(r.stat)).length;
      note(pid, main.stat.replace(/[^A-Za-z+<]/g, "").slice(0, 3) || "?", main.cpu, `runnable threads ${runnable}/${all.length}`);
      resolve();
    });
  });
}
function sampleLinux(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/task/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    let wchan = ""; try { wchan = fs.readFileSync(`/proc/${pid}/task/${pid}/wchan`, "utf8").trim().replace(/[^A-Za-z0-9_]/g, "").slice(0, 32); } catch (_) { /* hidden */ }
    note(pid, state, null, wchan === "0" ? "" : wchan);
  } catch (_) { note(pid, "gone", null, ""); }
  return Promise.resolve();
}
const sample = process.platform === "darwin" ? sampleMac : process.platform === "linux" ? sampleLinux : null;
let running = true;
(async () => {
  if (!sample) { out.unsupported = true; return; }
  while (running) {
    const t = Date.now();
    await Promise.all(pids.map((p) => sample(p)));
    await new Promise((r) => setTimeout(r, Math.max(1, intervalMs - (Date.now() - t))));
  }
})();
process.stdin.on("end", () => { running = false; setTimeout(() => { process.stdout.write(JSON.stringify(out)); process.exit(0); }, 20); });
process.stdin.resume();
