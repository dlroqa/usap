#!/usr/bin/env node
// MEASUREMENT ONLY (bench branch, never merged). Issue: macOS Intel "after that abort, computation stopped".
//
// What happens in llama-server after a client closes a streaming request during prompt evaluation, measured from the
// engine itself: per-request timings, a 250 ms /metrics timeline, the engine's own CPU time and its log.
//
//   Phase A — the engine exactly as the studio starts it (same command line, -lv 1). The failing check is repeated
//             three times on one engine (the first is the cold one, as in the check), plus unaborted runs of the same
//             prompt size whose `timings.prompt_ms` says how long prompt evaluation takes on this runner.
//   Phase B — the same command line started directly with the default log level (prompt progress lines), prompt sizes
//             750 / 1500 / 2942: unaborted, aborted after the status line, aborted before it, and a non-streaming abort.
//
// Observes only. It changes no setting, no product file and no check. Results: <logs>/chat-abort-*.jsonl and a table.
"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const APP = path.join(ROOT, "app");
const SERVE = path.join(ROOT, "scripts", "server", "serve.cjs");
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const MODEL = arg("model", "qwen2.5-0.5b-instruct-q4_k_m.gguf");
const LOGDIR = arg("logs", path.join(ROOT, "ci-logs"));
const PORT = Number(arg("port", "14980"));
const DIRECT_PORT = Number(arg("direct-port", "14981"));
const LIMIT_MS = Number(arg("limit-ms", "240000")); // diagnostic observation window (the check's own is 60 s)
const WIN = process.platform === "win32";
const LINUX = process.platform === "linux";
const NODE = [path.join(APP, "tools", "node-win", "node.exe"), path.join(APP, "tools", "node-linux", "bin", "node"), path.join(APP, "tools", "node-mac", "bin", "node")]
  .find((p) => fs.existsSync(p)) || process.execPath;
const PLATFORM = `${process.platform}-${process.arch}`;

fs.mkdirSync(LOGDIR, { recursive: true });
const RUNS = path.join(LOGDIR, "chat-abort-runs.jsonl");
const TIMELINE = path.join(LOGDIR, "chat-abort-timeline.jsonl");
const ENV_FILE = path.join(LOGDIR, "chat-abort-environment.json");
for (const f of [RUNS, TIMELINE]) fs.writeFileSync(f, "");
const summary = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────────────────
function call(port, method, p, body, { timeoutMs = 600000, agent = false } = {}) {
  let req;
  const t0 = Date.now();
  const marks = { sentAt: null, headersAt: null, firstDataAt: null, firstChunk: null, firstContentAt: null };
  const promise = new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve({ ...v, ms: Date.now() - t0, marks }); } };
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    req = http.request({ host: "127.0.0.1", port, path: p, method, agent, timeout: timeoutMs,
      headers: data ? { "content-type": "application/json", "content-length": data.length } : {} }, (res) => {
      marks.headersAt = Date.now();
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        if (marks.firstDataAt === null) { marks.firstDataAt = Date.now(); marks.firstChunk = c.slice(0, 40); }
        text += c;
        if (marks.firstContentAt === null && /"content":"[^"]/.test(text)) marks.firstContentAt = Date.now();
      });
      res.on("end", () => done({ status: res.statusCode, text, ended: true }));
      res.on("close", () => done({ status: res.statusCode, text, ended: false }));
      res.on("error", () => done({ status: res.statusCode, text, ended: false }));
    });
    req.on("timeout", () => req.destroy(new Error("client timeout")));
    req.on("error", (e) => done({ status: 0, text: "", ended: false, error: e.code || e.message }));
    if (data) req.write(data);
    req.end(() => { marks.sentAt = Date.now(); });
  });
  return { promise, marks, abort: () => req && req.destroy(), t0 };
}
const parseJson = (t) => { try { return JSON.parse(t); } catch (_) { return null; } };
const getJson = async (port, p, timeoutMs = 10000) => { const r = await call(port, "GET", p, undefined, { timeoutMs }).promise; return { status: r.status, json: parseJson(r.text) }; };
async function metrics(port) {
  const r = await call(port, "GET", "/metrics", undefined, { timeoutMs: 5000 }).promise;
  if (r.status !== 200) return null;
  const m = {};
  for (const line of r.text.split("\n")) { const x = line.match(/^llamacpp:([a-z_]+)\s+([0-9.eE+-]+)/); if (x) m[x[1]] = Number(x[2]); }
  return m;
}
const quiet = (m) => m && m.requests_processing === 0 && m.requests_deferred === 0;
const counters = (m) => m && [m.n_decode_total, m.tokens_predicted_total, m.prompt_tokens_total].join("/");
async function waitUntil(fn, ms, every = 100) {
  const end = Date.now() + ms;
  for (;;) { let v; try { v = await fn(); } catch (_) { v = undefined; } if (v) return v; if (Date.now() > end) return undefined; await sleep(every); }
}

// ── Prompts (same construction as chat-timeouts-validate.cjs) ───────────────────────────────────────────
let seq = 0;
const promptOf = (words) => `[${Date.now()}-${++seq}] ` + Array.from({ length: words }, (_, i) => `item${(i * 7919) % 10007}`).join(" ") + "\nSummarise the list above in one sentence.";
async function tokens(port, text) {
  const r = await call(port, "POST", "/tokenize", { content: text }, { timeoutMs: 30000 }).promise;
  const j = parseJson(r.text);
  return r.status === 200 && j && Array.isArray(j.tokens) ? j.tokens.length : null;
}
const wordsPerToken = {};
async function promptFor(port, target) {
  if (!wordsPerToken[port]) { const n = await tokens(port, promptOf(200)); wordsPerToken[port] = 200 / n; }
  const text = promptOf(Math.max(50, Math.floor(target * wordsPerToken[port])));
  return { text, tokens: await tokens(port, text) };
}

// ── Engine CPU time (seconds) ───────────────────────────────────────────────────────────────────────────
function parsePsTime(s) { // [[dd-]hh:]mm:ss[.cc]
  s = String(s || "").trim(); if (!s) return null;
  let days = 0; if (s.includes("-")) { const [d, rest] = s.split("-"); days = Number(d); s = rest; }
  const parts = s.split(":").map(Number); let sec = 0; for (const p of parts) sec = sec * 60 + p;
  return days * 86400 + sec;
}
const CLK = LINUX ? Number(spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).stdout.trim()) || 100 : 100;
function cpuSecondsSync(pid) {
  try {
    if (LINUX) { const f = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" "); return (Number(f[11]) + Number(f[12])) / CLK; }
    if (WIN) { const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).TotalProcessorTime.TotalSeconds`], { encoding: "utf8", timeout: 15000 }); return Number(String(r.stdout).trim().replace(",", ".")); }
    return parsePsTime(spawnSync("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8" }).stdout);
  } catch (_) { return null; }
}
function cpuSeconds(pid) { // async so the 250 ms metrics timeline isn't blocked (Windows PowerShell is slow)
  if (LINUX) return Promise.resolve(cpuSecondsSync(pid));
  return new Promise((resolve) => {
    const cmd = WIN ? ["powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).TotalProcessorTime.TotalSeconds`]] : ["ps", ["-o", "time=", "-p", String(pid)]];
    const c = spawn(cmd[0], cmd[1], { windowsHide: true }); let out = "";
    c.stdout.on("data", (d) => { out += d; }); c.on("error", () => resolve(null));
    c.on("close", () => resolve(WIN ? Number(out.trim().replace(",", ".")) || null : parsePsTime(out)));
  });
}
function topProcesses() {
  try {
    if (WIN) return String(spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-Process | Sort-Object CPU -Descending | Select-Object -First 8 Name,Id,CPU | Format-Table -HideTableHeaders | Out-String"], { encoding: "utf8", timeout: 20000 }).stdout).trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const r = LINUX ? spawnSync("ps", ["-eo", "pcpu,pid,comm", "--sort=-pcpu"], { encoding: "utf8" }) : spawnSync("ps", ["-Ao", "pcpu,pid,comm", "-r"], { encoding: "utf8" });
    return String(r.stdout).split("\n").slice(1, 9).map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);
  } catch (_) { return []; }
}
function listenerPids(port) {
  if (WIN) {
    const r = spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" });
    return [...new Set((r.stdout || "").split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 5 && /LISTENING/i.test(c[3]) && c[1].endsWith(`:${port}`)).map((c) => Number(c[4])).filter((n) => n > 0))];
  }
  const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  return [...new Set((r.stdout || "").split("\n").map(Number).filter((n) => n > 0))];
}

// ── One measured request ───────────────────────────────────────────────────────────────────────────────
// mode: "unaborted" (non-streaming, max_tokens 1: timings), "abort-after-status" (the failing check), "abort-before-status",
//       "abort-nonstream" (stream false, aborted once requests_processing is 1).
// `client`: "agent-false" (a new connection, Connection: close; what chat-timeouts-validate does), "keepalive"
// (a keep-alive agent, as the studio uses for llama-server), or "studio" (POST /api/llm/chat; the studio aborts).
const KEEPALIVE = new http.Agent({ keepAlive: true, maxSockets: 4, keepAliveMsecs: 30000 });
async function measure({ phase, label, port, pid, target, mode, logOffset, client = "agent-false" }) {
  const lp = await promptFor(port, target);
  const before = await metrics(port);
  const cpu0 = await cpuSeconds(pid);
  const stream = mode !== "unaborted" && mode !== "abort-nonstream";
  const body = { messages: [{ role: "user", content: lp.text }], max_tokens: mode === "unaborted" ? 1 : 64, temperature: 0, stream };
  const h = client === "studio" ? call(PORT, "POST", "/api/llm/chat", body)
    : call(port, "POST", "/v1/chat/completions", body, { agent: client === "keepalive" ? KEEPALIVE : false });
  const t0 = h.t0;
  const row = { phase, label, mode, client, platform: PLATFORM, promptTokens: lp.tokens, enginePid: pid };
  if (mode === "unaborted") {
    const r = await h.promise;
    const j = parseJson(r.text);
    const cpu1 = await cpuSeconds(pid);
    Object.assign(row, { status: r.status, wallMs: r.ms, promptMs: j?.timings?.prompt_ms ?? null, promptPerSecond: j?.timings?.prompt_per_second ?? null,
      promptN: j?.timings?.prompt_n ?? null, cpuSeconds: cpu1 != null && cpu0 != null ? +(cpu1 - cpu0).toFixed(2) : null });
    row.cores = row.cpuSeconds != null ? +(row.cpuSeconds / (r.ms / 1000)).toFixed(2) : null;
    fs.appendFileSync(RUNS, JSON.stringify(row) + "\n");
    summary.push(row);
    return row;
  }
  // Wait for the moment to abort.
  let seenAt = null;
  if (mode === "abort-before-status") {
    await waitUntil(() => h.marks.sentAt, 5000, 1);
    seenAt = Date.now();
  } else {
    const until = Date.now() + 30000;
    while (Date.now() < until && !h.marks.firstContentAt) {
      const m = await metrics(port);
      if (m && m.requests_processing >= 1) { seenAt = Date.now(); break; }
      await sleep(50);
    }
  }
  const abortAt = Date.now();
  const headersBeforeAbort = h.marks.headersAt !== null;
  h.abort();
  const cpuAbort = await cpuSeconds(pid);
  // Timeline until quiet and still for 3 s, or LIMIT_MS.
  let quietAt = null; let lastChange = abortAt; let prev = null; let cpuQuiet = null; let top = null;
  const until = abortAt + LIMIT_MS;
  let n = 0;
  while (Date.now() < until) {
    const m = await metrics(port);
    const t = Date.now();
    const cpu = n % 4 === 0 ? await cpuSeconds(pid) : undefined;
    if (n === 20) top = topProcesses(); // about 5 s after the abort
    fs.appendFileSync(TIMELINE, JSON.stringify({ phase, label, t: t - abortAt, processing: m?.requests_processing, deferred: m?.requests_deferred, counters: counters(m), cpu, load1: os.loadavg()[0] }) + "\n");
    if (prev && counters(m) !== counters(prev)) lastChange = t;
    prev = m;
    n += 1;
    if (quiet(m)) { quietAt = t; cpuQuiet = await cpuSeconds(pid); break; }
    await sleep(250);
  }
  let stillFor3s = null; let end = prev;
  if (quietAt) { await sleep(3000); end = await metrics(port); stillFor3s = quiet(end) && counters(end) === counters(prev); }
  const r = await h.promise;
  Object.assign(row, {
    abortAfterMs: abortAt - t0, headersBeforeAbort, processingSeenBeforeAbort: seenAt !== null && mode !== "abort-before-status",
    responseEnded: r.ended, quietAfterAbortMs: quietAt ? quietAt - abortAt : null, lastCounterChangeAfterAbortMs: lastChange - abortAt, stillFor3s,
    promptTokensEvaluated: end && before ? end.prompt_tokens_total - before.prompt_tokens_total : null,
    tokensGenerated: end && before ? end.tokens_predicted_total - before.tokens_predicted_total : null,
    decodes: end && before ? end.n_decode_total - before.n_decode_total : null,
    cpuSecondsAfterAbort: cpuQuiet != null && cpuAbort != null ? +(cpuQuiet - cpuAbort).toFixed(2) : null,
    loadAvg1: +os.loadavg()[0].toFixed(2), topProcessesAt5s: top,
  });
  row.coresAfterAbort = row.cpuSecondsAfterAbort != null && row.quietAfterAbortMs ? +(row.cpuSecondsAfterAbort / (row.quietAfterAbortMs / 1000)).toFixed(2) : null;
  if (logOffset) row.engineLogAfterAbort = logOffset.linesSince(abortAt, quietAt || Date.now()).slice(0, 40);
  fs.appendFileSync(RUNS, JSON.stringify(row) + "\n");
  summary.push(row);
  return row;
}

// ── Phase A: the studio's engine (exact product command line) ──────────────────────────────────────────
async function startStudio() {
  const log = fs.openSync(path.join(LOGDIR, "chat-abort-studio.log"), "w");
  const child = spawn(NODE, [SERVE], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), FRONTEND_PORT: String(PORT) }, stdio: ["ignore", log, log], windowsHide: true });
  const exited = new Promise((r) => child.once("exit", () => r()));
  if (!(await waitUntil(async () => (await getJson(PORT, "/api/health")).status === 200, 60000, 500))) throw new Error("studio did not start");
  const t = Date.now();
  const start = await call(PORT, "POST", "/api/llm/start", { model: MODEL, contextSize: 4096, gpuLayers: 0 }).promise;
  if (start.status !== 200) throw new Error(`model start ${start.status}`);
  if (!(await waitUntil(async () => (await getJson(PORT, "/api/llm/status")).json?.ready === true, 240000, 500))) throw new Error("model not ready");
  const enginePort = (await getJson(PORT, "/api/llm/status")).json.port;
  const pid = listenerPids(enginePort).filter((p) => p !== child.pid)[0];
  return { child, exited, enginePort, pid, loadMs: Date.now() - t };
}
async function stopStudio(s) {
  if (!s) return;
  await call(PORT, "POST", "/api/llm/stop", {}, { timeoutMs: 30000 }).promise;
  s.child.kill("SIGTERM");
  await Promise.race([s.exited, sleep(20000)]);
  try { s.child.kill("SIGKILL"); } catch (_) { /* gone */ }
}
function engineCommandLine() {
  const log = fs.readFileSync(path.join(LOGDIR, "chat-abort-studio.log"), "utf8");
  const line = log.split(/\r?\n/).find((l) => l.includes("[llm] Starting:"));
  if (!line) return null;
  const rest = line.split("[llm] Starting:")[1].trim();
  const bin = rest.slice(0, rest.indexOf(" --model"));
  return { bin, args: rest.slice(bin.length).trim().split(/\s+/) }; // paths here contain no spaces on the runners
}

// ── Phase B: the same command line, default log level ──────────────────────────────────────────────────
async function startDirect(cmd) {
  const args = [...cmd.args];
  const i = args.indexOf("-lv"); if (i >= 0) args.splice(i, 2);
  const p = args.indexOf("--port"); args[p + 1] = String(DIRECT_PORT);
  const lines = [];
  const logFile = path.join(LOGDIR, "chat-abort-engine-direct.log");
  fs.writeFileSync(logFile, `# ${cmd.bin} ${args.join(" ")}\n`);
  const child = spawn(cmd.bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const onData = (d) => { const t = Date.now(); for (const l of String(d).split(/\r?\n/)) if (l.trim()) { lines.push({ t, l }); fs.appendFileSync(logFile, `${t} ${l}\n`); } };
  child.stdout.on("data", onData); child.stderr.on("data", onData);
  const exited = new Promise((r) => child.once("exit", () => r()));
  if (!(await waitUntil(async () => (await getJson(DIRECT_PORT, "/health")).status === 200, 120000, 500))) throw new Error("direct engine did not become healthy");
  return { child, exited, pid: child.pid, args, log: { linesSince: (a, b) => lines.filter((x) => x.t >= a - 50 && x.t <= b + 50).map((x) => `+${x.t - a}ms ${x.l.slice(0, 200)}`) } };
}

function table() {
  const out = ["", `### chat abort diagnosis (${PLATFORM})`, "",
    "| phase | run | mode | prompt tok | unaborted prompt_ms | abort at ms | status line before abort | quiet after abort ms | prompt tok evaluated | generated | engine CPU s after abort (cores) |",
    "|---|---|---|---|---|---|---|---|---|---|---|"];
  for (const r of summary) {
    out.push(`| ${r.phase} | ${r.label} | ${r.mode} | ${r.promptTokens} | ${r.promptMs != null ? Math.round(r.promptMs) + ` (${Math.round(r.promptPerSecond)} tok/s, ${r.cores} cores)` : ""} | ${r.abortAfterMs ?? ""} | ${r.headersBeforeAbort ?? ""} | ${r.mode === "unaborted" ? "" : r.quietAfterAbortMs ?? `>${LIMIT_MS}`} | ${r.promptTokensEvaluated ?? ""} | ${r.tokensGenerated ?? ""} | ${r.cpuSecondsAfterAbort != null ? `${r.cpuSecondsAfterAbort} (${r.coresAfterAbort})` : ""} |`);
  }
  return out.join("\n");
}

(async () => {
  const envInfo = { platform: PLATFORM, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, totalMemMB: Math.round(os.totalmem() / 1048576), freeMemMB: Math.round(os.freemem() / 1048576), loadavg: os.loadavg(), node: process.version };
  let studio = null; let direct = null;
  try {
    // --engine "<bin> <args>" skips phase A (local smoke test of this script only).
    const given = arg("engine", null);
    let cmd = given ? { bin: given.split(" ")[0], args: given.split(" ").slice(1) } : null;
    if (!given) {
    studio = await startStudio();
    envInfo.studioLoadMs = studio.loadMs; envInfo.enginePid = studio.pid;
    cmd = engineCommandLine();
    envInfo.engineCommandLine = cmd ? `${cmd.bin} ${cmd.args.join(" ")}` : null;
    const A = { phase: "A", port: studio.enginePort, pid: studio.pid };
    // The failing check, three times in a row on the fresh engine (the first is what the check does).
    for (let k = 1; k <= 3; k += 1) await measure({ ...A, label: `check-repeat-${k}`, target: 3000, mode: "abort-after-status" });
    for (let k = 1; k <= 2; k += 1) await measure({ ...A, label: `unaborted-${k}`, target: 3000, mode: "unaborted" });
    await measure({ ...A, label: "check-repeat-4-warm", target: 3000, mode: "abort-after-status" });
    // Phase C (#115): the same abort from three clients, interleaved, on the same engine: is the difference between
    // the validator's direct abort (whole prompt evaluated on POSIX) and the studio's cancel (512 tokens) the client?
    for (let k = 1; k <= 2; k += 1) {
      for (const client of ["agent-false", "keepalive", "studio"]) await measure({ ...A, phase: "C", label: `${client}-${k}`, target: 3000, mode: "abort-after-status", client });
    }
    envInfo.enginePidAfterA = listenerPids(studio.enginePort)[0] ?? null;
    await stopStudio(studio); studio = null;
    }

    if (!cmd) throw new Error("engine command line not found in the studio log");
    direct = await startDirect(cmd);
    envInfo.directArgs = direct.args.join(" ");
    const B = { phase: "B", port: DIRECT_PORT, pid: direct.pid, logOffset: direct.log };
    for (const target of [750, 1500, 3000]) await measure({ ...B, label: `unaborted-${target}`, target, mode: "unaborted" });
    for (const target of [750, 1500, 3000]) await measure({ ...B, label: `abort-${target}`, target, mode: "abort-after-status" });
    await measure({ ...B, label: "abort-before-status-3000", target: 3000, mode: "abort-before-status" });
    await measure({ ...B, label: "abort-nonstream-3000", target: 3000, mode: "abort-nonstream" });
    await measure({ ...B, label: "unaborted-3000-again", target: 3000, mode: "unaborted" });
  } catch (err) {
    envInfo.error = err.message;
    console.log(`chat-abort-diagnose: ${err.message}`);
  } finally {
    await stopStudio(studio).catch(() => {});
    if (direct) { direct.child.kill("SIGTERM"); await Promise.race([direct.exited, sleep(10000)]); try { direct.child.kill("SIGKILL"); } catch (_) { /* gone */ } }
  }
  envInfo.loadavgEnd = os.loadavg();
  fs.writeFileSync(ENV_FILE, JSON.stringify(envInfo, null, 2));
  console.log(table());
  console.log("\n```\n" + JSON.stringify(envInfo, null, 1).slice(0, 3000) + "\n```");
  process.exit(0); // measurement: never fails the job
})();
