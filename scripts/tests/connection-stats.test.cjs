// Observe-only connection statistics (scripts/server/http/connection-stats.cjs; /api/diagnostics `connections`):
// every accepted TCP connection is counted from acceptance (also without complete headers), classified local/lan with
// sign-in's address normalisation, released exactly once on close; aggregate numbers only; never refuses or delays.
"use strict";
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const test = require("node:test");

const { createConnectionStats, classifyPeer } = require("../server/http/connection-stats.cjs");
const { makeRoot, startServer, stopServerAndWait, removeTestRoot, request } = require("./api-contract/harness.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000, what = "condition") {
  const end = Date.now() + ms;
  for (;;) { if (fn()) return; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(10); }
}
async function withServer(fn, { host = "127.0.0.1", classify } = {}) {
  const server = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("ok"); });
  const stats = createConnectionStats(classify ? { classify } : {}).attach(server);
  await new Promise((r) => server.listen(0, host, r));
  const sockets = [];
  const connect = (opts = {}) => new Promise((resolve, reject) => {
    const s = net.connect({ port: server.address().port, host: "127.0.0.1", ...opts }, () => resolve(s));
    s.on("error", () => {}); s.once("error", reject); sockets.push(s);
  });
  try { return await fn({ server, stats, connect }); }
  finally { for (const s of sockets) s.destroy(); server.closeAllConnections(); await new Promise((r) => server.close(r)); }
}
const fakeSocket = (remoteAddress) => Object.assign(new EventEmitter(), { remoteAddress });

test("classification: loopback (IPv4 127/8, ::1, IPv4-mapped loopback) is local; everything else, and unknown, is lan", () => {
  for (const a of ["127.0.0.1", "127.12.0.9", "::1", "::ffff:127.0.0.1", "::FFFF:127.0.0.1"]) assert.equal(classifyPeer(a), "local", a);
  for (const a of ["192.168.1.5", "10.0.0.1", "::ffff:192.168.1.5", "fe80::1%en0", "2001:db8::1", "0.0.0.0", "", undefined, null]) assert.equal(classifyPeer(a), "lan", String(a));
});

test("counted from acceptance: idle connections and incomplete headers are open; each is released exactly once on close", async () => {
  await withServer(async ({ stats, connect }) => {
    const idle = await Promise.all(Array.from({ length: 12 }, () => connect()));
    const partial = await connect(); partial.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Slow:"); // never completes
    await until(() => stats.snapshot().open === 13, 5000, "13 open");
    let s = stats.snapshot();
    assert.equal(s.local.open, 13); assert.equal(s.lan.open, 0); assert.equal(s.peakOpen, 13); assert.equal(s.accepted, 13);
    for (const c of [...idle, partial]) c.destroy();
    await until(() => stats.snapshot().open === 0, 5000, "all released");
    s = stats.snapshot();
    assert.equal(s.local.closed, 13); assert.equal(s.local.closedWithoutRequest, 13, "none of them made a complete request");
    assert.equal(s.peakOpen, 13, "peak kept");
    assert.equal(Object.values(s.local.lifetimeMs).reduce((a, b) => a + b, 0), 13, "every close in exactly one lifetime bucket");
  });
});

test("keep-alive and pipelining: one connection carrying several requests counts once; first request is timed once", async () => {
  await withServer(async ({ stats, connect }) => {
    const c = await connect(); let got = "";
    c.on("data", (d) => { got += d; });
    c.write("GET /a HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".repeat(5));
    await until(() => (got.match(/HTTP\/1\.1 200/g) || []).length === 5, 5000, "5 answers");
    let s = stats.snapshot();
    assert.equal(s.accepted, 1); assert.equal(s.local.open, 1);
    assert.equal(Object.values(s.local.firstRequestMs).reduce((a, b) => a + b, 0), 1, "first request recorded once");
    c.end(); await until(() => stats.snapshot().open === 0, 5000, "released");
    s = stats.snapshot();
    assert.equal(s.local.closed, 1); assert.equal(s.local.closedWithoutRequest, 0);
  });
});

test("abrupt disconnects and server shutdown release every connection; counts never go negative", async () => {
  await withServer(async ({ server, stats, connect }) => {
    const a = await Promise.all(Array.from({ length: 5 }, () => connect()));
    await until(() => stats.snapshot().open === 5, 5000, "5 open");
    a[0].resetAndDestroy(); a[1].destroy();
    await until(() => stats.snapshot().open === 3, 5000, "two released");
    server.closeAllConnections(); // shutdown path: the server closes the rest
    await until(() => stats.snapshot().open === 0, 5000, "all released on shutdown");
    const s = stats.snapshot();
    assert.equal(s.local.closed, 5); assert.ok(s.local.open === 0 && s.lan.open === 0);
  });
});

test("exactly once and classification with injected sockets: a repeated close is ignored; mapped LAN addresses are lan", () => {
  const stats = createConnectionStats();
  const local = fakeSocket("::ffff:127.0.0.1"), lan = fakeSocket("::ffff:192.168.7.20"), v6 = fakeSocket("fe80::2%eth0");
  for (const s of [local, lan, v6]) stats.onConnection(s);
  let snap = stats.snapshot();
  assert.equal(snap.local.open, 1); assert.equal(snap.lan.open, 2); assert.equal(snap.open, 3);
  lan.emit("close"); lan.emit("close"); // a second close must not release again
  snap = stats.snapshot();
  assert.equal(snap.lan.open, 1); assert.equal(snap.lan.closed, 1); assert.equal(snap.open, 2);
  local.emit("close"); v6.emit("close");
  snap = stats.snapshot();
  assert.equal(snap.open, 0); assert.equal(snap.local.open, 0); assert.equal(snap.lan.open, 0);
  // the peak is the highest number open at once, not the number open at the latest arrival
  stats.onConnection(fakeSocket("127.0.0.1"));
  snap = stats.snapshot();
  assert.equal(snap.peakOpen, 3, "peak of 3 kept after a later, smaller load"); assert.equal(snap.lan.peakOpen, 2);
});

test("a peer on a non-loopback address is counted as lan (real sockets)", async (t) => {
  const addr = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
  if (!addr) { t.skip("no non-loopback IPv4 address on this machine"); return; }
  await withServer(async ({ server, stats }) => {
    const s = net.connect({ port: server.address().port, host: addr.address, localAddress: addr.address });
    s.on("error", () => {});
    try {
      await until(() => stats.snapshot().lan.open === 1, 5000, "lan connection counted");
      assert.equal(stats.snapshot().local.open, 0);
    } finally { s.destroy(); }
    await until(() => stats.snapshot().open === 0, 5000, "released");
  }, { host: "0.0.0.0" });
});

test("privacy: the snapshot holds aggregate numbers only (no address, port or request data)", async () => {
  await withServer(async ({ stats, connect }) => {
    const c = await connect(); c.write("GET /secret?token=abc HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: usap_session=xyz\r\n\r\n");
    await until(() => Object.values(stats.snapshot().local.firstRequestMs).some((n) => n > 0), 5000, "request seen");
    const text = JSON.stringify(stats.snapshot());
    for (const bad of ["127.0.0.1", "::1", "secret", "token", "usap_session", "xyz", String(c.localPort)]) assert.ok(!text.includes(bad), `snapshot contains ${bad}`);
    const keys = []; JSON.parse(text, (k, v) => { keys.push(k); return v; });
    assert.ok(!keys.some((k) => /addr|port|ip|host|url|session|cookie|token/i.test(k)), `keys: ${keys.join(",")}`);
  });
});

test("real server: /api/diagnostics reports connections and refusals, with USAP_SCHEDULER=off too; 200 idle connections are all accepted", async () => {
  for (const env of [{}, { USAP_SCHEDULER: "off" }]) {
    const root = makeRoot();
    const srv = await startServer(root, env);
    const idle = [];
    try {
      for (let i = 0; i < 200; i += 1) {
        idle.push(await new Promise((resolve, reject) => { const s = net.connect(srv.port, "127.0.0.1", () => resolve(s)); s.once("error", reject); }));
      }
      // a refused request with an unread body (Origin check), to see the refusal counters move
      await new Promise((resolve) => {
        const s = net.connect(srv.port, "127.0.0.1", () => s.write("POST /api/cleanup HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://evil.example\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n10000\r\n" + "a".repeat(65536) + "\r\n"));
        s.on("data", () => {}); s.on("error", () => {}); s.on("close", resolve); setTimeout(() => s.destroy(), 8000);
      });
      const r = await request(srv.port, "GET", "/api/diagnostics"); // observe-only: still answered with 200 idle sockets open
      assert.equal(r.status, 200, `${JSON.stringify(env)}: diagnostics answered`);
      const c = r.json.connections;
      assert.equal(c.mode, "observe");
      assert.ok(c.open >= 201 && c.local.open >= 201, `${JSON.stringify(env)}: every idle connection accepted and open (${c.open})`);
      assert.equal(c.lan.accepted, 0);
      assert.ok(c.refusals.lingeredTotal >= 1, `${JSON.stringify(env)}: refusal counted (${JSON.stringify(c.refusals)})`);
      // the refused socket stays paused (it does not see the client's close) until its 2 s grace period ends
      let after = c.refusals;
      for (const end = Date.now() + 6000; after.lingering !== 0 && Date.now() < end; await sleep(100)) after = (await request(srv.port, "GET", "/api/diagnostics")).json.connections.refusals;
      assert.equal(after.lingering, 0, `refused connection left its grace period (${JSON.stringify(after)})`);
      assert.ok(after.lingerMs.upTo2500 + after.lingerMs.upTo5000 >= 1, `it lasted about the grace period (${JSON.stringify(after.lingerMs)})`);
    } finally { for (const s of idle) s.destroy(); await stopServerAndWait(srv); removeTestRoot(root); }
  }
});
