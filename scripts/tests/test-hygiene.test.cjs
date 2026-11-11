// Test hygiene: the API test harness never leaves temp roots or servers behind, even when a test
// forgets to clean up or fails before its own clean-up runs.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const HARNESS = path.join(__dirname, "api-contract", "harness.cjs");

test("harness: temp roots a test does not remove are removed when the test process exits", () => {
  const script = `const h = require(${JSON.stringify(HARNESS)}); const r = h.makeRoot(); console.log(r);`;
  const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const root = r.stdout.trim();
  assert.match(path.basename(root), /^usap-contract-/);
  assert.equal(fs.existsSync(root), false, `left behind: ${root}`);
});

test("harness: a server a test does not stop is stopped, and its root removed, when the test process exits", () => {
  const script = `const h = require(${JSON.stringify(HARNESS)});
    (async () => { const r = h.makeRoot(); const s = await h.startServer(r); console.log(JSON.stringify({ root: r, pid: s.proc.pid })); process.exit(0); })();`;
  const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  const { root, pid } = JSON.parse(r.stdout.trim().split("\n").pop());
  let alive = true;
  for (let i = 0; i < 50 && alive; i++) {
    try { process.kill(pid, 0); } catch (_) { alive = false; }
    if (alive) spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 100)"]);
  }
  assert.equal(alive, false, "server process stopped");
  for (let i = 0; i < 30 && fs.existsSync(root); i++) spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 100)"]);
  assert.equal(fs.existsSync(root), false, `left behind: ${root}`);
});

test("every test file that makes a temp root also removes it", () => {
  const missing = [];
  for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith(".test.cjs") && n !== path.basename(__filename))) {
    const src = fs.readFileSync(path.join(__dirname, f), "utf8");
    const made = (src.match(/\bmakeRoot\(\)/g) || []).length;
    const removed = (src.match(/\brmSync\(/g) || []).length;
    if (made > removed) missing.push(`${f}: ${made} makeRoot(), ${removed} rmSync()`);
  }
  assert.deepEqual(missing, []);
});
