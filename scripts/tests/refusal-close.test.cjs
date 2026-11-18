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
const { closeAfterAnswer, bodyMayRemain, GRACE_MS, SMALL_BODY_BYTES, WATCH_BYTES, lingeringCount, resumedCount, closedReadingCount } = require("../server/http/refusal-close.cjs");
const { makeRoot, startServer, stopServerAndWait, removeTestRoot } = require("./api-contract/harness.cjs");
const { rawRequest } = require("./fixtures/refusal-clients.cjs");
const { execFile } = require("node:child_process");

const MiB = 1024 * 1024;
const CHUNK = Buffer.alloc(64 * 1024, 0x61);
const SLACK_MS = 2500;     // scheduling slack on slow CI runners, on top of the grace period
const ANSWER_MS = 5000;    // the answer itself must arrive promptly (it is sent before any body is read)
const READ_BOUND = 16 * MiB; // what a refused connection may read at most (kernel buffers are a few MiB)
const READ_SMALL = 8 * MiB;  // what a refused connection may read from a client that ignores the answer and keeps sending
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A refused socket stops reading, so it may not see the client's own close: it ends when its grace period does.
async function noneLingering() { const end = Date.now() + GRACE_MS + SLACK_MS; while (lingeringCount() > 0 && Date.now() < end) await sleep(50); return lingeringCount(); }

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
  // Per connection, what the server itself did (wall-clock Date.now() times): when it accepted the connection, the
  // status of the answer and when that answer was handed to the OS ('finish'), and when the socket closed.
  const conns = new Set();
  const bySocket = new WeakMap();
  const server = http.createServer((req, res) => {
    const c = bySocket.get(req.socket);
    if (c) res.once("finish", () => { c.status = res.statusCode; c.answeredAt = Date.now(); });
    return pipeline(req, res);
  });
  server.on("connection", (s) => {
    const c = { s, bytesRead: 0, remotePort: s.remotePort, acceptedAt: Date.now(), status: null, answeredAt: null, closedAt: null };
    conns.add(c); bySocket.set(s, c);
    s.on("close", () => { c.bytesRead = s.bytesRead; c.closed = true; c.closedAt = Date.now(); });
  });
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

// ── a refused client in a separate process, judged against what the server did on its connection ──────────────────
// The server's side is checked directly (status, timing, close, bytes read). What the client saw is checked too: it
// must have read the complete answer, with one documented exception. A client that keeps sending and does not read
// for longer than the grace period may get a reset instead of the answer (refusal-close.cjs: the socket is destroyed
// GRACE_MS after the answer). That exception is accepted only with evidence: the server kept the connection open for
// the whole grace period after writing the answer, AND the client's process did not run at all in that window (no
// event-loop tick between the server's answer and its close), AND the connection ended with a reset or nothing,
// never a different answer. A server that closes early, never closes, or answers wrongly still fails.
const GRACE_TOLERANCE_MS = 100; // timer granularity: the grace timer starts just before 'finish' is observed
const TICK_MARGIN_MS = 5;       // loopback delivery time for the answer and for the reset
function judgeRefusedClient(st, conn, ticks, status) {
  if (!conn) return { ok: false, why: `no server connection for client port ${st.localPort}` };
  if (st.status === status) return { ok: true, kind: "answered" };
  if (st.status !== null) return { ok: false, why: `client read status ${st.status}, expected ${status}` };
  if (conn.status !== status || conn.answeredAt === null || conn.closedAt === null) return { ok: false, why: `server status ${conn.status}, answered ${conn.answeredAt}, closed ${conn.closedAt}` };
  const kept = conn.closedAt - conn.answeredAt;
  if (kept < GRACE_MS - GRACE_TOLERANCE_MS) return { ok: false, why: `answer lost, and the server closed only ${kept} ms after answering (grace ${GRACE_MS} ms)` };
  const ran = ticks.filter((t) => t > conn.answeredAt + TICK_MARGIN_MS && t < conn.closedAt - TICK_MARGIN_MS);
  if (ran.length > 0) return { ok: false, why: `answer lost although the client process ran ${ran.length} times during the ${kept} ms the server kept the connection open` };
  const before = ticks.filter((t) => t <= conn.answeredAt + TICK_MARGIN_MS).at(-1), after = ticks.find((t) => t >= conn.closedAt - TICK_MARGIN_MS);
  return { ok: true, kind: "stalled", why: `client process did not run from ${before - conn.answeredAt} ms to ${after - conn.answeredAt} ms after the answer; server closed at ${kept} ms; client error ${st.error}` };
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
// A server that refuses every request through the helper and records, per connection, what it read and when.
function refusingServer(before) {
  const recs = [];
  const server = http.createServer((req, res) => {
    const s = req.socket; const rec = { read: 0, readAtAnswer: null, answeredAt: null, closedAt: null };
    recs.push(rec);
    if (before) before(s, res);
    closeAfterAnswer(req, res);
    res.once("finish", () => { rec.answeredAt = Date.now(); rec.readAtAnswer = s.bytesRead; });
    s.once("close", () => { rec.read = s.bytesRead; rec.closedAt = Date.now(); });
    res.writeHead(403, { "Content-Type": "application/json" }); res.end("{}");
  });
  return { server, recs };
}
async function floodRefusal(before) {
  const { server, recs } = refusingServer(before);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const st = await rawRequest(server.address().port, { mode: "stream", ignoreFin: true, capBytes: 4096 * MiB, maxMs: GRACE_MS + 6000 });
    await sleep(50);
    return { st, rec: recs[0] };
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
}

test("node: after an answer that leaves the body unread, Node resumes reading a paused socket on the next tick; the helper pauses it again (refusal-close.cjs depends on this)", async () => {
  // Without the helper: the same steps as its grace period (pause, FIN, close later), and nothing else.
  const plain = await new Promise((resolve) => {
    const rec = { resumedAfterPause: false, read: 0 };
    const server = http.createServer((req, res) => {
      const s = req.socket; let paused = false;
      s.on("pause", () => { paused = true; }); s.on("resume", () => { if (paused) rec.resumedAfterPause = true; });
      s.destroySoon = function () { s.pause(); s.end(); setTimeout(() => s.destroy(), 500); };
      s.once("close", () => { rec.read = s.bytesRead; });
      res.writeHead(403, { "Content-Type": "application/json", Connection: "close" }); res.end("{}");
    });
    server.listen(0, "127.0.0.1", async () => {
      const st = await rawRequest(server.address().port, { mode: "stream", ignoreFin: true, capBytes: 4096 * MiB, maxMs: 5000 });
      await sleep(50);
      server.close(() => resolve({ ...rec, status: st.status }));
    });
  });
  assert.equal(plain.status, 403);
  // If this fails, Node no longer resumes a paused socket here: re-check what refusal-close.cjs needs on this runtime.
  assert.equal(plain.resumedAfterPause, true, `Node resumes the paused socket after the answer (read ${plain.read} bytes)`);
  // With the helper: Node still resumes it, and the helper pauses it again before anything is read.
  const resumed0 = resumedCount(), failsafe0 = closedReadingCount();
  const { st, rec } = await floodRefusal();
  assert.equal(st.status, 403, `answer (client error ${st.error})`);
  assert.ok(resumedCount() > resumed0, "Node resumed the socket and the helper paused it again");
  assert.equal(closedReadingCount(), failsafe0, "the fail-closed check was not needed");
  assert.ok(rec.read - rec.readAtAnswer <= WATCH_BYTES, `nothing more read after the answer (${rec.read - rec.readAtAnswer} bytes; without the helper ${plain.read})`);
  assert.ok(rec.closedAt - rec.answeredAt >= GRACE_MS - 200, `the grace period was kept (${rec.closedAt - rec.answeredAt} ms)`);
});

test("helper fails closed: a socket that reads during its grace period without Node emitting 'resume' (a different runtime) is closed at once", async () => {
  // Simulates a runtime that restarts reading some other way: the test (only) starts the socket's handle directly,
  // which reads without any stream event.
  const failsafe0 = closedReadingCount();
  const { st, rec } = await floodRefusal((s, res) => res.once("finish", () => setTimeout(() => { if (s._handle && !s.destroyed) { s._handle.reading = true; s._handle.readStart(); } }, 100)));
  assert.equal(st.status, 403, `answer (client error ${st.error})`);
  assert.equal(closedReadingCount(), failsafe0 + 1, "the fail-closed check closed the socket");
  assert.ok(rec.closedAt - rec.answeredAt < GRACE_MS - 500, `closed well before the grace period ended (${rec.closedAt - rec.answeredAt} ms)`);
  // bounded by a few watch intervals at network speed, instead of the whole grace period (about 1 GiB on loopback)
  assert.ok(rec.read - rec.readAtAnswer <= 64 * MiB, `read after the answer ${rec.read - rec.readAtAnswer} bytes`);
});

test("helper: Node's own drain handling after the answer does not restart reading", async () => {
  // Node's server 'drain' handler resumes a socket it had paused itself (socket._paused); emitting 'drain' after the
  // answer simulates it running late. A fix that relied on that internal flag read the whole grace period here.
  const failsafe0 = closedReadingCount();
  const { st, rec } = await floodRefusal((s, res) => res.once("finish", () => setTimeout(() => s.emit("drain"), 100)));
  assert.equal(st.status, 403, `answer (client error ${st.error})`);
  assert.equal(closedReadingCount(), failsafe0, "the fail-closed check was not needed");
  assert.ok(rec.read - rec.readAtAnswer <= WATCH_BYTES, `nothing more read after the answer (${rec.read - rec.readAtAnswer} bytes)`);
  assert.ok(rec.closedAt - rec.answeredAt >= GRACE_MS - 200, `the grace period was kept (${rec.closedAt - rec.answeredAt} ms)`);
});

test("runtime: CI runs the Node version the setup scripts package", () => {
  // The Node behaviour checked above is verified on the CI runtime; it must be the one users get.
  const root = path.join(__dirname, "..", "..");
  const sh = fs.readFileSync(path.join(root, "scripts", "setup", "setup.sh"), "utf8").match(/^NODE_VERSION="([\d.]+)"/m);
  const ps = fs.readFileSync(path.join(root, "scripts", "setup", "setup.ps1"), "utf8").match(/nodejs\.org\/dist\/v([\d.]+)\//);
  const ci = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8").match(/NODE_VERSION: "([\d.]+)"/);
  assert.ok(sh && ps && ci, "pins found");
  assert.equal(ps[1], sh[1], "setup.ps1 and setup.sh package the same Node");
  assert.equal(ci[1], sh[1], "ci.yml tests the packaged Node");
  if (process.env.CI) assert.equal(process.version, `v${sh[1]}`, "this CI run uses the packaged Node");
});

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
      // A client that ignores the answer and the server's FIN and keeps sending as fast as it can: the server reads little
      // more than it had before the answer, for the whole grace period (it must not go on reading and discarding).
      const before = srv.readTotal();
      const st = await rawRequest(srv.port, { ...c.opts, mode: "stream", ignoreFin: true, capBytes: 4096 * MiB, maxMs: GRACE_MS + 6000 });
      assert.equal(st.status, c.status, `${c.label}/ignores the answer: status (client error ${st.error})`);
      assert.ok(!st.clientGaveUp, `${c.label}/ignores the answer: the server closed the connection (client gave up at ${st.closedAt} ms)`);
      await sleep(50);
      const read = srv.readTotal() - before;
      assert.ok(read <= READ_SMALL, `${c.label}/ignores the answer: server read ${read} bytes while the client sent ${st.sent}`);
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

test("refusal: 20 concurrent refused clients that keep sending get the answer (or were provably not running during the grace period); the server answers each promptly and closes it in the grace period; reads stay bounded", async (t) => {
  const srv = await startPipelineServer();
  const errors = []; const onErr = (e) => errors.push(e);
  process.on("uncaughtException", onErr);
  try {
    // 8 MiB per client: more than a loopback receive buffer, so every client is still sending when refused. The 20
    // clients run in a separate process: writing as fast as they can, they would otherwise share this event loop with
    // the server and delay its answers on a slow runner (seen on macOS Intel CI), which would measure the test, not
    // the server.
    // Timing is therefore asserted on the server's side; the client process's own timing is only diagnostic.
    const opts = { headers: "Origin: http://evil.example\r\n", capBytes: 8 * MiB, maxMs: GRACE_MS + 10000 };
    const { clients: all, ticks } = await new Promise((resolve, reject) => {
      execFile(process.execPath, [path.join(__dirname, "fixtures", "refusal-clients.cjs"), JSON.stringify({ port: srv.port, n: 20, opts })], { timeout: GRACE_MS + 30000, maxBuffer: 16 * MiB },
        (err, stdout) => { if (err) reject(err); else resolve(JSON.parse(stdout)); });
    });
    assert.equal(await noneLingering(), 0);
    const conns = [...srv.conns];
    const record = () => JSON.stringify({ server: conns.map(({ s, ...c }) => ({ ...c, answeredMs: c.answeredAt - c.acceptedAt, keptMs: c.closedAt - c.answeredAt })), clients: all });
    assert.equal(all.length, 20);
    // The server: 20 connections, each refused with 403 promptly, closed within the grace period, nothing routed.
    assert.equal(conns.length, 20, `server saw ${conns.length} connections`);
    for (const c of conns) {
      assert.equal(c.status, 403, `server answered port ${c.remotePort} with ${c.status}: ${record()}`);
      assert.ok(c.answeredAt - c.acceptedAt <= ANSWER_MS, `server answered port ${c.remotePort} ${c.answeredAt - c.acceptedAt} ms after accepting it`);
      assert.ok(c.closedAt !== null && c.closedAt - c.answeredAt <= GRACE_MS + SLACK_MS, `server closed port ${c.remotePort} ${c.closedAt - c.answeredAt} ms after the answer`);
    }
    assert.equal(srv.routeHits.echo, 0, "no refused request reached the route");
    const read = srv.readTotal();
    assert.ok(read <= 20 * READ_BOUND, `server read ${read} bytes for 20 refused clients`);
    // The clients: each read the complete answer, or provably was not running while the server held the connection.
    const stalled = [];
    all.forEach((st, i) => {
      const v = judgeRefusedClient(st, conns.find((c) => c.remotePort === st.localPort), ticks, 403);
      assert.ok(v.ok, `client ${i}: ${v.why}; client error ${st.error}: ${record()}`);
      if (v.kind === "stalled") { stalled.push(`client ${i}: ${v.why}`); return; }
      assert.doesNotThrow(() => JSON.parse(st.body), `client ${i}: complete JSON answer, got ${JSON.stringify(st.body.slice(0, 80))}`);
      assert.equal(st.connectionHeader, "close", `client ${i}: Connection: close`);
    });
    if (stalled.length) t.diagnostic(`${stalled.length}/20 answers lost by a client process that was not running (documented reset tradeoff): ${stalled.join("; ")}`);
    assert.deepEqual(errors, [], "no uncaught socket errors");
  } finally { process.off("uncaughtException", onErr); await srv.close(); }
});

test("refusal judge: a lost answer is excused only when the server kept the grace period and the client was not running", () => {
  const conn = { remotePort: 1, status: 403, acceptedAt: 1000, answeredAt: 1040, closedAt: 1040 + GRACE_MS + 10 };
  const ticksEvery = (from, to) => Array.from({ length: Math.floor((to - from) / 10) + 1 }, (_, i) => from + i * 10);
  const lost = { localPort: 1, status: null, error: "EPIPE" };
  const asleep = [...ticksEvery(1000, 1030), ...ticksEvery(conn.closedAt + 200, conn.closedAt + 400)];
  // answered: always fine
  assert.equal(judgeRefusedClient({ localPort: 1, status: 403 }, conn, ticksEvery(1000, 4000), 403).kind, "answered");
  // control: lost while the client process was not running and the server kept the full grace period → excused
  assert.equal(judgeRefusedClient(lost, conn, asleep, 403).kind, "stalled");
  // lost while the client process was running → server failure
  assert.equal(judgeRefusedClient(lost, conn, ticksEvery(1000, 4000), 403).ok, false);
  // one tick inside the window is enough to fail
  assert.equal(judgeRefusedClient(lost, conn, [...asleep, conn.answeredAt + 1000].sort((a, b) => a - b), 403).ok, false);
  // server closed at once (no grace period), even with the client asleep → failure
  assert.equal(judgeRefusedClient(lost, { ...conn, closedAt: conn.answeredAt + 5 }, asleep, 403).ok, false);
  // server closed early (half the grace period) → failure
  assert.equal(judgeRefusedClient(lost, { ...conn, closedAt: conn.answeredAt + GRACE_MS / 2 }, asleep, 403).ok, false);
  // server never answered, answered differently, or never closed → failure
  assert.equal(judgeRefusedClient(lost, { ...conn, status: null, answeredAt: null }, asleep, 403).ok, false);
  assert.equal(judgeRefusedClient(lost, { ...conn, status: 200 }, asleep, 403).ok, false);
  assert.equal(judgeRefusedClient(lost, { ...conn, closedAt: null }, asleep, 403).ok, false);
  // the client read a different answer → failure; no matching server connection → failure
  assert.equal(judgeRefusedClient({ ...lost, status: 200 }, conn, asleep, 403).ok, false);
  assert.equal(judgeRefusedClient(lost, undefined, asleep, 403).ok, false);
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
      else {
        assert.ok(st.sent < 32 * MiB, `${c.label}: the server stopped reading (client sent ${st.sent})`);
        // a client that ignores the answer and the server's FIN and keeps sending: what it gets to send is bounded by
        // transport buffers, not by how fast the server can read and discard
        const keep = await rawRequest(srv.port, { ...c.opts, mode: "stream", ignoreFin: true, capBytes: 4096 * MiB, maxMs: GRACE_MS + 15000 });
        assert.equal(keep.status, c.status, `${c.label}/ignores the answer: status (client error ${keep.error})`);
        assert.ok(!keep.clientGaveUp, `${c.label}/ignores the answer: the server closed the connection`);
        assert.ok(keep.sent <= 2 * READ_SMALL, `${c.label}/ignores the answer: the client could send ${keep.sent} bytes after its answer`);
      }
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
