// Controls for the #170 R1b port record (fixtures/r1b-port-record.cjs; messages only): the reservation sequence
// across test processes reads in order with roles, a dead lock owner is marked, a holder found by a passive read is
// named with its PARENT's role, and without `full` no holder lookup runs. A temporary lock directory and range are
// used, never the shared ones.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const test = require("node:test");
const { describePortRecord, reservationLog } = require("./fixtures/r1b-port-record.cjs");
const { reservePort, releasePort } = require("./fixtures/test-ports.cjs");

const PORTS = path.join(__dirname, "fixtures", "test-ports.cjs");
let lockDir, logFile;
test.before(() => { lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "usap-r1bpr-")); logFile = path.join(lockDir, "..", `${path.basename(lockDir)}.log`); });
test.after(() => { try { fs.rmSync(logFile, { force: true }); } catch (_) { /* best effort */ } });
test.after(() => { try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch (_) { /* best effort */ } });
const range = { first: 23900, last: 23999 };

test("sequence: another test process reserved and released the port before this one; roles in order; lock now", async () => {
  const t0 = Date.now();
  const port = Number(execFileSync(process.execPath, ["-e", `const p=require(${JSON.stringify(PORTS)});p.reservePort({range:${JSON.stringify(range)},lockDir:${JSON.stringify(lockDir)},logFile:${JSON.stringify(logFile)}}).then((x)=>{p.releasePort(x);console.log(x)})`], { encoding: "utf8" }).trim());
  const mine = await reservePort({ range: { first: port, last: port }, lockDir, logFile });
  assert.equal(mine, port);
  try {
    const line = await describePortRecord({ port, t0, lockDir, logFile });
    assert.match(line, new RegExp(`^port ${port} reservation sequence: -?\\d+ test process A reserve, -?\\d+ test process A release, -?\\d+ this test process reserve; locks now: this test process; in dynamic range (true|false|unknown), in an excluded range (true|false)$`));
    assert.deepEqual(reservationLog(port, logFile).map((e) => e.what), ["reserve", "release", "reserve"]);
  } finally { releasePort(mine); }
  assert.deepEqual(reservationLog(port, logFile).map((e) => e.what), ["reserve", "release", "reserve", "release"]);
});

test("locks: a lock left by a process that is gone is marked dead", async () => {
  const port = 23950;
  const dead = spawn(process.execPath, ["-e", ""]); await new Promise((r) => dead.once("exit", r));
  fs.writeFileSync(path.join(lockDir, `${port}.${dead.pid}.lock`), "");
  const line = await describePortRecord({ port, t0: Date.now(), lockDir });
  assert.match(line, /locks now: test process A \(dead\)/);
  fs.rmSync(path.join(lockDir, `${port}.${dead.pid}.lock`));
});

test("holders (full): a listener started by a known role's child is named with its parent's role; not looked up without full", { skip: process.platform === "win32" && "parent lookup through CIM is exercised on CI failures only" }, async () => {
  const port = 23960;
  // "g1": a process that starts a grandchild listening on the port (as a guard -> launcher -> stand-in chain would)
  const g = spawn(process.execPath, ["-e", `const c=require("node:child_process").spawn(process.execPath,["-e","require('node:net').createServer().listen(${port},'127.0.0.1',()=>console.log('up'));setInterval(()=>{},1000)"],{stdio:["ignore","pipe","ignore"]});c.stdout.once("data",()=>console.log("ready "+c.pid));setInterval(()=>{},1000);process.on("SIGTERM",()=>{c.kill();process.exit(0)})`], { stdio: ["ignore", "pipe", "ignore"] });
  const child = await new Promise((r) => g.stdout.on("data", (d) => { const m = /ready (\d+)/.exec(String(d)); if (m) r(Number(m[1])); }));
  try {
    const roles = new Map([[g.pid, "g1"]]);
    const brief = await describePortRecord({ port, t0: Date.now(), roles, lockDir });
    assert.doesNotMatch(brief, /holders/);
    const full = await describePortRecord({ port, t0: Date.now(), roles, lockDir, full: true });
    assert.match(full, /holders: another process node\S* alive, parent g1: LISTEN now/);
    assert.ok(!full.includes(String(child)) && !full.includes(String(g.pid)), "no pids printed");
  } finally { g.kill(); await new Promise((r) => g.once("exit", r)); }
});
