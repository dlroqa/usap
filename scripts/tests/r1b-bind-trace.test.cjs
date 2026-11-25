// #170 R1b bind trace (test-only, messages only): controls for fixtures/r1b-bind-trace.cjs, the reader that
// engine-slot.test.cjs R1b appends to its unchanged assertion's message when it fails.
//  - synthetic: hand-made records for each reading (G overlap, T touch, U unrelated, X untimed, engine won, untraced)
//    and four mutations that must change the reading (shift by the resolution, flip the result, delete the bind, and
//    use the fake's old after-lookup time `t` instead of tErr: the defect this change removes);
//  - real, through the real studio with the fake engine and the same preload in its buffered R1b mode:
//      R-G  a studio-side bind held 800 ms from the engine's spawn (#208 control C)  -> G on the replacement
//      R-U  a bind from the TEST process (not the studio) between spawn and listen   -> U (unrelated to studio binds)
//      R-EW one /api/diagnostics while the engine listens                            -> engine won, no failure reading
//      R-N  a replacement with no port check polling                                 -> listening, no G/T/U
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");
const { makeRoot, startServer, stopServer, removeTestRoot, request, installFakeSdServer, fakeSdDiag, processesUnder } = require("./api-contract/harness.cjs");
const { readBindTrace } = require("./fixtures/r1b-bind-trace.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PRELOAD = path.join(__dirname, "fixtures", "e1-bind-trace-preload.cjs").replace(/\\/g, "/");
const readJsonl = (f) => { try { return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } };

// ── synthetic ───────────────────────────────────────────────────────────────
const P = 21500;
const bind = (id, start, bound, closed, extra = {}) => [
  { ev: "bind-start", id, kind: extra.kind || "studio", by: extra.by || ["checkPort", "getHealth"], t: start },
  ...(bound !== null ? [{ ev: "bound", id, kind: extra.kind || "studio", t: bound }] : [{ ev: "bind-error", id, kind: "studio", code: "EADDRINUSE", t: start + 1 }]),
  ...(closed !== null ? [{ ev: "closed", id, kind: extra.kind || "studio", t: closed }] : []),
];
const gen = (pid, start, tCall, res, tRes, extra = {}) => [
  { e: "start", pid, ppid: 1, port: extra.port || P, t: start },
  res === "listening" ? { e: "listening", pid, t: tRes, tCall, tOk: tRes } : { e: "listen-error", pid, code: res, t: tRes + (extra.lookup || 0), tCall, tErr: extra.noTErr ? undefined : tRes, holders: "" },
  ...(extra.exit !== undefined ? [{ e: "exit", pid, t: extra.exit }] : []),
];
const first = (trace, diag) => readBindTrace({ trace, diag, port: P }).rows.slice(-1)[0];

test("synthetic: each reading, and mutations that must change it", () => {
  // old engine 100 listening (exits at 1000), replacement 200 calls listen at 1100, fails at 1102
  const old = gen(100, 0, 10, "listening", 12, { exit: 1000 });
  const G = first([...bind(1, 1090, 1095, 1110)], [...old, ...gen(200, 1050, 1100, "EADDRINUSE", 1102)]);
  assert.match(G.reading, /^G /); assert.equal(G.prevExit, -100);
  // mutation: the bind closed exactly at tCall (touch, 1 ms resolution) -> T, never G
  assert.match(first([...bind(1, 1090, 1095, 1100)], [...old, ...gen(200, 1050, 1100, "EADDRINUSE", 1102)]).reading, /^T /);
  // mutation: the bind closed 5 ms before tCall -> U, nearest named with its gap
  const Un = first([...bind(1, 1080, 1085, 1095)], [...old, ...gen(200, 1050, 1100, "EADDRINUSE", 1102)]);
  assert.match(Un.reading, /^U /); assert.equal(Un.nearest.gapMs, 5);
  // mutation: the bind deleted -> U, nearest null
  assert.equal(first([], [...old, ...gen(200, 1050, 1100, "EADDRINUSE", 1102)]).nearest, null);
  // mutation: the fake's old after-lookup time only (no tErr) -> X untimed, never G or U
  assert.match(first([...bind(1, 1090, 1095, 1110)], [...old, ...gen(200, 1050, 1100, "EADDRINUSE", 1102, { noTErr: true, lookup: 900 })]).reading, /^X /);
  // the defect this removes: the fake's own `t` comes after its holder lookup (here +900 ms). A 2 ms probe held across
  // the listen call reads G from tErr; the same probe compared with `t` would be ~900 ms away (a near miss).
  const short = first([...bind(1, 1098, 1099, 1101)], [...old, ...gen(200, 1050, 1100, "EADDRINUSE", 1102, { lookup: 900 })]);
  assert.match(short.reading, /^G /); assert.equal(short.lookupMs, 900);
  // and a probe 50 ms after the error is not G even though it falls before the after-lookup `t`
  assert.match(first([...bind(1, 1150, 1151, 1152)], [...old, ...gen(200, 1050, 1100, "EADDRINUSE", 1102, { lookup: 900 })]).reading, /^U /);
  // mutation: flip the engine result -> listening; the studio bind that failed inside W counts as engine won
  const EW = first([...bind(1, 1101, null, null)], [...old, ...gen(200, 1050, 1100, "listening", 1102)]);
  assert.equal(EW.reading, "listening"); assert.equal(EW.engineWon, 1);
  // checkPort order (serve.cjs): its own 'listening' handler closes the port before the preload's "bound" line, so
  // bound == closed and the real hold lies in [bind-start, bound]. A check started 1 ms before the listen call whose
  // "bound"/"closed" lines come 1 ms after the error must read G, not T or U (mutation: hold from "bound").
  assert.match(first([...bind(1, 1099, 1103, 1103)], [...old, ...gen(200, 1050, 1100, "EADDRINUSE", 1102)]).reading, /^G /);
  // prevExit comes from the previous generation on the same port, not the backend probe's start on another port
  assert.equal(first([], [...old, ...gen(150, 1040, 1041, "listening", 1042, { port: 18082, exit: 1045 }), ...gen(200, 1050, 1100, "EADDRINUSE", 1102)]).prevExit, -100);
  // a generation on another port is untraced
  assert.equal(first([], [...old, ...gen(200, 1050, 1100, "EADDRINUSE", 1102, { port: 28090 })]).reading, "untraced");
  // the summary names the failure readings only
  assert.equal(readBindTrace({ trace: bind(1, 1090, 1095, 1110), diag: [...old, ...gen(200, 1050, 1100, "EADDRINUSE", 1102)], port: P }).summary, "G");
});

// ── real ────────────────────────────────────────────────────────────────────
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
async function waitFor(check, ms) { const end = Date.now() + ms; for (;;) { const v = await check(); if (v) return v; if (Date.now() > end) return null; await sleep(50); } }
const imageLoad = (srv, model, steps) => request(srv.port, "POST", "/api/restart-backend", { body: { model, backend_type: "cpu", use_gpu: false, width: 64, height: 64, steps } });
const ready = (srv, ms) => waitFor(async () => ((await request(srv.port, "GET", "/api/backend-status")).json || {}).ready, ms);

let root;
test.before(() => {
  root = makeRoot(); installFakeSdServer(root);
  for (const m of ["sd1-img-q4_0.gguf", "sd1-hold-load-q4_0.gguf"]) imageModel(path.join(root, "app", "models"), m);
});
test.after(() => removeTestRoot(root));

async function withTraced(extraEnv, fn) {
  const trace = path.join(root, `r1b-ctl-${Date.now()}.jsonl`);
  const t0 = Date.now();
  const srv = await startServer(root, { USAP_ENGINE_SLOT: "on", USAP_TEST_E1_TRACE: trace, USAP_TEST_E1_BUFFERED: "1", ...extraEnv,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require "${PRELOAD}"`.trim() });
  try { await fn(srv); await sleep(250); return readBindTrace({ trace: readJsonl(trace), diag: fakeSdDiag(root), port: srv.sdPort, from: t0 }); }
  finally { stopServer(srv); await sleep(300); }
}
// R1b's replacement: load, ready, one generation, then a settings change replaces the engine
async function replace(srv) {
  assert.equal((await imageLoad(srv, "sd1-img-q4_0.gguf", 4)).status, 200);
  assert.ok(await ready(srv, 20000), "first load ready");
  await request(srv.port, "POST", "/sdapi/v1/txt2img", { body: { prompt: "x", steps: 4, width: 64, height: 64, seed: 1, batch_size: 1 } });
  await waitFor(async () => (await request(srv.port, "GET", "/api/generation-progress")).json.active === false, 5000);
  await imageLoad(srv, "sd1-img-q4_0.gguf", 6);
  await ready(srv, 6000);
}

test("real R-G: a studio-side bind held across the replacement's spawn reads G (3 of 3)", { timeout: 180000 }, async (t) => {
  for (let i = 0; i < 3; i += 1) {
    const r = await withTraced({ USAP_TEST_E1_INJECT: "800" }, replace);
    t.diagnostic(r.line.slice(0, 900));
    const last = r.rows.filter((x) => x.port !== undefined).slice(-1)[0] || {};
    if (last.result === "EADDRINUSE") assert.match(last.reading, /^G /, r.line);
    else assert.fail(`the injected bind did not collide (engine ${last.result}); control not exercised: ${r.line}`);
    assert.ok(last.binds.some((b) => /^inject#/.test(b)), r.line);
  }
});

test("real R-U: a bind by another process between the engine's spawn and its listen reads U, not G", { timeout: 90000 }, async (t) => {
  // Lifecycle (round 15): the holder's listen error rejects (it used to be swallowed, leaving the promise and the studio
  // pending); the holder, the release file and any fake engine of this file's root are cleaned up on every path, after
  // withTraced (closing the holder earlier could let the studio start another generation and change the reading).
  let holder = null, r = null;
  const release = path.join(root, "app", "models", "sd1-hold-load-q4_0.gguf.release");
  try {
    r = await withTraced({}, async (srv) => {
      const before = fakeSdDiag(root).length;
      const load = imageLoad(srv, "sd1-hold-load-q4_0.gguf", 4);
      load.catch(() => {}); // awaited below; a failure before that must not become an unhandled rejection
      assert.ok(await waitFor(async () => fakeSdDiag(root).slice(before).some((x) => x.e === "start"), 15000), "hold-load engine started");
      holder = net.createServer((c) => c.destroy()); // the studio's readiness probes connect to the engine port: an accepted, unhandled connection would keep holder.close() from ever completing (round-16 macOS Intel CI)
      await new Promise((res, rej) => { holder.once("error", rej); holder.listen(srv.sdPort, "127.0.0.1", () => { holder.off("error", rej); res(); }); });
      fs.writeFileSync(release, "");
      await waitFor(async () => fakeSdDiag(root).slice(before).some((x) => x.e === "listen-error"), 10000);
      await load;
    });
  } finally {
    if (holder && holder.listening) await new Promise((res) => holder.close(res));
    fs.rmSync(release, { force: true });
    // every process still running from this file's private root (the studio is already stopped by withTraced): no name
    // pattern, so the macOS fake (app/backend/mac/sd) is covered too (round-15 review: /sd-server|sd-cpu/ missed it)
    for (const p of processesUnder(root)) { try { process.kill(p.pid, "SIGKILL"); } catch (_) { /* gone */ } }
  }
  t.diagnostic(r.line.slice(0, 900));
  const last = r.rows.slice(-1)[0] || {};
  assert.equal(last.result, "EADDRINUSE", r.line);
  assert.match(last.reading, /^U /, r.line);
  assert.ok(last.lookupMs >= 0, "the after-lookup time is later than tErr");
});

test("real R-EW and R-N: a port check while the engine listens loses (engine won); a replacement without checks reads no failure", { timeout: 90000 }, async (t) => {
  const r = await withTraced({}, async (srv) => {
    await replace(srv);
    assert.equal((await request(srv.port, "GET", "/api/diagnostics")).status, 200);
  });
  t.diagnostic(r.line.slice(0, 900));
  assert.equal(r.summary, "no engine EADDRINUSE", r.line);
  const last = r.rows.slice(-1)[0] || {};
  assert.equal(last.reading, "listening", r.line);
  assert.ok(last.engineWon >= 1, `the diagnostics port check failed while the engine listened: ${r.line}`);
});
