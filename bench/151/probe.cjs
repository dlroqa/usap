// Bench only (issue #151, bench/151-json413-macos): never merged. Repeats json-413's concurrent scenario against the
// real server: 10 clients each declare a 100 MiB JSON body and keep sending. For a client that has received nothing
// 1500 ms after its request, it snapshots the kernel's view of that connection (netstat Recv-Q/Send-Q for both
// ends) and the client's own timings. Output: timings, statuses and queue sizes only.
"use strict";
const net = require("node:net"); const fs = require("node:fs"); const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { makeRoot, startServer, stopServerAndWait, removeTestRoot } = require("../../scripts/tests/api-contract/harness.cjs");
const MiB = 1048576, CHUNK = Buffer.alloc(65536, 0x61), ROUNDS = Number(process.argv[2] || 20);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function netstat(ports) {
  try {
    const out = execFileSync("netstat", ["-an", "-p", "tcp"], { encoding: "utf8", timeout: 5000 });
    return out.split("\n").filter((l) => ports.some((p) => l.includes(`.${p} `))).map((l) => l.trim().replace(/\s+/g, " "));
  } catch (e) { return [`netstat failed: ${e.message}`]; }
}
function client(port, i, onStall) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1", allowHalfOpen: true });
    const st = { i, t0: Date.now(), connectAt: null, headAt: null, firstDataAt: null, endAt: null, errorAt: null, closedAt: null, status: null, sent: 0, error: null, localPort: null, stall: null };
    const rel = () => Date.now() - st.t0; let stopped = false;
    s.on("data", (d) => { if (st.firstDataAt === null) { st.firstDataAt = rel(); const m = d.toString("latin1").match(/^HTTP\/1\.1 (\d{3})/); st.status = m ? Number(m[1]) : -1; } });
    s.on("end", () => { st.endAt = rel(); });
    s.on("error", (e) => { st.error = e.code || e.message; if (st.errorAt === null) st.errorAt = rel(); });
    s.on("close", () => { stopped = true; st.closedAt = rel(); resolve(st); });
    setTimeout(() => { stopped = true; s.destroy(); }, 12000);
    s.on("connect", () => {
      st.connectAt = rel(); st.localPort = s.localPort;
      s.write(`POST /api/cleanup HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${100 * MiB}\r\n\r\n`, () => { st.headAt = rel(); });
      setTimeout(() => { if (st.firstDataAt === null && !stopped) st.stall = { at: rel(), sent: st.sent, kernel: onStall(st.localPort) }; }, 1500);
      const pump = () => { while (!stopped && !s.destroyed && st.sent < 100 * MiB) { st.sent += CHUNK.length; if (!s.write(CHUNK)) { s.once("drain", pump); return; } } };
      pump();
    });
  });
}
(async () => {
  const root = makeRoot(); const log = path.join(root, "conn-log.jsonl");
  const preload = path.join(__dirname, "..", "..", "scripts", "tests", "api-contract", "connection-log-preload.cjs").replace(/\\/g, "/");
  const srv = await startServer(root, { USAP_TEST_CONN_LOG: log, USAP_TEST_CONN_LOG_PREFIX: "/api/cleanup", NODE_OPTIONS: `--require "${preload}"` });
  let lost = 0, total = 0;
  try {
    for (let r = 0; r < ROUNDS; r++) {
      const sts = await Promise.all(Array.from({ length: 10 }, (_, i) => client(srv.port, i, (lp) => netstat([lp, srv.port]).filter((l) => l.includes(`.${lp} `)))));
      await sleep(300);
      const recs = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
      for (const st of sts) {
        total++;
        if (st.status === 413) continue;
        lost++;
        const rec = recs.find((x) => x.remotePort === st.localPort);
        console.log(JSON.stringify({ round: r, client: st.i, c: { ...st, t0: undefined }, server: rec ? { status: rec.status, arrivedRel: rec.arrivedAt - st.t0, answerMs: rec.finishAt - rec.arrivedAt, closeAfterAnswerMs: rec.sockCloseAt - rec.finishAt } : null }));
      }
    }
  } finally { await stopServerAndWait(srv); removeTestRoot(root); }
  console.log(`SUMMARY lost ${lost}/${total}`);
})();
