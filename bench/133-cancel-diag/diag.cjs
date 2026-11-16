// Issue #133 diagnostic (bench branch only; never merged). Windows-focused, runs anywhere.
//
// Question: after a streaming client disconnects during prompt evaluation, when does llama-server (b11418) notice,
// how many 512-token prompt batches does it still process, and how does the studio's chat-timeouts guard
// (CONFIRMING -> confirmed or UNRESPONSIVE -> recovered) see it?
//
//   B  through the studio (chat timeouts on with the validator's test values, production engine arguments, -lv 1):
//      4 x abort as soon as the engine reports requests_processing >= 1 (the validator's timing), then a short chat.
//   A  direct to a second engine started by this script with the studio engine's exact command line, except the
//      port and -lv 3 (diagnostic verbosity; the engine log gets "stop: cancel task" / "release" lines):
//      2 x complete (baseline, equivalent prompt), 4 x abort as in B.
//
// Recorded per trial: engine PID, executable, command line, port owner before and after (netstat/lsof), client
// abort time and socket close time, a 250 ms timeline of n_decode_total, prompt_tokens_total, tokens_predicted_total,
// requests_processing, engine CPU seconds (every 2 s), and (B) the studio's chatTimeouts engine state and counts. Bounded: each
// trial <= 180 s, the script <= 45 min; cleanup kills only the processes this script started, by PID.
// Nothing here changes production code, defaults, or the existing validator and its 20 s window.
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync, execFile } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const APP = path.join(ROOT, "app");
const SERVE = path.join(ROOT, "scripts", "server", "serve.cjs");
const OUT = path.resolve(process.argv[2] || path.join(ROOT, "ci-logs", "diag133"));
const MODEL = "qwen2.5-0.5b-instruct-q4_k_m.gguf";
const PORT = 14940;            // studio test server for B
const A_PORT = 14945;          // direct engine for A
const WIN = process.platform === "win32";
const ON_ENV = { USAP_CHAT_TIMEOUTS: "on", USAP_CHAT_FIRST_BYTE_SECONDS: "30", USAP_CHAT_IDLE_SECONDS: "10", USAP_CHAT_CANCEL_CONFIRM_SECONDS: "20", USAP_CHAT_UNRESPONSIVE_PROBE_SECONDS: "5" };
const NODE = [path.join(APP, "tools", "node-win", "node.exe"), path.join(APP, "tools", "node-linux", "bin", "node"), path.join(APP, "tools", "node-mac", "bin", "node")].find((p) => fs.existsSync(p)) || process.execPath;
const SCRIPT_DEADLINE = Date.now() + 70 * 60 * 1000;
const TRIAL_MS = 180000;
fs.mkdirSync(OUT, { recursive: true });
const RESULTS = path.join(OUT, "diag133.jsonl");
fs.writeFileSync(RESULTS, "");
const out = (o) => { const s = JSON.stringify({ t: Date.now(), ...o }); fs.appendFileSync(RESULTS, s + "\n"); console.log(s.length > 600 ? s.slice(0, 600) + "…" : s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function call(port, method, p, body, { timeoutMs = 600000 } = {}) {
  let req; const t0 = Date.now(); const marks = { headersAt: null, firstDataAt: null, firstDataText: null, closedAt: null };
  const promise = new Promise((resolve) => {
    let settled = false; const done = (v) => { if (!settled) { settled = true; resolve({ ...v, ms: Date.now() - t0, marks }); } };
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    req = http.request({ host: "127.0.0.1", port, path: p, method, agent: false, timeout: timeoutMs, headers: data ? { "content-type": "application/json", "content-length": data.length } : {} }, (res) => {
      marks.headersAt = Date.now(); let text = ""; res.setEncoding("utf8");
      res.on("data", (c) => { if (marks.firstDataAt === null) { marks.firstDataAt = Date.now(); marks.firstDataText = c.slice(0, 40); } text += c; });
      res.on("end", () => done({ status: res.statusCode, headers: res.headers, text, ended: true }));
      res.on("close", () => done({ status: res.statusCode, headers: res.headers, text, ended: false }));
      res.on("error", () => done({ status: res.statusCode, headers: res.headers, text, ended: false }));
    });
    req.on("socket", (s) => s.once("close", () => { marks.closedAt = Date.now(); }));
    req.on("timeout", () => req.destroy(new Error("client timeout")));
    req.on("error", (e) => done({ status: 0, headers: {}, text: "", ended: false, error: e.code || e.message }));
    if (data) req.write(data); req.end();
  });
  return { promise, marks, t0, abort: () => { const at = Date.now(); req && req.destroy(); return at; } };
}
const getJson = async (port, p, timeoutMs = 10000) => { const r = await call(port, "GET", p, undefined, { timeoutMs }).promise; try { return { status: r.status, json: JSON.parse(r.text) }; } catch (_) { return { status: r.status, json: null }; } };
async function metrics(port) {
  const r = await call(port, "GET", "/metrics", undefined, { timeoutMs: 5000 }).promise;
  if (r.status !== 200) return null;
  const m = {}; for (const line of r.text.split("\n")) { const x = line.match(/^llamacpp:([a-z_]+)\s+([0-9.eE+-]+)/); if (x) m[x[1]] = Number(x[2]); }
  return { proc: m.requests_processing, deferred: m.requests_deferred, decode: m.n_decode_total, prompt: m.prompt_tokens_total, pred: m.tokens_predicted_total };
}
async function waitUntil(fn, ms, every = 200) { const end = Date.now() + ms; for (;;) { let v; try { v = await fn(); } catch (_) { v = undefined; } if (v) return v; if (Date.now() > end) return null; await sleep(every); } }

// ── process facts ──────────────────────────────────────────────────────────────────────────────────────────────
function listenerPids(port) {
  if (WIN) {
    const r = spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" });
    return [...new Set((r.stdout || "").split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 5 && /LISTENING/i.test(c[3]) && c[1].endsWith(`:${port}`)).map((c) => Number(c[4])).filter((n) => n > 0))];
  }
  const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  return [...new Set((r.stdout || "").split("\n").map(Number).filter((n) => n > 0))];
}
function procInfo(pid) {
  if (WIN) {
    const ps = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { [pscustomobject]@{ exe=$p.ExecutablePath; cmd=$p.CommandLine; ppid=$p.ParentProcessId; created=$p.CreationDate.ToString('o') } | ConvertTo-Json -Compress }`;
    const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
    try { return JSON.parse(r.stdout); } catch (_) { return null; }
  }
  try { return { exe: fs.readlinkSync(`/proc/${pid}/exe`), cmd: fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" "), ppid: null, created: null }; } catch (_) {
    const r = spawnSync("ps", ["-o", "comm=,args=", "-p", String(pid)], { encoding: "utf8" }); return { exe: null, cmd: (r.stdout || "").trim(), ppid: null, created: null };
  }
}
function cpuSeconds(pid) { // async, so sampling never blocks the event loop
  return new Promise((resolve) => {
    if (WIN) execFile("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).TotalProcessorTime.TotalSeconds`], { timeout: 4000 }, (e, so) => resolve(e ? null : Number(String(so).trim()) || null));
    else execFile("ps", ["-o", "time=", "-p", String(pid)], { timeout: 4000 }, (e, so) => { if (e) return resolve(null); const p = String(so).trim().split(/[-:]/).map(Number); resolve(p.reduce((a, x) => a * 60 + x, 0)); });
  });
}
function killPid(pid) { if (!pid) return; if (WIN) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"]); else { try { process.kill(pid, "SIGKILL"); } catch (_) {} } }

// ── prompt (same construction and size as the validator's 2942-token case) ────────────────────────────────────
let seq = 0;
const promptOf = (words) => `[${Date.now()}-${++seq}] ` + Array.from({ length: words }, (_, i) => `item${(i * 7919) % 10007}`).join(" ") + "\nSummarise the list above in one sentence.";
async function tokens(port, text) { const r = await call(port, "POST", "/tokenize", { content: text }, { timeoutMs: 30000 }).promise; try { return JSON.parse(r.text).tokens.length; } catch (_) { return null; } }
let WORDS = null;
async function sizePrompt(enginePort) { if (WORDS) return; const tpw = (await tokens(enginePort, promptOf(200))) / 200; WORDS = Math.floor(3000 / tpw); out({ event: "prompt", words: WORDS, tokens: await tokens(enginePort, promptOf(WORDS)) }); }

// ── one trial ──────────────────────────────────────────────────────────────────────────────────────────────────
async function trial({ label, kind, enginePort, enginePid, viaStudio }) {
  const ownerBefore = listenerPids(enginePort);
  const base = await metrics(enginePort); const cpu0 = await cpuSeconds(enginePid);
  const body = { messages: [{ role: "user", content: promptOf(WORDS) }], max_tokens: 64, temperature: 0, stream: true };
  const h = viaStudio ? call(PORT, "POST", "/api/llm/chat", body) : call(enginePort, "POST", "/v1/chat/completions", body);
  const tl = []; let sampling = true;
  let tick = 0;
  const sampler = (async () => {
    while (sampling) {
      // metrics every 250 ms; engine CPU every 2 s (PowerShell sampling must not itself load a 4-vCPU runner)
      const t = Date.now(); const wantCpu = tick++ % 8 === 0;
      const [m, c, r] = await Promise.all([metrics(enginePort), wantCpu ? cpuSeconds(enginePid) : Promise.resolve(null), viaStudio ? getJson(PORT, "/api/resources", 4000) : Promise.resolve(null)]);
      const ct = r && r.json && r.json.chatTimeouts;
      tl.push({ dt: t - h.t0, proc: m && m.proc, decode: m && m.decode - base.decode, prompt: m && m.prompt - base.prompt, pred: m && m.pred - base.pred, cpu: c != null && cpu0 != null ? +(c - cpu0).toFixed(2) : null, studio: ct ? ct.engine : undefined, cancelConfirmed: ct ? ct.counts.cancelConfirmed : undefined, unconfirmed: ct ? ct.counts.cancelUnconfirmed : undefined, recovered: ct ? ct.counts.recovered : undefined });
      await sleep(Math.max(0, 250 - (Date.now() - t)));
    }
  })();
  let abortAt = null;
  const busy = await waitUntil(async () => (await metrics(enginePort))?.proc >= 1, 30000, 50);
  if (kind === "abort") abortAt = h.abort();
  // follow until the engine is quiet (processing 0, decode unchanged for 3 s) and, via the studio, the studio is ready
  let stableSince = Date.now(), last = null, quietAt = null, studioReadyAt = null;
  const end = h.t0 + TRIAL_MS;
  while (Date.now() < end) {
    await sleep(250);
    const s = tl.at(-1); if (!s) continue;
    if (!last || s.decode !== last.decode || s.proc !== last.proc) { last = s; stableSince = Date.now(); }
    if (s.proc === 0 && Date.now() - stableSince >= 3000 && quietAt === null) quietAt = Date.now();
    if (viaStudio && s.studio === "ready" && abortAt && studioReadyAt === null && quietAt) studioReadyAt = Date.now();
    if (quietAt && (kind === "complete" ? true : (!viaStudio || studioReadyAt))) break;
  }
  const r = kind === "complete" ? await h.promise : null;
  sampling = false; await sampler;
  const ownerAfter = listenerPids(enginePort);
  const after = await metrics(enginePort); const cpu1 = await cpuSeconds(enginePid);
  // what happened between the abort and quiet: decode steps and prompt counter
  const atAbort = abortAt ? tl.filter((x) => x.dt <= abortAt - h.t0).at(-1) || null : null;
  const studioStates = viaStudio ? tl.reduce((a, x) => { if (x.studio && (a.length === 0 || a.at(-1).state !== x.studio)) a.push({ state: x.studio, dt: x.dt }); return a; }, []) : null;
  let followUp = null;
  if (viaStudio) { const f = await call(PORT, "POST", "/api/llm/chat", { messages: [{ role: "user", content: `[${++seq}] Say ok.` }], max_tokens: 8, temperature: 0, stream: true }, { timeoutMs: 120000 }).promise; followUp = { status: f.status, done: /\[DONE\]/.test(f.text), ms: f.ms, error: f.error || null }; }
  out({ event: "trial", label, kind, viaStudio, enginePid, enginePort, ownerBefore, ownerAfter, ownerOk: ownerBefore.length === 1 && ownerBefore[0] === enginePid && ownerAfter.length === 1 && ownerAfter[0] === enginePid,
    msToBusy: busy ? null : "not busy", abortAtMs: abortAt ? abortAt - h.t0 : null, clientSocketClosedMs: h.marks.closedAt ? h.marks.closedAt - h.t0 : null,
    firstDataMs: h.marks.firstDataAt ? h.marks.firstDataAt - h.t0 : null, firstDataText: h.marks.firstDataText, completeStatus: r && r.status, completeMs: r && r.ms,
    atAbort, quietMs: quietAt ? quietAt - h.t0 : null, studioReadyMs: studioReadyAt ? studioReadyAt - h.t0 : null,
    decodeDelta: after.decode - base.decode, promptDelta: after.prompt - base.prompt, predDelta: after.pred - base.pred, cpuDelta: cpu1 != null && cpu0 != null ? +(cpu1 - cpu0).toFixed(2) : null,
    studioStates, followUp, timeline: tl });
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────────────────────
// Run 2 (owner-authorized follow-up): compare the existing engine configuration with fewer inference threads and
// with busy-polling disabled, same prompt and abort timing.
//   B (studio, production arguments; threads set through /api/llm/start, --poll stays 30 as in production):
//     B-t4 x2 aborts (existing configuration), B-t2 x2 aborts
//   A (direct engine, studio command line with -lv 3; threads/poll replaced):
//     t4/poll30, t2/poll30, t4/poll0: 1 complete + 3 aborts each
async function startStudio(threads, studioLog) {
  const studio = spawn(NODE, [SERVE], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), FRONTEND_PORT: String(PORT), ...ON_ENV }, stdio: ["ignore", studioLog, studioLog], windowsHide: true });
  if (!(await waitUntil(async () => (await getJson(PORT, "/api/health")).status === 200, 60000, 500))) throw new Error("studio did not start");
  const st = await call(PORT, "POST", "/api/llm/start", { model: MODEL, contextSize: 4096, gpuLayers: 0, ...(threads ? { threads } : {}) }).promise;
  if (st.status !== 200) throw new Error(`model start ${st.status}: ${String(st.text).slice(0, 200)}`);
  if (!(await waitUntil(async () => (await getJson(PORT, "/api/llm/status")).json?.ready === true, 240000, 1000))) throw new Error("model not ready");
  const port = (await getJson(PORT, "/api/llm/status")).json.port;
  const pids = listenerPids(port).filter((p) => p !== studio.pid);
  if (pids.length !== 1) throw new Error(`expected one engine on ${port}, found ${pids}`);
  return { studio, port, pid: pids[0], info: procInfo(pids[0]) };
}
async function stopStudio(s) {
  if (!s) return;
  try { await call(PORT, "POST", "/api/llm/stop", {}, { timeoutMs: 30000 }).promise; } catch (_) {}
  killPid(s.studio.pid);
  await waitUntil(() => listenerPids(s.port).length === 0 && listenerPids(PORT).length === 0, 30000, 500);
}
const flag = (cmd, name) => { const m = String(cmd).match(new RegExp(`(?:^|\\s)${name}\\s+(\\S+)`)); return m ? m[1] : null; };

(async () => {
  let s = null, aEngine = null, baseCmd = null;
  const studioLog = fs.openSync(path.join(OUT, "studio.log"), "w");
  try {
    for (const threads of [null, 2]) {
      if (Date.now() > SCRIPT_DEADLINE) break;
      s = await startStudio(threads, studioLog);
      baseCmd = baseCmd || s.info.cmd;
      const label = `B-t${flag(s.info.cmd, "--threads")}-p${flag(s.info.cmd, "--poll")}`;
      out({ event: "engine", which: label, pid: s.pid, port: s.port, threads: flag(s.info.cmd, "--threads"), poll: flag(s.info.cmd, "--poll"), ...s.info, studioPid: s.studio.pid });
      await sizePrompt(s.port);
      for (let i = 1; i <= 2 && Date.now() < SCRIPT_DEADLINE; i++) await trial({ label: `${label}-abort${i}`, kind: "abort", enginePort: s.port, enginePid: s.pid, viaStudio: true });
      await stopStudio(s); s = null;
    }
    const argv0 = baseCmd.match(/"[^"]*"|\S+/g).map((x) => x.replace(/^"|"$/g, ""));
    for (const [threads, poll] of [["4", "30"], ["2", "30"], ["4", "0"]]) {
      if (Date.now() > SCRIPT_DEADLINE) break;
      const argv = argv0.slice(1);
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--port") argv[i + 1] = String(A_PORT);
        if (argv[i] === "-lv") argv[i + 1] = "3";
        if (argv[i] === "--threads") argv[i + 1] = threads;
        if (argv[i] === "--poll") argv[i + 1] = poll;
      }
      const label = `A-t${threads}-p${poll}`;
      const engLog = fs.openSync(path.join(OUT, `engine-${label}.log`), "w");
      const spawnAt = Date.now();
      aEngine = spawn(argv0[0], argv, { stdio: ["ignore", engLog, engLog], windowsHide: true });
      if (!(await waitUntil(async () => (await getJson(A_PORT, "/health", 3000)).status === 200, 240000, 500))) throw new Error(`engine ${label} not ready`);
      const aPids = listenerPids(A_PORT);
      out({ event: "engine", which: label, pid: aEngine.pid, listenerPids: aPids, port: A_PORT, threads, poll, spawnAtMs: spawnAt, ...procInfo(aEngine.pid), argv: [argv0[0], ...argv].join(" ") });
      if (aPids.length !== 1 || aPids[0] !== aEngine.pid) throw new Error(`port ${A_PORT} owner ${aPids} is not engine ${aEngine.pid}`);
      await trial({ label: `${label}-complete`, kind: "complete", enginePort: A_PORT, enginePid: aEngine.pid, viaStudio: false });
      for (let i = 1; i <= 3 && Date.now() < SCRIPT_DEADLINE; i++) await trial({ label: `${label}-abort${i}`, kind: "abort", enginePort: A_PORT, enginePid: aEngine.pid, viaStudio: false });
      killPid(aEngine.pid); await waitUntil(() => listenerPids(A_PORT).length === 0, 30000, 500); aEngine = null;
    }
  } catch (err) {
    out({ event: "error", error: String(err && err.stack || err) }); process.exitCode = 1;
  } finally {
    if (aEngine) killPid(aEngine.pid);
    if (s) await stopStudio(s);
    await sleep(1000);
    out({ event: "cleanup", studioPortListeners: listenerPids(PORT), enginePortAListeners: listenerPids(A_PORT) });
  }
})();
