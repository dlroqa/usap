// Cross-process clock calibration (#170, test-only, measured and never judged on its outcome). The first naturally
// traced R1b failure (Windows, #209 07f0281) read T: a studio port check and the engine's failed bind within 1 ms by
// Date.now, with tp (timeOrigin + now) putting the check 1.0 ms earlier. Whether such sub-ms gaps between two processes
// mean anything depends on how comparable their clocks are. This file measures it on every OS, for three clocks:
//   th = process.hrtime.bigint() (machine-wide monotonic counter), tp = performance.timeOrigin + performance.now()
//   (per-process anchor), t = Date.now().
// (a) offset bounds: 6 fresh child processes, 200 ping-pongs each over a pipe; for each clock the child's offset lies
//     in [c - r - res, c - s + res] (s/r = parent's send/receive stamps, c = child's, res = the clock's resolution:
//     1 ms for Date.now, 0 for the others); the tightest bound over the rounds is kept.
// (b) ordering, positive: process A runs bind / hold 3 ms / close cycles on one port while B keeps trying to bind it.
//     Callback stamps only bound when a bind happened: B's bind lies in [attempt, result], A held the port at most
//     during [start, closed] and certainly during [bound, closeCall]. Every EADDRINUSE interval of B must OVERLAP an
//     A hold [start, closed]; (c) ordering, negative: no successful B bind interval may lie wholly inside an A
//     certain hold [bound, closeCall]. The smallest margin that removes all contradictions is reported per clock.
// (d) injected offsets: B's stamps shifted by 2, 5 and 16 ms (beyond A's 3 ms holds) must produce contradictions.
// It prints one line; its only assertions check that the children ran and produced data.
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { reservePort, releasePort } = require("./fixtures/test-ports.cjs");

const CHILD = path.join(__dirname, "fixtures", "clock-child.cjs");
const stamp = () => ({ th: Number(process.hrtime.bigint()) / 1e6, tp: performance.timeOrigin + performance.now(), t: Date.now() });
const CLOCKS = ["th", "tp", "t"];
const r3 = (x) => Math.round(x * 1000) / 1000;

function run(args, { input = null, ms = 25000 } = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CHILD, ...args], { stdio: ["pipe", "pipe", "ignore"] });
    let out = ""; c.stdout.on("data", (d) => { out += d; });
    const kill = setTimeout(() => c.kill("SIGKILL"), ms);
    c.once("close", () => { clearTimeout(kill); resolve(out); });
    if (input) input(c); else c.stdin.end();
  });
}
// (a) one child: 200 sequential pings; returns per clock [maxLo, minHi] (the child's offset lies inside)
function pingChild(rounds = 200) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CHILD, "pingpong"], { stdio: ["pipe", "pipe", "ignore"] });
    const b = Object.fromEntries(CLOCKS.map((k) => [k, [-Infinity, Infinity]]));
    let s = null, n = 0, buf = "";
    const kill = setTimeout(() => c.kill("SIGKILL"), 20000);
    const send = () => { s = stamp(); c.stdin.write("p\n"); };
    c.stdout.on("data", (d) => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1); const r = stamp(); const ch = JSON.parse(line);
        for (const k of CLOCKS) { const res = k === "t" ? 1 : 0; b[k][0] = Math.max(b[k][0], ch[k] - r[k] - res); b[k][1] = Math.min(b[k][1], ch[k] - s[k] + res); }
        n += 1; if (n < rounds) send(); else c.stdin.end();
      }
    });
    c.once("close", () => { clearTimeout(kill); resolve({ n, b }); });
    send();
  });
}
// (b)/(c) contradictions of B's results against A's holds for a clock, with B shifted by `shift` and a margin
function contradictions(holds, tries, k, shift = 0, margin = 0) {
  let pos = 0, neg = 0;
  for (const x of tries) {
    const b0 = x.start[k] + shift, b1 = x.res[k] + shift; // B's bind happened somewhere in [b0, b1]
    if (x.result === "EADDRINUSE") { if (!holds.some((h) => b1 >= h.start[k] - margin && b0 <= h.closed[k] + margin)) pos += 1; } // must overlap an A hold
    else if (x.result === "ok") { if (holds.some((h) => b0 > h.bound[k] + margin && b1 < h.closeCall[k] - margin)) neg += 1; } // wholly inside A's certain hold
  }
  return { pos, neg };
}
const minMargin = (holds, tries, k) => { for (const m of [0, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 16, 32]) { const c = contradictions(holds, tries, k, 0, m); if (!c.pos && !c.neg) return m; } return Infinity; };

test("clock calibration (measured only): cross-process offset bounds and bind-ordering controls for hrtime, tp and Date.now", { timeout: 120000 }, async (t) => {
  // (a)
  const kids = [];
  for (let i = 0; i < 6; i += 1) kids.push(await pingChild());
  assert.ok(kids.every((k) => k.n === 200), "every ping child answered 200 pings");
  const worst = Object.fromEntries(CLOCKS.map((k) => [k, r3(Math.max(...kids.map((x) => Math.max(Math.abs(x.b[k][0]), Math.abs(x.b[k][1])))))]));
  const width = Object.fromEntries(CLOCKS.map((k) => [k, r3(Math.max(...kids.map((x) => x.b[k][1] - x.b[k][0])))]));
  const consistent = Object.fromEntries(CLOCKS.map((k) => [k, kids.every((x) => x.b[k][0] <= x.b[k][1])])); // false = the bound is impossible (clock not comparable at this resolution)
  // (b)/(c)
  const port = await reservePort();
  let holds = [], tries = [];
  try {
    const [h, tr] = await Promise.all([run(["hold", String(port), "300", "3"]), run(["try", String(port), "800"])]);
    holds = JSON.parse(h.trim() || "[]").filter((x) => x.result === "ok"); tries = JSON.parse(tr.trim() || "[]");
  } finally { releasePort(port); }
  assert.ok(holds.length > 0 && tries.length > 0, "both ordering children produced data");
  const inUse = tries.filter((x) => x.result === "EADDRINUSE").length;
  const order = Object.fromEntries(CLOCKS.map((k) => { const c = contradictions(holds, tries, k); return [k, { pos: c.pos, neg: c.neg, minMargin: minMargin(holds, tries, k) }]; }));
  // (d) injected offsets on B (th): contradictions must appear
  const inj = Object.fromEntries([2, 5, 16].map((sft) => { const c = contradictions(holds, tries, "th", sft); return [sft, c.pos + c.neg]; }));
  t.diagnostic(`#170 clock calibration (${process.platform}/${process.arch} ${process.version}): (a) 6 children x 200 pings, worst |offset| bound ms ${JSON.stringify(worst)}, widest bound ${JSON.stringify(width)}, bounds consistent ${JSON.stringify(consistent)}; (b/c) A holds ${holds.length}, B tries ${tries.length} (EADDRINUSE ${inUse}), contradictions at margin 0 and the smallest margin removing them ${JSON.stringify(order)}; (d) th with B shifted by 2/5/16 ms -> contradictions ${JSON.stringify(inj)}`);
});
