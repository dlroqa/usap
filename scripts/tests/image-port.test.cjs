// #170: image-engine port choice with engineSlot on (services/image-port.cjs). Deterministic: a fake clock, a fake slot
// and a fake port table, so the orders below are exact (no real sockets, no timing). The end-to-end checks are in
// engine-slot.test.cjs ("#170 ..." tests) and the native engine-lifecycle validator.
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { selectImagePort, FALLBACK_FIRST, FALLBACK_LAST, RELEASE_WAIT_MS } = require("../server/services/image-port.cjs");

const P = 21032; // preferred port in these tests
const quiet = { log() {}, warn() {} };

// A world with a clock, an engine that exits at `exitAt`, and per-port "busy until" times. Every call is logged in order.
function world({ exitAt = 0, exitConfirmed = true } = {}) {
  const w = { t: 0, events: [], busy: new Map(), lateBind: null, cancelled: false };
  w.now = () => w.t;
  w.sleep = async (ms) => { w.t += ms; };
  w.portBusy = (port) => (w.busy.has(port) && w.t < w.busy.get(port));
  w.checkPort = async (port) => {
    w.events.push(["check", port, w.t]);
    return { port, available: !w.portBusy(port) };
  };
  w.slot = {
    waitForExits: async (kind, ms) => {
      w.events.push(["waitForExits:start", kind, w.t]);
      // The superseded engine binds late (after it was asked to stop, before its exit): the "late bind" of #170.
      if (w.lateBind) w.busy.set(w.lateBind.port, Infinity);
      if (!exitConfirmed) { w.t += ms; w.events.push(["waitForExits:timeout", kind, w.t]); return false; }
      w.t = Math.max(w.t, exitAt);
      if (w.lateBind) w.busy.set(w.lateBind.port, w.t + w.lateBind.lingerMs); // released some time after its exit
      w.events.push(["waitForExits:done", kind, w.t]);
      return true;
    },
    unconfirmedError: (kind) => Object.assign(new Error(`An earlier ${kind} engine process has not exited yet`), { code: "ENGINE_EXIT_UNCONFIRMED", statusCode: 503 }),
  };
  w.opts = (extra = {}) => ({ slot: w.slot, wantedPort: P, previousPort: P, checkPort: w.checkPort, now: w.now, sleep: w.sleep, log: quiet,
    isCancelled: () => w.cancelled, ...extra });
  return w;
}
const firstCheckIndex = (w) => w.events.findIndex((e) => e[0] === "check");
const exitDoneIndex = (w) => w.events.findIndex((e) => e[0] === "waitForExits:done");

test("#170 order: no port is checked before every earlier image engine's exit is confirmed", async () => {
  const w = world({ exitAt: 700 });
  const r = await selectImagePort(w.opts());
  assert.equal(r.port, P);
  assert.ok(exitDoneIndex(w) >= 0 && firstCheckIndex(w) > exitDoneIndex(w), `events ${JSON.stringify(w.events)}`);
  assert.ok(w.events[firstCheckIndex(w)][2] >= 700, "first check at or after the exit");
});

test("#170 late bind: the superseded engine binds after the request; its port is not chosen while busy", async () => {
  // Port looks free at the start; the old engine binds while the new load waits for its exit, and the socket is released
  // 400 ms after the exit (the Windows hypothesis). Checking first (the old order) would choose P while it is busy.
  const w = world({ exitAt: 600 });
  w.lateBind = { port: P, lingerMs: 400 };
  const r = await selectImagePort(w.opts());
  assert.equal(r.port, P, "the preferred port, after its release");
  assert.equal(r.reason, "released");
  assert.ok(r.waitedForReleaseMs >= 400 && r.waitedForReleaseMs < 400 + 2 * 150, `waited ${r.waitedForReleaseMs} ms`);
  assert.equal(w.portBusy(P), false, "never chosen while busy");
});

test("#170 release wait is bounded: still busy after the wait → a verified backup port, not an endless wait", async () => {
  const w = world({ exitAt: 100 });
  w.lateBind = { port: P, lingerMs: 60_000 };
  const r = await selectImagePort(w.opts());
  assert.equal(r.port, FALLBACK_FIRST);
  assert.equal(r.fellBack, true);
  assert.equal(r.reason, "not-released");
  assert.ok(r.waitedForReleaseMs >= RELEASE_WAIT_MS && r.waitedForReleaseMs <= RELEASE_WAIT_MS + 150, `waited ${r.waitedForReleaseMs}`);
  const checksOfP = w.events.filter((e) => e[0] === "check" && e[1] === P).length;
  assert.ok(checksOfP <= Math.ceil(RELEASE_WAIT_MS / 150) + 2, `bounded polling (${checksOfP} checks)`);
});

test("#170 occupied backup ports are skipped; the chosen one was verified free", async () => {
  const w = world();
  w.busy.set(P, Infinity);
  for (let p = FALLBACK_FIRST; p < FALLBACK_FIRST + 3; p += 1) w.busy.set(p, Infinity);
  const r = await selectImagePort(w.opts({ previousPort: null }));
  assert.equal(r.port, FALLBACK_FIRST + 3);
  assert.deepEqual(w.events.filter((e) => e[0] === "check").map((e) => e[1]), [P, FALLBACK_FIRST, FALLBACK_FIRST + 1, FALLBACK_FIRST + 2, FALLBACK_FIRST + 3]);
});

test("#170 a port held by another program is not waited for (backup range at once, as before)", async () => {
  const w = world();
  w.busy.set(P, Infinity);
  const r = await selectImagePort(w.opts({ previousPort: 28100 })); // our previous engine used a different port
  assert.equal(r.port, FALLBACK_FIRST);
  assert.equal(r.waitedForReleaseMs, 0);
  assert.equal(r.reason, "busy");
  assert.equal(w.t, 0, "no time spent waiting");
});

test("#170 no free port at all → the existing error, after a bounded number of checks", async () => {
  const w = world();
  w.busy.set(P, Infinity);
  for (let p = FALLBACK_FIRST; p <= FALLBACK_LAST; p += 1) w.busy.set(p, Infinity);
  await assert.rejects(selectImagePort(w.opts({ previousPort: null })), { message: `No free backend port found. Tried ${P} and ${FALLBACK_FIRST}-${FALLBACK_LAST}.` });
  assert.equal(w.events.filter((e) => e[0] === "check").length, 1 + (FALLBACK_LAST - FALLBACK_FIRST + 1));
});

test("#170 an unconfirmed exit refuses the load (503) without checking any port", async () => {
  const w = world({ exitConfirmed: false });
  await assert.rejects(selectImagePort(w.opts()), { code: "ENGINE_EXIT_UNCONFIRMED", statusCode: 503 });
  assert.equal(firstCheckIndex(w), -1, "no port checked");
});

test("#170 a stop request during the release wait ends it at once (409 ENGINE_START_CANCELLED), before any spawn", async () => {
  const w = world({ exitAt: 0 });
  w.lateBind = { port: P, lingerMs: 60_000 };
  const realSleep = w.sleep;
  w.sleep = async (ms) => { await realSleep(ms); if (w.t >= 450) w.cancelled = true; };
  await assert.rejects(selectImagePort(w.opts({ sleep: w.sleep })), { code: "ENGINE_START_CANCELLED", statusCode: 409 });
  assert.ok(w.t < 450 + 2 * 150, `ended ${w.t} ms in, not after the whole wait`);
});

test("#170 a stop request before any check ends the choice without checking", async () => {
  const w = world();
  w.cancelled = true;
  await assert.rejects(selectImagePort(w.opts()), { code: "ENGINE_START_CANCELLED" });
  assert.equal(firstCheckIndex(w), -1);
});

test("#170 an explicitly requested port is verified the same way", async () => {
  const w = world({ exitAt: 50 });
  w.busy.set(28095, Infinity);
  const r = await selectImagePort(w.opts({ wantedPort: 28095, previousPort: null }));
  assert.equal(r.port, FALLBACK_FIRST, "busy requested port → backup range (verified)");
  const free = world();
  assert.equal((await selectImagePort(free.opts({ wantedPort: 28095, previousPort: null }))).port, 28095);
});

test("#170 a checkPort failure counts as busy, never as free", async () => {
  const w = world();
  let n = 0;
  const flaky = async (port) => { n += 1; if (port === P) throw new Error("boom"); return { port, available: true }; };
  const r = await selectImagePort(w.opts({ checkPort: flaky, previousPort: null }));
  assert.equal(r.port, FALLBACK_FIRST);
  assert.ok(n >= 2);
});
