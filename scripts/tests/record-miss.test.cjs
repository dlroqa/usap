// Controls for the json-413 missing-record diagnostics (fixtures/record-miss.cjs, api-contract/connection-log-preload.cjs
// USAP_TEST_CONN_LOG_TRACE; messages only). A real test server with the preload refuses real over-limit requests, and
// each way a record can go missing is produced for real and must read as such: never generated (the record write
// fails), delayed (collected before the server closed the socket, the record appears later), never generated (the
// socket still open when the trail is read), identity mismatch (looked up under another port), unreadable log (an
// unparsable line hides every record) and overwritten log (the file shrinks). The normal case leaves the full trail in
// order with the grace timer as the destroy caller. Bounded: every client and wait has a deadline.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");
const { makeRoot, startServer, stopServerAndWait, removeTestRoot } = require("./api-contract/harness.cjs");
const { describeRecordMiss, parseTrail, makeRecordCollector, sanitizeTail } = require("./fixtures/record-miss.cjs");
const { GRACE_MS } = require("../server/http/refusal-close.cjs");

const MiB = 1024 * 1024;
const URL = "/api/cleanup";
const preload = path.join(__dirname, "api-contract", "connection-log-preload.cjs").replace(/\\/g, "/");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One over-limit request (declared 80 MiB) whose client keeps sending (as json-413's "still sending" client, capped at
// capBytes) and keeps its side open; resolves at the answer with the socket still open (the server closes it).
const CHUNK = Buffer.alloc(64 * 1024, 0x61);
function overLimit(port, { capBytes = 96 * MiB } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ port, host: "127.0.0.1", allowHalfOpen: true });
    const st = { t0: Date.now(), status: null, answeredAt: null, closedAt: null, errorAt: null, error: null, localPort: null, s };
    const give = setTimeout(() => { s.destroy(); reject(new Error("no answer within 10 s")); }, 10000);
    let buf = "";
    s.on("data", (d) => { buf += d.toString("latin1"); const m = buf.match(/^HTTP\/1\.1 (\d{3})/); if (m && st.status === null) { st.status = Number(m[1]); st.answeredAt = Date.now() - st.t0; clearTimeout(give); resolve(st); } });
    s.on("error", (e) => { st.error = e.code; if (st.errorAt === null) st.errorAt = Date.now() - st.t0; });
    s.on("close", () => { st.closedAt = Date.now() - st.t0; });
    s.on("connect", () => {
      st.localPort = s.localPort;
      s.write(`POST ${URL} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${80 * MiB}\r\n\r\n`);
      let sent = 0;
      const pump = () => { while (!s.destroyed && sent < capBytes) { sent += CHUNK.length; if (!s.write(CHUNK)) { s.once("drain", pump); return; } } };
      pump();
    });
  });
}
const closed = async (st, ms = GRACE_MS + 5000) => { const end = Date.now() + ms; while (st.closedAt === null && Date.now() < end) await sleep(20); assert.notEqual(st.closedAt, null, "client closed"); };

async function withTraced(fn, { log: logOverride = null } = {}) {
  const root = makeRoot();
  const log = logOverride ? logOverride(root) : path.join(root, "conn-log.jsonl");
  const trail = path.join(root, "conn-trail.jsonl");
  const srv = await startServer(root, { USAP_TEST_CONN_LOG: log, USAP_TEST_CONN_LOG_PREFIX: URL, USAP_TEST_CONN_LOG_TRACE: trail, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require "${preload}"`.trim() });
  const events = () => { try { return parseTrail(fs.readFileSync(trail, "utf8")).events; } catch (_) { return []; } };
  // C3: the same server snapshot json-413 passes (exit seen while the test runs; sanitized tail)
  let stopAt = null; // when the test begins stopping the server; "before" compares the exit with it
  const exit = { code: null, signal: null, at: null };
  srv.proc.once("exit", (code, signal) => { exit.code = code; exit.signal = signal; exit.at = Date.now(); });
  const server = () => { const running = srv.proc.exitCode === null && srv.proc.signalCode === null;
    return { pid: srv.proc.pid, running, exit: running ? null : { ...exit, before: stopAt === null || (exit.at !== null && exit.at < stopAt) }, tail: sanitizeTail(srv.log(), { root }) }; };
  const collector = (deadlineMs, lateLookMs = 0, withServer = false) => makeRecordCollector({ log, trail, trace: true, deadlineMs, lateLookMs, server: withServer ? server : null });
  const stopNow = async () => { stopAt = Date.now(); await stopServerAndWait(srv); };
  try { return await fn({ port: srv.port, log, trail, events, collector, srv, root, stopNow }); }
  finally { if (stopAt === null) stopAt = Date.now(); await stopServerAndWait(srv); removeTestRoot(root); }
}

test("normal: the trail is complete and in order, the grace timer destroys, and the record is found", { timeout: 30000 }, async () => {
  await withTraced(async ({ port, events, collector }) => {
    const st = await overLimit(port);
    await closed(st);
    const rec = await collector(GRACE_MS + 2500).recordFor(st);
    assert.ok(rec, "record found"); assert.equal(rec.status, 413);
    assert.equal(st.recordMiss, undefined, "no reading for a found record");
    const ev = events().filter((e) => e.rp === st.localPort || e.id === (events().find((x) => x.ev === "arrive" && x.rp === st.localPort) || {}).id);
    const order = ev.map((e) => e.ev).filter((e) => e !== "sockerr");
    assert.deepEqual(order, ["arrive", "end", "finish", "destroy", "sockclose", "flush"], JSON.stringify(ev));
    const at = Object.fromEntries(ev.map((e) => [e.ev, e.at]));
    assert.ok(at.arrive <= at.end && at.end <= at.finish && at.finish <= at.destroy && at.destroy <= at.sockclose && at.sockclose <= at.flush);
    assert.ok(at.destroy - at.finish >= GRACE_MS - 100, `destroyed ${at.destroy - at.finish} ms after finish (grace)`);
    const a = ev.find((e) => e.ev === "arrive"), d = ev.find((e) => e.ev === "destroy");
    assert.equal(a.over, true); assert.equal(a.cl, 80 * MiB);
    assert.ok(Array.isArray(d.by) && d.by.length > 0 && d.by.every((n) => !/[\\/]/.test(n)), `caller names only: ${JSON.stringify(d.by)}`);
    assert.equal(ev.find((e) => e.ev === "flush").result, "ok");
  });
});

test("never generated: the record write fails and the reading names its error", { timeout: 30000 }, async () => {
  await withTraced(async ({ port, collector }) => {
    const st = await overLimit(port);
    await closed(st);
    assert.equal(await collector(300).recordFor(st), undefined, "a miss");
    assert.match(st.recordMiss, /^never generated: the record write failed \((EISDIR|EPERM|EACCES|ENOENT)\)/, st.recordMiss);
    assert.match(st.recordMiss, /record write (EISDIR|EPERM|EACCES|ENOENT) \d+/);
  }, { log: (root) => { const d = path.join(root, "log-is-a-dir"); fs.mkdirSync(d); return d; } });
});

test("delayed: collected while the server still holds the socket; the record appears after the deadline", { timeout: 30000 }, async () => {
  await withTraced(async ({ port, collector }) => {
    const st = await overLimit(port);
    assert.equal(await collector(200, GRACE_MS + 2000).recordFor(st), undefined, "a miss at the short deadline");
    assert.match(st.recordMiss, /^published after the last read \(delayed, \d+ ms after it\)/, st.recordMiss);
    assert.match(st.recordMiss, /record appeared after the deadline at \d+$/);
    await closed(st);
  });
});

test("never generated: the server socket is still open when the trail is read", { timeout: 30000 }, async () => {
  await withTraced(async ({ port, collector }) => {
    const st = await overLimit(port);
    assert.equal(await collector(100, 0).recordFor(st), undefined);
    assert.match(st.recordMiss, /^never generated: the server socket was not closed by the end of collection \(no destroy seen\)/, st.recordMiss);
    assert.match(st.recordMiss, /record not seen after the deadline either$/);
    await closed(st);
  });
});

test("identity mismatch: looked up under another port, the reading names the port the request arrived with", { timeout: 30000 }, async () => {
  await withTraced(async ({ port, collector }) => {
    const st = await overLimit(port);
    await closed(st);
    const real = st.localPort, wrong = { ...st, localPort: real === 65535 ? 1 : real + 1 };
    assert.equal(await collector(200).recordFor(wrong), undefined);
    assert.match(wrong.recordMiss, new RegExp(`^identity mismatch: a request arrived near this client with remotePort ${real} \\(client local port ${wrong.localPort}\\)`), wrong.recordMiss);
    const far = { ...wrong, t0: st.t0 + 600000 }; // an arrival nowhere near this client: not claimed as its identity
    assert.equal(await collector(100).recordFor(far), undefined);
    assert.match(far.recordMiss, /^never seen by the record listener \(1 traced arrivals, none for port \d+\)/, far.recordMiss);
  });
});

test("unreadable log: one unparsable line hides every record (records() unchanged) and the reading says so", { timeout: 30000 }, async () => {
  await withTraced(async ({ port, log, collector }) => {
    const st = await overLimit(port);
    await closed(st);
    const c = collector(400);
    assert.ok(await c.recordFor({ ...st }), "found before the bad line");
    fs.appendFileSync(log, "{\"remotePort\": 1, partial");
    assert.deepEqual(c.records(), [], "records(): any unparsable line -> none (unchanged)");
    assert.equal(await c.recordFor(st), undefined);
    assert.match(st.recordMiss, /^published, but the log had 1 unparsable line\(s\): collected as none/, st.recordMiss);
  });
});

test("overwritten: the log shrinks during collection and the reading says so", { timeout: 30000 }, async () => {
  await withTraced(async ({ port, log, collector }) => {
    const st = await overLimit(port);
    await closed(st);
    fs.appendFileSync(log, JSON.stringify({ remotePort: 1, pad: "x".repeat(200) }) + "\n");
    const other = { ...st, localPort: 2 }; // a port with no record, so collection keeps reading while the file shrinks
    setTimeout(() => fs.writeFileSync(log, ""), 150);
    assert.equal(await makeRecordCollector({ log, trail: null, trace: true, deadlineMs: 600, lateLookMs: 0 }).recordFor(other), undefined);
    assert.match(other.recordMiss, /log shrank/, other.recordMiss);
    // with the trail: the real record was published, then the log lost it
    // (the record is replaced by another line, then the file is truncated while collection reads it)
    const st2 = { ...st };
    fs.writeFileSync(log, JSON.stringify({ remotePort: 1, pad: "x".repeat(400) }) + "\n");
    const c = collector(400);
    setTimeout(() => fs.writeFileSync(log, ""), 150);
    assert.equal(await c.recordFor(st2), undefined);
    assert.match(st2.recordMiss, /^published, then the log shrank \(overwritten\)/, st2.recordMiss);
  });
});

test("synthetic: readings are bounded, sanitized and ordered by rule", () => {
  const t0 = 5_000_000, st = { t0, answeredAt: 2, errorAt: 1774, error: "ECANCELED", closedAt: 1775, localPort: 61342 };
  const ev = [{ ev: "arrive", id: 1, rp: 61342, cl: 83886080, over: true, at: t0 + 1 }, { ev: "end", id: 1, at: t0 + 2 }, { ev: "finish", id: 1, status: 413, at: t0 + 2 },
    { ev: "destroy", id: 1, by: ["watchAll", "listOnTimeout"], at: t0 + 1774 }, { ev: "sockclose", id: 1, at: t0 + 1775 }, { ev: "flush", id: 1, rp: 61342, result: "EBUSY", at: t0 + 1776 }];
  const r = describeRecordMiss({ st, port: 61342, events: ev, polls: { count: 3, first: t0 + 1800, last: t0 + 6300, deadline: t0 + 6275, log: { lines: 0, bad: 0, ports: [] } } });
  assert.equal(r.verdict, "never generated: the record write failed (EBUSY)");
  assert.match(r.line, /destroy 1774 by watchAll < listOnTimeout/);
  assert.match(r.line, /client answer 2, error ECANCELED 1774, close 1775/);
  const huge = describeRecordMiss({ st, port: 61342, events: ev.map((e) => (e.ev === "destroy" ? { ...e, by: ["x".repeat(2000)] } : e)), polls: {} });
  assert.ok(huge.line.length <= 900);
  assert.equal(describeRecordMiss({ st, port: 61342, events: [], polls: {} }).verdict, "never seen by the record listener (0 traced arrivals, none for port 61342)");
  const ok = ev.map((e) => (e.ev === "flush" ? { ...e, result: "ok" } : e));
  assert.equal(describeRecordMiss({ st, port: 61342, events: ok, polls: { last: t0 + 1700, log: { lines: 0, bad: 0, ports: [] } } }).verdict, "published after the last read (delayed, 76 ms after it)");
  assert.equal(describeRecordMiss({ st, port: 61342, events: ok, polls: { last: t0 + 9000, log: { lines: 1, bad: 0, ports: [61342] } } }).verdict, "published and present at the last read, but not matched");
  assert.equal(describeRecordMiss({ st, port: 61342, events: ok, polls: { last: t0 + 9000, log: { lines: 0, bad: 0, ports: [] } } }).verdict, "published before the last read but not seen (unexplained)");
  assert.deepEqual(parseTrail("{\"a\":1}\nnot json\n"), { events: [{ a: 1 }], bad: 1 });
});

test("without USAP_TEST_CONN_LOG_TRACE the preload writes no trail and the record has exactly its previous fields", { timeout: 30000 }, async () => {
  const root = makeRoot();
  const log = path.join(root, "conn-log.jsonl");
  const srv = await startServer(root, { USAP_TEST_CONN_LOG: log, USAP_TEST_CONN_LOG_PREFIX: URL, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require "${preload}"`.trim() });
  try {
    const st = await overLimit(srv.port);
    await closed(st);
    const rec = await makeRecordCollector({ log, deadlineMs: GRACE_MS + 2500 }).recordFor(st);
    assert.ok(rec);
    assert.deepEqual(Object.keys(rec), ["url", "remotePort", "arrivedAt", "status", "body", "finishAt", "resCloseAt", "sockCloseAt", "bytesRead"]);
    assert.deepEqual(fs.readdirSync(root).filter((f) => /trail/.test(f)), []);
  } finally { await stopServerAndWait(srv); removeTestRoot(root); }
});

// ── C3 (round 15): dead server, trail cap, read-failure counts, sanitized tail ──────────────────────────────────────
test("C3 real: the studio dies after its answer; the miss reads 'server dead' with the exit seen before any test stop", { timeout: 30000 }, async () => {
  await withTraced(async ({ port, collector, srv, root }) => {
    const st = await overLimit(port);
    const killAt = Date.now();
    srv.proc.kill("SIGKILL"); // Windows: TerminateProcess (exit code 1); POSIX: SIGKILL
    await closed(st);
    assert.equal(await collector(300, 200, true).recordFor(st), undefined, "a miss (the required-record lookup is unchanged)");
    assert.match(st.recordMiss, /^server dead: the studio had exited \(code (1|null), signal (SIGKILL|none)\) at -?\d+ \(before the test stopped it\), with no record write traced for this connection/, st.recordMiss);
    assert.match(st.recordMiss, /studio at the miss exited \(pid \d+/);
    const exitRel = Number(/had exited \([^)]*\) at (-?\d+)/.exec(st.recordMiss)[1]);
    assert.ok(exitRel >= killAt - st.t0 - 1, `the exit time (${exitRel}) is the kill's (${killAt - st.t0}), not a constant`);
    assert.ok(!st.recordMiss.includes(root) && !st.recordMiss.includes(require("node:os").tmpdir()), "no paths in the reading");
  });
});

test("C3 real: a healthy studio's record is found; the server snapshot adds nothing to a hit", { timeout: 30000 }, async () => {
  await withTraced(async ({ port, collector }) => {
    const st = await overLimit(port);
    await closed(st);
    const rec = await collector(GRACE_MS + 2500, 0, true).recordFor(st);
    assert.ok(rec, "found"); assert.equal(st.recordMiss, undefined);
  });
});

test("C3 synthetic: rule order - dead without a write, dead WITH a write (not 'dead'), trail cap, read-failure counts", () => {
  const st = { t0: 1000, answeredAt: 2, error: "ECANCELED", errorAt: 1774, closedAt: 1775 };
  const ev = (id, rp, list) => [{ ev: "arrive", id, rp, at: 1001, cl: 100 }, ...list.map(([e, at, extra]) => ({ ev: e, id, at, ...(extra || {}) }))];
  const dead = { atMiss: { pid: 7, running: false, exit: { code: 1, signal: null, at: 2770, before: true } }, afterLook: { pid: 7, running: false, exit: { code: 1, signal: null, at: 2770, before: true }, tail: "TypeError: boom" } };
  const r1 = describeRecordMiss({ st, port: 5, events: ev(1, 5, [["end", 1002], ["finish", 1003, { status: 413 }]]), polls: {}, server: dead });
  assert.match(r1.verdict, /^server dead: the studio had exited \(code 1, signal none\) at 1770 \(before the test stopped it\)/);
  assert.match(r1.line, /log tail \[TypeError: boom\]/);
  const r2 = describeRecordMiss({ st, port: 5, events: ev(1, 5, [["sockclose", 1500], ["flush", 1501, { result: "ok" }]]), polls: { last: 1400 }, server: dead });
  assert.doesNotMatch(r2.verdict, /^server dead/, "a record write succeeded: a reader-side miss, not a dead server");
  const cap = Array.from({ length: 400 }, (_, i) => ({ ev: "arrive", id: i + 10, rp: 9000 + i, at: 1001 }));
  assert.match(describeRecordMiss({ st, port: 5, events: cap, polls: {} }).verdict, /^trail incomplete \(400 lines, the preload's cap, 0 unparsable\)/);
  assert.match(describeRecordMiss({ st, port: 5, events: [], polls: {}, trailBad: 2 }).verdict, /^trail incomplete \(0 lines, 2 unparsable\)/);
  const running = { atMiss: { pid: 7, running: true }, afterLook: { pid: 7, running: true, tail: "" } };
  assert.match(describeRecordMiss({ st, port: 5, events: ev(1, 5, [["end", 1002]]), polls: { readStats: { parse: 3 } }, server: running }).line, /^never generated: .*studio at the miss running \(pid 7\).*collector read failures parsex3/);
});

test("C3 sanitizer: no root, temp or home path and no JSON body survive; bounded", () => {
  const os = require("node:os");
  const root = path.join(os.tmpdir(), "usap-contract-abc");
  const text = [`[backend] start ${path.join(root, "app", "m.gguf")}`, `{"error":"a body"}`, "C:\\Users\\someone\\x.exe failed", `at f (${path.join(os.homedir(), "repo", "serve.cjs")}:1:2)`, ...Array.from({ length: 50 }, (_, i) => `line ${i}`)].join("\n");
  const t = sanitizeTail(text, { root });
  for (const bad of [root, os.tmpdir(), os.homedir(), "a body", "Users\\someone"]) assert.ok(!t.includes(bad), `${bad} removed: ${t}`);
  assert.ok(t.length <= 1024 && t.split(" | ").length <= 20, "bounded");
});

test("C3 real: a studio stopped by the test itself before the reading does not read 'before the test stopped it'", { timeout: 30000 }, async () => {
  await withTraced(async ({ port, collector, stopNow }) => {
    const st = await overLimit(port);
    await stopNow(); // the test's own stop (taskkill /F on Windows: exit code 1, like a crash)
    await closed(st);
    assert.equal(await collector(300, 200, true).recordFor(st), undefined);
    assert.doesNotMatch(st.recordMiss, /before the test stopped it/, st.recordMiss);
  });
});

test("C3 sanitizer: forward-slash drive paths, file URLs, UNC, paths after = or :, inspect bodies", () => {
  const t = sanitizeTail(["opening C:/Users/someone/models/m.gguf", "url file:///C:/x/y.json done", "share \\\\fileserver\\share\\dir\\f.txt", "--model=/mnt/data/models/m.gguf",
    "cwd:/srv/app/x ok", "{ error: 'body text' }", "[{ id: 1 }]", "kept line"].join("\n"));
  for (const bad of ["someone", "C:/x", "fileserver", "/mnt/data", "/srv/app", "body text", "id: 1"]) assert.ok(!t.includes(bad), `${bad} removed: ${t}`);
  assert.match(t, /kept line/);
});
