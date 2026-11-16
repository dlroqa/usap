// Test infrastructure (issue #127): removeTestRoot retries only Windows' transient lock errors, a bounded number of
// times, and otherwise fails visibly; it refuses to remove a root a process still runs from. No real locks are needed:
// the file operations are injected.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { makeRoot, removeTestRoot, processesUnder } = require("./api-contract/harness.cjs");

const err = (code) => Object.assign(new Error(`${code}: simulated`), { code });
const noSleep = async () => {};
const none = () => [];

test("cleanup: a transient Windows lock (EBUSY) is retried and the removal then succeeds", async () => {
  let calls = 0;
  const rm = () => { calls += 1; if (calls < 3) throw err("EBUSY"); };
  const r = await removeTestRoot("C:/x", { deps: { rm, isWin: true, sleep: noSleep, processesUnder: none } });
  assert.deepEqual([r.attempts, calls], [3, 3]);
});

test("cleanup: a lock that persists fails visibly after the bounded attempts", async () => {
  let calls = 0;
  const rm = () => { calls += 1; throw err("EBUSY"); };
  await assert.rejects(removeTestRoot("C:/x", { attempts: 5, deps: { rm, isWin: true, sleep: noSleep, processesUnder: none } }),
    (e) => e.code === "EBUSY" && /attempt 5 of 5, Windows lock persisted/.test(e.message));
  assert.equal(calls, 5);
});

test("cleanup: other errors are never retried or swallowed (Windows: EACCES; POSIX: EBUSY too)", async () => {
  for (const [code, isWin] of [["EACCES", true], ["EIO", true], ["EBUSY", false], ["EPERM", false]]) {
    let calls = 0;
    const rm = () => { calls += 1; throw err(code); };
    await assert.rejects(removeTestRoot("/x", { deps: { rm, isWin, sleep: noSleep, processesUnder: none } }), (e) => e.code === code, `${code} on ${isWin ? "Windows" : "POSIX"}`);
    assert.equal(calls, 1, `${code}: one attempt only`);
  }
});

test("cleanup: a root that a process still runs from is not removed; the process is named", async () => {
  let removed = false;
  const listed = [{ pid: 4242, cmd: "node C:/x/scripts/server/serve.cjs" }];
  await assert.rejects(removeTestRoot("C:/x", { waitProcessesMs: 0, deps: { rm: () => { removed = true; }, isWin: true, sleep: noSleep, processesUnder: () => listed } }),
    /still in use by 1 process\(es\).*4242 node C:\/x\/scripts\/server\/serve\.cjs/);
  assert.equal(removed, false);
});

test("cleanup: a process that exits in time is waited for, then the root is removed", async () => {
  let polls = 0;
  const r = await removeTestRoot("C:/x", { deps: { rm: () => {}, isWin: true, sleep: noSleep, processesUnder: () => (++polls < 3 ? [{ pid: 1, cmd: "C:/x/a" }] : []) } });
  assert.equal(r.attempts, 1);
  assert.equal(polls, 3);
});

test("cleanup: processesUnder finds a real process running from the root (and not after it exits)", async () => {
  const root = makeRoot();
  const script = path.join(root, "idle.cjs");
  fs.writeFileSync(script, "setTimeout(() => {}, 60000);");
  const child = spawn(process.execPath, [script], { stdio: "ignore", windowsHide: true });
  try {
    let seen = [];
    for (let i = 0; i < 40 && !seen.some((p) => p.pid === child.pid); i += 1) { seen = processesUnder(root); await new Promise((r) => setTimeout(r, 100)); }
    assert.ok(seen.some((p) => p.pid === child.pid), `the child ${child.pid} is listed`);
  } finally {
    child.kill();
    await new Promise((r) => (child.exitCode !== null || child.signalCode !== null ? r() : child.once("exit", r)));
  }
  await removeTestRoot(root);
  assert.equal(fs.existsSync(root), false);
});
