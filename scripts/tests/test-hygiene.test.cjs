// Test hygiene: the API test harness never leaves temp roots or servers behind, even when a test
// forgets to clean up or fails before its own clean-up runs.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const HARNESS = path.join(__dirname, "api-contract", "harness.cjs");

// ── #157: evidence when a harness child process ends before it reports its server ──────────────────────────────────
// The interrupted-run test starts a child that makes a root, starts a test server and prints {root, pid}. Once, on
// Linux CI, the child exited after ~0.5 s with nothing on stdout, and the failure message held only stdout. A failure
// now reports: the iteration, the child's exit code and signal, how far it got (phase markers it prints on stdout),
// whether the root it made is still on disk, how long it ran, and the end of its stdout and stderr. Output is bounded,
// and the temp directory, repository and home paths are replaced by placeholders before anything is printed.
const os = require("node:os");
const OUTPUT_TAIL = 2000; // characters of stdout / stderr kept for a failure message
const PATHS = [[os.tmpdir(), "<tmp>"], [path.resolve(__dirname, "..", ".."), "<repo>"], [os.homedir(), "<home>"]]
  .filter(([p]) => p && p.length > 1).sort((a, b) => b[0].length - a[0].length);
function redact(text) { let t = String(text); for (const [p, r] of PATHS) t = t.split(p).join(r).split(p.replace(/\\/g, "/")).join(r); return t; }
function tail(text) { return text.length > OUTPUT_TAIL ? `…${text.slice(-OUTPUT_TAIL)}` : text; }
const PHASE_PREFIX = "phase:";

/**
 * Spawn `node -e script` and resolve with { child, info } once it prints a JSON line (its server info). If it exits,
 * or prints nothing usable within timeoutMs, reject with the evidence above. `iteration` names the loop step.
 */
function startHarnessChild(script, iteration, { timeoutMs = 60000 } = {}) {
  const { spawn } = require("node:child_process");
  const started = Date.now();
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "", root = null;
  const phases = [];
  const evidence = (how, extra = {}) => JSON.stringify({
    iteration, how, ms: Date.now() - started, exitCode: child.exitCode, signal: child.signalCode, phases,
    serverStartReached: phases.includes("server-starting"), serverReported: false,
    rootLeftOnDisk: root === null ? null : fs.existsSync(root), ...extra,
    stdout: redact(tail(out)), stderr: redact(tail(err)),
  });
  return new Promise((resolve, reject) => {
    let done = false, timedOut = false, hardKill = null;
    // A child that never reports is stopped, not left running: SIGTERM first (a harness child then removes its root and
    // stops its server), SIGKILL if it is still there 5 s later. The rejection waits for it to close, so the evidence
    // says how it ended and nothing is left holding this test file open.
    const timer = setTimeout(() => {
      if (done) return;
      timedOut = true;
      child.kill("SIGTERM");
      hardKill = setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      out += d;
      for (const line of out.split("\n")) {
        if (line.startsWith(PHASE_PREFIX)) { const [name, ...rest] = line.slice(PHASE_PREFIX.length).split(" "); if (!phases.includes(name)) phases.push(name); if (name === "root-made") root = rest.join(" ").trim(); }
      }
      const line = out.split("\n").find((l) => l.startsWith("{"));
      if (line && !done) { done = true; clearTimeout(timer); resolve({ child, info: JSON.parse(line) }); }
    });
    child.stderr.on("data", (d) => { err = (err + d).slice(-4 * OUTPUT_TAIL); });
    // 'close' (not 'exit'): all of the child's stdout and stderr has been read by then
    child.on("close", () => {
      clearTimeout(hardKill);
      if (done) return;
      done = true; clearTimeout(timer);
      if (timedOut) reject(new Error(`timeout: ${evidence(`no server info within ${timeoutMs} ms; child stopped`)}`));
      else reject(new Error(`child exited early: ${evidence("exited before reporting its server")}`));
    });
  });
}

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
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const script = `const h = require(${JSON.stringify(HARNESS)});
      (async () => { const r = h.makeRoot(); console.log("phase:root-made " + r); console.log("phase:server-starting"); const s = await h.startServer(r); console.log(JSON.stringify({ root: r, pid: s.proc.pid })); setInterval(() => {}, 1000); })();`;
    const { child, info } = await startHarnessChild(script, signal);
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

test("#157 diagnostics: a harness child that ends before reporting its server is reported with iteration, exit code, signal, phase, root status and bounded, path-free output", async () => {
  const early = async (script, iteration, timeoutMs = 30000) => {
    try { await startHarnessChild(script, iteration, { timeoutMs }); } catch (e) { return e.message; }
    assert.fail(`${iteration}: the child was reported as started`);
  };
  // started its server start, wrote an error, exited 7, and left the root it made on disk
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usap-157-control-"));
  try {
    const msg = await early(`console.log("phase:root-made " + ${JSON.stringify(dir)}); console.log("phase:server-starting");
      process.stderr.write("simulated startup failure in " + ${JSON.stringify(dir)} + "\\n"); process.exitCode = 7;`, "control-exit-7");
    assert.match(msg, /^child exited early: /);
    const ev = JSON.parse(msg.slice("child exited early: ".length));
    assert.equal(ev.iteration, "control-exit-7"); assert.equal(ev.exitCode, 7); assert.equal(ev.signal, null);
    assert.deepEqual(ev.phases, ["root-made", "server-starting"]); assert.equal(ev.serverStartReached, true); assert.equal(ev.serverReported, false);
    assert.equal(ev.rootLeftOnDisk, true, "the root the child made is reported as still on disk");
    assert.match(ev.stderr, /simulated startup failure in <tmp>/);
    assert.ok(!msg.includes(os.tmpdir()), `no temp-directory path in the message: ${msg}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // exited before starting a server: phase says so
  const before = JSON.parse((await early(`console.log("phase:root-made <none>"); process.exit(3);`, "control-before-server")).slice("child exited early: ".length));
  assert.equal(before.exitCode, 3); assert.equal(before.serverStartReached, false); assert.equal(before.rootLeftOnDisk, false);
  // a crash (uncaught exception) shows its stack's message in stderr
  const thrown = JSON.parse((await early(`console.log("phase:server-starting"); throw new Error("simulated listen failure EADDRINUSE");`, "control-throw")).slice("child exited early: ".length));
  assert.equal(thrown.exitCode, 1); assert.match(thrown.stderr, /simulated listen failure EADDRINUSE/);
  // huge output stays bounded. The children set process.exitCode instead of calling process.exit(): on macOS a write
  // to a stderr pipe is asynchronous and process.exit() would drop what is still pending.
  const big = await early(`process.stderr.write("x".repeat(200000) + "END"); process.exitCode = 1;`, "control-big-output");
  assert.ok(big.length < 4 * OUTPUT_TAIL + 1000, `message is bounded (${big.length} characters)`); assert.match(big, /END/);
  // a child that never reports is stopped, and the rejection comes only after it has closed (no process left behind)
  const t0 = Date.now();
  const hung = await early(`console.log("phase:server-starting"); setInterval(() => {}, 1000);`, "control-never-reports", 1500);
  assert.match(hung, /^timeout: /);
  const hev = JSON.parse(hung.slice("timeout: ".length));
  assert.equal(hev.iteration, "control-never-reports"); assert.equal(hev.serverStartReached, true);
  assert.ok(hev.exitCode !== null || hev.signal !== null, `the child had ended when the timeout was reported: ${hung}`);
  assert.ok(Date.now() - t0 < 1500 + 5000 + 3000, "stopped within the SIGTERM/SIGKILL bound");
  // killed by a signal (POSIX): the signal is reported
  if (process.platform !== "win32") {
    const killed = JSON.parse((await early(`process.kill(process.pid, "SIGKILL");`, "control-sigkill")).slice("child exited early: ".length));
    assert.equal(killed.signal, "SIGKILL"); assert.equal(killed.exitCode, null);
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
    // removeTestRoot (harness, #127) removes a root too: it waits for processes, then calls rmSync with bounded retries.
    const removed = (src.match(/\brmSync\(|\bremoveTestRoot\(/g) || []).length;
    if (made > removed) missing.push(`${f}: ${made} makeRoot(), ${removed} rmSync()`);
  }
  assert.deepEqual(missing, []);
});
