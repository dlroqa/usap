// JSON routes refuse a body whose declared Content-Length is over the 64 MiB JSON limit before reading it
// (serve.cjs readJsonBody / declaredOverJsonLimit). The answer is the same 413 as before (status, code, message), the
// connection ends through http/refusal-close.cjs, and everything else is unchanged: chunked bodies keep the streamed
// limit, in-limit bodies are accepted, and the Host/Origin, sign-in and content-type answers come first.
//
// Judged on the server's side: a test-only preload (api-contract/connection-log-preload.cjs) records, for each request
// to the JSON route, its status and how many bytes the server read from that connection. The real server runs in its
// own process; clients are bounded in bytes and time and destroyed when done.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");

const { makeRoot, startServer, stopServerAndWait, removeTestRoot } = require("./api-contract/harness.cjs");
const { GRACE_MS } = require("../server/http/refusal-close.cjs");
const { execFile } = require("node:child_process");
const { judgeRefusedClient } = require("./fixtures/refusal-judge.cjs");
const { describeLostClient } = require("./fixtures/stall-diag.cjs");
const { describeStallCorrelates } = require("./fixtures/stall-correlate.cjs"); // #151 diagnostics only
const { spawn } = require("node:child_process");
const GRACE_TOLERANCE_MS = 100; // as fixtures/refusal-judge.cjs: the grace timer starts just before 'finish' is observed

const MiB = 1024 * 1024;
const LIMIT = 64 * MiB;
const URL = "/api/cleanup"; // a JSON route; `{"ids": []}` deletes nothing
const MESSAGE = "Request body is too large. Limit is 64 MB.";
const EARLY_READ_BOUND = 4 * MiB; // what the server may read from a refused connection (headers, what was already in flight)
const ANSWER_MS = 5000;           // an early refusal answers promptly, whatever the client sends
const SLACK_MS = 2500;
const CHUNK = Buffer.alloc(64 * 1024, 0x61);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One raw HTTP/1.1 request. framing: { contentLength } or { chunked: true } or {} (no body header).
 * send: "stream" (as fast as possible up to capBytes) | "silent" (headers only) | { partial: bytes } | Buffer (whole body).
 */
function raw(port, { framing = {}, send = "stream", capBytes = 96 * MiB, headers = "", contentType = "application/json", ignoreFin = true, maxMs = GRACE_MS + 10000 } = {}) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1", allowHalfOpen: ignoreFin });
    const st = { status: null, head: "", body: "", sent: 0, sentAtAnswer: null, answeredAt: null, closedAt: null, localPort: null, error: null, t0: Date.now(),
      firstDataAt: null, endAt: null, errorAt: null }; // diagnostics: when the client saw data, the server's FIN, an error
    let buf = Buffer.alloc(0), stopped = false;
    s.on("data", (d) => {
      if (st.firstDataAt === null) st.firstDataAt = Date.now() - st.t0;
      buf = Buffer.concat([buf, d]);
      const text = buf.toString("latin1"); const i = text.indexOf("\r\n\r\n");
      if (i < 0) return;
      st.head = text.slice(0, i); st.body = text.slice(i + 4);
      const m = st.head.match(/^HTTP\/1\.1 (\d{3})/);
      if (m && st.status === null) { st.status = Number(m[1]); st.answeredAt = Date.now() - st.t0; st.sentAtAnswer = st.sent; }
      // a complete answer the server keeps the connection open after (keep-alive): done
      const cl = st.head.match(/\r\ncontent-length: (\d+)/i);
      const complete = cl ? Buffer.byteLength(st.body, "latin1") >= Number(cl[1]) : /\r\ntransfer-encoding: chunked/i.test(st.head) && st.body.endsWith("0\r\n\r\n");
      if (complete && !/\r\nconnection: close/i.test(st.head)) { st.keptAlive = true; s.destroy(); }
    });
    s.on("error", (e) => { st.error = e.code || e.message; if (st.errorAt === null) st.errorAt = Date.now() - st.t0; });
    s.on("end", () => { st.endAt = Date.now() - st.t0; });
    const end = setTimeout(() => { stopped = true; st.clientGaveUp = true; s.destroy(); }, maxMs);
    s.on("close", () => { clearTimeout(end); stopped = true; st.closedAt = Date.now() - st.t0; resolve(st); });
    s.on("connect", () => {
      st.localPort = s.localPort;
      const frame = framing.chunked ? "Transfer-Encoding: chunked\r\n" : framing.contentLength !== undefined ? `Content-Length: ${framing.contentLength}\r\n` : "";
      s.write(`POST ${URL} HTTP/1.1\r\nHost: 127.0.0.1\r\n${headers}Content-Type: ${contentType}\r\n${frame}\r\n`);
      const write = (b) => {
        if (framing.chunked) { s.write(b.length.toString(16) + "\r\n"); const ok = s.write(b); s.write("\r\n"); st.sent += b.length; return ok; }
        st.sent += b.length; return s.write(b);
      };
      if (Buffer.isBuffer(send)) { write(send); if (framing.chunked) s.write("0\r\n\r\n"); return; }
      if (send === "silent") return;
      const cap = typeof send === "object" ? send.partial : capBytes;
      const pump = () => { while (!stopped && !s.destroyed && st.sent < cap) { if (!write(CHUNK.subarray(0, Math.min(CHUNK.length, cap - st.sent)))) { s.once("drain", pump); return; } } };
      pump();
    });
  });
}

const preload = path.join(__dirname, "api-contract", "connection-log-preload.cjs").replace(/\\/g, "/");
async function withServer(fn, extra = {}) {
  const root = makeRoot();
  const log = path.join(root, "conn-log.jsonl");
  const srv = await startServer(root, { USAP_TEST_CONN_LOG: log, USAP_TEST_CONN_LOG_PREFIX: URL, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require "${preload}"`.trim(), ...extra });
  const records = () => { try { return fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } };
  // the server's record for a client connection (written when the server's socket closes)
  const recordFor = async (st) => { const until = Date.now() + GRACE_MS + SLACK_MS; for (;;) { const r = records().find((x) => x.remotePort === st.localPort); if (r || Date.now() > until) return r; await sleep(50); } };
  try { return await fn({ port: srv.port, recordFor, records, serverPid: srv.proc.pid }); } // serverPid: #151 diagnostics only
  finally { await stopServerAndWait(srv); removeTestRoot(root); }
}

// Both sides of one connection, for failure messages: tells "the server never saw the request" (no record), "the
// server answered and kept the grace period, the client did not read the answer" and "the server closed early" apart.
function evidence(st, rec) {
  const c = { status: st.status, error: st.error, sent: st.sent, sentAtAnswer: st.sentAtAnswer, answeredAt: st.answeredAt,
    firstDataAt: st.firstDataAt, endAt: st.endAt, errorAt: st.errorAt, closedAt: st.closedAt, localPort: st.localPort };
  const s = rec ? { status: rec.status, bytesRead: rec.bytesRead, answerMs: rec.finishAt && rec.finishAt - rec.arrivedAt,
    closeAfterAnswerMs: rec.finishAt && rec.sockCloseAt && rec.sockCloseAt - rec.finishAt, body: String(rec.body || "").slice(0, 80) } : null;
  return `[client ${JSON.stringify(c)} server ${JSON.stringify(s)}]`;
}
function assertEarly413(st, rec, label) {
  const ev = evidence(st, rec);
  assert.equal(st.status, 413, `${label}: status (client error ${st.error}) ${ev}`);
  assert.match(st.body, /"code":"BODY_TOO_LARGE"/, `${label}: code ${ev}`);
  assert.ok(st.body.includes(MESSAGE), `${label}: unchanged message (${st.body.slice(0, 200)}) ${ev}`);
  assert.match(st.head, /\r\nconnection: close/i, `${label}: Connection: close ${ev}`);
  assert.ok(st.answeredAt <= ANSWER_MS, `${label}: answered after ${st.answeredAt} ms ${ev}`);
  assert.ok(!st.clientGaveUp, `${label}: the server closed the connection (client gave up at ${st.closedAt} ms) ${ev}`);
  assert.ok(rec, `${label}: server record ${ev}`);
  assert.equal(rec.status, 413, `${label}: server status ${ev}`);
  assert.ok(rec.bytesRead <= EARLY_READ_BOUND, `${label}: the server read ${rec.bytesRead} bytes from this connection (bound ${EARLY_READ_BOUND}) ${ev}`);
}

test("a declared body over the 64 MiB limit is refused with today's 413 before it is read: still-sending, silent and partial clients", async () => {
  await withServer(async ({ port, recordFor }) => {
    const declared = 80 * MiB;
    const stream = await raw(port, { framing: { contentLength: declared }, send: "stream" });
    assertEarly413(stream, await recordFor(stream), "still sending");
    assert.ok(stream.sentAtAnswer < LIMIT, `still sending: answered before the client could send the limit (sent ${stream.sentAtAnswer})`);
    // Without the early check, these two would wait for a body that never arrives (until Node's request timeout).
    const silent = await raw(port, { framing: { contentLength: declared }, send: "silent", ignoreFin: false });
    assertEarly413(silent, await recordFor(silent), "silent");
    const partial = await raw(port, { framing: { contentLength: declared }, send: { partial: 1 * MiB }, ignoreFin: false });
    assertEarly413(partial, await recordFor(partial), "partial");
    // grace period kept for a client that keeps the connection open (F0 refusal-close)
    assert.ok(silent.closedAt - silent.answeredAt <= GRACE_MS + SLACK_MS, `silent: closed ${silent.closedAt - silent.answeredAt} ms after the answer`);
  });
});

// The concurrent clients run in their own process (fixtures/refusal-clients.cjs), which records its event-loop ticks
// and its I/O on each connection, so a client that simply did not run can be told apart from a server that
// misbehaved (#151: on a loaded macOS Intel runner the test process once did not run for 2.1 s, longer than the grace
// period, and the closing reset discarded an answer it never read). The server is judged from its own records; the
// client must have read the answer unless fixtures/refusal-judge.cjs shows it did not run (documented reset tradeoff).
const ANSWER_BODY = /"error":"Request body is too large\. Limit is 64 MB\.","code":"BODY_TOO_LARGE"/;
// stackSample (#151 diagnostics, opt-in): passed only by the concurrent test on macOS (see fixtures/stack-sampler.cjs).
// onSpawn (#151 diagnostics, optional): called with the client process's pid once it is spawned.
function concurrentClients(port, n, opts, cpuDiag = false, stackSample = null, onSpawn = null) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [path.join(__dirname, "fixtures", "refusal-clients.cjs"), JSON.stringify(cpuDiag ? { port, n, opts, cpuDiag, ...(stackSample ? { stackSample } : {}) } : { port, n, opts })], { timeout: GRACE_MS + 30000, maxBuffer: 16 * MiB },
      (err, stdout) => { if (err) return reject(err); try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); } }); // round 17: unparsable output rejects (was an uncaught throw)
    if (onSpawn && child && child.pid) { try { onSpawn(child.pid); } catch (_) { /* diagnostics only */ } }
  });
}
// #151 diagnostics (opt-in, macOS and Linux): the independent main-thread state observer (fixtures/thread-observer.cjs)
// for the given pids, every 200 ms. stop() -> its JSON or null; never throws.
function startThreadObserver(pids) {
  if (!["darwin", "linux"].includes(process.platform)) return { stop: async () => null };
  let child = null, out = "";
  try { child = spawn(process.execPath, [path.join(__dirname, "fixtures", "thread-observer.cjs"), "200", ...pids.map(String)], { stdio: ["pipe", "pipe", "ignore"] }); } catch (_) { return { stop: async () => null }; }
  child.on("error", () => {}); child.stdin.on("error", () => {});
  child.stdout.on("data", (d) => { if (out.length < 1 << 20) out += d; });
  const exited = new Promise((r) => child.once("exit", r));
  let stopped = null; // stop() is idempotent (round 17: the test's finally also calls it)
  return { pid: child.pid, stop: () => stopped || (stopped = (async () => {
    try { child.stdin.end(); } catch (_) {}
    if (await Promise.race([exited.then(() => "exit"), sleep(5000).then(() => "timeout")]) === "timeout") { try { child.kill("SIGKILL"); } catch (_) {} return null; }
    try { return JSON.parse(out); } catch (_) { return null; }
  })()) };
}
// Server side of one connection, from the connection-log preload: the 413 with its body, promptly, the whole grace
// period (unless the client closed first), reads within the bound. Returns the judge's view of the connection.
// #151 diagnostics: an independent process that only records scheduling gaps (fixtures/stall-sampler.cjs). Never
// throws and never decides anything: on any problem it yields null and the description says "unavailable".
function startSampler() {
  let child = null, out = "";
  try { child = spawn(process.execPath, [path.join(__dirname, "fixtures", "stall-sampler.cjs")], { stdio: ["pipe", "pipe", "ignore"] }); } catch (_) { return { stop: async () => null }; }
  child.on("error", () => {}); child.stdin.on("error", () => {});
  child.stdout.on("data", (d) => { if (out.length < 65536) out += d; });
  const exited = new Promise((r) => child.once("exit", r));
  let stopped = null; // stop() is idempotent (round 17: the test's finally also calls it)
  return {
    pid: child.pid,
    stop: () => stopped || (stopped = (async () => {
      try { child.stdin.end(); } catch (_) {}
      const t = await Promise.race([exited.then(() => "exit"), sleep(5000).then(() => "timeout")]);
      if (t === "timeout") { try { child.kill("SIGKILL"); } catch (_) {} return null; }
      try { return JSON.parse(out); } catch (_) { return null; }
    })()),
  };
}
function assertServerRefusal(rec, st, label) {
  const ev = `[client ${JSON.stringify({ status: st.status, error: st.error, sent: st.sent, answeredAt: st.answeredAt, closedAt: st.closedAt, drains: (st.drainsAt || []).length, localPort: st.localPort })} server ${JSON.stringify(rec && { status: rec.status, bytesRead: rec.bytesRead, answerMs: rec.finishAt - rec.arrivedAt, closeAfterAnswerMs: rec.sockCloseAt - rec.finishAt })}]`;
  assert.ok(rec, `${label}: server record ${ev}`);
  assert.equal(rec.status, 413, `${label}: server status ${ev}`);
  assert.match(rec.body, ANSWER_BODY, `${label}: server answer body ${ev}`);
  assert.ok(rec.finishAt - rec.arrivedAt <= ANSWER_MS, `${label}: answered ${rec.finishAt - rec.arrivedAt} ms after the request ${ev}`);
  const clientClosedFirst = st.t0 + st.closedAt < rec.sockCloseAt && st.error === null;
  if (!clientClosedFirst) assert.ok(rec.sockCloseAt - rec.finishAt >= GRACE_MS - GRACE_TOLERANCE_MS, `${label}: the server closed ${rec.sockCloseAt - rec.finishAt} ms after the answer (grace ${GRACE_MS} ms) ${ev}`);
  assert.ok(rec.bytesRead <= EARLY_READ_BOUND, `${label}: the server read ${rec.bytesRead} bytes from this connection (bound ${EARLY_READ_BOUND}) ${ev}`);
  return { conn: { status: rec.status, answeredAt: rec.finishAt, closedAt: rec.sockCloseAt }, ev };
}

test("concurrent over-limit declarations are each refused early; the server's total read stays bounded", async (t) => {
  await withServer(async ({ port, records, serverPid }) => {
    let observer = null, clientPid = null; // #151 diagnostics only
    const sampler = startSampler(); // #151 diagnostics only
    // round 17 (S151-J413-HANG-201): the observers are stopped on EVERY path. When the client process is killed at its
    // exec timeout, concurrentClients rejects and the stops below were skipped; both observer children kept their stdin
    // pipes open and the file ran into its 600 s timeout. The stops are idempotent; verdicts are unchanged.
    try {
    // cpuDiag (#151 diagnostics only): the client process also records its CPU time, context switches and bytes sent
    // at each tick, and runs a watchdog thread; `proc` is used only in the description below
    const { clients, ticks, proc } = await concurrentClients(port, 10, { url: URL, mode: "stream", contentLength: 100 * MiB, ignoreFin: true, capBytes: 96 * MiB, maxMs: GRACE_MS + 10000 }, true,
      process.platform === "darwin" ? { seconds: 10, intervalMs: 10 } : null, // #151: main-thread stacks while the clients run (macOS)
      (pid) => { clientPid = pid; observer = startThreadObserver([pid, serverPid]); }); // #151: independent state observer
    const until = Date.now() + GRACE_MS + SLACK_MS;
    while (records().length < clients.length && Date.now() < until) await sleep(50);
    const recs = records();
    // #151 diagnostics, printed before (and independent of) the assertions below: every client whose answer was lost.
    const samples = await sampler.stop();
    if (proc && proc.stack !== undefined) t.diagnostic(`#151 client main-thread stacks: ${String(proc.stack).slice(0, 900)}`);
    const observed = observer ? await observer.stop() : null;
    for (const [i, st] of clients.entries()) {
      if (st.status !== null) continue;
      let d; try { d = describeStallCorrelates({ st, rec: recs.find((x) => x.remotePort === st.localPort), ticks, proc, observer: observed, clientPid, serverPid }); } catch (_) { d = "description failed"; }
      t.diagnostic(`#151 stall correlates, client ${i}: ${d}`);
    }
    if (proc) t.diagnostic(`#151 client process: GC pauses >= 5 ms ${(proc.gc || []).length} (max ${Math.max(0, ...(proc.gc || []).map((g) => g[1]))} ms); loop delay ${proc.loop ? `max ${proc.loop.maxMs} ms p99 ${proc.loop.p99Ms} ms` : "not recorded"}; observer ${observed ? `${observed.platform} samples client ${(observed.procs[clientPid] || {}).samples || 0} studio ${(observed.procs[serverPid] || {}).samples || 0}` : "not run"}`);
    for (const [i, st] of clients.entries()) {
      if (st.status !== null) continue;
      let d; try { d = describeLostClient(st, recs.find((x) => x.remotePort === st.localPort), ticks, samples, proc || null, i); } catch (_) { d = "description failed"; }
      t.diagnostic(`#151 lost answer, client ${i}: ${d}`);
    }
    let total = 0, stalled = 0;
    const excused = []; // #151 diagnostics: each excused client with its timeline, for the guard below
    for (const [i, st] of clients.entries()) {
      const rec = recs.find((x) => x.remotePort === st.localPort);
      const { conn, ev } = assertServerRefusal(rec, st, `client ${i}`);
      total += rec.bytesRead;
      const v = judgeRefusedClient(st, conn, ticks, 413, ANSWER_BODY);
      assert.ok(v.ok, `client ${i}: ${v.why} ${ev}`);
      if (v.kind === "answered") assert.equal(st.connectionHeader, "close", `client ${i}: Connection: close ${ev}`);
      else { stalled += 1; excused.push(`client ${i}: ${v.why}`); }
    }
    if (excused.length) t.diagnostic(`${excused.length}/${clients.length} clients excused (documented reset tradeoff): ${excused.join(" | ")}`);
    assert.ok(stalled < clients.length, `at least one client read its answer (a run where none did proves nothing about delivery); excused: ${excused.join(" | ")}`);
    assert.ok(total <= 10 * EARLY_READ_BOUND, `total read ${total}`);
    } finally { await sampler.stop(); if (observer) await observer.stop(); } // round 17: every path (see above)
  }, { USAP_TEST_CONN_LOG_LOOP: "1" }); // #151 diagnostics: the server's loop summary in each record
});

// round 17 (S151-J413-HANG-201) control: both observers end their children when stopped, also when the client run
// fails, and stop() is idempotent (the concurrent test's finally calls it again). The concurrent test itself keeps its
// verdicts; this only checks the cleanup it now relies on.
test("observer cleanup: the sampler and the thread observer end their child processes when stopped, also after a failed client run; stop() is idempotent", { timeout: 30000 }, async () => {
  const sampler = startSampler(); const observer = startThreadObserver([process.pid]);
  const alive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
  try { assert.ok(alive(sampler.pid), "the sampler child runs"); await assert.rejects(Promise.reject(new Error("client run failed (injected)"))); }
  finally {
    const a = sampler.stop(), b = sampler.stop(); assert.equal(a, b, "sampler stop() is idempotent (same promise)");
    await a; await observer.stop(); await observer.stop();
  }
  await sleep(200);
  assert.equal(alive(sampler.pid), false, "the sampler child is gone");
  if (observer.pid) assert.equal(alive(observer.pid), false, "the thread observer child is gone");
});

test("judge rules for this test: an answer is required unless the client provably did not run while the server held the connection", () => {
  const conn = { status: 413, answeredAt: 10000, closedAt: 12000 };
  const body = '{"ok":false,"error":"Request body is too large. Limit is 64 MB.","code":"BODY_TOO_LARGE"}';
  const read = { status: 413, body, localPort: 1, drainsAt: [] };
  const lost = { status: null, body: "", error: "EPIPE", localPort: 1, drainsAt: [] };
  const asleep = [9990, 12100]; // no tick between the answer and the close
  assert.equal(judgeRefusedClient(read, conn, asleep, 413, ANSWER_BODY).ok, true, "answer read");
  assert.equal(judgeRefusedClient({ ...read, body: body.replace("64 MB", "32 MB") }, conn, asleep, 413, ANSWER_BODY).ok, false, "wrong message");
  assert.equal(judgeRefusedClient({ ...read, status: 400 }, conn, asleep, 413, ANSWER_BODY).ok, false, "wrong status");
  assert.equal(judgeRefusedClient(lost, null, asleep, 413, ANSWER_BODY).ok, false, "no server record");
  assert.equal(judgeRefusedClient(lost, conn, asleep, 413, ANSWER_BODY).kind, "stalled", "lost while the client did not run: excused");
  assert.equal(judgeRefusedClient(lost, { ...conn, closedAt: 10300 }, asleep, 413, ANSWER_BODY).ok, false, "lost after a 300 ms grace period");
  assert.equal(judgeRefusedClient(lost, { ...conn, status: 400 }, asleep, 413, ANSWER_BODY).ok, false, "server did not answer 413");
  assert.equal(judgeRefusedClient(lost, conn, [9990, 10500, 10510, 12100], 413, ANSWER_BODY).ok, false, "the client completed an event-loop iteration in the window");
  assert.equal(judgeRefusedClient({ ...lost, drainsAt: [11000] }, conn, asleep, 413, ANSWER_BODY).ok, false, "the client handled I/O on this connection in the window");
});

test("unchanged: a declared body of exactly the limit is accepted; one byte more is refused before reading", async () => {
  await withServer(async ({ port, recordFor }) => {
    const head = Buffer.from('{"ids":[],"pad":"'), tail = Buffer.from('"}');
    const body = Buffer.concat([head, Buffer.alloc(LIMIT - head.length - tail.length, 0x61), tail]);
    assert.equal(body.length, LIMIT);
    const ok = await raw(port, { framing: { contentLength: LIMIT }, send: body, ignoreFin: false, maxMs: 60000 });
    assert.equal(ok.status, 200, `exactly the limit: ${ok.body.slice(0, 200)} (client error ${ok.error})`);
    assert.match(ok.body, /"ok":true/);
    const over = await raw(port, { framing: { contentLength: LIMIT + 1 }, send: "silent", ignoreFin: false });
    assertEarly413(over, await recordFor(over), "limit + 1");
  });
});

test("unchanged: chunked bodies (no declared length) keep the streamed limit; a small JSON request is accepted and kept alive", async () => {
  await withServer(async ({ port, recordFor }) => {
    const chunked = await raw(port, { framing: { chunked: true }, send: "stream", capBytes: 80 * MiB, maxMs: GRACE_MS + 30000 });
    assert.equal(chunked.status, 413, `chunked over the limit (client error ${chunked.error})`);
    assert.ok(chunked.body.includes(MESSAGE), "same message");
    const rec = await recordFor(chunked);
    assert.ok(rec && rec.bytesRead >= LIMIT, `chunked: read up to the streamed limit, as before (${rec && rec.bytesRead})`);
    const small = await raw(port, { framing: { contentLength: 10 }, send: Buffer.from('{"ids":[]}'), ignoreFin: false, maxMs: 5000 });
    assert.equal(small.status, 200, small.body);
    assert.equal(small.keptAlive, true, `kept alive (head ${small.head})`);
  });
});

test("precedence unchanged: Origin 403 and content-type 415 come before the declared-length 413; malformed framing is refused by Node", async () => {
  await withServer(async ({ port }) => {
    const declared = { contentLength: 80 * MiB };
    const origin = await raw(port, { framing: declared, send: "silent", ignoreFin: false, headers: "Origin: http://evil.example\r\n" });
    assert.equal(origin.status, 403, origin.body);
    const type = await raw(port, { framing: declared, send: "silent", ignoreFin: false, contentType: "text/plain" });
    assert.equal(type.status, 415, type.body);
    // Node's parser rejects these before any route runs (400), so the early check never sees them
    for (const [label, frame] of [["Content-Length and Transfer-Encoding", `Content-Length: ${80 * MiB}\r\nTransfer-Encoding: chunked`], ["non-numeric Content-Length", "Content-Length: 8e7"]]) {
      const st = await new Promise((resolve) => {
        const s = net.connect(port, "127.0.0.1"); let out = "";
        s.on("data", (d) => { out += d; }); s.on("error", () => {}); s.on("close", () => resolve(out));
        s.write(`POST ${URL} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n${frame}\r\n\r\n`);
        setTimeout(() => s.destroy(), 3000);
      });
      assert.match(st, /^HTTP\/1\.1 400/, `${label}: ${st.slice(0, 80)}`);
    }
  });
});
