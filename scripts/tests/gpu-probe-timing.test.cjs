// #181 GPU-probe measurement (opt-in USAP_TEST_GPU_PROBE_TIMING=1 in api-contract/resources-timing-preload.cjs, read by
// scripts/ci/resources-timing.cjs). These tests pin that, when on, the first /api/resources snapshot's time is split by
// scheduler input and the GPU code's synchronous child processes are listed by program name; that when off nothing of
// it is recorded; that the answer is the same either way; and (Linux control) that a slow GPU-information probe shows
// up where it ran. No production code is changed and nothing here judges the server.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { makeRoot, startServer, stopServerAndWait } = require("./api-contract/harness.cjs");
const { describeProbe, readRecords, PRELOAD } = require("../ci/resources-timing.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function get(port, p) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method: "GET", agent: false, timeout: 20000 }, (res) => {
      let t = ""; res.setEncoding("utf8"); res.on("data", (c) => { t += c; });
      res.on("end", () => { let json = null; try { json = JSON.parse(t); } catch (_) { /* not json */ } resolve({ status: res.statusCode, json }); });
    });
    req.on("timeout", () => req.destroy(new Error("client timeout")));
    req.on("error", () => resolve({ status: 0, json: null }));
    req.end();
  });
}
const shape = (v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape(v[k])])) : typeof v);
const envFor = (file, probe, extra = {}) => ({ USAP_TEST_RESOURCES_TIMING: file, USAP_TEST_GPU_PROBE_TIMING: probe, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require "${PRELOAD.replace(/\\/g, "/")}"`.trim(), ...extra });
async function twoReads(root, env, file) {
  const srv = await startServer(root, env);
  try {
    const a = await get(srv.port, "/api/resources");
    const b = await get(srv.port, "/api/resources");
    const end = Date.now() + 5000;
    let recs = [];
    while (Date.now() < end) { recs = readRecords(file) || []; if (recs.filter((r) => r.e === "resources").length >= 2) break; await sleep(50); }
    return { a, b, recs };
  } finally { await stopServerAndWait(srv); }
}

let root, dir;
test.before(() => { root = makeRoot(); dir = fs.mkdtempSync(path.join(os.tmpdir(), "usap-gpuprobe-")); });
test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ } });

test("on: the first snapshot is split by input, GPU-memory calls and GPU-code child processes are recorded; off: none of it; same answer", async () => {
  const off = await twoReads(root, envFor(path.join(dir, "off.jsonl"), ""), path.join(dir, "off.jsonl"));
  const on = await twoReads(root, envFor(path.join(dir, "on.jsonl"), "1"), path.join(dir, "on.jsonl"));
  assert.equal(on.a.status, 200); assert.equal(off.a.status, 200);
  assert.deepEqual(shape(on.a.json), shape(off.a.json), "same answer shape with the measurement on");
  assert.equal(off.recs.filter((r) => r.e === "gpu-probe" || r.e === "sync-child" || r.parts || r.probe).length, 0, "off: nothing extra recorded");

  const reqs = on.recs.filter((r) => r.e === "resources").sort((x, y) => x.receivedAt - y.receivedAt);
  assert.ok(reqs.length >= 2);
  const [first] = reqs;
  assert.ok(Array.isArray(first.parts), "parts recorded");
  assert.ok(Array.isArray(first.probe) && first.probe.some((p) => p.fn === "budget.totalVramBytes"), `GPU-memory call recorded: ${JSON.stringify(first.probe)}`);
  for (const p of first.probe) assert.ok(first.handlerAt <= p.entryAt && p.entryAt <= p.exitAt && p.exitAt <= first.snapshotDoneAt, "inside the snapshot");
  const probes = on.recs.filter((r) => r.e === "gpu-probe");
  assert.ok(probes.some((p) => p.fn === "budget.totalVramBytes"), "a gpu-probe line for the first call");
  for (const c of on.recs.filter((r) => r.e === "sync-child")) {
    assert.match(c.cmd, /^[A-Za-z0-9._-]{1,32}$|^\?$/, "program name only");
    assert.ok(Number.isFinite(c.ms) && c.endAt >= c.startAt);
  }
  const line = describeProbe(on.recs);
  assert.match(line, /^first \/api\/resources: snapshot \d+ ms; snapshot parts .*; GPU-memory first calls budget\.totalVramBytes \d+ ms inside \/api\/resources/);
  assert.match(line, /; later snapshots 1, max \d+ ms$/);
  assert.doesNotMatch(line.replace(/\/api\/resources/g, ""), /[\\/][a-z]/i, "no paths");
  assert.equal(describeProbe(off.recs), null, "off: no probe line");
});

test("control (Linux): a GPU-information probe that takes 1.5 s shows up in the first snapshot, its input and its child process", { skip: process.platform !== "linux" ? "uses a fake powershell on PATH; the real probes run on macOS and Windows CI" : false }, async () => {
  const bin = path.join(dir, "bin"); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "powershell"), "#!/bin/sh\nsleep 1.5\nexit 1\n", { mode: 0o755 });
  const file = path.join(dir, "slow.jsonl");
  const { a, recs } = await twoReads(root, envFor(file, "1", { PATH: `${bin}${path.delimiter}${process.env.PATH}` }), file);
  assert.equal(a.status, 200);
  const [first, second] = recs.filter((r) => r.e === "resources").sort((x, y) => x.receivedAt - y.receivedAt);
  assert.ok(first.snapshotDoneAt - first.handlerAt >= 1400, `first snapshot ${first.snapshotDoneAt - first.handlerAt} ms`);
  assert.ok(first.parts.find(([k]) => k === "budget.totalVramBytes")[1] >= 1400, JSON.stringify(first.parts));
  assert.ok(first.children.some((c) => c.cmd === "powershell" && c.ms >= 1400 && c.gpuInfo), JSON.stringify(first.children));
  assert.ok(first.loop.gaps.some(([, ms]) => ms >= 1000), "the event loop was blocked for it");
  assert.ok(second.snapshotDoneAt - second.handlerAt < 500, "a later snapshot is quick (the GPU information is kept after the first call)");
  assert.match(describeProbe(recs), /^first \/api\/resources: snapshot [1-9]\d{3} ms; snapshot parts budget\.totalVramBytes [1-9]\d{3}.*sync child processes powershell 1[4-9]\d\d ms code 1 \(GPU code\)/);
});

test("reader: no probe records → null; bounded", () => {
  assert.equal(describeProbe(null), null);
  assert.equal(describeProbe([{ e: "loaded" }, { e: "resources", receivedAt: 1 }]), null);
  const many = Array.from({ length: 300 }, (_, i) => ({ e: "sync-child", cmd: `c${i}`, ms: i, code: "0", gpuInfo: true }));
  const s = describeProbe([{ e: "gpu-probe", fn: "budget.totalVramBytes", ms: 3, inResources: false }, ...many]);
  assert.ok(s.length <= 2400);
  assert.match(s, /GPU-memory first calls budget\.totalVramBytes 3 ms elsewhere/);
  assert.equal((s.match(/ ms code 0/g) || []).length, 6);
});
