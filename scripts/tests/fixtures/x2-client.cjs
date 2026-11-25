// X2 (#151, test-only experiment): a client child (so its stall can't block node:test). Opens 16 connections at once
// with the real rawRequest (fixtures/refusal-clients.cjs, with the corrected write accounting io.writes): 2 queue
// sizes x 2 FIN handlings x 4 reps. Q-small: cap 128 KiB (expected fully accepted by the kernel before the stall);
// Q-large: cap 96 MiB (a write stays pending; rawRequest respects backpressure, so at most ~1 chunk is queued in Node).
// F: ignoreFin false (as refusal-close's 20 clients) or true (as json-413's). After all have connected and 150 ms
// passed, the main thread blocks in Atomics.wait for X2_STALL_MS (0 = no stall). A 10 ms ticker records when the
// main thread ran. Prints one JSON object: per connection the bounded event order, and the stall and ticks.
"use strict";
const { rawRequest } = require("./refusal-clients.cjs");
const port = Number(process.argv[2]), stallMs = Number(process.argv[3] || 0);
const MiB = 1024 * 1024;
const cells = [];
for (const [q, cap] of [["Q-small", 128 * 1024], ["Q-large", 96 * MiB]]) for (const f of [false, true]) for (let rep = 0; rep < 4; rep += 1) cells.push({ q, f, rep, cap });
const ticks = []; const tick = setInterval(() => { if (ticks.length < 2000) ticks.push(Date.now()); }, 10);
const live = [];
const t0 = Date.now();
const runs = cells.map((c) => rawRequest(port, { url: "/x2", mode: "stream", contentLength: 100 * MiB, ignoreFin: c.f, capBytes: c.cap, maxMs: 9000 }, live));
const snapW = (st) => { const w = st.io.writes || {}; return { sub: w.subBytes, ok: w.okBytes, fail: w.failBytes, failCalls: w.failCalls }; };
let stall = null;
const connected = setInterval(() => {
  if (live.length < cells.length || live.some((st) => st.localPort === undefined)) return;
  clearInterval(connected);
  setTimeout(() => {
    const atStart = live.map(snapW);
    const stallAt = Date.now();
    if (stallMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stallMs);
    stall = { requestedMs: stallMs, at: stallAt, end: Date.now(), atStart };
  }, 150);
}, 5);
Promise.all(runs).then((sts) => {
  clearInterval(tick);
  const firstTickAfter = stall ? ticks.find((t) => t > stall.end) || null : null;
  const lastTickBefore = stall ? [...ticks].reverse().find((t) => t <= stall.at) || null : null;
  const out = sts.map((st, i) => {
    const w = st.io.writes || {};
    const ev = (x) => (x ? { code: x.code, syscall: x.syscall, t: x.t, notAccepted: x.notAcceptedBytes, queuedInNode: x.queuedInNode, failCalls: x.failCalls, seq: x.seq } : null);
    return { ...cells[i], cap: undefined, localPort: st.localPort, status: st.status, bodyComplete: st.status === 413 && /payload too large/.test(st.body || ""),
      firstDataAt: st.io.firstDataAt, dataEvents: st.io.dataEvents, endAt: st.io.endAt, errorAt: st.io.errorAt, closeAt: st.io.closeAt, error: st.error, gaveUp: Boolean(st.clientGaveUp), sent: st.sent,
      pendingAtError: st.io.pendingAtError, writes: { sub: w.subBytes, ok: w.okBytes, fail: w.failBytes, failCalls: w.failCalls, failCodes: w.failCodes, atFirstFail: ev(w.atFirstFail), atError: ev(w.atError) },
      atStallStart: stall ? stall.atStart[i] : null };
  });
  process.stdout.write(JSON.stringify({ t0, stall: stall && { requestedMs: stall.requestedMs, at: stall.at, end: stall.end }, lastTickBefore, firstTickAfter, ticks: ticks.length, conns: out }));
});
