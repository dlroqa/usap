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
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");
const { makeRoot, startServer, stopServer, removeTestRoot, request } = require("./api-contract/harness.cjs");
const { reservePort, releasePort, heldPorts } = require("./fixtures/test-ports.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const listening = (port) => new Promise((r) => { const s = net.connect(port, "127.0.0.1"); const t = setTimeout(() => { s.destroy(); r(false); }, 1000); s.once("connect", () => { clearTimeout(t); s.destroy(); r(true); }); s.once("error", () => { clearTimeout(t); r(false); }); });

test("released studio ports: a port still listened on by the stopped studio's engine is never handed out; the engine is gone within 10 s", { timeout: 120000 }, async (t) => {
  const lines = [];
  for (let cycle = 1; cycle <= 3; cycle += 1) {
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
          .then(async (r) => { rec.granted = r.granted; rec.listeningAtDecision = await listening(port); rec.decidedMs = Date.now() - rec.at; if (r.granted) releasePort(port); resolve(rec); });
      }));
      stopServer(srv);
      const rec = await atRelease;
      let goneMs = null;
      for (const end = Date.now() + 10000; Date.now() < end; await sleep(20)) if (!alive(enginePid) && !(await listening(port))) { goneMs = Date.now() - rec.at; break; }
      lines.push(`cycle ${cycle}: released ${rec.released}, engine alive at release ${rec.engineAlive}, re-reservation ${rec.granted ? "granted" : "refused"} (${rec.decidedMs} ms), port listened on right after the decision ${rec.listeningAtDecision}, old engine gone and port free ${goneMs === null ? "NOT within 10 s" : `+${goneMs} ms`}`);
      assert.equal(rec.released, true, "startServer released the port when the studio exited");
      // judged at the decision: this process holds the port's lock then, so a listener right after a grant is the old one
      assert.ok(!(rec.granted && rec.listeningAtDecision), `a port still listened on by the old engine was handed out: ${lines[lines.length - 1]}`);
      assert.notEqual(goneMs, null, `the stopped studio's engine is gone and its port free within 10 s: ${lines[lines.length - 1]}`);
    } finally { removeTestRoot(root); }
  }
  t.diagnostic(`harness release (${process.platform}): ${lines.join("; ")}`);
});
