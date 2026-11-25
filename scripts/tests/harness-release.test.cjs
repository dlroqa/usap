// Isolation control for the shared test-port reservations (test-only; fixtures/test-ports.cjs, api-contract/harness.cjs).
// startServer() releases the studio's five reserved ports when the studio process exits ("its engines are stopped with
// it"). On POSIX the studio's engines run in their own process groups and are stopped by their guards after the
// studio is gone, so for a short time a released port can still belong to a live engine of the stopped studio, while
// another test file running in parallel may already reserve it. What protects that file is reservePort()'s bind probe.
// This control stops a real studio with a running text engine, and at the moment the ports are released it records
// whether the engine is still alive and still listening (one line per cycle, messages only). It then tries to reserve
// exactly that port, and asserts the property the parallel test files rely on: a port that is still being listened
// on is never handed out. It also asserts the old engine is gone and the port free within a bounded time. Nothing in
// the harness or in port selection changes.
//
// Attribution (round 16): reservePort() refuses a port for one of two reasons that it reports the same way: another
// live test process holds its lock, or the bind probe found the port in use. Each refusal is now attributed, without
// changing reservePort:
//   lock   a read-only look at the shared lock directory: a live owner other than this process;
//   probe  the same reservation again with a PRIVATE, EMPTY lock directory, where the lock cannot refuse;
//   holder who listens right after: the old engine (its /fake/stats pid) or another holder.
// The isolated controls below create each reason on purpose (a listener, a live lock owner, an unrelated holder,
// a free port) and require the attribution to name it; disabling the bind probe is caught on every OS. The studio
// cycles count as NON-VACUOUS only when the old engine was alive at release, still listened on the port at the
// decision, and the refusal is attributed to the probe. On POSIX at least one such cycle is required (up to 6
// cycles); on Windows (taskkill /T ends the engine with the studio) a run with none is reported as INCONCLUSIVE
// (test skipped with the reason), never as a pass of that property. The original assertions are unchanged.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { makeRoot, startServer, stopServer, removeTestRoot, request } = require("./api-contract/harness.cjs");
const { reservePort, releasePort, heldPorts, LOCK_DIR } = require("./fixtures/test-ports.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const listening = (port) => new Promise((r) => { const s = net.connect(port, "127.0.0.1"); const t = setTimeout(() => { s.destroy(); r(false); }, 1000); s.once("connect", () => { clearTimeout(t); s.destroy(); r(true); }); s.once("error", () => { clearTimeout(t); r(false); }); });

// ── attribution (read-only for the shared directory; a private directory for the probe-only reservation) ──────────
const LOCK_RE = /^(\d+)\.(\d+)\.lock$/;
function liveLockOwners(lockDir, port) { // the same rule as test-ports.cjs claim(): live owners other than this process
  let names = []; try { names = fs.readdirSync(lockDir); } catch (_) { return []; }
  return names.map((n) => LOCK_RE.exec(n)).filter((m) => m && Number(m[1]) === port && Number(m[2]) !== process.pid && alive(Number(m[2]))).map((m) => Number(m[2]));
}
async function probeOnly(port) { // reservePort with an empty private lock dir: only the bind probe can refuse
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usap-probe-only-"));
  try {
    const p = await reservePort({ range: { first: port, last: port }, lockDir: dir }).then((x) => x, () => null);
    if (p === port) releasePort(port);
    return p === port ? "granted" : "refused";
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
}
function holderPid(port) { // a fake engine answers /fake/stats with its pid; anything else listening (or silent) is "other"
  return listening(port).then((on) => (!on ? null : new Promise((resolve) => {
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const req = require("node:http").get({ host: "127.0.0.1", port, path: "/fake/stats", timeout: 500 }, (res) => {
      let text = ""; res.on("data", (c) => { if (text.length < 4096) text += c; }); res.on("end", () => { try { fin(JSON.parse(text).pid || "other"); } catch (_) { fin("other"); } });
      res.on("error", () => fin("other"));
    });
    req.on("timeout", () => { req.destroy(); fin("other"); }); req.on("error", () => fin("other"));
  })));
}
// lockDir: the directory the refused reservation used. Returns { reason, lockOwners, probe, holder }.
async function attribute(port, { lockDir = LOCK_DIR, enginePid = null } = {}) {
  const lockOwners = liveLockOwners(lockDir, port);
  const probe = await probeOnly(port);
  const h = await holderPid(port);
  // holder: "old engine" only when the listener answers /fake/stats with that pid; a listener that does not identify
  // itself (a dying engine, or an unrelated program) is "unidentified" - never claimed as either
  const holder = h === null ? "none" : enginePid !== null && h === enginePid ? "old engine" : "unidentified";
  // "gone": refused at the decision, but neither the lock nor the probe refuses a few ms later (cause not reproducible)
  const reason = lockOwners.length && probe === "refused" ? "lock+probe" : lockOwners.length ? "lock" : probe === "refused" ? "probe" : "gone";
  return { reason, lockOwners: lockOwners.length, probe, holder };
}

// ── isolated attribution controls (every OS; no studio) ────────────────────────────────────────────────────────
test("attribution controls: a listener reads 'probe', a live lock owner reads 'lock', an unrelated holder reads 'probe' (unidentified), a free port reads 'gone'", { timeout: 60000 }, async (t) => {
  const port = await reservePort(); releasePort(port); // a free port from the shared range, released for the controls
  const children = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usap-attr-"));
  try {
    // free
    assert.deepEqual(await attribute(port, { lockDir: dir }), { reason: "gone", lockOwners: 0, probe: "granted", holder: "none" });
    // probe: this process listens on the port; the lock directory is empty
    const own = net.createServer((c) => c.destroy()); // destroys what the probes connect, so own.close() can complete
    await new Promise((r) => own.listen(port, "127.0.0.1", r));
    try {
      await assert.rejects(reservePort({ range: { first: port, last: port }, lockDir: dir }), /no free test port/, "refused");
      const a = await attribute(port, { lockDir: dir, enginePid: -1 });
      assert.equal(a.reason, "probe", JSON.stringify(a)); assert.equal(a.lockOwners, 0); assert.equal(a.holder, "unidentified");
    } finally { await new Promise((r) => own.close(r)); }
    // lock: a live child process owns the port's lock; nothing listens
    const locker = spawn(process.execPath, ["-e", `require("fs").writeFileSync(${JSON.stringify(path.join(dir, `${port}.`))} + process.pid + ".lock", ""); process.stdout.write("ok"); setTimeout(() => {}, 30000)`], { stdio: ["ignore", "pipe", "ignore"] });
    children.push(locker);
    await new Promise((r) => locker.stdout.once("data", r));
    await assert.rejects(reservePort({ range: { first: port, last: port }, lockDir: dir }), /no free test port/, "refused by the lock");
    const b = await attribute(port, { lockDir: dir });
    assert.deepEqual(b, { reason: "lock", lockOwners: 1, probe: "granted", holder: "none" }, JSON.stringify(b));
    locker.kill("SIGKILL"); await new Promise((r) => (locker.exitCode !== null || locker.signalCode !== null ? r() : locker.once("exit", r)));
    // other holder: an unrelated process listens (not a fake engine)
    const other = spawn(process.execPath, ["-e", `require("net").createServer().listen(${port}, "127.0.0.1", () => process.stdout.write("ok")); setTimeout(() => {}, 30000)`], { stdio: ["ignore", "pipe", "ignore"] });
    children.push(other);
    await new Promise((r) => other.stdout.once("data", r));
    const c = await attribute(port, { lockDir: dir, enginePid: 12345 });
    assert.deepEqual(c, { reason: "probe", lockOwners: 0, probe: "refused", holder: "unidentified" }, JSON.stringify(c));
    t.diagnostic(`harness release attribution controls (${process.platform}): free port reads gone; listener refused by the probe; live lock owner ${JSON.stringify(b)}; unrelated holder ${JSON.stringify(c)}`);
  } finally {
    for (const ch of children) { try { ch.kill("SIGKILL"); } catch (_) {} }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

test("released studio ports: a port still listened on by the stopped studio's engine is never handed out; the engine is gone within 10 s", { timeout: 240000 }, async (t) => {
  const lines = [];
  let nonVacuous = 0, cycle = 0;
  const POSIX = process.platform !== "win32";
  while (cycle < 3 || (POSIX && nonVacuous === 0 && cycle < 6)) {
    cycle += 1;
    const root = makeRoot();
    try {
      fs.writeFileSync(path.join(root, "app", "llm-models", "plain.gguf"), Buffer.from("GGUF\x03\x00\x00\x00"));
      const srv = await startServer(root);
      assert.equal((await request(srv.port, "POST", "/api/llm/start", { body: { model: "plain.gguf", contextSize: 512, gpuLayers: 0 } })).status, 200, srv.log().slice(-800));
      const st = (await request(srv.port, "GET", "/api/llm/status")).json;
      const port = st.port;
      assert.ok(heldPorts().includes(port), "the text engine's port is one of the studio's reservations");
      const enginePid = JSON.parse((await request(port, "GET", "/fake/stats", { raw: true })).text).pid;
      // registered after startServer's own exit listener, so the ports are already released when this runs
      const atRelease = new Promise((resolve) => srv.proc.once("exit", () => {
        const rec = { at: Date.now(), released: !heldPorts().includes(port), engineAlive: alive(enginePid) };
        // try to take exactly this port, as a parallel test file would; then check who listens right after the decision
        reservePort({ range: { first: port, last: port } })
          .then((p) => ({ granted: p === port }), () => ({ granted: false }))
          .then(async (r) => {
            rec.granted = r.granted; rec.listeningAtDecision = await listening(port); rec.decidedMs = Date.now() - rec.at;
            if (r.granted) releasePort(port);
            // attribution of a refusal (after the unchanged decision above; a few ms later)
            if (!r.granted) { try { rec.attr = await attribute(port, { enginePid }); } catch (_) { rec.attr = { reason: "attribution failed" }; } }
            resolve(rec);
          });
      }));
      stopServer(srv);
      const rec = await atRelease;
      let goneMs = null;
      for (const end = Date.now() + 10000; Date.now() < end; await sleep(20)) if (!alive(enginePid) && !(await listening(port))) { goneMs = Date.now() - rec.at; break; }
      const nv = rec.engineAlive && rec.listeningAtDecision && !rec.granted && rec.attr && /^probe/.test(rec.attr.reason);
      if (nv) nonVacuous += 1;
      lines.push(`cycle ${cycle}: released ${rec.released}, engine alive at release ${rec.engineAlive}, re-reservation ${rec.granted ? "granted" : "refused"} (${rec.decidedMs} ms), port listened on right after the decision ${rec.listeningAtDecision}, refusal attributed ${rec.attr ? JSON.stringify(rec.attr) : "-"}, ${nv ? "NON-VACUOUS" : "vacuous"}, old engine gone and port free ${goneMs === null ? "NOT within 10 s" : `+${goneMs} ms`}`);
      assert.equal(rec.released, true, "startServer released the port when the studio exited");
      // judged at the decision: this process holds the port's lock then, so a listener right after a grant is the old one
      assert.ok(!(rec.granted && rec.listeningAtDecision), `a port still listened on by the old engine was handed out: ${lines[lines.length - 1]}`);
      assert.notEqual(goneMs, null, `the stopped studio's engine is gone and its port free within 10 s: ${lines[lines.length - 1]}`);
    } finally { removeTestRoot(root); }
  }
  t.diagnostic(`harness release (${process.platform}): ${lines.join("; ")}; non-vacuous cycles ${nonVacuous}/${cycle}`);
  if (POSIX) assert.ok(nonVacuous >= 1, `at least one non-vacuous cycle (engine alive and listening at the decision, refusal attributed to the bind probe) in ${cycle}: ${lines.join("; ")}`);
  else if (nonVacuous === 0) t.skip(`INCONCLUSIVE on ${process.platform}: 0/${cycle} non-vacuous cycles (the engine ends with the studio), so this run does not show the bind probe protecting a released port; the isolated attribution controls above do`);
});
