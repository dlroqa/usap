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
const { reservePort, releasePort, LOG_MAX } = require("./fixtures/test-ports.cjs");
const net = require("node:net");
const { lockOwners } = require("./fixtures/port-range-diag.cjs");

const PORTS = path.join(__dirname, "fixtures", "test-ports.cjs");
let lockDir, logFile, nLogs = 0;
const logs = [];
// a fresh reservation log per control (beside the temporary lock directory), removed at the end
const freshLog = () => { const f = path.join(lockDir, "..", `${path.basename(lockDir)}-${++nLogs}.log`); logs.push(f, `${f}.1`); return f; };
test.before(() => { lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "usap-r1bpr-")); });
test.beforeEach(() => { logFile = freshLog(); });
test.after(() => { for (const f of logs) { try { fs.rmSync(f, { force: true }); } catch (_) { /* best effort */ } } });
// Another test process (a child) that reserves `port` in the temporary lock directory, optionally releases it at
// once, and otherwise holds it until stop() (its stdin ends; it releases on exit). This process keeps the shared lock.
function otherReserver(port, { releaseAtOnce = false, log = logFile } = {}) {
  const src = `const p=require(${JSON.stringify(PORTS)});p.reservePort({range:{first:${port},last:${port}},lockDir:${JSON.stringify(lockDir)},logFile:${JSON.stringify(log)}}).then((x)=>{${releaseAtOnce ? "p.releasePort(x);console.log('done '+x);process.exit(0)" : "console.log('held '+x);process.stdin.on('end',()=>process.exit(0));process.stdin.resume()"}},(e)=>{console.log('failed '+e.message);process.exit(3)})`;
  const c = spawn(process.execPath, ["-e", src], { stdio: ["pipe", "pipe", "ignore"] });
  const ready = new Promise((r) => { let out = ""; c.stdout.on("data", (d) => { out += d; if (/(held|done|failed) /.test(out)) r(out.trim()); }); c.once("exit", () => r(out.trim() || "exited")); });
  return { ready, pid: c.pid, stop: () => new Promise((r) => { if (c.exitCode !== null) return r(); c.once("exit", r); try { c.stdin.end(); } catch (_) { r(); } }) };
}
test.after(() => { try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch (_) { /* best effort */ } });
// Every port these controls bind or probe is first reserved through the SHARED lock directory (held for the whole
// test), so no other test file can be handed it meanwhile; the temporary lock directory is then exercised on that
// same port. (1e918b3 used fixed ports in the test range without a shared reservation: a parallel test file that had
// reserved one could fail with EADDRINUSE, or make these controls fail - reproduced.)
const sharedPort = () => reservePort();

test("sequence: one test process reserved and released the port, then another holds it; roles in order; lock now", async () => {
  const t0 = Date.now();
  const port = await sharedPort();
  try {
    const a = otherReserver(port, { releaseAtOnce: true });
    assert.equal(await a.ready, `done ${port}`);
    const b = otherReserver(port);
    assert.equal(await b.ready, `held ${port}`);
    try {
      const line = await describePortRecord({ port, t0, lockDir, logFile });
      assert.match(line, new RegExp(`^port ${port} reservation sequence \\(bookkeeping, not socket ownership\\): -?\\d+ test process A reserve, -?\\d+ test process A release, -?\\d+ test process B reserve; locks now: test process B; in dynamic range (true|false|unknown), in an excluded range (true|false)$`));
    } finally { await b.stop(); }
    assert.deepEqual(reservationLog(port, logFile).map((e) => e.what), ["reserve", "release", "reserve", "release"]);
  } finally { releasePort(port); }
});

test("locks: a lock left by a process that is gone is marked dead", async () => {
  const port = await sharedPort();
  const dead = spawn(process.execPath, ["-e", ""]); await new Promise((r) => dead.once("exit", r));
  fs.writeFileSync(path.join(lockDir, `${port}.${dead.pid}.lock`), "");
  const line = await describePortRecord({ port, t0: Date.now(), lockDir, logFile });
  assert.match(line, /locks now: test process A \(dead\)/);
  fs.rmSync(path.join(lockDir, `${port}.${dead.pid}.lock`));
  releasePort(port);
});

test("holders (full): a listener started by a known role's child is named with its parent's role; not looked up without full", { skip: process.platform === "win32" && "parent lookup through CIM is exercised on CI failures only" }, async () => {
  const port = await sharedPort();
  // "g1": a process that starts a grandchild listening on the port (as a guard -> launcher -> stand-in chain would)
  const g = spawn(process.execPath, ["-e", `const c=require("node:child_process").spawn(process.execPath,["-e","require('node:net').createServer().listen(${port},'127.0.0.1',()=>console.log('up'));setInterval(()=>{},1000)"],{stdio:["ignore","pipe","ignore"]});c.stdout.once("data",()=>console.log("ready "+c.pid));setInterval(()=>{},1000);process.on("SIGTERM",()=>{c.kill();process.exit(0)})`], { stdio: ["ignore", "pipe", "ignore"] });
  const child = await new Promise((r) => g.stdout.on("data", (d) => { const m = /ready (\d+)/.exec(String(d)); if (m) r(Number(m[1])); }));
  try {
    const roles = new Map([[g.pid, "g1"]]);
    const brief = await describePortRecord({ port, t0: Date.now(), roles, lockDir, logFile });
    assert.doesNotMatch(brief, /holders/);
    const full = await describePortRecord({ port, t0: Date.now(), roles, lockDir, logFile, full: true });
    assert.match(full, /holders: another process node\S* alive, parent g1, started -?\d+ \(\+-\d+ ms\) outside every reservation in the log: LISTEN now/);
    assert.ok(!full.includes(String(child)) && !full.includes(String(g.pid)), "no pids printed");
  } finally { g.kill(); await new Promise((r) => g.once("exit", r)); releasePort(port); }
});

// Kill a process by pid and wait (bounded) until it is gone; Windows: taskkill /F (no signals there).
async function killAndWait(pid, ms = 10000) {
  const isAlive = () => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
  if (!isAlive()) return true;
  try { if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 5000 }); else process.kill(pid, "SIGKILL"); } catch (_) { /* already gone */ }
  const end = Date.now() + ms; while (isAlive() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return !isAlive();
}
const bindResult = (port) => new Promise((resolve) => { const s = net.createServer(); s.once("error", (e) => resolve(e.code || "error")); s.listen(port, "127.0.0.1", () => s.close(() => resolve("free"))); });

test("surviving child: a listener that outlives its reserving parent keeps the port; the released lock is not taken as availability; the holder and its origin are named; once it is gone the port is free", { timeout: 60000 }, async () => {
  const port = await sharedPort(), t0 = Date.now();
  const pidFile = path.join(lockDir, "survivor.pid");
  // Parent "test process": reserves the port through test-ports, starts a detached child that listens on it, waits
  // until it listens, then exits normally - which releases its reservation (exit handler) while the child keeps the socket.
  // child: listens on argv[1], writes its pid to argv[2] once listening, ends itself after 45 s at the latest
  const CHILD = "const [port,pidFile]=process.argv.slice(1);require('node:net').createServer().listen(Number(port),'127.0.0.1',()=>require('node:fs').writeFileSync(pidFile,String(process.pid)));setTimeout(()=>process.exit(0),45000);";
  const parentSrc = `const p=require(${JSON.stringify(PORTS)});const fs=require("node:fs");const {spawn}=require("node:child_process");
p.reservePort({range:{first:${port},last:${port}},lockDir:${JSON.stringify(lockDir)},logFile:${JSON.stringify(logFile)}}).then(()=>{
 const c=spawn(process.execPath,["-e",${JSON.stringify(CHILD)},"${port}",${JSON.stringify(pidFile)}],{detached:true,stdio:"ignore",windowsHide:true});
 c.unref(); const end=Date.now()+15000; const w=()=>{ if(fs.existsSync(${JSON.stringify(pidFile)})) process.exit(0); if(Date.now()>end) process.exit(2); setTimeout(w,20); }; w(); });`;
  const parent = spawn(process.execPath, ["-e", parentSrc], { stdio: "ignore" });
  const parentCode = await new Promise((r) => parent.once("exit", r));
  let child = null;
  try {
    assert.equal(parentCode, 0, "parent reserved, started the listener and exited");
    child = Number(fs.readFileSync(pidFile, "utf8"));
    // bookkeeping says released ...
    assert.deepEqual(lockOwners(lockDir, port), [], "no lock after the parent's exit");
    assert.deepEqual(reservationLog(port, logFile).map((e) => e.what), ["reserve", "release"]);
    // ... but the port is still occupied
    assert.equal(await bindResult(port), "EADDRINUSE", "the port is still in use although its reservation was released");
    const line = await describePortRecord({ port, t0, lockDir, logFile, full: true });
    assert.match(line, /reservation sequence \(bookkeeping, not socket ownership\): -?\d+ test process A reserve, -?\d+ test process A release; locks now: none;/);
    // the actual listener, alive, attributed to the reservation that was open when it started
    assert.match(line, /holders: another process node\S* alive, parent ([^,]+), started -?\d+ \(\+-\d+ ms\) during test process A's reservation: (LISTEN|LISTENING) now/);
    // parentage: Windows keeps the original parent id (the gone test process); Linux/macOS re-parent the survivor
    const parentRole = /parent ([^,]+), started/.exec(line)[1];
    if (process.platform === "win32") assert.equal(parentRole, "test process A (gone)", line);
    else assert.notEqual(parentRole, "unknown", line);
    assert.ok(!line.includes(String(child)) && !line.includes(String(parent.pid)), "no pids printed");
    // missing owner: once the survivor is gone the port is free and no live holder is reported
    assert.equal(await killAndWait(child), true, "survivor terminated");
    child = null;
    assert.equal(await bindResult(port), "free");
    const after = await describePortRecord({ port, t0, lockDir, logFile, full: true });
    assert.doesNotMatch(after, / alive, parent /);
  } finally { if (child) await killAndWait(child); releasePort(port); }
});

test("log bound: past LOG_MAX the reservation log moves to .1; both parts are still read", async () => {
  const f = freshLog();
  try {
    fs.writeFileSync(f, `${Date.now()} 1 23990 reserve\n`.padEnd(LOG_MAX + 10, "#"));
    const held = await sharedPort();
    const a = otherReserver(held, { releaseAtOnce: true, log: f });
    assert.equal(await a.ready, `done ${held}`);
    assert.ok(fs.statSync(`${f}.1`).size > LOG_MAX, "old log moved aside");
    assert.ok(fs.statSync(f).size < 200, "new log started small");
    assert.deepEqual(reservationLog(held, f).map((e) => e.what), ["reserve", "release"]);
    releasePort(held);
  } finally { /* removed in test.after */ }
});
