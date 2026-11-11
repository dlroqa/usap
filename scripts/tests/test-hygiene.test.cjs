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

test("harness: an interrupted test run (SIGINT, SIGTERM) still removes its roots and stops its servers", { skip: process.platform === "win32" && "Windows has no catchable SIGINT/SIGTERM for child processes" }, async () => {
  const { spawn } = require("node:child_process");
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const script = `const h = require(${JSON.stringify(HARNESS)});
      (async () => { const r = h.makeRoot(); const s = await h.startServer(r); console.log(JSON.stringify({ root: r, pid: s.proc.pid })); setInterval(() => {}, 1000); })();`;
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const info = await new Promise((resolve, reject) => {
      child.stdout.on("data", (d) => { out += d; const line = out.split("\n").find((l) => l.startsWith("{")); if (line) resolve(JSON.parse(line)); });
      child.on("exit", () => reject(new Error(`child exited early: ${out}`)));
      setTimeout(() => reject(new Error("timeout")), 60000);
    });
    const exited = new Promise((resolve) => child.on("exit", (code, sig) => resolve({ code, sig })));
    child.kill(signal);
    const { code } = await exited;
    assert.equal(code, signal === "SIGINT" ? 130 : 143, `${signal} exit code`);
    assert.equal(fs.existsSync(info.root), false, `${signal}: root removed`);
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) { try { process.kill(info.pid, 0); await new Promise((r) => setTimeout(r, 100)); } catch (_) { alive = false; } }
    assert.equal(alive, false, `${signal}: server stopped`);
  }
});

test("harness: clean-up only touches roots this process created", () => {
  const other = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "usap-contract-"));
  try {
    const r = spawnSync(process.execPath, ["-e", `const h = require(${JSON.stringify(HARNESS)}); h.makeRoot();`], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(other), true, "a root made by another process is left alone");
  } finally { fs.rmSync(other, { recursive: true, force: true }); }
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
