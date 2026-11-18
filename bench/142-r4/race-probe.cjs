// #142 probe: the harness pattern freePort() -> (delay) -> engine listen(port), run by several processes at once
// (node --test runs files in parallel). Counts how often the later listen fails, and with which error.
//   node race-probe.cjs [workers=4] [iterations=1500]
"use strict";
const net = require("node:net"); const { fork } = require("node:child_process");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const listenOn = (port) => new Promise((resolve) => { const s = net.createServer(); s.once("error", (e) => resolve({ err: e.code })); s.listen(port, "127.0.0.1", () => resolve({ s })); });
if (process.argv[2] === "worker") {
  (async () => {
    const n = Number(process.argv[3]); const out = { tries: 0, failures: {}, ports: [] };
    for (let i = 0; i < n; i += 1) {
      const p = await freePort(); out.tries += 1; if (out.ports.length < 50) out.ports.push(p);
      await sleep(Math.floor(Math.random() * 40));          // harness: the engine binds some ms later
      // other traffic meanwhile: a few outgoing loopback connections (ephemeral source ports)
      const r = await listenOn(p);
      if (r.err) out.failures[r.err] = (out.failures[r.err] || 0) + 1;
      else { await sleep(Math.floor(Math.random() * 30)); await new Promise((d) => r.s.close(d)); }
    }
    process.send(out, () => process.exit(0));
  })();
} else {
  const W = Number(process.argv[2] || 4), N = Number(process.argv[3] || 1500);
  const t0 = Date.now();
  Promise.all(Array.from({ length: W }, () => new Promise((res) => { const c = fork(__filename, ["worker", String(N)]); c.once("message", res); }))).then((rs) => {
    const failures = {}; let tries = 0;
    for (const r of rs) { tries += r.tries; for (const [k, v] of Object.entries(r.failures)) failures[k] = (failures[k] || 0) + v; }
    console.log(JSON.stringify({ platform: `${process.platform}-${process.arch}`, node: process.version, workers: W, tries, failures, ms: Date.now() - t0, samplePorts: rs[0].ports.slice(0, 12) }));
  });
}
