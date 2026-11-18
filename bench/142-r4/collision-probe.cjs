// #142 probe: does an outgoing loopback connection whose SOURCE port is P make a later listen(P, 127.0.0.1) fail?
// Mirrors the harness: freePort() (listen 0, close) hands P to the engine, which binds P later.
"use strict";
const net = require("node:net");
const listenOn = (port) => new Promise((resolve) => { const s = net.createServer(); s.once("error", (e) => resolve({ ok: false, code: e.code })); s.listen(port, "127.0.0.1", () => { s.close(() => resolve({ ok: true })); }); });
(async () => {
  const target = net.createServer((c) => c.on("error", () => {})); await new Promise((r) => target.listen(0, "127.0.0.1", r));
  const free = await new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
  // an outgoing connection that uses `free` as its source port (as an ephemeral pick would)
  const c = net.connect({ port: target.address().port, host: "127.0.0.1", localAddress: "127.0.0.1", localPort: free });
  await new Promise((r, j) => { c.once("connect", r); c.once("error", j); });
  const whileConnected = await listenOn(free);
  c.destroy(); await new Promise((r) => setTimeout(r, 100));
  const afterClose = await listenOn(free); // TIME_WAIT on the client side of that port
  console.log(JSON.stringify({ platform: `${process.platform}-${process.arch}`, node: process.version, port: free, whileConnected, afterClientClosed: afterClose }));
  target.close();
})();
