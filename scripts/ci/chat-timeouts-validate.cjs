#!/usr/bin/env node
// Real-model validation of Step 9.9f-1 chat timeouts (docs/roadmap/STEP9_9F_TIMEOUTS.md), opt-in only.
//
// Runs in the native-runtime job after the first launch has stopped. It starts its OWN studio servers from this
// checkout, with chatTimeouts switched on in their environment only (the installed default stays off; the first
// check proves it), loads the pinned Qwen2.5 0.5B Q4_K_M model with real llama.cpp on the CPU, and checks:
//
//   A. the confirmation signal itself, on the engine directly: /metrics answers during prompt evaluation and during
//      decoding with requests_processing 1; after a transport abort in either phase, and after a normal
//      completion, requests_processing and requests_deferred return to 0 and the decode/token counters then stay
//      still (computation stopped). A successful HTTP abort is recorded separately and is never counted as proof;
//   B. the engine's status line and its first body chunk, timed separately (why "first byte" means the body);
//   C. through the studio, mode on: a client cancel is confirmed by /metrics; a SUSPENDED engine (SIGSTOP, or
//      NtSuspendProcess on Windows) gives the idle-timeout error event, CONFIRMING, then UNRESPONSIVE (503,
//      Retry-After); after resuming, the studio recovers WITHOUT a restart (same engine PID) and chats work;
//      a suspended engine before the request gives 504 ENGINE_TIMEOUT phase first-byte.
//
// Only the engine this script's own server started is ever touched (found by its listening port, never by name).
// A suspended engine is always resumed: in a finally block, and on exit and signals. Statuses: PASS / FAIL (fails
// the step) / UNSUPPORTED (process suspension can't be set up on this runner; recorded, never a pass) / SKIP (a
// measurement window was too short to observe, recorded with the reason) / DIAG (a measurement of the engine's own
// responsiveness, recorded, never a pass or a failure). A failure after suspension worked is FAIL.
//
// Client cancel (#133): the studio's safety is checked separately from how fast the engine stops. llama-server
// applies a cancel only between prompt batches, and on Windows it notices a closed connection late and variably
// (measured 3.8-60 s on the hosted runner, independent of thread count and busy-polling). Safety rows fail the step
// on every platform; how fast the engine stopped is recorded as DIAG. The 20 s confirmation window stays a pass/fail
// check on Linux and macOS, and is recorded as DIAG (met / not met, with the times) on Windows.
//
//   node scripts/ci/chat-timeouts-validate.cjs --model qwen2.5-0.5b-instruct-q4_k_m.gguf --results out.jsonl
"use strict";

const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const APP = path.join(ROOT, "app");
const SERVE = path.join(ROOT, "scripts", "server", "serve.cjs");
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const MODEL = arg("model", "qwen2.5-0.5b-instruct-q4_k_m.gguf");
const RESULTS = arg("results", path.join(ROOT, "ci-logs", "chat-timeouts-results.jsonl"));
const LOGDIR = arg("logs", path.join(ROOT, "ci-logs"));
const PORT = Number(arg("port", "14930"));
const WIN = process.platform === "win32";
const NODE = [path.join(APP, "tools", "node-win", "node.exe"), path.join(APP, "tools", "node-linux", "bin", "node"), path.join(APP, "tools", "node-mac", "bin", "node")]
  .find((p) => fs.existsSync(p)) || process.execPath;
// Smallest allowed limits, so the run stays short. These are test values only.
const ON_ENV = { USAP_CHAT_TIMEOUTS: "on", USAP_CHAT_FIRST_BYTE_SECONDS: "30", USAP_CHAT_IDLE_SECONDS: "10", USAP_CHAT_CANCEL_CONFIRM_SECONDS: "20", USAP_CHAT_UNRESPONSIVE_PROBE_SECONDS: "5" };

fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
fs.mkdirSync(LOGDIR, { recursive: true });
fs.writeFileSync(RESULTS, "");
let failed = false;
function record(check, status, detail) {
  const d = String(detail).replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 500);
  fs.appendFileSync(RESULTS, JSON.stringify({ check, status, platform: `${process.platform}-${process.arch}`, detail: d }) + "\n");
  console.log(`| ${check} | ${status} | ${d} |`);
  if (status === "FAIL") failed = true;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, ms, every = 100) {
  const end = Date.now() + ms;
  for (;;) {
    let v; try { v = await fn(); } catch (_) { v = undefined; }
    if (v) return v;
    if (Date.now() > end) return undefined;
    await sleep(every);
  }
}
const portOpen = (port) => new Promise((resolve) => {
  const s = net.connect(port, "127.0.0.1"); s.setTimeout(1000);
  s.on("connect", () => { s.destroy(); resolve(true); }); s.on("error", () => resolve(false)); s.on("timeout", () => { s.destroy(); resolve(false); });
});

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────────────────
function call(port, method, p, body, { timeoutMs = 600000 } = {}) {
  let req;
  const t0 = Date.now();
  const marks = { headersAt: null, firstDataAt: null, firstContentAt: null };
  const promise = new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve({ ...v, ms: Date.now() - t0, at: Date.now(), marks }); } };
    const data = body === undefined ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    req = http.request({ host: "127.0.0.1", port, path: p, method, agent: false, timeout: timeoutMs,
      headers: data ? { "content-type": "application/json", "content-length": data.length } : {} }, (res) => {
      marks.headersAt = Date.now();
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        if (marks.firstDataAt === null) marks.firstDataAt = Date.now();
        text += c;
        if (marks.firstContentAt === null && /"content":"[^"]/.test(text)) marks.firstContentAt = Date.now();
      });
      res.on("end", () => done({ status: res.statusCode, headers: res.headers, text, ended: true }));
      res.on("close", () => done({ status: res.statusCode, headers: res.headers, text, ended: false }));
      res.on("error", () => done({ status: res.statusCode, headers: res.headers, text, ended: false }));
    });
    req.on("timeout", () => req.destroy(new Error("client timeout")));
    req.on("error", (e) => done({ status: 0, headers: {}, text: "", ended: false, error: e.code || e.message }));
    if (data) req.write(data);
    req.end();
  });
  return { promise, marks, abort: () => req && req.destroy(), t0 };
}
const getJson = async (port, p, timeoutMs = 10000) => { const r = await call(port, "GET", p, undefined, { timeoutMs }).promise; try { return { status: r.status, json: JSON.parse(r.text) }; } catch (_) { return { status: r.status, json: null }; } };
const parseJson = (t) => { try { return JSON.parse(t); } catch (_) { return null; } };
async function metrics(enginePort) {
  const r = await call(enginePort, "GET", "/metrics", undefined, { timeoutMs: 5000 }).promise;
  if (r.status !== 200) return null;
  const m = { start: r.headers["process-start-time-unix"] || null };
  for (const line of r.text.split("\n")) {
    const x = line.match(/^llamacpp:([a-z_]+)\s+([0-9.eE+-]+)/);
    if (x) m[x[1]] = Number(x[2]);
  }
  return m;
}
const quiet = (m) => m && m.requests_processing === 0 && m.requests_deferred === 0;
const counters = (m) => m && [m.n_decode_total, m.tokens_predicted_total, m.prompt_tokens_total].join("/");
const lastEvent = (text) => { const ev = String(text || "").split("\n\n").filter(Boolean).at(-1) || ""; return parseJson(ev.replace(/^data: /, "")); };

// A prompt long enough that prompt evaluation takes a while on a CPU, but sized with the engine's own /tokenize to
// fit the 4096-token context with room for the answer (an oversized prompt is refused at once and proves nothing).
// A fresh prefix each time defeats the prompt cache.
let promptSeq = 0;
let tokensPerWord = null; // measured once with /tokenize; prompts of any target size are derived from it
const promptOf = (words) => `[${Date.now()}-${++promptSeq}] ` + Array.from({ length: words }, (_, i) => `item${(i * 7919) % 10007}`).join(" ") + "\nSummarise the list above in one sentence.";
async function tokens(enginePort, text) {
  const r = await call(enginePort, "POST", "/tokenize", { content: text }, { timeoutMs: 30000 }).promise;
  const j = parseJson(r.text);
  return r.status === 200 && j && Array.isArray(j.tokens) ? j.tokens.length : null;
}
async function longPrompt(enginePort, target = 3000) {
  if (!tokensPerWord) {
    const probeWords = 200;
    const n = await tokens(enginePort, promptOf(probeWords));
    if (!n) throw new Error("the engine's /tokenize did not answer; can't size the prompt");
    tokensPerWord = n / probeWords;
  }
  const words = Math.max(50, Math.floor(target / tokensPerWord));
  const text = promptOf(words);
  const n = await tokens(enginePort, text);
  if (!n || n > target * 1.2) throw new Error(`prompt sizing failed (${n} tokens for ${words} words, target ${target})`);
  return { text, tokens: n };
}
const COUNT = () => ({ messages: [{ role: "user", content: `[${++promptSeq}] Count from 1 to 3000. Write each number on its own line and nothing else.` }], max_tokens: 1024, temperature: 0, stream: true });

// ── Processes ─────────────────────────────────────────────────────────────────────────────────────────────
function listenerPids(port) {
  if (!port) return [];
  if (WIN) {
    const r = spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" });
    return [...new Set((r.stdout || "").split(/\r?\n/).map((l) => l.trim().split(/\s+/))
      .filter((c) => c.length >= 5 && /LISTENING/i.test(c[3]) && c[1].endsWith(`:${port}`)).map((c) => Number(c[4])).filter((n) => n > 0))];
  }
  const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  return [...new Set((r.stdout || "").split("\n").map(Number).filter((n) => n > 0))];
}

// Process suspension. Returns { ok, detail }. Verified by reading the process state back.
const NT = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class UsapNt { [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h); [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h); }';`;
function ps(cmd) { return spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], { encoding: "utf8", timeout: 60000 }); }
function isSuspended(pid) {
  if (WIN) {
    const r = ps(`$t = (Get-Process -Id ${pid}).Threads; $n = ($t | Where-Object { $_.WaitReason -ne 'Suspended' }).Count; "$($t.Count) $n"`);
    const [all, notSuspended] = String(r.stdout || "").trim().split(/\s+/).map(Number);
    return all > 0 && notSuspended === 0;
  }
  const r = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  return /^T/.test(String(r.stdout || "").trim());
}
const suspended = new Set();
function suspend(pid) {
  if (WIN) {
    const r = ps(`${NT} $p = [System.Diagnostics.Process]::GetProcessById(${pid}); [UsapNt]::NtSuspendProcess($p.Handle)`);
    if (r.status !== 0 || String(r.stdout).trim() !== "0") return { ok: false, detail: `NtSuspendProcess unavailable (exit ${r.status}, ${String(r.stdout || r.stderr).trim().slice(0, 120)})` };
  } else {
    try { process.kill(pid, "SIGSTOP"); } catch (e) { return { ok: false, detail: `SIGSTOP failed: ${e.code}` }; }
  }
  suspended.add(pid);
  const v = waitSync(() => isSuspended(pid), 5000);
  return v ? { ok: true, detail: WIN ? "NtSuspendProcess; all threads report WaitReason Suspended" : "SIGSTOP; ps state T" } : { ok: false, detail: "the process state did not show it suspended" };
}
function resume(pid) {
  if (WIN) ps(`${NT} $p = [System.Diagnostics.Process]::GetProcessById(${pid}); [UsapNt]::NtResumeProcess($p.Handle)`);
  else { try { process.kill(pid, "SIGCONT"); } catch (_) { /* gone */ } }
  const ok = waitSync(() => !isSuspended(pid), 5000);
  if (ok) suspended.delete(pid);
  return ok;
}
function waitSync(fn, ms) { const end = Date.now() + ms; for (;;) { if (fn()) return true; if (Date.now() > end) return false; spawnSync(process.execPath, ["-e", "setTimeout(()=>{},200)"]); } }
// Never leave a suspended process behind, whatever happens.
const resumeAll = () => { for (const pid of [...suspended]) { try { resume(pid); } catch (_) { /* best effort */ } } };
process.on("exit", resumeAll);
for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => { resumeAll(); process.exit(130); });

// ── Servers ─────────────────────────────────────────────────────────────────────────────────────────────
async function startServer(label, env, { model = true } = {}) {
  const log = fs.openSync(path.join(LOGDIR, `chat-timeouts-${label}.log`), "w");
  const child = spawn(NODE, [SERVE], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), FRONTEND_PORT: String(PORT), ...env }, stdio: ["ignore", log, log], windowsHide: true });
  const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
  const up = await waitUntil(async () => (await getJson(PORT, "/api/health")).status === 200, 60000, 500);
  if (!up) throw new Error(`server ${label} did not start (see chat-timeouts-${label}.log)`);
  const srv = { label, child, exited };
  if (!model) return srv;
  const start = await call(PORT, "POST", "/api/llm/start", { model: MODEL, contextSize: 4096, gpuLayers: 0 }).promise;
  if (start.status !== 200) throw new Error(`model start ${start.status}: ${start.text.slice(0, 200)}`);
  const ready = await waitUntil(async () => (await getJson(PORT, "/api/llm/status")).json?.ready === true, 240000, 1000);
  if (!ready) throw new Error("model did not become ready");
  srv.enginePort = (await getJson(PORT, "/api/llm/status")).json.port;
  srv.enginePids = listenerPids(srv.enginePort).filter((pid) => pid !== child.pid);
  if (srv.enginePids.length !== 1) throw new Error(`expected one engine process on port ${srv.enginePort}, found ${srv.enginePids.length}`);
  return srv;
}
async function stopServer(srv) {
  if (!srv) return;
  resumeAll();
  if (srv.child.exitCode !== null || srv.child.signalCode !== null) return;
  await call(PORT, "POST", "/api/llm/stop", {}, { timeoutMs: 30000 }).promise;
  srv.child.kill("SIGTERM");
  const r = await Promise.race([srv.exited, sleep(20000).then(() => null)]);
  if (!r) { try { srv.child.kill("SIGKILL"); } catch (_) { /* gone */ } await srv.exited; }
  await waitUntil(async () => !(await portOpen(PORT)), 15000, 250);
}
const timeoutsReport = async () => (await getJson(PORT, "/api/resources")).json?.chatTimeouts;

async function scenario(name, fn) { try { await fn(); } catch (err) { record(name, "FAIL", err.message); } }

// After an abort: poll /metrics until quiet, then require the counters to stay still for 3 s more.
async function observeStop(enginePort, abortAt) {
  let quietAt = null;
  let base = null;
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    const m = await metrics(enginePort);
    if (quiet(m)) { quietAt = Date.now(); base = m; break; }
    await sleep(100);
  }
  if (!base) return { stopped: false, detail: "requests_processing never returned to 0 within 60 s" };
  await sleep(3000);
  const after = await metrics(enginePort);
  const still = quiet(after) && counters(after) === counters(base) && after.start === base.start;
  return { stopped: still, quietMs: quietAt - abortAt, detail: `quiet ${quietAt - abortAt} ms after the abort; counters ${counters(base)} → ${counters(after)} over 3 s; processing ${after?.requests_processing}` };
}

// ── A + B: the signal on the engine directly ───────────────────────────────────────────────────────────
async function signalChecks(srv) {
  const ep = srv.enginePort;
  const m0 = await metrics(ep);
  const fields = ["requests_processing", "requests_deferred", "n_decode_total", "tokens_predicted_total", "prompt_tokens_total"];
  record("engine /metrics exposes what confirmation needs", m0 && fields.every((f) => Number.isFinite(m0[f])) && m0.start ? "PASS" : "FAIL",
    m0 ? `${fields.map((f) => `${f}=${m0[f]}`).join(", ")}; Process-Start-Time-Unix ${m0.start ? "present" : "missing"}` : "no /metrics");
  record("engine idle before the checks: requests_processing 0", quiet(m0) ? "PASS" : "FAIL", `processing ${m0?.requests_processing}, deferred ${m0?.requests_deferred}`);

  await scenario("abort during prompt evaluation stops computation", async () => {
    // #115: llama.cpp b11418 on Linux and macOS does not notice a client that disconnects after its status line until
    // it writes the first token, so the time to quiet is the prompt's own evaluation time (measured on every OS:
    // abort-to-quiet = unaborted prompt_ms). A 3000-token prompt takes 52-76 s on the macOS Intel runner, beyond the
    // 60 s window; about 1000 tokens takes 10-27 s there and still runs for seconds on the fastest runner. The window
    // and the stopped-computation assertion are unchanged; the abort must also stop the output at once (<= 2 tokens).
    const lp = await longPrompt(ep, 1000);
    const before = await metrics(ep);
    const h = call(ep, "POST", "/v1/chat/completions", { messages: [{ role: "user", content: lp.text }], max_tokens: 64, temperature: 0, stream: true });
    // Wait until the engine reports the request processing while no output has been produced yet.
    let seen = null;
    const until = Date.now() + 30000;
    while (Date.now() < until && !h.marks.firstContentAt) {
      const m = await metrics(ep);
      if (m && m.requests_processing >= 1 && !h.marks.firstContentAt) { seen = m; break; }
      await sleep(50);
    }
    if (!seen) {
      h.abort();
      const r = await h.promise;
      // An engine refusal is a failure of this check, never a skip.
      if (r.status !== 200 && r.status !== 0) throw new Error(`the engine answered ${r.status} to a ${lp.tokens}-token prompt: ${r.text.slice(0, 160)}`);
      record("/metrics answers during prompt evaluation (requests_processing 1)", "SKIP", `prompt evaluation of ${lp.tokens} tokens ended before a reading could be taken`);
      return;
    }
    record("/metrics answers during prompt evaluation (requests_processing 1)", "PASS", `${lp.tokens}-token prompt: processing ${seen.requests_processing} before any output; engine status line ${h.marks.headersAt ? `after ${h.marks.headersAt - h.t0} ms` : "not yet"}, body ${h.marks.firstDataAt ? "started" : "not started"}`);
    const abortAt = Date.now();
    h.abort();
    const r = await h.promise;
    record("transport abort during prompt evaluation (HTTP only; not proof)", r.ended ? "FAIL" : "PASS", `connection closed by the client after ${abortAt - h.t0} ms`);
    const s = await observeStop(ep, abortAt);
    const end = await metrics(ep);
    const generated = end.tokens_predicted_total - before.tokens_predicted_total;
    record("after that abort, computation stopped (metrics quiet, counters still for 3 s, at most 2 tokens generated)", s.stopped && generated <= 2 ? "PASS" : "FAIL",
      `${s.detail}; after the abort the engine still evaluated prompt tokens up to ${end.prompt_tokens_total - before.prompt_tokens_total} of ${lp.tokens} and generated ${end.tokens_predicted_total - before.tokens_predicted_total} (an HTTP abort doesn't stop it at once)`);
  });

  await scenario("abort during decoding stops computation", async () => {
    const h = call(ep, "POST", "/v1/chat/completions", COUNT());
    const got = await waitUntil(() => h.marks.firstContentAt, 60000, 20);
    if (!got) { h.abort(); throw new Error("no output from the engine"); }
    await sleep(500);
    const m = await metrics(ep);
    record("/metrics answers during decoding (requests_processing 1)", m && m.requests_processing === 1 ? "PASS" : "FAIL", `processing ${m?.requests_processing}`);
    const abortAt = Date.now();
    h.abort();
    const s = await observeStop(ep, abortAt);
    record("after an abort during decoding, computation stopped", s.stopped ? "PASS" : "FAIL", s.detail);
  });

  await scenario("normal completion leaves the engine quiet", async () => {
    const h = call(ep, "POST", "/v1/chat/completions", { messages: [{ role: "user", content: `[${++promptSeq}] Say ok.` }], max_tokens: 8, temperature: 0, stream: true });
    const r = await h.promise;
    const s = await observeStop(ep, Date.now());
    record("after a normal completion the engine is quiet", r.status === 200 && s.stopped ? "PASS" : "FAIL", `status ${r.status}; ${s.detail}`);
    // B: status line vs first body chunk.
    const lp2 = await longPrompt(ep);
    const h2 = call(ep, "POST", "/v1/chat/completions", { messages: [{ role: "user", content: lp2.text }], max_tokens: 4, temperature: 0, stream: true });
    const r2 = await h2.promise;
    fullPrompt = { tokens: lp2.tokens, ms: r2.ms }; // a complete request of the same size (4 output tokens), for comparison
    const { headersAt, firstDataAt } = h2.marks;
    const first = (r2.text.split("\n\n")[0] || "").slice(0, 120);
    record("engine status line vs first body chunk (long prompt, measured)", r2.status === 200 && headersAt && firstDataAt && r2.text.includes("[DONE]") ? "PASS" : "FAIL",
      `${lp2.tokens}-token prompt: status ${r2.status}, status line after ${headersAt - h2.t0} ms, first body chunk after ${firstDataAt - h2.t0} ms (${first}); the first-byte limit runs to the body chunk`);
    await observeStop(ep, Date.now());
  });
}

// Ground truth after the studio says "ready": the engine computes nothing more (checked with our own readings).
async function noComputeAfter(label) {
  const ep = currentEnginePort;
  const a = await metrics(ep);
  await sleep(10000);
  const b = await metrics(ep);
  record(`${label}: no engine computation after the studio's confirmation (10 s)`, quiet(a) && quiet(b) && counters(a) === counters(b) && a.start === b.start ? "PASS" : "FAIL",
    `counters ${counters(a)} → ${counters(b)}, processing ${a?.requests_processing}/${b?.requests_processing}`);
}
let currentEnginePort = null;
let fullPrompt = null;

// ── C: through the studio, mode on ──────────────────────────────────────────────────────────────────────
async function studioChecks(srv) {
  const ep = srv.enginePort;
  currentEnginePort = ep;
  const pid = srv.enginePids[0];
  const r0 = await timeoutsReport();
  record("on (environment only): /api/resources reports the limits", r0 && r0.mode === "on" && r0.idleSeconds === 10 && r0.firstByteSeconds === 30 && r0.nonStreamTotalSeconds === 300 && r0.engine === "ready" ? "PASS" : "FAIL", JSON.stringify(r0 || null).slice(0, 300));

  await scenario("studio: client cancel during prompt evaluation (safety, then engine responsiveness)", async () => {
    const lp = await longPrompt(ep);
    const busyBase = await metrics(ep);
    const c0 = (await timeoutsReport())?.counts || {};
    const h = call(PORT, "POST", "/api/llm/chat", { messages: [{ role: "user", content: lp.text }], max_tokens: 64, temperature: 0, stream: true });
    const busy = await waitUntil(async () => (await metrics(ep))?.requests_processing >= 1, 30000, 50);
    if (!busy) { const r = await h.promise; throw new Error(`the request never reached the engine (studio answered ${r.status}: ${r.text.slice(0, 160)})`); }
    h.abort();
    const abortAt = Date.now();
    // Follow the studio and the engine together until the engine is quiet and the studio is ready (bounded).
    const samples = [];
    let falseQuiet = null, firstUnresponsive = null, refusal = null, lastDecodeAt = abortAt, prev = null, cancelSeenAt = null;
    const end = abortAt + 180000;
    while (Date.now() < end) {
      const [rep, m] = await Promise.all([timeoutsReport(), metrics(ep)]);
      const t = Date.now() - abortAt;
      if (m && prev && m.n_decode_total !== prev.n_decode_total) lastDecodeAt = Date.now();
      const computing = !m || !quiet(m) || (prev && counters(m) !== counters(prev));
      const cancelSeen = (rep?.counts?.clientCancelled || 0) > (c0.clientCancelled || 0);
      if (cancelSeen && cancelSeenAt === null) cancelSeenAt = t;
      samples.push({ t, studio: rep?.engine, cancelSeen, processing: m?.requests_processing, decode: m?.n_decode_total });
      // Only after the studio registered the cancel: before that it has no reason to call the engine busy.
      if (cancelSeen && rep?.engine === "ready" && computing && !falseQuiet) falseQuiet = { t, studio: rep.engine, processing: m?.requests_processing, decode: `${prev?.n_decode_total}→${m?.n_decode_total}` };
      if (rep?.engine === "unresponsive" && !firstUnresponsive) {
        firstUnresponsive = t;
        const r = await call(PORT, "POST", "/api/llm/chat", { messages: [{ role: "user", content: "hi" }], max_tokens: 4, stream: false }, { timeoutMs: 15000 }).promise;
        const body = parseJson(r.text) || {};
        refusal = { status: r.status, code: body.code, retryAfter: r.headers?.["retry-after"], ms: r.ms };
      }
      prev = m;
      if (cancelSeen && rep?.engine === "ready" && m && quiet(m) && Date.now() - lastDecodeAt >= 3000) break;
      await sleep(200);
    }
    const rep = await timeoutsReport();
    const m = await metrics(ep);
    const settledMs = Date.now() - abortAt;
    const states = samples.filter((x) => x.cancelSeen).reduce((a, x) => { if (x.studio && (a.length === 0 || a.at(-1).s !== x.studio)) a.push({ s: x.studio, t: x.t }); return a; }, []);
    const stateText = states.map((x) => `${x.s}@${Math.round(x.t / 100) / 10}s`).join(" → ");
    // A. safety (fails the step on every platform)
    record("studio safety: after a client cancel the engine is never reported idle while it still computes", !falseQuiet ? "PASS" : "FAIL",
      falseQuiet ? `reported ${falseQuiet.studio} at ${falseQuiet.t} ms while processing ${falseQuiet.processing}, decodes ${falseQuiet.decode}` : `states ${stateText}; ${samples.length} readings`);
    record("studio safety: the client cancel is registered", cancelSeenAt !== null && cancelSeenAt < 5000 ? "PASS" : "FAIL", `clientCancelled seen ${cancelSeenAt} ms after the abort`);
    record("studio safety: CONFIRMING after the cancel, then confirmed or UNRESPONSIVE (never anything else)", states.length >= 2 && states[0].s === "confirming" && states.every((x) => ["ready", "confirming", "unresponsive"].includes(x.s)) ? "PASS" : "FAIL", stateText);
    if (firstUnresponsive !== null) {
      record("studio safety: while UNRESPONSIVE, new chats are refused at once (503 ENGINE_UNRESPONSIVE, Retry-After)", refusal && refusal.status === 503 && refusal.code === "ENGINE_UNRESPONSIVE" && Number(refusal.retryAfter) >= 1 && refusal.ms < 3000 ? "PASS" : "FAIL",
        `unresponsive at ${firstUnresponsive} ms; refusal ${refusal?.status} ${refusal?.code} Retry-After ${refusal?.retryAfter} in ${refusal?.ms} ms`);
    } else {
      record("studio safety: while UNRESPONSIVE, new chats are refused at once (503 ENGINE_UNRESPONSIVE, Retry-After)", "SKIP", "not reached: the engine stopped within the confirmation window");
    }
    const pidsNow = listenerPids(ep).filter((p) => p !== srv.child.pid);
    record("studio safety: recovered to ready after the engine went quiet, same engine PID (no restart)", rep?.engine === "ready" && m && quiet(m) && pidsNow.length === 1 && pidsNow[0] === pid ? "PASS" : "FAIL",
      `engine ${rep?.engine} after ${settledMs} ms, processing ${m?.requests_processing}, pid ${pidsNow.join(",")} (was ${pid}), recovered ${rep?.counts?.recovered}, confirmed ${rep?.counts?.cancelConfirmed}`);
    await noComputeAfter("studio safety: after the cancel");
    const after = await call(PORT, "POST", "/api/llm/chat", { messages: [{ role: "user", content: `[${++promptSeq}] Say ok.` }], max_tokens: 8, temperature: 0, stream: true }).promise;
    record("studio safety: the next chat works", after.status === 200 && after.text.includes("[DONE]") ? "PASS" : "FAIL", `chat ${after.status} done ${after.text.includes("[DONE]")}`);
    // B. engine responsiveness (recorded; the engine decides how fast it stops)
    const quietMs = lastDecodeAt - abortAt;
    const decodesAfter = m ? m.n_decode_total - busyBase.n_decode_total : null;
    record("engine responsiveness: abort → last engine batch, batches after the abort, compared with the full prompt", "DIAG",
      `last batch ${quietMs} ms after the abort; ${decodesAfter} decode steps; prompt tokens evaluated ${m ? m.prompt_tokens_total - busyBase.prompt_tokens_total : "?"} of ${lp.tokens}; full ${fullPrompt ? `${fullPrompt.tokens}-token request ${fullPrompt.ms} ms` : "not measured"}; studio ${stateText}`);
    const confirmedInWindow = (rep?.counts?.cancelConfirmed || 0) > (c0.cancelConfirmed || 0) && firstUnresponsive === null;
    const windowRow = "studio: client cancel confirmed within the 20 s window (USAP_CHAT_CANCEL_CONFIRM_SECONDS=20)";
    const windowDetail = `${confirmedInWindow ? "met" : "not met"}; states ${stateText}; last engine batch ${quietMs} ms after the abort`;
    if (WIN) record(windowRow, "DIAG", `${windowDetail} (Windows: llama-server notices a closed connection late; #133)`);
    else record(windowRow, confirmedInWindow ? "PASS" : "FAIL", windowDetail);
  });

  // Suspension. Set it up once, honestly: UNSUPPORTED only if it can't be done at all.
  const probe = suspend(pid);
  if (!probe.ok) { resumeAll(); record("process suspension available", "UNSUPPORTED", probe.detail); return; }
  const resumedProbe = resume(pid);
  record("process suspension available (and resumed)", resumedProbe ? "PASS" : "FAIL", `${probe.detail}; resumed ${resumedProbe}`);
  if (!resumedProbe) return;

  await scenario("studio: suspended engine mid-stream → idle error event → UNRESPONSIVE → recovery without restart", async () => {
    const h = call(PORT, "POST", "/api/llm/chat", COUNT());
    const got = await waitUntil(() => h.marks.firstContentAt, 60000, 20);
    if (!got) { h.abort(); throw new Error("no output before suspending"); }
    try {
      const s = suspend(pid);
      if (!s.ok) throw new Error(`suspension failed after it worked once: ${s.detail}`);
      const stoppedAt = Date.now();
      const r = await h.promise;
      const ev = lastEvent(r.text);
      const tookS = Math.round((r.at - stoppedAt) / 100) / 10;
      record("suspended mid-stream: in-stream ENGINE_TIMEOUT (idle), no [DONE]", r.status === 200 && ev?.error?.code === "ENGINE_TIMEOUT" && ev.error.phase === "idle" && !r.text.includes("[DONE]") && tookS >= 9 && tookS < 30 ? "PASS" : "FAIL",
        `status ${r.status}, last event ${JSON.stringify(ev)?.slice(0, 120)}, ${tookS} s after suspending (idle limit 10 s)`);
      const rep1 = await timeoutsReport();
      record("suspended: the engine is CONFIRMING, not free", rep1?.engine === "confirming" ? "PASS" : "FAIL", `engine ${rep1?.engine}`);
      const unresp = await waitUntil(async () => (await timeoutsReport())?.engine === "unresponsive", 40000, 500);
      const refused = await call(PORT, "POST", "/api/llm/chat", { messages: [{ role: "user", content: "hi" }], max_tokens: 4, stream: false }, { timeoutMs: 15000 }).promise;
      const body = parseJson(refused.text) || {};
      record("unconfirmed within the window → UNRESPONSIVE; new chats refused at once (503, Retry-After)", unresp && refused.status === 503 && body.code === "ENGINE_UNRESPONSIVE" && refused.headers["retry-after"] === "30" && refused.ms < 3000 ? "PASS" : "FAIL",
        `engine ${unresp ? "unresponsive" : (await timeoutsReport())?.engine}, refusal ${refused.status} ${body.code} Retry-After ${refused.headers?.["retry-after"]} in ${refused.ms} ms`);
    } finally {
      const ok = resume(pid);
      record("engine resumed (never left suspended)", ok ? "PASS" : "FAIL", `pid still suspended: ${!ok}`);
    }
    const back = await waitUntil(async () => (await timeoutsReport())?.engine === "ready", 40000, 500);
    await noComputeAfter("after resuming the mid-stream suspension");
    const pidsNow = listenerPids(ep).filter((p) => p !== srv.child.pid);
    const after = await call(PORT, "POST", "/api/llm/chat", { messages: [{ role: "user", content: `[${++promptSeq}] Say ok.` }], max_tokens: 8, temperature: 0, stream: true }).promise;
    const rep = await timeoutsReport();
    record("after resuming: recovered by /metrics, same engine PID (no restart), chat works", back && pidsNow.length === 1 && pidsNow[0] === pid && after.status === 200 && after.text.includes("[DONE]") ? "PASS" : "FAIL",
      `engine ${rep?.engine}, recovered ${rep?.counts?.recovered}, pid ${pidsNow.join(",")} (was ${pid}), chat ${after.status} done ${after.text.includes("[DONE]")}`);
  });

  await scenario("studio: suspended engine before the request → 504 ENGINE_TIMEOUT first-byte", async () => {
    try {
      const s = suspend(pid);
      if (!s.ok) throw new Error(`suspension failed after it worked once: ${s.detail}`);
      const r = await call(PORT, "POST", "/api/llm/chat", { messages: [{ role: "user", content: "hi" }], max_tokens: 8, temperature: 0, stream: true }, { timeoutMs: 90000 }).promise;
      const body = parseJson(r.text) || {};
      const sec = Math.round(r.ms / 100) / 10;
      record("suspended before the request: 504 ENGINE_TIMEOUT phase first-byte at ~30 s", r.status === 504 && body.code === "ENGINE_TIMEOUT" && body.phase === "first-byte" && sec >= 29 && sec < 60 ? "PASS" : "FAIL",
        `status ${r.status}, code ${body.code}, phase ${body.phase}, after ${sec} s`);
    } finally {
      const ok = resume(pid);
      record("engine resumed after the first-byte check", ok ? "PASS" : "FAIL", `resumed ${ok}`);
    }
    const back = await waitUntil(async () => (await timeoutsReport())?.engine === "ready", 60000, 500);
    await noComputeAfter("after resuming the first-byte suspension");
    const after = await call(PORT, "POST", "/api/llm/chat", { messages: [{ role: "user", content: `[${++promptSeq}] Say ok.` }], max_tokens: 8, temperature: 0, stream: false }).promise;
    record("after the first-byte check: ready again and chat works without a restart", back && after.status === 200 && listenerPids(ep).includes(pid) ? "PASS" : "FAIL", `engine ${(await timeoutsReport())?.engine}, chat ${after.status}`);
  });
}

(async () => {
  let srv = null;
  try {
    // Default: off. Started without the model; only the report shape is checked.
    srv = await startServer("default", {}, { model: false });
    const r = (await getJson(PORT, "/api/resources")).json;
    record("default (no setting): chat timeouts off, no new report keys", r && !("chatTimeouts" in r) && !("runningTimeouts" in (r.limits || {})) ? "PASS" : "FAIL",
      `chatTimeouts key ${r && "chatTimeouts" in r}, limits ${JSON.stringify(r?.limits)}`);
    await stopServer(srv); srv = null;

    srv = await startServer("on", ON_ENV);
    await signalChecks(srv);
    await studioChecks(srv);
  } catch (err) {
    record("chat timeouts validation", "FAIL", err.message);
  } finally {
    resumeAll();
    await stopServer(srv).catch(() => {});
  }
  console.log(failed ? "\nchat-timeouts: FAILED" : "\nchat-timeouts: OK");
  process.exit(failed ? 1 : 0);
})();
