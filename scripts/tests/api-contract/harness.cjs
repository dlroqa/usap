// Shared harness for the API contract tests: runs a copy of the server in an isolated temp root
// (so no request can touch the checkout's real models, chats or outputs), with every engine port
// on a free port, plus helpers to describe and compare JSON response shapes.
"use strict";
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const REPO = path.resolve(__dirname, "..", "..", "..");
const IS_WIN = process.platform === "win32";

// Ports a child process binds later come from the test-port allocator (owned, outside the ephemeral range; #142).
const { reservePort, releasePort } = require("../fixtures/test-ports.cjs");

// Where the server looks for a CPU llama-server on this OS (see LLM_BACKEND_PATHS in serve.cjs).
function fakeLlamaPath(root) {
  if (process.platform === "linux") return path.join(root, "app", "llm-backend", "linux", "cpu", "llama-server");
  if (process.platform === "darwin") return path.join(root, "app", "llm-backend", "mac", process.arch === "arm64" ? "arm64" : "x64", "llama-server");
  return path.join(root, "app", "llm-backend", "win", "cpu", "llama-server.exe");
}

// Windows: compile fake-llama-launcher.cs with the .NET Framework compiler that ships with Windows.
// Fails loudly if it is missing; the streaming tests must not be skipped (issue #14).
function compileWindowsLauncher(outExe) {
  const windir = process.env.WINDIR || process.env.SystemRoot || "C:\\Windows";
  const candidates = ["Framework64", "Framework"].map((f) => path.join(windir, "Microsoft.NET", f, "v4.0.30319", "csc.exe"));
  const csc = candidates.find((c) => fs.existsSync(c));
  if (!csc) throw new Error(`csc.exe not found (looked in ${candidates.join(", ")}); cannot build the Windows fake llama-server`);
  const r = spawnSync(csc, ["/nologo", "/target:exe", "/optimize+", `/out:${outExe}`, path.join(__dirname, "fake-llama-launcher.cs")], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`csc.exe failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
}

// Build an isolated root: scripts/ copied from the checkout, empty app/ data folders, sentinel files
// OUTSIDE every data folder (to prove traversal attempts can't read or delete them), and a fake
// llama-server where the OS allows a script executable.
// Every temp root and server made here is remembered. When the test process exits, servers that are
// still running are stopped and roots that are still there are removed, so a failed or forgetful test
// never leaves folders in the temp directory. Only paths this harness created are touched.
const liveRoots = new Set();
const liveServers = new Set();
function cleanUpLeftovers() {
  for (const srv of liveServers) { try { stopServer(srv); } catch (_) { /* already gone */ } }
  liveServers.clear();
  for (const root of liveRoots) {
    if (!path.basename(root).startsWith("usap-contract-") || path.dirname(root) !== path.resolve(os.tmpdir())) continue;
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { /* Windows may hold files briefly */ }
  }
  liveRoots.clear();
}
process.on("exit", cleanUpLeftovers);
// An interrupted run (Ctrl+C, or the test runner stopping a file) skips "exit" handlers unless the signal is
// handled. A hard kill (SIGKILL, Windows TerminateProcess) can't run any clean-up; those roots stay behind.
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.once(signal, () => { cleanUpLeftovers(); process.exit(code); });
}

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usap-contract-"));
  liveRoots.add(path.resolve(root));
  fs.cpSync(path.join(REPO, "scripts"), path.join(root, "scripts"), { recursive: true });
  for (const d of ["models", "llm-models", "outputs", "chat-history", "speech-models", "transcriptions", "tts-models", "tts-outputs"]) {
    fs.mkdirSync(path.join(root, "app", d), { recursive: true });
  }
  fs.writeFileSync(path.join(root, "app", "SENTINEL.safetensors"), "outside models/");
  fs.writeFileSync(path.join(root, "app", "SENTINEL.gguf"), "outside llm-models/");
  fs.writeFileSync(path.join(root, "app", "SENTINEL.wav"), "outside tts-outputs/");
  fs.writeFileSync(path.join(root, "app", "SENTINEL.png"), "outside outputs/");
  fs.writeFileSync(path.join(root, "app", "SENTINEL.txt"), "outside transcriptions/");
  const fake = fakeLlamaPath(root);
  fs.mkdirSync(path.dirname(fake), { recursive: true });
  if (IS_WIN) {
    fs.copyFileSync(path.join(__dirname, "fake-llama-server.cjs"), path.join(path.dirname(fake), "fake-llama-server.cjs"));
    compileWindowsLauncher(fake);
  } else {
    fs.copyFileSync(path.join(__dirname, "fake-llama-server.cjs"), fake);
    fs.chmodSync(fake, 0o755);
  }
  return root;
}

// readyPath: a route that answers 200 once the server is up (a sign-in-required server answers
// /api/health with 401, so its tests wait on /api/auth/status instead).
async function startServer(root, extraEnv = {}, { readyPath = "/api/health" } = {}) {
  const ports = await Promise.all([reservePort(), reservePort(), reservePort(), reservePort(), reservePort()]);
  const [port, llm, sd, speech, tts] = ports;
  const env = {
    ...process.env,
    PORT: String(port), FRONTEND_PORT: String(port), LLM_PORT: String(llm), BACKEND_PORT: String(sd),
    SD_BACKEND_PORT: String(sd), SPEECH_PORT: String(speech), TTS_PORT: String(tts),
    UAIS_HOST: "", UAIS_ALLOWED_ORIGINS: "", UAIS_ALLOWED_HOSTS: "",
    USAP_TEST_NODE: process.execPath, // used by the Windows fake llama-server launcher
    ...extraEnv,
  };
  const proc = spawn(process.execPath, [path.join(root, "scripts", "server", "serve.cjs")], {
    cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: !IS_WIN,
  });
  proc.once("exit", () => { for (const p of ports) releasePort(p); }); // its engines are stopped with it
  let log = "";
  proc.stdout.on("data", (d) => { log += d; });
  proc.stderr.on("data", (d) => { log += d; });
  const deadline = Date.now() + 30000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`server exited early (${proc.exitCode}):\n${log}`);
    try { const r = await request(port, "GET", readyPath); if (r.status === 200) break; } catch (_) { /* not up yet */ }
    if (Date.now() > deadline) {
      stopServer({ proc }); // don't leave a half-started server holding the test process open
      throw new Error(`server did not start (no 200 from ${readyPath}):\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const srv = { port, llmPort: llm, sdPort: sd, proc, root, log: () => log };
  liveServers.add(srv);
  proc.on("exit", () => liveServers.delete(srv));
  return srv;
}

// Stop the server and anything it spawned (engines), so no test leaves processes behind.
function stopServer(srv) {
  if (!srv || !srv.proc || srv.proc.exitCode !== null) return;
  if (IS_WIN) spawnSync("taskkill", ["/PID", String(srv.proc.pid), "/T", "/F"], { stdio: "ignore" });
  else { try { process.kill(-srv.proc.pid, "SIGKILL"); } catch (_) { srv.proc.kill("SIGKILL"); } }
}

// Stop a test server and wait until its process has exited (issue #127). On Windows `stopServer` returns when taskkill
// returns; the OS releases the killed processes' handles and working directories a little later. Bounded: a server
// that doesn't exit is an error, never a silent pass.
async function stopServerAndWait(srv, timeoutMs = 10000) {
  if (!srv || !srv.proc) return;
  stopServer(srv);
  if (srv.proc.exitCode !== null || srv.proc.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`test server ${srv.proc.pid} did not exit within ${timeoutMs} ms of being stopped`)), timeoutMs);
    srv.proc.once("exit", () => { clearTimeout(t); resolve(); });
  });
}

// Processes still running from inside `dir` (their command line names a path under it), excluding this process.
function processesUnder(dir) {
  const needle = path.resolve(dir).toLowerCase();
  let rows = [];
  if (IS_WIN) {
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"], { encoding: "utf8", windowsHide: true, timeout: 30000 });
    rows = String(r.stdout || "").split(/\r?\n/);
  } else {
    const r = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
    rows = String(r.stdout || "").split("\n").map((l) => l.trim().replace(/^(\d+)\s+/, "$1\t"));
  }
  return rows.map((l) => l.split("\t")).filter(([pid, cmd]) => pid && cmd && Number(pid) !== process.pid && cmd.toLowerCase().includes(needle))
    .map(([pid, cmd]) => ({ pid: Number(pid), cmd: cmd.slice(0, 200) }));
}

// Codes Windows returns while a just-terminated process still holds a file or directory open.
const TRANSIENT_RM_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

/**
 * Remove a test root (issue #127). First waits (bounded) until no process runs from inside it; a process that stays
 * is reported by PID and command line and fails the caller. Then removes it, retrying only Windows' transient lock
 * codes, a bounded number of times; anything else, or a lock that persists, is thrown with the attempts made.
 * `deps` exists for the unit test only.
 */
async function removeTestRoot(dir, { attempts = 20, delayMs = 100, waitProcessesMs = 10000, deps = {} } = {}) {
  const rm = deps.rm || ((d) => fs.rmSync(d, { recursive: true, force: true }));
  const listUnder = deps.processesUnder || processesUnder;
  const isWin = deps.isWin === undefined ? IS_WIN : deps.isWin;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const until = Date.now() + waitProcessesMs;
  let left = listUnder(dir);
  while (left.length && Date.now() < until) { await sleep(250); left = listUnder(dir); }
  if (left.length) {
    throw new Error(`test root still in use by ${left.length} process(es) after ${waitProcessesMs} ms: ${left.map((p) => `${p.pid} ${p.cmd}`).join(" | ")}`);
  }
  for (let i = 1; ; i += 1) {
    try { rm(dir); return { attempts: i }; } catch (err) {
      const transient = isWin && TRANSIENT_RM_CODES.has(err && err.code);
      if (!transient || i >= attempts) {
        err.message = `${err.message} (removing the test root, attempt ${i} of ${transient ? attempts : 1}${transient ? ", Windows lock persisted" : ""})`;
        throw err;
      }
      await sleep(delayMs);
    }
  }
}

function request(port, method, urlPath, { body, headers = {}, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    const h = { ...headers };
    if (data !== null && !Object.keys(h).some((k) => k.toLowerCase() === "content-type")) h["Content-Type"] = "application/json";
    if (data !== null) h["Content-Length"] = Buffer.byteLength(data);
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers: h, timeout: 30000 }, (res) => {
      const chunks = [];
      // A connection cut after the headers is reported on the response, not the request.
      res.on("aborted", () => reject(Object.assign(new Error(`response aborted: ${method} ${urlPath}`), { partial: Buffer.concat(chunks).toString("utf8") })));
      res.on("error", (err) => reject(Object.assign(err, { partial: Buffer.concat(chunks).toString("utf8") })));
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        if (!raw && /json/.test(res.headers["content-type"] || "")) { try { json = JSON.parse(text); } catch (_) { /* leave undefined */ } }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`timeout ${method} ${urlPath}`)));
    req.on("error", reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

// ── Shapes ──────────────────────────────────────────────────────────────────
// A shape records types, not values: "string" | "number" | "boolean" | "any" (null was seen, so the
// value may legitimately be null or a value) | ["<element shape>"] | [] | { key: shape }.
// depth = number of object levels described; depth 1 pins the top-level keys and their types and
// leaves nested objects as "object" (used for payloads whose nested content depends on OS/hardware).
function shapeOf(value, depth = Infinity, level = 0) {
  if (value === null || value === undefined) return "any";
  if (Array.isArray(value)) return value.length && level < depth ? [shapeOf(value[0], depth, level + 1)] : [];
  if (typeof value === "object") {
    if (level >= depth) return "object";
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = shapeOf(value[k], depth, level + 1);
    return out;
  }
  return typeof value;
}

// Compare an actual value with an expected shape. Extra keys are allowed (additive changes are
// compatible); a missing key or a changed type is a contract break. Returns a list of problems.
function checkShape(value, shape, where = "$", optional = []) {
  const problems = [];
  if (shape === "any") return problems;
  if (value === null || value === undefined) {
    if (value === null && optional.includes(where)) return problems; // declared nullable
    problems.push(`${where}: expected ${typeof shape === "string" ? shape : Array.isArray(shape) ? "array" : "object"}, got ${value}`);
    return problems;
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) return [`${where}: expected array, got ${typeof value}`];
    if (shape.length && value.length) problems.push(...checkShape(value[0], shape[0], `${where}[0]`, optional));
    return problems;
  }
  if (shape === "object") return typeof value === "object" && !Array.isArray(value) ? problems : [`${where}: expected object`];
  if (typeof shape === "object") {
    if (typeof value !== "object" || Array.isArray(value)) return [`${where}: expected object, got ${Array.isArray(value) ? "array" : typeof value}`];
    for (const [k, s] of Object.entries(shape)) {
      const p = `${where}.${k}`;
      if (!(k in value)) { if (!optional.includes(p)) problems.push(`${p}: missing`); continue; }
      problems.push(...checkShape(value[k], s, p, optional));
    }
    return problems;
  }
  if (typeof value !== shape) problems.push(`${where}: expected ${shape}, got ${typeof value}`);
  return problems;
}

// Step 9.8g: a fake stable-diffusion.cpp sd-server at the path the studio uses for the CPU image engine on
// this OS (fake-sd-server.cjs; on Windows through the same compiled launcher, as sd-cpu.exe + sd-cpu.cjs).
function fakeSdPath(root) {
  if (process.platform === "linux") return path.join(root, "app", "backend", "linux", "cpu", "sd-server-cpu");
  if (process.platform === "darwin") return path.join(root, "app", "backend", "mac", "sd");
  return path.join(root, "app", "backend", "win", "cpu", "sd-cpu.exe");
}
function installFakeSdServer(root) {
  const fake = fakeSdPath(root);
  fs.mkdirSync(path.dirname(fake), { recursive: true });
  if (IS_WIN) {
    fs.copyFileSync(path.join(__dirname, "fake-sd-server.cjs"), path.join(path.dirname(fake), "sd-cpu.cjs"));
    compileWindowsLauncher(fake);
  } else {
    fs.copyFileSync(path.join(__dirname, "fake-sd-server.cjs"), fake);
    fs.chmodSync(fake, 0o755);
  }
  return fake;
}

// #142: the fake sd-server's own record of each start, listen result and exit (fake-sd-server.cjs), for failure messages.
function fakeSdDiag(root) {
  try {
    return fs.readFileSync(path.join(path.dirname(fakeSdPath(root)), "fake-sd-diag.jsonl"), "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_) { return { unparsed: l }; } });
  } catch (_) { return []; }
}

module.exports = { REPO, IS_WIN, makeRoot, startServer, stopServer, stopServerAndWait, removeTestRoot, processesUnder, request, shapeOf, checkShape, fakeLlamaPath, fakeSdPath, installFakeSdServer, fakeSdDiag };
