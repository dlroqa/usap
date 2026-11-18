// Test-port allocator (scripts/tests/fixtures/test-ports.cjs, #142): owned ports outside the ephemeral range, never
// handed to two test processes, never one that something else is listening on.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawn, spawnSync } = require("node:child_process");

const ports = require("./fixtures/test-ports.cjs");
const { reservePort, releasePort, RANGE, LOCK_DIR } = ports;
const tmpLocks = () => fs.mkdtempSync(path.join(os.tmpdir(), "usap-contract-ports-"));
const listenOn = (port) => new Promise((resolve, reject) => {
  const s = net.createServer(); s.once("error", reject); s.listen(port, "127.0.0.1", () => resolve(s));
});
const close = (s) => new Promise((r) => s.close(r));

test("ports come from the owned range, are distinct, are locked to this process and released", async () => {
  // The range is outside every OS ephemeral range and the product's own ports.
  assert.ok(RANGE.first >= 20000 && RANGE.last < 28088 && RANGE.last < 32768, `range ${RANGE.first}-${RANGE.last}`);
  const got = await Promise.all(Array.from({ length: 6 }, () => reservePort()));
  try {
    assert.equal(new Set(got).size, got.length, `distinct: ${got}`);
    for (const p of got) {
      assert.ok(p >= RANGE.first && p <= RANGE.last, `${p} in range`);
      assert.equal(fs.readFileSync(path.join(LOCK_DIR, `${p}.lock`), "utf8"), String(process.pid), `${p} locked to this process`);
      const s = await listenOn(p); await close(s); // the owner can bind it
    }
  } finally { for (const p of got) releasePort(p); }
  for (const p of got) assert.equal(fs.existsSync(path.join(LOCK_DIR, `${p}.lock`)), false, `${p} released`);
});

test("negative control: a port something else is listening on is never handed out", async () => {
  const lockDir = tmpLocks();
  const other = await listenOn(0); // a listener that is not a test-port owner
  const busy = other.address().port;
  try {
    await assert.rejects(reservePort({ range: { first: busy, last: busy }, lockDir }), /no free test port/);
    assert.equal(fs.existsSync(path.join(lockDir, `${busy}.lock`)), false, "no lock left for a port it could not bind");
  } finally { await close(other); fs.rmSync(lockDir, { recursive: true, force: true }); }
});

test("a port locked by another live process is skipped; a lock left by a process that has exited is reclaimed", async () => {
  const lockDir = tmpLocks();
  const probe = await listenOn(0); const port = probe.address().port; await close(probe); // a port free right now
  try {
    fs.writeFileSync(path.join(lockDir, `${port}.lock`), String(process.ppid)); // the parent runner: alive, not us
    await assert.rejects(reservePort({ range: { first: port, last: port }, lockDir }), /no free test port/);
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    fs.writeFileSync(path.join(lockDir, `${port}.lock`), dead.stdout); // its process is gone
    const got = await reservePort({ range: { first: port, last: port }, lockDir });
    assert.equal(got, port);
    assert.equal(fs.readFileSync(path.join(lockDir, `${port}.lock`), "utf8"), String(process.pid), "reclaimed");
    releasePort(got);
  } finally { fs.rmSync(lockDir, { recursive: true, force: true }); }
});

test("concurrent test processes never receive the same port (all scan the range in the same order)", async () => {
  const lockDir = tmpLocks();
  const mod = path.join(__dirname, "fixtures", "test-ports.cjs").replace(/\\/g, "/");
  // Each child reserves 10 ports and keeps them until told to exit, as a test file keeps its servers' ports.
  const code = `const t = require(${JSON.stringify(mod)});
    Promise.all(Array.from({ length: 10 }, () => t.reservePort({ lockDir: ${JSON.stringify(lockDir)} })))
      .then((p) => { process.stdout.write(JSON.stringify(p) + "\\n"); process.stdin.once("data", () => process.exit(0)); })
      .catch((e) => { process.stdout.write(JSON.stringify({ error: e.message }) + "\\n"); process.exit(1); });`;
  const kids = Array.from({ length: 8 }, () => spawn(process.execPath, ["-e", code], { stdio: ["pipe", "pipe", "inherit"] }));
  try {
    const lists = await Promise.all(kids.map((k) => new Promise((resolve) => {
      let out = ""; k.stdout.on("data", (d) => { out += d; if (out.includes("\n")) resolve(JSON.parse(out)); });
    })));
    for (const l of lists) assert.ok(Array.isArray(l), `child result ${JSON.stringify(l)}`);
    const all = lists.flat();
    assert.equal(all.length, 80);
    assert.equal(new Set(all).size, all.length, `no port handed to two processes: ${JSON.stringify(lists)}`);
  } finally {
    await Promise.all(kids.map((k) => new Promise((r) => { if (k.exitCode !== null) return r(); k.once("exit", r); k.stdin.end("x"); })));
    // every child removed its locks when it exited
    const left = fs.readdirSync(lockDir);
    fs.rmSync(lockDir, { recursive: true, force: true });
    assert.deepEqual(left, [], "locks removed on exit");
  }
});

test("releasing a port never removes another process's newer lock for it", async () => {
  const lockDir = tmpLocks();
  const probe = await listenOn(0); const port = probe.address().port; await close(probe);
  try {
    const got = await reservePort({ range: { first: port, last: port }, lockDir });
    const file = path.join(lockDir, `${got}.lock`);
    fs.writeFileSync(file, String(process.ppid)); // the port now belongs to another (live) process
    releasePort(got);
    assert.equal(fs.readFileSync(file, "utf8"), String(process.ppid), "the other process's lock is kept");
  } finally { fs.rmSync(lockDir, { recursive: true, force: true }); }
});

test("an empty lock is a lock being written (respected) until it is old enough to be a crashed process's (reclaimed)", async () => {
  const lockDir = tmpLocks();
  const probe = await listenOn(0); const port = probe.address().port; await close(probe);
  const file = path.join(lockDir, `${port}.lock`);
  try {
    fs.writeFileSync(file, "");
    await assert.rejects(reservePort({ range: { first: port, last: port }, lockDir }), /no free test port/, "fresh empty lock respected");
    const old = (Date.now() - ports.EMPTY_LOCK_STALE_MS - 5000) / 1000;
    fs.utimesSync(file, old, old);
    const got = await reservePort({ range: { first: port, last: port }, lockDir });
    assert.equal(got, port, "old empty lock reclaimed");
    assert.equal(fs.readFileSync(file, "utf8"), String(process.pid));
    releasePort(got);
  } finally { fs.rmSync(lockDir, { recursive: true, force: true }); }
});
