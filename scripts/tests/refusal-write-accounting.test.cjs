// #151 write accounting (DD-201-PEND; diagnostics only, never judged): controls for io.writes in
// fixtures/refusal-clients.cjs rawRequest. #201's pendingAtError (writableLength in 'error') reads 0 even when writes
// were outstanding, because Node fails every write callback and empties its queue before it emits 'error'. io.writes
// counts from the write callbacks instead. Real 127.0.0.1 sockets, the real rawRequest:
//   (a) backpressure: a peer that never reads -> bytes not yet accepted by the kernel > 0, no error
//   (b) 413 + FIN, the client keeps sending (ignoreFin, as json-413), RST 300 ms later -> the X1 case: pendingAtError 0
//       while notAcceptedBytes > 0 at 'error'
//   (c) RST while established (resetAndDestroy) -> an error is recorded with its code and syscall
//   (d) clean small request -> every submitted byte accepted, no failed callback, atError null (absent, not 0)
//   (d') small request completed, then a reset -> error with notAcceptedBytes 0 (a valid zero)
// Kernel send-buffer occupancy is not visible from Node; "accepted by the kernel" is not "received by the peer".
"use strict";
const assert = require("node:assert/strict");
const net = require("node:net");
const test = require("node:test");
const { rawRequest } = require("./fixtures/refusal-clients.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MiB = 1024 * 1024;
async function server(onConn) {
  const socks = new Set();
  const srv = net.createServer((c) => { socks.add(c); c.on("error", () => {}); c.on("close", () => socks.delete(c)); onConn(c); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { port: srv.address().port, close: () => new Promise((r) => { for (const c of socks) c.destroy(); srv.close(r); }) };
}
const sum = (w) => w.okBytes + w.failBytes + (w.subBytes - w.okBytes - w.failBytes);

test("(a) backpressure: a peer that never reads leaves submitted bytes not yet accepted by the kernel, and no error", async () => {
  const srv = await server((c) => c.pause());
  const live = [];
  try {
    const p = rawRequest(srv.port, { capBytes: 64 * MiB, maxMs: 1500 }, live);
    await sleep(800);
    const w = live[0].io.writes;
    assert.ok(w.subBytes > w.okBytes, `submitted ${w.subBytes} > accepted ${w.okBytes}`);
    assert.equal(w.failCalls, 0); assert.equal(w.atError, null);
    assert.equal(sum(w), w.subBytes);
    const st = await p;
    assert.equal(st.clientGaveUp, true);
  } finally { await srv.close(); }
});

test("(b) peer destroy with unread data: at 'error' the old pendingAtError reads 0 while bytes not accepted by the kernel are > 0", async (t) => {
  let seenX1 = 0; const lines = [];
  for (let i = 0; i < 5; i += 1) {
    const srv = await server((c) => { c.write("HTTP/1.1 413 Payload Too Large\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); c.end(); setTimeout(() => c.destroy(), 300); });
    const live = [];
    try {
      // ignoreFin: keep sending after the server's FIN, as json-413's clients do; without it the client ends on the FIN
      // and (macOS, Windows) never writes into the RST (first CI attempt a494c9a: no error on those 3 runners)
      const st = await rawRequest(srv.port, { capBytes: 64 * MiB, maxMs: 4000, ignoreFin: true }, live);
      const w = st.io.writes;
      lines.push(`${st.error}/${w.atError && w.atError.syscall} failCalls ${w.failCalls} notAccepted@error ${w.atError && w.atError.notAcceptedBytes} pendingAtError ${st.io.pendingAtError}`);
      assert.ok(st.error, `an error is recorded (${lines.at(-1)})`);
      assert.ok(w.atError, "atError snapshot taken");
      assert.equal(sum(w), w.subBytes);
      if (w.failCalls > 0) {
        assert.ok(w.atFirstFail && w.atFirstFail.seq < w.atError.seq, "the first failed callback came before 'error' (why writableLength is 0 there)");
        assert.ok(w.atError.notAcceptedBytes > 0, lines.at(-1));
        assert.equal(w.atError.notAcceptedBytes, w.subBytes - w.okBytes);
        if (st.io.pendingAtError === 0) seenX1 += 1;
      }
    } finally { await srv.close(); }
  }
  t.diagnostic(`#151 write accounting (b) ${process.platform}: ${lines.join(" | ")}`);
  // Linux (X1) and macOS (N2 controls) fail write callbacks before 'error' in this shape; Windows is not established, so
  // there the case is recorded above, not required (the invariants above still hold for every run)
  if (process.platform !== "win32") assert.ok(seenX1 >= 1, `the X1 case (failed callbacks, pendingAtError 0, notAccepted > 0) occurred at least once in 5: ${lines.join(" | ")}`);
});

test("(c) RST while established: the error's code and syscall are recorded", async () => {
  const srv = await server((c) => { c.once("data", () => setTimeout(() => c.resetAndDestroy(), 50)); });
  const live = [];
  try {
    const st = await rawRequest(srv.port, { capBytes: 64 * MiB, maxMs: 4000 }, live);
    const w = st.io.writes;
    assert.ok(st.error, "an error is recorded");
    assert.ok(w.atError && w.atError.code === st.error, `atError code ${w.atError && w.atError.code} = ${st.error}`);
    if (process.platform !== "win32") assert.ok(["ECONNRESET", "EPIPE"].includes(st.error), st.error);
    assert.ok(typeof w.atError.syscall === "string" || w.atError.syscall === null);
  } finally { await srv.close(); }
});

test("(d) clean small request: every submitted byte accepted by the kernel, no failed callback, atError absent", async () => {
  const srv = await server((c) => { let n = 0; c.on("data", (d) => { n += d.length; if (n >= 2048) { c.end("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 2\r\n\r\nok"); } }); });
  const live = [];
  try {
    const st = await rawRequest(srv.port, { mode: "small", maxMs: 4000 }, live);
    const w = st.io.writes;
    assert.equal(st.status, 200); assert.equal(st.error, null);
    assert.equal(w.okBytes, w.subBytes); assert.equal(w.failCalls, 0);
    assert.equal(w.atError, null, "absent, not a zero");
    assert.equal(st.io.pendingAtError, undefined);
  } finally { await srv.close(); }
});

test("(d') small request fully accepted, then a reset: an error with notAcceptedBytes 0 (a valid zero)", async () => {
  const srv = await server((c) => { let n = 0; c.on("data", (d) => { n += d.length; if (n >= 2048) setTimeout(() => c.resetAndDestroy(), 100); }); });
  const live = [];
  try {
    const st = await rawRequest(srv.port, { mode: "small", maxMs: 4000 }, live);
    const w = st.io.writes;
    assert.ok(st.error, "an error is recorded");
    assert.equal(w.failCalls, 0);
    assert.equal(w.atError.notAcceptedBytes, 0);
    assert.equal(w.okBytes, w.subBytes);
  } finally { await srv.close(); }
});
