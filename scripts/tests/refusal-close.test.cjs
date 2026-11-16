// Requests answered before their body is read (refusals) end with the answer: the connection is closed after a short
// grace period instead of the rest of the body being read (scripts/server/http/refusal-close.cjs).
//
// In-process: the real request pipeline, request policy and sign-in modules with a test router. Spawned: the real
// server (api-contract harness) for the JSON-only and fallback answers. Every client is bounded (bytes and time),
// sends from one reused buffer, and is destroyed in finally; every server is closed in finally.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createPipeline } = require("../server/http/pipeline.cjs");
const { createRouter } = require("../server/http/router.cjs");
const { createRequestPolicy } = require("../server/request-policy.cjs");
const { createLanAuth, MAX_FAILURES } = require("../server/lan-auth.cjs");
const { closeAfterAnswer, bodyMayRemain, GRACE_MS, SMALL_BODY_BYTES, lingeringCount } = require("../server/http/refusal-close.cjs");
const { makeRoot, startServer, stopServerAndWait, removeTestRoot } = require("./api-contract/harness.cjs");

const MiB = 1024 * 1024;
const CHUNK = Buffer.alloc(64 * 1024, 0x61);
const SLACK_MS = 2500;     // scheduling slack on slow CI runners, on top of the grace period
const ANSWER_MS = 5000;    // the answer itself must arrive promptly (it is sent before any body is read)
const READ_BOUND = 16 * MiB; // what a refused connection may read at most (kernel buffers are a few MiB)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A refused socket stops reading, so it may not see the client's own close: it ends when its grace period does.
async function noneLingering() { const end = Date.now() + GRACE_MS + SLACK_MS; while (lingeringCount() > 0 && Date.now() < end) await sleep(50); return lingeringCount(); }

function dechunk(raw) { // decode a chunked body (complete chunks only)
  let out = "", i = 0;
  for (;;) {
    const j = raw.indexOf("\r\n", i); if (j < 0) break;
    const n = parseInt(raw.slice(i, j), 16); if (!Number.isFinite(n) || n === 0) break;
    out += raw.slice(j + 2, j + 2 + n); i = j + 2 + n + 2;
    if (i > raw.length) break;
  }
  return out;
}

// ── a raw HTTP client that keeps sending ─────────────────────────────────────────────────────────────────────────
// mode: "stream" (chunked, as fast as allowed), "silent" (headers only, large Content-Length), "drip" (1 KiB every
// 200 ms), "small" (complete 2 KiB body), "pipelined" (finished chunked body, then a second request).
function rawRequest(port, { method = "POST", url = "/api/echo", headers = "", mode = "stream", capBytes = 32 * MiB, maxMs = 8000, contentType = "application/json", second = "" } = {}) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    const st = { status: null, head: "", body: "", sent: 0, closedAt: null, answeredAt: null, error: null, t0: Date.now(), connectionHeader: null };
    let buf = Buffer.alloc(0), stopped = false, timer = null;
    const parse = () => {
      const text = buf.toString("latin1"); const i = text.indexOf("\r\n\r\n");
      if (i < 0) return;
      st.head = text.slice(0, i); const m = st.head.match(/^HTTP\/1\.1 (\d{3})/); if (m && st.status === null) { st.status = Number(m[1]); st.answeredAt = Date.now() - st.t0; }
      const c = st.head.match(/\r\nconnection: ([^\r]+)/i); st.connectionHeader = c ? c[1].toLowerCase() : null;
      const raw = text.slice(i + 4);
      st.body = /\r\ntransfer-encoding: chunked/i.test(st.head) ? dechunk(raw) : raw;
    };
    s.on("data", (d) => { buf = Buffer.concat([buf, d]); parse(); });
    s.on("error", (e) => { st.error = e.code || e.message; });
    s.on("close", () => { st.closedAt = Date.now() - st.t0; stopped = true; clearTimeout(timer); resolve(st); });
    const end = setTimeout(() => { stopped = true; st.clientGaveUp = true; s.destroy(); }, maxMs);
    s.on("close", () => clearTimeout(end));
    s.on("connect", () => {
      const host = /\bHost:/i.test(headers) ? "" : "Host: 127.0.0.1\r\n";
      if (mode === "small") {
        const body = Buffer.alloc(2048, 0x61);
        s.write(`${method} ${url} HTTP/1.1\r\n${host}${headers}Content-Type: ${contentType}\r\nContent-Length: ${body.length}\r\n\r\n`); s.write(body); st.sent = body.length;
        return;
      }
      if (mode === "small-stalled") { // declares a small body, sends only part of it, then nothing
        s.write(`${method} ${url} HTTP/1.1\r\n${host}${headers}Content-Type: ${contentType}\r\nContent-Length: 2048\r\n\r\n`); s.write(Buffer.alloc(100, 0x61)); st.sent = 100;
        return;
      }
      if (mode === "silent") { s.write(`${method} ${url} HTTP/1.1\r\n${host}${headers}Content-Type: ${contentType}\r\nContent-Length: ${10 * MiB}\r\n\r\n`); return; }
      s.write(`${method} ${url} HTTP/1.1\r\n${host}${headers}Content-Type: ${contentType}\r\nTransfer-Encoding: chunked\r\n\r\n`);
      const send = (b) => { const ok = s.write(b.length.toString(16) + "\r\n"); s.write(b); s.write("\r\n"); st.sent += b.length; return ok; };
      if (mode === "pipelined") { send(Buffer.from("{}")); s.write("0\r\n\r\n"); s.write(second); return; }
      if (mode === "drip") { const tick = () => { if (stopped || s.destroyed) return; send(CHUNK.subarray(0, 1024)); timer = setTimeout(tick, 200); }; tick(); return; }
      const pump = () => { while (!stopped && !s.destroyed && st.sent < capBytes) { if (!send(CHUNK)) { s.once("drain", pump); return; } } };
      pump();
    });
  });
}

// ── in-process server: real pipeline, request policy and sign-in ─────────────────────────────────────────────────
async function startPipelineServer({ auth = "" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usap-refusal-"));
  try { return await startPipelineServerIn(dir, auth); } catch (err) { fs.rmSync(dir, { recursive: true, force: true }); throw err; }
}
async function startPipelineServerIn(dir, auth) {
  const env = { UAIS_AUTH: auth };
  const requestPolicy = createRequestPolicy({ listenHost: "127.0.0.1", env });
  const lanAuth = createLanAuth({ tokenFile: path.join(dir, "token"), listenHost: "127.0.0.1", env });
  lanAuth.ensureToken();
  const tokenFile = path.join(dir, "token");
  const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : null; // only created when sign-in is on
  const json = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  const router = createRouter();
  const routeHits = { echo: 0 };
  router.post("/api/echo", async (req, res) => { // an accepted route that reads its whole body
    routeHits.echo += 1; let n = 0;
    for await (const c of req) n += c.length;
    json(res, 200, { ok: true, bytes: n });
  });
  const pipeline = createPipeline({ requestPolicy, lanAuth, router, fallback: async (req, res) => json(res, 404, { ok: false }), json, errors: { errorStatus: () => 500, errorBody: () => ({}) }, logError: () => {} });
  const conns = new Set();
  const server = http.createServer(pipeline);
  server.on("connection", (s) => { const c = { s, bytesRead: 0 }; conns.add(c); s.on("close", () => { c.bytesRead = s.bytesRead; c.closed = true; }); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const readTotal = () => [...conns].reduce((a, c) => a + (c.closed ? c.bytesRead : c.s.bytesRead), 0);
  const close = async () => { for (const c of conns) c.s.destroy(); await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); };
  return { port: server.address().port, token, routeHits, readTotal, conns, close, lanAuth };
}

function assertClosedRefusal(st, status, label) {
  assert.equal(st.status, status, `${label}: answer status (client error ${st.error})`);
  assert.doesNotThrow(() => JSON.parse(st.body), `${label}: complete JSON answer, got ${JSON.stringify(st.body.slice(0, 80))}`);
  assert.equal(st.connectionHeader, "close", `${label}: Connection: close`);
  assert.ok(!st.clientGaveUp, `${label}: the server closed the connection (client gave up after ${st.closedAt} ms)`);
  // The grace period starts when the answer is written, so the close is measured from the answer.
  assert.ok(st.answeredAt <= ANSWER_MS, `${label}: answered promptly (${st.answeredAt} ms)`);
  assert.ok(st.closedAt - st.answeredAt <= GRACE_MS + SLACK_MS, `${label}: closed within the grace period after the answer (answer ${st.answeredAt} ms, close ${st.closedAt} ms)`);
}

// ── Node behaviour this fix depends on (fails loudly after a runtime change) ─────────────────────────────────────
test("node: a Connection: close answer to a request with an unread body ends through socket.destroySoon, after the body was switched to discard mode", async () => {
  let calls = 0, flowingAtClose = null;
  const server = http.createServer((req, res) => {
    const orig = req.socket.destroySoon;
    req.socket.destroySoon = function () { calls += 1; flowingAtClose = req.readableFlowing; req.socket.destroySoon = orig; return orig.call(this); };
    res.writeHead(403, { "Content-Type": "application/json", Connection: "close" }); res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await rawRequest(server.address().port, { capBytes: 2 * MiB, maxMs: 4000 });
    assert.equal(calls, 1, "Node closed the connection with destroySoon");
    assert.equal(flowingAtClose, true, "Node had switched the unread body to discard mode");
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});

test("node: without this fix, an answer that leaves the body unread keeps the connection open while Node reads the rest", async () => {
  const conns = [];
  const server = http.createServer((req, res) => { res.writeHead(403, { "Content-Type": "application/json" }); res.end("{}"); });
  server.on("connection", (s) => conns.push(s));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const st = await rawRequest(server.address().port, { capBytes: 8 * MiB, maxMs: 3000 });
    assert.equal(st.status, 403);
    assert.ok(st.clientGaveUp, "the server never closed it");
    assert.ok(conns[0].bytesRead >= 8 * MiB, `Node read the whole body (${conns[0].bytesRead} bytes)`);
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});

// ── the helper ───────────────────────────────────────────────────────────────────────────────────────────────────
test("helper: only chunked bodies or a declared Content-Length above the small-body limit count as unread", () => {
  const r = (headers, complete = false) => ({ headers, complete });
  assert.equal(bodyMayRemain(r({})), false, "no body");
  assert.equal(bodyMayRemain(r({ "content-length": "0" })), false);
  assert.equal(bodyMayRemain(r({ "content-length": String(SMALL_BODY_BYTES) })), false, "small declared body: Node's normal handling");
  assert.equal(bodyMayRemain(r({ "content-length": String(SMALL_BODY_BYTES + 1) })), true);
  assert.equal(bodyMayRemain(r({ "transfer-encoding": "chunked" })), true, "unknown length");
  assert.equal(bodyMayRemain(r({ "transfer-encoding": "chunked" }, true)), false, "already received");
  assert.equal(GRACE_MS, 2000);
});

test("helper: answers already started, or a second call, change nothing", () => {
  const set = []; const res = { headersSent: false, setHeader: (k, v) => set.push([k, v]), once: () => {} };
  const req = { headers: { "transfer-encoding": "chunked" }, complete: false, socket: { destroyed: false, destroySoon() {} } };
  assert.equal(closeAfterAnswer(req, res), true);
  assert.equal(closeAfterAnswer(req, res), false, "second call");
  assert.deepEqual(set, [["Connection", "close"]]);
  assert.equal(closeAfterAnswer(req, { ...res, headersSent: true }), false, "too late");
});

// ── every refusal in the pipeline and the sign-in module ─────────────────────────────────────────────────────────
const IN_PROCESS = [
  { label: "Host check 403", auth: "", status: 403, opts: { headers: "Host: evil.example\r\n" } },
  { label: "Origin check 403", auth: "", status: 403, opts: { headers: "Origin: http://evil.example\r\n" } },
  { label: "preflight OPTIONS 204 with a body", auth: "", status: 204, opts: { method: "OPTIONS" }, noJson: true },
  { label: "sign-in required 401", auth: "on", status: 401, opts: {} },
  { label: "sign-in route, wrong method 405", auth: "on", status: 405, opts: { method: "PUT", url: "/api/auth/login" } },
  { label: "sign-in route, sign-in disabled 404", auth: "", status: 404, opts: { url: "/api/auth/login" } },
  { label: "sign-in, wrong content type 415", auth: "on", status: 415, opts: { url: "/api/auth/login", contentType: "text/plain" } },
  { label: "sign-in, body over its limit 413", auth: "on", status: 413, opts: { url: "/api/auth/login" } },
  { label: "sign-out with a body it does not use", auth: "on", status: 200, opts: { url: "/api/auth/logout" } },
];

for (const c of IN_PROCESS) {
  test(`refusal: ${c.label} — still-sending, silent and slow clients get the answer; the connection closes in the grace period; little is read`, async () => {
    const srv = await startPipelineServer({ auth: c.auth });
    try {
      for (const mode of ["stream", "silent", "drip"]) {
        const before = srv.readTotal();
        const st = await rawRequest(srv.port, { ...c.opts, mode, maxMs: GRACE_MS + 6000 });
        if (c.noJson) {
          assert.equal(st.status, c.status, `${c.label}/${mode}`); assert.equal(st.connectionHeader, "close"); assert.ok(!st.clientGaveUp && st.closedAt - st.answeredAt <= GRACE_MS + SLACK_MS, `${c.label}/${mode} closed (answer ${st.answeredAt} ms, close ${st.closedAt} ms)`);
        } else assertClosedRefusal(st, c.status, `${c.label}/${mode}`);
        await sleep(50);
        const read = srv.readTotal() - before;
        assert.ok(read <= READ_BOUND, `${c.label}/${mode}: server read ${read} bytes`);
        if (mode === "stream") assert.ok(st.sent < 32 * MiB, `${c.label}: the server stopped reading (client sent ${st.sent})`);
      }
      assert.equal(srv.routeHits.echo, 0, "no refused request reached a route");
      assert.equal(await noneLingering(), 0, "no connection left after its grace period");
    } finally { await srv.close(); }
  });
}

test("refusal: sign-in rate limit 429 (after repeated failures) closes the same way", async () => {
  const srv = await startPipelineServer({ auth: "on" });
  try {
    const wrong = "Authorization: Bearer not-the-token\r\n";
    for (let i = 0; i < MAX_FAILURES; i++) {
      const r = await rawRequest(srv.port, { headers: wrong, mode: "small", maxMs: 1500 });
      assert.equal(r.status, 401, `failure ${i}`);
    }
    for (const [url, headers] of [["/api/echo", wrong], ["/api/auth/login", ""]]) {
      const st = await rawRequest(srv.port, { url, headers, mode: "stream", maxMs: GRACE_MS + 6000 });
      assertClosedRefusal(st, 429, `rate limited ${url}`);
    }
    assert.equal(srv.routeHits.echo, 0);
  } finally { await srv.close(); }
});

test("refusal: a complete small body keeps today's behaviour (answered, keep-alive, nothing closed)", async () => {
  const srv = await startPipelineServer({ auth: "on" });
  try {
    for (const opts of [{ headers: "Origin: http://evil.example\r\n" }, {}, { url: "/api/auth/login", contentType: "text/plain" }]) {
      const st = await rawRequest(srv.port, { ...opts, mode: "small", maxMs: 1500 });
      assert.ok([401, 403, 415].includes(st.status), `status ${st.status}`);
      assert.notEqual(st.connectionHeader, "close", "keep-alive unchanged");
      assert.ok(st.clientGaveUp, "the server kept the connection open for the next request, as before");
    }
  } finally { await srv.close(); }
});

test("refusal: a small declared body that stalls is closed within the grace period after the answer (not held until Node's request timeout)", async () => {
  const srv = await startPipelineServer({ auth: "on" });
  try {
    for (const [label, opts, status] of [["Origin", { headers: "Origin: http://evil.example\r\n" }, 403], ["sign-in", {}, 401], ["sign-in 415", { url: "/api/auth/login", contentType: "text/plain" }, 415]]) {
      const st = await rawRequest(srv.port, { ...opts, mode: "small-stalled", maxMs: GRACE_MS + 8000 });
      assert.equal(st.status, status, label);
      assert.ok(!st.clientGaveUp, `${label}: closed by the server (client gave up after ${st.closedAt} ms)`);
      assert.ok(st.closedAt - st.answeredAt <= GRACE_MS + SLACK_MS, `${label}: closed within the grace period after the answer (answer ${st.answeredAt} ms, close ${st.closedAt} ms)`);
    }
    assert.equal(srv.routeHits.echo, 0);
  } finally { await srv.close(); }
});

test("misleading framing: bytes past the declared Content-Length, or after a request that declared no body, never reach a route", async () => {
  const srv = await startPipelineServer();
  try {
    const raw = (head, extra) => new Promise((resolve) => {
      const s = net.connect(srv.port, "127.0.0.1"); let text = ""; s.on("error", () => {});
      s.on("data", (d) => (text += d)); s.on("close", () => resolve(text));
      s.on("connect", () => { s.write(head); s.write(extra); });
      setTimeout(() => s.destroy(), GRACE_MS + 6000);
    });
    const junk = "x".repeat(4096) + "\r\n\r\n";
    const a = await raw("POST /api/echo HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://evil.example\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}", junk);
    const b = await raw("POST /api/echo HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://evil.example\r\nContent-Type: application/json\r\n\r\n", junk);
    for (const [label, text] of [["past the declared length", a], ["no length declared", b]]) {
      assert.match(text, /^HTTP\/1\.1 403/, `${label}: refused`);
      assert.ok(!/HTTP\/1\.1 200/.test(text), `${label}: nothing accepted`);
    }
    assert.equal(srv.routeHits.echo, 0, "the extra bytes were never routed");
  } finally { await srv.close(); }
});

test("refusal: request text inside a refused request's unread body is never parsed; a pipelined request is checked on its own", async () => {
  const srv = await startPipelineServer();
  try {
    // a request hidden in the body of a refused request (declared 1 MiB, only the start is sent)
    const smuggled = "POST /api/echo HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}";
    const st = await new Promise((resolve) => {
      const s = net.connect(srv.port, "127.0.0.1"); let text = ""; s.on("error", () => {});
      s.on("data", (d) => (text += d)); s.on("close", () => resolve({ text }));
      s.on("connect", () => { s.write(`POST /api/echo HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://evil.example\r\nContent-Type: application/json\r\nContent-Length: ${MiB}\r\n\r\n`); s.write(smuggled); });
      setTimeout(() => s.destroy(), GRACE_MS + 6000);
    });
    assert.match(st.text, /^HTTP\/1\.1 403/);
    assert.equal((st.text.match(/HTTP\/1\.1 /g) || []).length, 1, "one answer only");
    // a pipelined request that is itself refused never reaches the route either
    const second = "POST /api/echo HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://evil.example\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}";
    const p = await rawRequest(srv.port, { headers: "Origin: http://evil.example\r\n", mode: "pipelined", second, maxMs: GRACE_MS + 6000 });
    assert.equal(p.status, 403);
    assert.equal(srv.routeHits.echo, 0, "nothing reached the route");
  } finally { await srv.close(); }
});

test("refusal: 20 concurrent refused clients that keep sending all get the answer; all close in the grace period; reads stay bounded", async () => {
  const srv = await startPipelineServer();
  const errors = []; const onErr = (e) => errors.push(e);
  process.on("uncaughtException", onErr);
  try {
    const t0 = Date.now();
    // 8 MiB per client: more than a loopback receive buffer, so every client is still sending when refused; the
    // clients run in this process next to the server, so a larger cap only adds event-loop load on slow runners
    const all = await Promise.all(Array.from({ length: 20 }, () => rawRequest(srv.port, { headers: "Origin: http://evil.example\r\n", capBytes: 8 * MiB, maxMs: GRACE_MS + 10000 })));
    all.forEach((st, i) => assertClosedRefusal(st, 403, `client ${i}`));
    const read = srv.readTotal();
    assert.ok(read <= 20 * READ_BOUND, `server read ${read} bytes for 20 refused clients`);
    assert.ok(Date.now() - t0 <= ANSWER_MS + GRACE_MS + SLACK_MS, `all done within answer + grace (${Date.now() - t0} ms)`);
    assert.equal(await noneLingering(), 0);
    assert.deepEqual(errors, [], "no uncaught socket errors");
  } finally { process.off("uncaughtException", onErr); await srv.close(); }
});

test("refusal: a client that resets the connection during the grace period leaves nothing behind", async () => {
  const srv = await startPipelineServer();
  const errors = []; const onErr = (e) => errors.push(e);
  process.on("uncaughtException", onErr);
  try {
    const s = net.connect(srv.port, "127.0.0.1");
    s.on("error", () => {});
    await new Promise((r) => s.on("connect", r));
    s.write("POST /api/echo HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://evil.example\r\nTransfer-Encoding: chunked\r\n\r\n");
    s.write("10000\r\n"); s.write(CHUNK);
    await new Promise((r) => s.once("data", r));
    s.resetAndDestroy();
    assert.equal(await noneLingering(), 0);
    assert.deepEqual(errors, []);
  } finally { process.off("uncaughtException", onErr); await srv.close(); }
});

test("accepted requests are unchanged: a signed-in request with a large chunked body is read in full and kept alive", async () => {
  const srv = await startPipelineServer({ auth: "on" });
  try {
    const st = await rawRequest(srv.port, { headers: `Authorization: Bearer ${srv.token}\r\n`, mode: "pipelined", second: "", maxMs: 1500 });
    assert.equal(st.status, 200);
    assert.notEqual(st.connectionHeader, "close");
    const big = await new Promise((resolve, reject) => {
      const body = Buffer.alloc(3 * MiB, 0x61);
      const r = http.request({ host: "127.0.0.1", port: srv.port, path: "/api/echo", method: "POST", headers: { Authorization: `Bearer ${srv.token}`, "Content-Type": "application/json", "Content-Length": body.length } }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(b), connection: res.headers.connection })); });
      r.on("error", reject); r.end(body);
    });
    assert.equal(big.status, 200); assert.equal(big.body.bytes, 3 * MiB); assert.notEqual(big.connection, "close");
    assert.equal(srv.routeHits.echo, 2);
  } finally { await srv.close(); }
});

// ── the real server: JSON-only routes and the fallback (default configuration) ───────────────────────────────────
test("server (default configuration): JSON-only 415, JSON over the 64 MiB limit 413, unknown /api 404 and static paths answer and close; accepted JSON unchanged", async (t) => {
  const root = makeRoot();
  let srv = null;
  try {
    srv = await startServer(root);
    const cases = [
      { label: "JSON-only route, wrong type 415", opts: { url: "/api/cleanup", contentType: "text/plain" }, status: 415 },
      { label: "unknown API endpoint 404", opts: { url: "/api/no-such-route" }, status: 404 },
      { label: "JSON over the limit 413", opts: { url: "/api/cleanup", capBytes: 80 * MiB }, status: 413 },
    ];
    for (const c of cases) {
      const st = await rawRequest(srv.port, { ...c.opts, mode: "stream", maxMs: GRACE_MS + 15000 });
      assertClosedRefusal(st, c.status, c.label);
      if (c.status === 413) assert.match(st.body, /BODY_TOO_LARGE/);
      else assert.ok(st.sent < 32 * MiB, `${c.label}: the server stopped reading (client sent ${st.sent})`);
    }
    const page = await rawRequest(srv.port, { url: "/some/page", mode: "stream", contentType: "text/plain", maxMs: GRACE_MS + 6000 });
    assert.ok([200, 404].includes(page.status), `static answer (${page.status}; 404 when the test root has no built frontend)`); assert.equal(page.connectionHeader, "close"); assert.ok(!page.clientGaveUp && page.closedAt - page.answeredAt <= GRACE_MS + SLACK_MS, `static page closed (answer ${page.answeredAt} ms, close ${page.closedAt} ms)`);
    // accepted: a JSON route with a complete body answers as before and keeps the connection (nothing to delete)
    const ok = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ ids: [] });
      const r = http.request({ host: "127.0.0.1", port: srv.port, path: "/api/cleanup", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(b), connection: res.headers.connection })); });
      r.on("error", reject); r.end(body);
    });
    assert.equal(ok.status, 200); assert.equal(ok.body.ok, true); assert.notEqual(ok.connection, "close");
  } finally {
    await stopServerAndWait(srv);
    await removeTestRoot(root);
  }
});
