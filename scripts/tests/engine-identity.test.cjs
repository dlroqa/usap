// Controls for the #170 engine identity diagnostics (fixtures/engine-identity.cjs; messages only). Real fake engines
// (api-contract/fake-llama-server.cjs, started directly) produce the cases a PID comparison cannot tell apart, and
// each must read as such: a new process after a real kill; a surviving old child (the kill hit another process); a
// wrong listener (a relay owns the port and forwards to the engine). PID reuse and wrong-generation readiness cannot
// be forced on a real OS, so they are read from real snapshots with only the PID / studio fields replaced. Every
// process is killed in `finally`, every wait has a deadline.
"use strict";
const assert = require("node:assert/strict");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");
const { spawn, spawnSync } = require("node:child_process");
const { reservePort, releasePort } = require("./fixtures/test-ports.cjs");
const id = require("./fixtures/engine-identity.cjs");

const FAKE = path.join(__dirname, "api-contract", "fake-llama-server.cjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
function startFake(port) {
  const p = spawn(process.execPath, [FAKE, "--port", String(port), "--host", "127.0.0.1"], { stdio: "ignore", windowsHide: true });
  procs.push(p); return p;
}
async function until(fn, ms, what) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) assert.fail(`timed out: ${what}`); await sleep(50); } }
function hardKill(pid) {
  if (process.platform === "win32") return spawnSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" }).status;
  try { process.kill(pid, "SIGKILL"); return "sent"; } catch (e) { return e.code; }
}
// Bounded (#170 lifecycle fix): a process that does not exit within ms fails the test here instead of letting it run on
// past its timeout (and past test.after) and start the next fake after cleanup.
const exited = (p, ms = 10000) => (p.exitCode !== null || p.signalCode !== null ? Promise.resolve()
  : new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error(`pid ${p.pid} did not exit within ${ms} ms`)), ms); p.once("exit", () => { clearTimeout(t); resolve(); }); }));
test.after(async () => { for (const p of procs) { try { p.kill("SIGKILL"); } catch (_) { /* gone */ } } });

test("fake stats carry a per-start instance id, start time and parent pid", { timeout: 30000 }, async () => {
  const port = await reservePort();
  try {
    const a = startFake(port);
    const s = await until(() => id.engineStats(port), 10000, "fake up");
    assert.equal(s.pid, a.pid); assert.equal(s.ppid, process.pid);
    assert.match(s.instance, /^[0-9a-f]{12}$/);
    assert.ok(Math.abs(s.startedAt - Date.now()) < 15000);
    a.kill("SIGKILL"); await exited(a);
  } finally { releasePort(port); }
});

test("new process after a real kill: reads 'new process'; the listener owner is the new process", { timeout: 60000 }, async () => {
  const port = await reservePort();
  try {
    const a = startFake(port); await until(() => id.engineStats(port), 10000, "A up");
    const before = await id.snapshot({ label: "before", enginePort: port });
    if (before.lookup !== "unavailable") assert.ok(before.owners.some((o) => o.pid === a.pid), `owner lookup finds A: ${JSON.stringify(before.owners)}`);
    const kill = { pid: a.pid, at: Date.now(), status: hardKill(a.pid), aliveAfter: null }; await exited(a); kill.aliveAfter = id.alive(a.pid);
    // OS creation times have a resolution (macOS ps: 1 s): start B only once A's and B's can differ by more than it
    const resA = (before.procs[a.pid] && before.procs[a.pid].resMs) || 0, aAt = before.procs[a.pid] && before.procs[a.pid].startedAt;
    if (aAt) { const wait = aAt + 2 * resA + 1100 - Date.now(); if (wait > 0) await sleep(Math.min(wait, 5000)); }
    const b = startFake(port); await until(async () => { const s = await id.engineStats(port); return s && s.pid === b.pid; }, 10000, "B up");
    const after = await id.snapshot({ label: "after", enginePort: port });
    const r = id.readEngineIdentity({ before, after, kill });
    assert.equal(r.verdict, "new process", r.line);
    if (after.lookup !== "unavailable") assert.ok(after.owners.some((o) => o.pid === b.pid), r.line);
    assert.ok(id.sameProc(after.procs[b.pid], after.procs[b.pid]) && !id.sameProc(before.procs[a.pid], after.procs[b.pid]), "creation identity differs between A and B");
    assert.ok(r.line.length <= 1500 && !/[\\/]/.test(r.line.replace(/-> /g, "")), r.line);
    b.kill("SIGKILL"); await exited(b);
  } finally { releasePort(port); }
});

test("surviving old child: the kill hits another process; same instance, alive, same creation time", { timeout: 60000 }, async () => {
  const port = await reservePort();
  try {
    const a = startFake(port); await until(() => id.engineStats(port), 10000, "A up");
    const decoy = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" }); procs.push(decoy);
    const before = await id.snapshot({ label: "before", enginePort: port, extraPids: [a.pid] });
    // the test believes it killed A (kill.pid = A) but the signal went to the decoy: A survives
    const kill = { pid: a.pid, at: Date.now(), status: hardKill(decoy.pid), aliveAfter: null }; await exited(decoy); kill.aliveAfter = id.alive(a.pid);
    const after = await id.snapshot({ label: "after", enginePort: port, extraPids: [a.pid] });
    const r = id.readEngineIdentity({ before, after, kill });
    assert.match(r.verdict, /^surviving old child: the killed process \(same instance(, same creation time)?\) was alive right after the kill/, r.line);
    if (after.lookup !== "unavailable") assert.match(r.verdict, /same creation time/, r.line);
    a.kill("SIGKILL"); await exited(a);
  } finally { releasePort(port); }
});

test("wrong listener: a relay owns the port and forwards to the engine; the answer's pid is not the owner", { timeout: 60000 }, async (t) => {
  const port = await reservePort(), inner = await reservePort();
  const relay = net.createServer((c) => { const u = net.connect(inner, "127.0.0.1"); c.pipe(u).pipe(c); c.on("error", () => u.destroy()); u.on("error", () => c.destroy()); });
  try {
    const a = startFake(inner); await until(() => id.engineStats(inner), 10000, "A up");
    await new Promise((r) => relay.listen(port, "127.0.0.1", r));
    const before = await id.snapshot({ label: "before", enginePort: port });
    const after = await id.snapshot({ label: "after", enginePort: port });
    if (after.lookup === "unavailable") { t.diagnostic("owner lookup unavailable here: the wrong-listener rule needs it"); return; }
    assert.ok(after.owners.some((o) => o.pid === process.pid), `the relay (this process) owns the port: ${JSON.stringify(after.owners)}`);
    const r = id.readEngineIdentity({ before, after });
    assert.match(r.verdict, new RegExp(`^wrong listener: the answer came from pid ${a.pid} but the listening socket is owned by ${process.pid}`), r.line);
    a.kill("SIGKILL"); await exited(a);
  } finally { await new Promise((r) => relay.close(r)); releasePort(port); releasePort(inner); }
});

test("PID reuse, wrong-generation readiness and fixture errors (real snapshots, PID / studio fields replaced)", { timeout: 60000 }, async () => {
  const port = await reservePort();
  try {
    const a = startFake(port); await until(() => id.engineStats(port), 10000, "A up");
    const before = await id.snapshot({ label: "before", enginePort: port });
    const kill = { pid: a.pid, at: Date.now(), status: hardKill(a.pid), aliveAfter: null }; await exited(a); kill.aliveAfter = id.alive(a.pid);
    const b = startFake(port); await until(async () => { const s = await id.engineStats(port); return s && s.pid === b.pid; }, 10000, "B up");
    const real = await id.snapshot({ label: "after", enginePort: port });
    // PID reuse: B as if the OS had given it A's pid (owners follow the answer)
    const reused = { ...real, stats: { ...real.stats, pid: a.pid }, owners: real.owners.map((o) => ({ ...o, pid: a.pid })), procs: { ...real.procs, [a.pid]: real.procs[b.pid] } };
    const r1 = id.readEngineIdentity({ before, after: reused, kill });
    assert.match(r1.verdict, new RegExp(`^PID reuse: a new process \\(instance ${real.stats.instance}, started -?\\d+, -?\\d+ ms after the kill.*\\) got the old pid ${a.pid}, NOT under the studio's current engine record$`), r1.line);
    const underStudio = { ...reused, supervised: [{ guardPid: 1, enginePid: reused.stats.ppid, startedAt: Date.now() }] };
    assert.match(id.readEngineIdentity({ before, after: underStudio, kill }).verdict, /, child of the studio's current engine record$/);
    // wrong-generation readiness: the old instance answers while the studio is ready on a new guard
    const oldAns = { ...real, stats: before.stats, owners: before.owners, procs: before.procs, studio: { state: "ready", ready: true, restarts: 1 }, supervised: [{ guardPid: 99999, enginePid: 99998, startedAt: Date.now() }] };
    const r2 = id.readEngineIdentity({ before: { ...before, supervised: [{ guardPid: 11111, enginePid: 11112, startedAt: before.at }] }, after: oldAns, kill: { ...kill, aliveAfter: true } });
    assert.match(r2.verdict, /^surviving old child.*; wrong-generation readiness: the studio reports ready for a new generation \(guard 99999\) while the old instance answers$/, r2.line);
    // fixture errors
    assert.match(id.readEngineIdentity({ before, after: { ...real, stats: null }, kill }).verdict, /^no engine answer/);
    assert.match(id.readEngineIdentity({ before: { ...before, stats: { ...before.stats, instance: null } }, after: real, kill }).verdict, /^identity unavailable: .*\(test-fixture\)$/);
    b.kill("SIGKILL"); await exited(b);
  } finally { releasePort(port); }
});

test("sampler: transitions only, bounded, stopped cleanly", { timeout: 30000 }, async () => {
  const port = await reservePort();
  try {
    const t0 = Date.now(); const s = id.startSampler({ enginePort: port, intervalMs: 30, t0 });
    let out = null, a = null;
    try { // stop the sampler and the fake on every path: a failed wait must not leave the loop running (#125)
      await sleep(150); a = startFake(port); await until(() => id.engineStats(port), 10000, "A up"); await sleep(150);
      a.kill("SIGKILL"); await exited(a); a = null; await sleep(150);
    } finally { if (a) { try { a.kill("SIGKILL"); } catch (_) {} } out = await s.stop(); }
    assert.deepEqual(out.map((x) => x.replace(/^\d+ /, "").replace(/^[0-9a-f]+\/\d+$/, "ANSWER")), ["no answer", "ANSWER", "no answer"], JSON.stringify(out));
    assert.ok(out.length <= 60);
  } finally { releasePort(port); }
});

// #170 lifecycle controls (round 15): every observer in fixtures/engine-identity.cjs ends on its own.
test("lifecycle: a response cut after its headers settles null; a throwing status, a never-stopped sampler and a stop() mid-sleep all end", { timeout: 30000 }, async () => {
  const cut = net.createServer((c) => { c.on("error", () => {}); c.once("data", () => { c.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"); setTimeout(() => c.destroy(), 50); }); });
  await new Promise((r) => cut.listen(0, "127.0.0.1", r));
  try {
    const t0 = Date.now();
    assert.equal(await id.engineStats(cut.address().port), null, "a cut response reads as no answer");
    assert.ok(Date.now() - t0 < 2500, `settled in ${Date.now() - t0} ms (bound 1500 + 500)`);
  } finally { await new Promise((r) => cut.close(r)); }
  const port = await reservePort();
  try {
    const thrower = id.startSampler({ enginePort: port, intervalMs: 20, status: () => { throw new Error("injected"); } });
    await sleep(100);
    const out1 = await thrower.stop();
    assert.ok(out1.length >= 1 && out1.every((x) => /no answer/.test(x)), JSON.stringify(out1));
    const bounded = id.startSampler({ enginePort: port, intervalMs: 20, maxMs: 300 }); // never stopped by the caller
    await sleep(700);
    const t1 = Date.now(); const out2 = await bounded.stop();
    assert.ok(out2.some((x) => /sampler bound$/.test(x)), `ended at its bound: ${JSON.stringify(out2)}`);
    assert.ok(Date.now() - t1 < 100, "stop() after the bound returns at once");
    const slow = id.startSampler({ enginePort: port, intervalMs: 5000 });
    await sleep(100);
    const t2 = Date.now(); await slow.stop();
    assert.ok(Date.now() - t2 < 1000, `stop() cancels a pending 5 s sleep (${Date.now() - t2} ms)`);
  } finally { releasePort(port); }
  const stuck = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore" }); procs.push(stuck);
  try { await assert.rejects(exited(stuck, 300), /did not exit within 300 ms/); } finally { stuck.kill("SIGKILL"); }
});
