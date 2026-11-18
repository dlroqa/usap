// Test-port allocator (scripts/tests/fixtures/test-ports.cjs, #142): owned ports outside the ephemeral range, never
// handed to two test processes, never one that something else is listening on. Lock files are named
// <port>.<owner pid>.lock, so ownership is never rewritten or taken over from a live process.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawn, spawnSync } = require("node:child_process");

const { reservePort, releasePort, RANGE, LOCK_DIR } = require("./fixtures/test-ports.cjs");
const tmpLocks = () => fs.mkdtempSync(path.join(os.tmpdir(), "usap-contract-ports-"));
const listenOn = (port) => new Promise((resolve, reject) => {
  const s = net.createServer(); s.once("error", reject); s.listen(port, "127.0.0.1", () => resolve(s));
});
const close = (s) => new Promise((r) => s.close(r));
const lockOf = (dir, port, pid) => path.join(dir, `${port}.${pid}.lock`);
const freeNow = async () => { const s = await listenOn(0); const p = s.address().port; await close(s); return p; };
const deadPid = () => Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
const one = (port) => ({ first: port, last: port });

test("ports come from the owned range, are distinct (also for concurrent calls in one process), locked to this process and released", async () => {
  // The range is outside every OS ephemeral range and the product's own ports.
  assert.ok(RANGE.first >= 20000 && RANGE.last < 28088 && RANGE.last < 32768, `range ${RANGE.first}-${RANGE.last}`);
  const got = await Promise.all(Array.from({ length: 6 }, () => reservePort()));
  try {
    assert.equal(new Set(got).size, got.length, `distinct: ${got}`);
    for (const p of got) {
      assert.ok(p >= RANGE.first && p <= RANGE.last, `${p} in range`);
      assert.ok(fs.existsSync(lockOf(LOCK_DIR, p, process.pid)), `${p} locked to this process`);
      const s = await listenOn(p); await close(s); // the owner can bind it
    }
  } finally { for (const p of got) releasePort(p); }
  for (const p of got) assert.equal(fs.existsSync(lockOf(LOCK_DIR, p, process.pid)), false, `${p} released`);
});

test("negative control: a port something else is listening on is never handed out", async () => {
  const lockDir = tmpLocks();
  const other = await listenOn(0); // a listener that is not a test-port owner
  const busy = other.address().port;
  try {
    await assert.rejects(reservePort({ range: one(busy), lockDir }), /no free test port/);
    assert.deepEqual(fs.readdirSync(lockDir), [], "no lock left for a port it could not bind");
  } finally { await close(other); fs.rmSync(lockDir, { recursive: true, force: true }); }
});

test("a live owner's lock is never taken over, however old it is; a dead owner's lock does not block and is removed", async () => {
  const lockDir = tmpLocks(); const port = await freeNow();
  try {
    // A live owner (the parent runner, not us) that has been holding the port for an hour: a delayed or slow owner.
    const live = lockOf(lockDir, port, process.ppid);
    fs.writeFileSync(live, ""); const old = (Date.now() - 3600e3) / 1000; fs.utimesSync(live, old, old);
    await assert.rejects(reservePort({ range: one(port), lockDir }), /no free test port/);
    assert.ok(fs.existsSync(live), "the live owner's lock is untouched");
    assert.deepEqual(fs.readdirSync(lockDir), [path.basename(live)], "our own attempt left nothing behind");
    fs.unlinkSync(live);
    // A dead owner (a crashed test process): its lock does not block the port and is cleaned up.
    const dead = lockOf(lockDir, port, deadPid());
    fs.writeFileSync(dead, "");
    const got = await reservePort({ range: one(port), lockDir });
    assert.equal(got, port);
    assert.equal(fs.existsSync(dead), false, "dead owner's lock removed");
    releasePort(got);
  } finally { fs.rmSync(lockDir, { recursive: true, force: true }); }
});

test("releasing a port removes only this process's lock, never another owner's", async () => {
  const lockDir = tmpLocks(); const port = await freeNow();
  try {
    const got = await reservePort({ range: one(port), lockDir });
    const other = lockOf(lockDir, port, process.ppid);
    fs.writeFileSync(other, ""); // another (live) owner's lock for the same port
    releasePort(got);
    assert.equal(fs.existsSync(lockOf(lockDir, port, process.pid)), false, "ours removed");
    assert.ok(fs.existsSync(other), "the other owner's lock is kept");
  } finally { fs.rmSync(lockDir, { recursive: true, force: true }); }
});

test("two processes claiming the same port at the same moment: at most one keeps it", async () => {
  // Deterministic interleaving: the other process's lock appears after ours is created and before we look for
  // owners (the worst case for a check-then-act lock). We must see it and back off.
  const lockDir = tmpLocks(); const port = await freeNow();
  const other = lockOf(lockDir, port, process.ppid);
  const readdir = fs.readdirSync;
  fs.readdirSync = function (dir, ...rest) { if (dir === lockDir && !fs.existsSync(other)) fs.writeFileSync(other, ""); return readdir.call(this, dir, ...rest); };
  try {
    await assert.rejects(reservePort({ range: one(port), lockDir }), /no free test port/);
    assert.equal(fs.existsSync(lockOf(lockDir, port, process.pid)), false, "we backed off and removed our lock");
    assert.ok(fs.existsSync(other), "the other claimant keeps its lock");
  } finally { fs.readdirSync = readdir; fs.rmSync(lockDir, { recursive: true, force: true }); }
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
    const left = fs.readdirSync(lockDir);
    fs.rmSync(lockDir, { recursive: true, force: true });
    assert.deepEqual(left, [], "every child removed its locks when it exited");
  }
});
