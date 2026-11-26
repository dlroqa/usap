// #197/#181 end-to-end control: with the real studio, the request routes that read GPU information never start
// system_profiler synchronously. On macOS the studio starts it once, asynchronously (execFile), and every route waits
// for that one result; on other platforms system_profiler is never started. Records come from a test-only preload
// (fixtures/gpu-probe-recorder-preload.cjs) that only logs the calls. Response shapes are covered by
// hardware-module.test.cjs and the API contract tests.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { makeRoot, startServer, stopServerAndWait, removeTestRoot, request } = require("./api-contract/harness.cjs");

const PRE = path.join(__dirname, "fixtures", "gpu-probe-recorder-preload.cjs").replace(/\\/g, "/");

test("request routes never run system_profiler synchronously; macOS runs it once with execFile", { timeout: 60000 }, async (t) => {
  const root = makeRoot();
  const log = path.join(root, "gpu-probe.jsonl");
  const srv = await startServer(root, { USAP_TEST_GPU_PROBE_LOG: log, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require "${PRE}"`.trim() });
  try {
    const routes = ["/api/diagnostics", "/api/hardware-specs", "/api/telemetry", "/api/resources"];
    const statuses = await Promise.all(routes.map((r) => request(srv.port, "GET", r).then((x) => x.status)));
    for (const [i, s] of statuses.entries()) assert.ok(s === 200 || (routes[i] === "/api/resources" && s === 404), `${routes[i]} answered ${s}`);
    for (const r of routes) await request(srv.port, "GET", r); // the cached answers
    let lines = [];
    try { lines = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { lines = []; }
    const counts = lines.reduce((o, x) => ({ ...o, [x.fn]: (o[x.fn] || 0) + 1 }), {});
    t.diagnostic(`#197 gpu probe (${process.platform}/${process.arch}): system_profiler started by ${JSON.stringify(counts)}`);
    const sync = (counts.execSync || 0) + (counts.spawnSync || 0) + (counts.execFileSync || 0) + (counts.exec || 0);
    assert.equal(sync, 0, "no synchronous (or shell) system_profiler in the studio");
    if (process.platform === "darwin") assert.equal(counts.execFile || 0, 1, "macOS: exactly one asynchronous probe for all routes");
    else assert.equal(lines.length, 0, "other platforms: system_profiler is never started");
    // round 20: /api/diagnostics hardware.gpuDiscovery reports how the macOS GPU information was obtained (enums only)
    const diag = (await request(srv.port, "GET", "/api/diagnostics")).json;
    const gd = diag.hardware.gpuDiscovery;
    t.diagnostic(`#197 gpu discovery (${process.platform}/${process.arch}): ${JSON.stringify(gd === undefined ? "absent" : gd)}; gpu ${JSON.stringify({ name: diag.hardware.gpu_name, vram_gb: diag.hardware.gpu_vram_gb })}`);
    if (process.platform === "darwin") {
      assert.deepEqual(Object.keys(gd).sort(), ["reason", "source", "state"]);
      assert.ok(["ready", "fallback"].includes(gd.state), `settled: ${gd.state}`);
      assert.ok(["measured", "inferred", "unavailable"].includes(gd.source));
      assert.ok([null, "timeout", "overflow", "spawn", "exit", "guard", "cancelled", "parse", "none-listed"].includes(gd.reason));
      if (gd.source === "unavailable") assert.equal(diag.hardware.gpu_vram_gb, 0, "GPU memory not known is reported as 0, never RAM");
    } else assert.equal(gd, undefined, "other platforms: no gpuDiscovery (diagnostics unchanged)");
    // the top-level shapes stay those of the recorded WebUI fixtures on every platform (the render job's live-backend
    // check; round 20's first head added a macOS-only top-level key and failed it there)
    const fixtures = path.join(__dirname, "..", "..", "tests", "e2e", "fixtures", "api");
    for (const [route, file] of [["/api/diagnostics", "diagnostics.json"], ["/api/hardware-specs", "hardware-specs.json"], ["/api/telemetry", "telemetry.json"]]) {
      const live = Object.keys((await request(srv.port, "GET", route)).json).sort();
      const fixture = Object.keys(JSON.parse(fs.readFileSync(path.join(fixtures, file), "utf8"))).sort();
      assert.deepEqual(live, fixture, `${route}: top-level keys match the fixture`);
    }
    assert.equal((await request(srv.port, "GET", "/api/hardware-specs")).json.gpuDiscovery, undefined, "/api/hardware-specs unchanged");
  } finally { await stopServerAndWait(srv); removeTestRoot(root); }
});
