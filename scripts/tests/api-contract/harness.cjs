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

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

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
function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usap-contract-"));
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
  const [port, llm, sd, speech, tts] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
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
  return { port, llmPort: llm, proc, root, log: () => log };
}

// Stop the server and anything it spawned (engines), so no test leaves processes behind.
function stopServer(srv) {
  if (!srv || !srv.proc || srv.proc.exitCode !== null) return;
  if (IS_WIN) spawnSync("taskkill", ["/PID", String(srv.proc.pid), "/T", "/F"], { stdio: "ignore" });
  else { try { process.kill(-srv.proc.pid, "SIGKILL"); } catch (_) { srv.proc.kill("SIGKILL"); } }
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

module.exports = { REPO, IS_WIN, makeRoot, startServer, stopServer, request, shapeOf, checkShape, fakeLlamaPath, fakeSdPath, installFakeSdServer };
