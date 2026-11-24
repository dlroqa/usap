// #170-adjacent diagnostics (test-only, messages only): Windows CI once failed to start a test studio with listen
// EADDRINUSE on a port fixtures/test-ports.cjs had reserved; that module assumes its range 21000-23999 lies outside
// every OS ephemeral range. This prints, on every platform, the OS dynamic (ephemeral) and excluded port ranges and
// their overlap with the test range, and checks the failure description (fixtures/port-range-diag.cjs) against real
// controls: a port held by another process is named as such, a released port shows no owner, and a real studio start
// that fails with EADDRINUSE carries the description in its unchanged error.
"use strict";
const assert = require("node:assert/strict");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { portRanges, describeRanges, describeStartFailure, parseNetshDynamic, parseNetshExcluded, overlap } = require("./fixtures/port-range-diag.cjs");
const { reservePort, releasePort, RANGE, LOCK_DIR } = require("./fixtures/test-ports.cjs");
const { makeRoot, startServer, removeTestRoot } = require("./api-contract/harness.cjs");

test("ranges: the OS dynamic and excluded port ranges and their overlap with the test port range (messages only)", async (t) => {
  const r = await portRanges();
  t.diagnostic(`test ports: ${describeRanges(r, RANGE)}`);
  assert.ok(r && Array.isArray(r.excluded));
});

test("parsers: netsh dynamic and excluded ranges; overlap", () => {
  assert.deepEqual(parseNetshDynamic("\r\nProtocol tcp Dynamic Port Range\r\n---------------------------------\r\nStart Port      : 49152\r\nNumber of Ports : 16384\r\n"), { first: 49152, last: 65535 });
  assert.deepEqual(parseNetshDynamic("Start Port      : 1025\r\nNumber of Ports : 64510\r\n"), { first: 1025, last: 65534 });
  assert.equal(parseNetshDynamic("Der Befehl ist fehlgeschlagen"), null);
  assert.deepEqual(parseNetshExcluded("\r\nProtocol tcp Port Exclusion Ranges\r\n\r\nStart Port    End Port\r\n----------    --------\r\n      5357        5357\r\n     21000       21099     *\r\n\r\n* - Administered port exclusions.\r\n"), [[5357, 5357], [21000, 21099]]);
  assert.equal(overlap({ first: 1025, last: 65534 }, RANGE), RANGE.last - RANGE.first + 1);
  assert.equal(overlap({ first: 49152, last: 65535 }, RANGE), 0);
});

// A Node process listening on `port` (another process, as on CI); resolves once it listens.
function foreignListener(port) {
  const c = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${port},"127.0.0.1",()=>console.log("up"));setInterval(()=>{},1000);`], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolve, reject) => { c.stdout.once("data", () => resolve(c)); c.once("exit", (code) => reject(new Error(`listener exited ${code}`))); });
}
const stopChild = (c) => new Promise((r) => { if (c.exitCode !== null || c.signalCode !== null) return r(); c.once("exit", r); c.kill(); });

test("description: a reserved port held by another process names that process and this process's lock; released: no owner", async () => {
  const port = await reservePort();
  const reservedAt = Date.now();
  const c = await foreignListener(port);
  try {
    const line = await describeStartFailure({ port, role: "reserved for the studio", reservedAt, failedAt: Date.now(), lockDir: LOCK_DIR, testRange: RANGE });
    assert.match(line, new RegExp(`^port ${port} \\(reserved for the studio\\) reserved \\d+ ms before the failure; locks this test process;`));
    assert.match(line, /owners now: (LISTEN|LISTENING) other program node(\.exe)?/);
    assert.match(line, /in dynamic range (true|false|unknown)/);
  } finally { await stopChild(c); }
  const after = await describeStartFailure({ port, role: "reserved for the studio", reservedAt, failedAt: Date.now(), lockDir: LOCK_DIR, testRange: RANGE });
  assert.match(after, /owners now: none \(no socket on this local port\)|owners now: TIME_WAIT/);
  releasePort(port);
});

test("harness: a studio start that fails with EADDRINUSE keeps its error and carries the port description", async () => {
  const port = await reservePort();
  const c = await foreignListener(port);
  const root = makeRoot();
  try {
    await assert.rejects(startServer(root, { PORT: String(port), FRONTEND_PORT: String(port) }), (err) => {
      assert.match(err.message, /^server exited early \(1\):/);
      assert.match(err.message, /EADDRINUSE/);
      assert.match(err.message, new RegExp(`\\[#170 test-port diagnostics\\] port ${port} \\(not one of the reserved ports\\)`));
      assert.match(err.message, /owners now: (LISTEN|LISTENING) other program node(\.exe)?/);
      return true;
    });
  } finally { await stopChild(c); releasePort(port); removeTestRoot(root); }
});
