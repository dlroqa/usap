// #181 diagnostics: the test-only preload api-contract/resources-timing-preload.cjs and the validators' reader
// scripts/ci/resources-timing.cjs. These tests pin that the preload records what it says, changes nothing in the
// answer, does nothing without its variable, and that the reader reports missing records as missing. No verdict here
// depends on timing except the paused-server control, which only checks that a pause it caused is visible.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { makeRoot, startServer, stopServerAndWait, IS_WIN } = require("./api-contract/harness.cjs");
const { createResourcesTiming, describeRequest, describeSlow, readRecords, PRELOAD } = require("../ci/resources-timing.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The validators' request: one connection (agent: false), a fixed client timeout.
function get(port, p, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.request({ host: "127.0.0.1", port, path: p, method: "GET", agent: false, timeout: timeoutMs }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (c) => { text += c; });
      res.on("end", () => { let json = null; try { json = JSON.parse(text); } catch (_) { /* not json */ } resolve({ status: res.statusCode, json, sentAt: t0, endedAt: Date.now() }); });
    });
    req.on("timeout", () => req.destroy(new Error("client timeout")));
    req.on("error", () => resolve({ status: 0, json: null, sentAt: t0, endedAt: Date.now() }));
    req.end();
  });
}
const preloadEnv = (file) => ({ USAP_TEST_RESOURCES_TIMING: file, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require "${PRELOAD.replace(/\\/g, "/")}"`.trim() });
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return null; await sleep(50); } };
const shape = (v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape(v[k])])) : typeof v);

let root, dir;
test.before(() => { root = makeRoot(); dir = fs.mkdtempSync(path.join(os.tmpdir(), "usap-rt-")); });
test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ } });

test("preload: each /api/resources gets accept, receipt, handler, snapshot, end, finish and close in order; the answer is unchanged", async () => {
  const file = path.join(dir, "on.jsonl");
  const plain = await startServer(root, {});
  let without;
  try { without = await get(plain.port, "/api/resources"); } finally { await stopServerAndWait(plain); }
  const srv = await startServer(root, preloadEnv(file));
  try {
    const a = await get(srv.port, "/api/resources");
    const h = await get(srv.port, "/api/health");
    assert.equal(a.status, 200); assert.equal(h.status, 200);
    assert.equal(without.status, 200);
    assert.deepEqual(shape(a.json), shape(without.json), "same answer shape with and without the preload");
    const recs = await waitFor(() => { const r = readRecords(file) || []; return r.filter((x) => x.e === "resources").length >= 1 ? r : null; });
    assert.ok(recs, "a record was written");
    assert.equal(recs.filter((x) => x.e === "loaded").length, 1);
    const [r] = recs.filter((x) => x.e === "resources");
    assert.equal(recs.filter((x) => x.e === "resources").length, 1, "only /api/resources is recorded");
    const order = [r.acceptAt, r.receivedAt, r.handlerAt, r.snapshotDoneAt, r.endAt, r.finishAt, r.closeAt];
    assert.ok(order.every(Number.isFinite), `all times recorded: ${JSON.stringify(r)}`);
    for (let i = 1; i < order.length; i++) assert.ok(order[i] >= order[i - 1], `in order: ${JSON.stringify(r)}`);
    assert.ok(r.acceptAt >= a.sentAt - 5 && r.closeAt <= Date.now());
    assert.equal(r.status, 200);
    assert.ok(r.bytesWritten > 0);
    assert.ok(r.loop && Array.isArray(r.loop.gaps) && Number.isFinite(r.loop.delayMaxMs));
    assert.match(describeRequest(recs, a.sentAt, a.endedAt), /^times in ms from the client's send; accepted \d+, received \d+, handler \d+, snapshot done \d+, end \d+, finish \d+, closed \d+; status 200;/);
  } finally { await stopServerAndWait(srv); }
});

test("preload: without its variable it does nothing", async () => {
  const file = path.join(dir, "off.jsonl");
  const srv = await startServer(root, { NODE_OPTIONS: preloadEnv(file).NODE_OPTIONS });
  try {
    assert.equal((await get(srv.port, "/api/resources")).status, 200);
    await sleep(300);
    assert.equal(fs.existsSync(file), false);
  } finally { await stopServerAndWait(srv); }
});

test("control: a server paused while a request waits shows the late receipt and the loop gap", { skip: IS_WIN ? "no SIGSTOP on Windows" : false }, async () => {
  const file = path.join(dir, "paused.jsonl");
  const srv = await startServer(root, preloadEnv(file));
  try {
    assert.equal((await get(srv.port, "/api/resources")).status, 200);
    process.kill(srv.proc.pid, "SIGSTOP");
    const p = get(srv.port, "/api/resources");
    await sleep(1200);
    process.kill(srv.proc.pid, "SIGCONT");
    const a = await p;
    assert.equal(a.status, 200);
    const recs = await waitFor(() => { const r = readRecords(file) || []; return r.filter((x) => x.e === "resources").length >= 2 ? r : null; });
    const r = recs.filter((x) => x.e === "resources")[1];
    assert.ok(r.receivedAt - a.sentAt >= 1000, `received late: ${r.receivedAt - a.sentAt} ms`);
    assert.ok(r.loop.gaps.some(([, ms]) => ms >= 1000), `a gap >= 1000 ms: ${JSON.stringify(r.loop.gaps)}`);
    assert.ok(r.loop.delayMaxMs >= 1000);
    assert.match(describeSlow(recs), /2 recorded, 1 slow, unanswered or with a loop gap >= 1000 ms/);
  } finally { await stopServerAndWait(srv); }
});

test("reader: missing, unloaded and unreadable records are said, never filled in; only slow or failed requests print", () => {
  const T = 100000;
  assert.equal(describeRequest(null, T, T + 10), "timing file unreadable");
  assert.equal(describeRequest([], T, T + 10), "instrumentation not loaded");
  assert.match(describeRequest([{ e: "loaded", at: T - 5000 }], T, T + 10002), /no \/api\/resources record in the request's window yet/);
  const conn = describeRequest([{ e: "loaded", at: 1 }, { e: "conn", acceptAt: T + 3, closeAt: T + 10002 }], T, T + 10002);
  assert.match(conn, /connections closed without a request in the window 1 \(accepted 3\)/);
  assert.equal(describeSlow([{ e: "loaded" }, { e: "resources", acceptAt: T, receivedAt: T, finishAt: T + 5 }]), null);
  assert.match(describeSlow([{ e: "loaded" }, { e: "resources", acceptAt: T, receivedAt: T + 9000, closeAt: T + 10001 }]),
    /^1 recorded, 1 slow, unanswered or with a loop gap >= 1000 ms \(connections without a request 0\): \[accepted 0, received 9000, handler none, snapshot done none, end none, finish none, closed 10001; status none;/);

  const d = fs.mkdtempSync(path.join(os.tmpdir(), "usap-rt-note-"));
  try {
    const lines = [];
    const rt = createResourcesTiming(d, "v", (s) => lines.push(s));
    const env = rt.env("on", { NODE_OPTIONS: "--max-old-space-size=64", A: "1" });
    assert.equal(env.A, "1");
    assert.match(env.NODE_OPTIONS, /^--max-old-space-size=64 --require ".*resources-timing-preload\.cjs"$/, "the caller's NODE_OPTIONS are kept");
    rt.note(T, 200, T + 40);
    assert.equal(lines.length, 0, "a quick 200 prints nothing");
    rt.note(T, 0, T + 10006);
    assert.match(lines[0], /^#181 \/api\/resources timing \(status 0 after 10006 ms\): timing file unreadable$/);
    fs.writeFileSync(env.USAP_TEST_RESOURCES_TIMING, `${JSON.stringify({ e: "loaded", at: 1 })}\nnot json\n`);
    rt.note(T, 200, T + 2500);
    assert.match(lines[1], /HTTP 200 after 2500 ms\): times in ms from the client's send; no \/api\/resources record/);
    rt.stopped("on/x");
    assert.equal(lines.length, 2, "nothing slow recorded: no stop line");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("reader: bounded, numbers and fixed words only", () => {
  const T = 5;
  const many = Array.from({ length: 50 }, (_, i) => ({ e: "resources", acceptAt: T + i, receivedAt: T + i + 9000, closeAt: T + i + 10001, loop: { gaps: Array.from({ length: 30 }, (_, j) => [T + j, 900]), delayP99Ms: 10, delayMaxMs: 9000 }, url: "/home/u/secret" }));
  const s = describeSlow([{ e: "loaded" }, ...many]);
  assert.ok(s.length <= 2400);
  assert.doesNotMatch(s, /secret|\/home/);
  assert.equal((s.match(/\[accepted/g) || []).length, 6);
});
