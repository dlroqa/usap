// E1 (#170, test-only experiment, messages only). Windows R1b once failed because the replacement image engine could
// not listen on the preferred port (EADDRINUSE) right after the studio's port check had found it free. Code review:
// every GET /api/diagnostics makes the studio itself bind and close that same port (getHealth -> checkPort), and R1b
// polls /api/diagnostics about every 40 ms while the engine is replaced. This file does R1b's replacement (slot on,
// a settings change replaces the loaded image engine) repeatedly, in three servers:
//   C  control: no polling; a preload (fixtures/e1-bind-trace-preload.cjs) binds the port itself for 800 ms at the
//      moment the studio spawns the engine, like a probe at the worst instant. The replacement engine must then fail
//      to listen (EADDRINUSE) and the trace must show the overlap: proof that a studio-side bind in that window
//      produces the R1b form AND that the instruments see a real collision.
//   A  polling GET /api/diagnostics every 40 ms (R1b's cadence; binds the port);
//   B  polling GET /api/backend-status every 40 ms (no port check).
// For A and B it reports, per arm: replacements, engine listen errors, studio binds on the port during replacements
// (by calling function), overlaps of a studio bind with an engine's listen attempt, and the closest distance between
// the two. A and B are measured, never judged: the original R1b and R2 tests are unchanged and keep their assertions.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { makeRoot, startServer, stopServer, removeTestRoot, request, installFakeSdServer, fakeSdDiag } = require("./api-contract/harness.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PRELOAD = path.join(__dirname, "fixtures", "e1-bind-trace-preload.cjs").replace(/\\/g, "/");
const CYCLES = 8;
function imageModel(dir, name) { // as engine-slot.test.cjs
  const kv = (key, type, val) => {
    const k = Buffer.from(key); const head = Buffer.alloc(8 + k.length + 4); head.writeBigUInt64LE(BigInt(k.length)); k.copy(head, 8); head.writeUInt32LE(type, 8 + k.length);
    if (type === 8) { const v = Buffer.from(val); const b = Buffer.alloc(8 + v.length); b.writeBigUInt64LE(BigInt(v.length)); v.copy(b, 8); return Buffer.concat([head, b]); }
    const b = Buffer.alloc(4); b.writeUInt32LE(val); return Buffer.concat([head, b]);
  };
  const header = Buffer.alloc(24); header.write("GGUF"); header.writeUInt32LE(3, 4); header.writeBigUInt64LE(0n, 8); header.writeBigUInt64LE(2n, 16);
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.concat([header, kv("general.architecture", 8, "sd1"), kv("general.file_type", 4, 2)]));
  fs.truncateSync(file, 130 * 1024 * 1024);
}
async function waitFor(check, ms) { const end = Date.now() + ms; for (;;) { const v = await check(); if (v) return v; if (Date.now() > end) return null; await sleep(100); } }
const imageLoad = (srv, steps) => request(srv.port, "POST", "/api/restart-backend", { body: { model: "sd1-img-q4_0.gguf", backend_type: "cpu", use_gpu: false, width: 64, height: 64, steps } });
const backendStatus = async (srv) => (await request(srv.port, "GET", "/api/backend-status")).json || {};
const readJsonl = (f) => { try { return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } };
function poller(srv, pollPath) {
  let on = Boolean(pollPath), count = 0;
  const loop = (async () => { while (on) { try { await request(srv.port, "GET", pollPath); count += 1; } catch (_) { /* busy */ } await sleep(40); } })();
  return async () => { on = false; await loop; return count; };
}

// One server, `cycles` replacements. Returns per-cycle records built from the studio trace and the fake's own records.
async function arm(root, { pollPath = null, inject = 0, cycles = CYCLES }) {
  const trace = path.join(root, `e1-trace-${pollPath ? pollPath.replace(/\W/g, "") : inject ? "inject" : "none"}.jsonl`);
  const srv = await startServer(root, { USAP_ENGINE_SLOT: "on", USAP_TEST_E1_TRACE: trace, ...(inject ? { USAP_TEST_E1_INJECT: String(inject) } : {}),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require "${PRELOAD}"`.trim() });
  const out = [];
  try {
    assert.equal((await imageLoad(srv, 4)).status, 200);
    assert.ok(await waitFor(async () => (await backendStatus(srv)).ready, 20000), `first image load ready (${srv.log().slice(-600)})`);
    for (let c = 0; c < cycles; c += 1) {
      // as R1b: run one generation (clears the fake's load-progress state), then change a setting to replace the engine
      await request(srv.port, "POST", "/sdapi/v1/txt2img", { body: { prompt: "x", steps: 4, width: 64, height: 64, seed: 1, batch_size: 1 } });
      await waitFor(async () => (await request(srv.port, "GET", "/api/generation-progress")).json.active === false, 5000);
      const t0 = Date.now();
      const stop = poller(srv, pollPath);
      const r = await imageLoad(srv, 5 + (c % 2));
      const ready = await waitFor(async () => (await backendStatus(srv)).ready, 15000);
      const polls = await stop();
      out.push({ c, t0, t1: Date.now(), status: r.status, ready: Boolean(ready), polls });
      if (!ready) { // recover for the next cycle the way a user would: load again
        await imageLoad(srv, 4); await waitFor(async () => (await backendStatus(srv)).ready, 15000);
      }
    }
  } finally { stopServer(srv); await sleep(300); }
  return { cycles: out, trace: readJsonl(trace), port: srv.sdPort, log: srv.log() };
}

// Joins the studio's binds on the engine port with each engine generation's listen attempt inside a cycle.
function analyse(res, root, label) {
  const diag = fakeSdDiag(root).filter((r) => r.port === res.port || r.e !== "start");
  const binds = new Map();
  for (const e of res.trace) {
    const b = binds.get(e.id) || { id: e.id, kind: e.kind, by: e.by };
    if (e.ev === "bind-start") b.start = e.t; if (e.ev === "bound") b.bound = e.t; if (e.ev === "closed") b.closed = e.t; if (e.ev === "bind-error") { b.error = e.code; b.closed = e.t; }
    if (e.id) binds.set(e.id, b);
  }
  const all = [...binds.values()].filter((b) => b.start);
  const rows = [];
  for (const cy of res.cycles) {
    const inC = (t) => t >= cy.t0 && t <= cy.t1;
    const starts = diag.filter((r) => r.e === "start" && inC(r.t));
    const listenEv = diag.filter((r) => (r.e === "listening" || r.e === "listen-error") && inC(r.t));
    const studioBinds = all.filter((b) => inC(b.start));
    const overlaps = []; let closest = null;
    for (const ev of listenEv) for (const b of studioBinds) {
      const from = b.bound || b.start, to = b.closed || cy.t1;
      // who lost: the engine (its listen-error) or the studio's bind (its own bind-error: the engine had the port first)
      if (ev.t >= from && ev.t <= to) overlaps.push({ engineEvent: ev.e, kind: b.kind, studioBind: b.error ? `error ${b.error}` : b.bound ? "bound" : "pending", by: (b.by || []).slice(0, 2).join("<") });
      const d = ev.t < from ? from - ev.t : ev.t > to ? ev.t - to : 0;
      if (closest === null || d < closest) closest = d;
    }
    rows.push({ cycle: cy.c, status: cy.status, ready: cy.ready, polls: cy.polls, engineStarts: starts.length, listenErrors: listenEv.filter((r) => r.e === "listen-error").map((r) => r.code), studioBinds: studioBinds.length,
      bindCallers: [...new Set(studioBinds.map((b) => `${b.kind}:${(b.by || []).join("<") || "?"}`))].slice(0, 4), overlaps, closestMs: closest });
  }
  const sum = (f) => rows.reduce((x, r) => x + f(r), 0);
  const line = `E1 ${label} (${process.platform}): ${rows.length} replacements, not ready ${rows.filter((r) => !r.ready).length}, engine listen errors ${sum((r) => r.listenErrors.length)} [${[...new Set(rows.flatMap((r) => r.listenErrors))].join(",") || "none"}], studio binds on the port during replacements ${sum((r) => r.studioBinds)} (${[...new Set(rows.flatMap((r) => r.bindCallers))].join(" | ") || "none"}), overlaps with an engine listen ${sum((r) => r.overlaps.length)} (${[...new Set(rows.flatMap((r) => r.overlaps.map((o) => `engine ${o.engineEvent} / studio ${o.kind} ${o.studioBind}`)))].join("; ") || "none"}), closest studio bind to an engine listen ${Math.min(...rows.map((r) => (r.closestMs === null ? Infinity : r.closestMs)))} ms, polls ${sum((r) => r.polls)}`;
  return { rows, line };
}

let root;
test.before(() => { root = makeRoot(); installFakeSdServer(root); imageModel(path.join(root, "app", "models"), "sd1-img-q4_0.gguf"); });
test.after(() => removeTestRoot(root));

test("E1 control C: a studio-side bind held across the engine's spawn makes the replacement fail to listen (EADDRINUSE), and the trace shows the overlap", { timeout: 240000 }, async (t) => {
  const res = await arm(root, { inject: 800, cycles: 3 });
  const a = analyse(res, root, "control C (inject 800 ms at engine spawn)");
  t.diagnostic(a.line);
  const collided = a.rows.filter((r) => r.listenErrors.includes("EADDRINUSE"));
  assert.ok(collided.length >= 1, `the injected bind collided with at least one replacement: ${JSON.stringify(a.rows)}`);
  for (const r of collided) assert.ok(r.overlaps.some((o) => o.kind === "inject" && o.engineEvent === "listen-error"), `the trace names the overlapping bind for cycle ${r.cycle}: ${JSON.stringify(r)}`);
  for (const r of a.rows) if (!r.listenErrors.length && r.engineStarts) assert.ok(!r.overlaps.some((o) => o.engineEvent === "listening"), `no overlap is claimed for an engine that listened: ${JSON.stringify(r)}`);
});

test("E1 arms A/B: R1b's replacement while polling /api/diagnostics (binds the port) vs /api/backend-status (does not), measured only", { timeout: 400000 }, async (t) => {
  const A = analyse(await arm(root, { pollPath: "/api/diagnostics" }), root, "arm A (GET /api/diagnostics every 40 ms)");
  const B = analyse(await arm(root, { pollPath: "/api/backend-status" }), root, "arm B (GET /api/backend-status every 40 ms)");
  t.diagnostic(A.line); t.diagnostic(B.line);
  for (const r of [...A.rows, ...B.rows].filter((x) => x.listenErrors.length || x.overlaps.length).slice(0, 6)) t.diagnostic(`E1 cycle detail: ${JSON.stringify(r)}`.slice(0, 900));
  // instrument sanity only (not an outcome): arm A's polling reaches the port check; arm B's does not
  assert.ok(A.rows.some((r) => r.bindCallers.some((c) => /getHealth|checkPort/.test(c))), `arm A recorded studio binds from the diagnostics port check: ${A.line}`);
  assert.ok(!B.rows.some((r) => r.bindCallers.some((c) => /getHealth/.test(c))), `arm B made no diagnostics port check: ${B.line}`);
});
