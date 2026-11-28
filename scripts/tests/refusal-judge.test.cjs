// #151 diagnostics: the refusal judge (fixtures/refusal-judge.cjs). Today's rule is unchanged and stays the rule every
// refusal test uses. Failure messages now carry a timeline relative to the server's answer. A proposed macOS rule is
// exported for review only; these tests pin what it would excuse and, above all, what it must still reject.
"use strict";
const assert = require("node:assert/strict");
const net = require("node:net");
const path = require("node:path");
const { execFile } = require("node:child_process");
const test = require("node:test");
const { judgeRefusedClient, judgeRefusedClientProposed, judgeRefusedClientMac } = require("./fixtures/refusal-judge.cjs");
const { GRACE_MS } = require("../server/http/refusal-close.cjs");

const conn = { status: 413, answeredAt: 10000, closedAt: 10000 + GRACE_MS + 3 };
const lost = { localPort: 1, status: null, body: "", error: "ECONNRESET", drainsAt: [], io: { firstDataAt: null, dataEvents: 0, endAt: null, errorAt: 16317, closeAt: 16317 } };
const asleep = [9990, 12200, 12210]; // last tick before the answer, then nothing until after the close
// the #151 recurrence shape: one drain inside the window, no tick inside it
const macShape = { ...lost, drainsAt: [10400] };

test("today's rule is unchanged: a drain in the window fails, on every platform", () => {
  assert.equal(judgeRefusedClient(lost, conn, asleep, 413).kind, "stalled", "lost while not running: excused");
  const v = judgeRefusedClient(macShape, conn, asleep, 413);
  assert.equal(v.ok, false); assert.match(v.why, /handled I\/O on this connection 1 time/);
  assert.equal(judgeRefusedClient(lost, conn, [9990, 10500, 10510, 12200], 413).ok, false, "a full iteration in the window fails");
  assert.equal(judgeRefusedClient(lost, { ...conn, closedAt: conn.answeredAt + 300 }, asleep, 413).ok, false, "a short grace period fails");
  assert.equal(judgeRefusedClient({ ...lost, status: 200 }, conn, asleep, 413).ok, false, "a different answer fails");
  assert.equal(judgeRefusedClient({ ...lost, status: 413, body: "{}" }, conn, asleep, 413).kind, "answered");
});

test("failure messages carry the client's timeline relative to the server's answer", () => {
  const v = judgeRefusedClient(macShape, conn, asleep, 413);
  assert.match(v.why, /\[timeline ms from the server's answer: serverClose 2003; ticks last-before -10, inside 0, first-after 2200; drains \[400\]; client firstData null \(0 events\), end null, error 6317, close 6317\]/);
  assert.match(judgeRefusedClient(lost, conn, asleep, 413).why, /timeline/, "an excuse carries it too");
  assert.equal(judgeRefusedClient({ ...lost, status: 413, body: "{}" }, conn, asleep, 413).why, undefined, "an answered client needs none");
});

test("PROPOSED macOS rule (not in use): excuses only the drain-then-stall shape; still rejects every case where the client could have read", () => {
  const P = (st, c = conn, ticks = asleep) => judgeRefusedClientProposed(st, c, ticks, 413, null, "darwin");
  // the one case it changes: a lone drain in the window, nothing after it until the close
  assert.equal(P(macShape).kind, "stalled", "drain, then the process did not run again before the close: excused on macOS");
  // ...and nowhere else: other platforms keep today's rule
  assert.equal(judgeRefusedClientProposed(macShape, conn, asleep, 413, null, "linux").ok, false, "Linux: unchanged");
  assert.equal(judgeRefusedClientProposed(macShape, conn, asleep, 413, null, "win32").ok, false, "Windows: unchanged");
  // negative controls: the client ran again after the drain, or read something, or the server misbehaved
  assert.equal(P(macShape, conn, [...asleep, 10900].sort((a, b) => a - b)).ok, false, "drain then a tick in the window");
  assert.equal(P({ ...macShape, drainsAt: [10400, 10450] }).ok, false, "two drains in the window");
  assert.equal(P(lost, conn, [9990, 10500, 10510, 12200]).ok, false, "a full iteration (two ticks) in the window");
  assert.equal(P(macShape, conn, [9990, 10300, 12200]).ok, false, "a tick then the drain in the window");
  assert.equal(P({ ...macShape, io: { ...macShape.io, firstDataAt: 10401, dataEvents: 1 } }).ok, false, "received data in the window");
  assert.equal(P(macShape, { ...conn, closedAt: conn.answeredAt + 300 }).ok, false, "server closed early");
  assert.equal(P(macShape, { ...conn, closedAt: conn.answeredAt + 5 }).ok, false, "server closed at once");
  assert.equal(P(macShape, { ...conn, status: 400 }).ok, false, "server answered differently");
  assert.equal(P(macShape, { ...conn, answeredAt: null }).ok, false, "server never answered");
  assert.equal(P(macShape, { ...conn, closedAt: null }).ok, false, "server never closed");
  assert.equal(P(macShape, null).ok, false, "no server record");
  assert.equal(P({ ...macShape, status: 200 }).ok, false, "client read a different answer");
  assert.equal(P(macShape, conn, Array.from({ length: 300 }, (_, i) => 9990 + i * 10)).ok, false, "a client running normally (tick every 10 ms)");
});

// A real refused connection whose answer never reaches an active client: the server records an answer and keeps the
// whole grace period, but writes nothing, then resets. The client (separate process, keeps sending) is running the whole
// time. Both today's rule and the proposed macOS rule must reject it on every platform.
test("real sockets: an active client that lost its answer is rejected by today's rule and by the proposed macOS rule", { timeout: 60000 }, async () => {
  const MiB = 1024 * 1024;
  const records = new Map();
  const server = net.createServer((s) => {
    s.on("error", () => {});
    const rec = { status: null, answeredAt: null, closedAt: null };
    records.set(s.remotePort, rec);
    s.once("data", () => {
      s.pause(); // read nothing more, like a refusal
      rec.status = 413; rec.answeredAt = Date.now(); // the answer is "sent" but never written: lost on the way
      setTimeout(() => { rec.closedAt = Date.now(); s.resetAndDestroy(); }, GRACE_MS);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const opts = { url: "/api/cleanup", mode: "stream", ignoreFin: true, capBytes: 64 * MiB, maxMs: GRACE_MS + 10000 };
    const { clients: [st], ticks } = await new Promise((resolve, reject) => {
      execFile(process.execPath, [path.join(__dirname, "fixtures", "refusal-clients.cjs"), JSON.stringify({ port: server.address().port, n: 1, opts })], { timeout: 30000, maxBuffer: 16 * MiB },
        (err, stdout) => { if (err) reject(err); else resolve(JSON.parse(stdout)); });
    });
    const rec = records.get(st.localPort);
    assert.ok(rec && rec.closedAt, "server record");
    assert.equal(st.status, null, "the client never got an answer");
    const now = judgeRefusedClient(st, rec, ticks, 413);
    assert.equal(now.ok, false, `today's rule: ${now.why}`);
    for (const platform of ["darwin", "linux", "win32"]) {
      const p = judgeRefusedClientProposed(st, rec, ticks, 413, null, platform);
      assert.equal(p.ok, false, `proposed rule (${platform}) must reject an active client: ${p.why}`);
    }
    const mac = judgeRefusedClientMac(st, rec, ticks, 413); // the v2b macOS rule, checked on every platform's runner
    assert.equal(mac.ok, false, `macOS rule v2b must reject an active client: ${mac.why}`);
  } finally { server.close(); }
});
