#!/usr/bin/env node
// Real-model validation of the bounded chat queue (Step 9.9c, docs/roadmap/STEP9_9_SCHEDULING.md), opt-in only.
//
// Runs in the native-runtime job after the first launch has stopped: it starts its OWN studio servers from this
// checkout with the queue switched on in their environment only (nothing is written to the install's settings
// except a temporary scheduler.json for the rollback check, removed afterwards), loads the pinned Qwen2.5 0.5B
// Q4_K_M model with real llama.cpp on the CPU, and checks the queue's behaviour from outside, through the app API
// and the engine's own /metrics. The queue stays off by default; this script never changes that.
//
//   node scripts/ci/chat-queue-validate.cjs --model qwen2.5-0.5b-instruct-q4_k_m.gguf --results out.jsonl
//
// Statuses: PASS / FAIL (fails the step) / EXPECTED (documented behaviour that is recorded, not judged, such as
// which error a waiting request gets after an engine crash) / UNSUPPORTED (a capability the queue doesn't have
// yet; recorded so it is never mistaken for a pass) / SKIP (the engine didn't expose what a check needs).
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
const RESULTS = arg("results", path.join(ROOT, "ci-logs", "chat-queue-results.jsonl"));
const LOGDIR = arg("logs", path.join(ROOT, "ci-logs"));
const PORT = Number(arg("port", "14920"));
const WIN = process.platform === "win32";
const NODE = [path.join(APP, "tools", "node-win", "node.exe"), path.join(APP, "tools", "node-linux", "bin", "node"), path.join(APP, "tools", "node-mac", "bin", "node")]
  .find((p) => fs.existsSync(p)) || process.execPath;

fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
fs.mkdirSync(LOGDIR, { recursive: true });
fs.writeFileSync(RESULTS, "");
let failed = false;
function record(check, status, detail) {
  const d = String(detail).replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 400);
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

// ── HTTP: every request on its own connection (agent: false), so a socket left open would be ours to see ────────
function call(port, method, p, body, { timeoutMs = 600000 } = {}) {
  let req;
  let markFirst;
  const first = new Promise((r) => { markFirst = r; });
  const t0 = Date.now();
  const promise = new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; markFirst(null); resolve({ ...v, ms: Date.now() - t0, at: Date.now() }); } };
    const data = body === undefined ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    req = http.request({ host: "127.0.0.1", port, path: p, method, agent: false, timeout: timeoutMs,
      headers: data ? { "content-type": "application/json", "content-length": data.length } : {} }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { text += c; if (/"content":"[^"]/.test(text)) markFirst(Date.now()); });
      res.on("end", () => done({ status: res.statusCode, headers: res.headers, text, ended: true }));
      res.on("close", () => done({ status: res.statusCode, headers: res.headers, text, ended: false }));
      res.on("error", () => done({ status: res.statusCode, headers: res.headers, text, ended: false }));
    });
    req.on("timeout", () => req.destroy(new Error("client timeout")));
    req.on("error", (e) => done({ status: 0, headers: {}, text: "", ended: false, error: e.code || e.message }));
    if (data) req.write(data);
    req.end();
  });
  return { promise, first, abort: () => req && req.destroy() };
}
const getJson = async (port, p) => { const r = await call(port, "GET", p, undefined, { timeoutMs: 10000 }).promise; try { return { status: r.status, json: JSON.parse(r.text) }; } catch (_) { return { status: r.status, json: null }; } };
const parseJson = (t) => { try { return JSON.parse(t); } catch (_) { return null; } };
function sse(text) {
  const events = String(text || "").split("\n\n").filter(Boolean);
  const data = events.filter((e) => e.startsWith("data: {")).map((e) => parseJson(e.slice(6))).filter(Boolean);
  return {
    content: data.map((d) => d.choices?.[0]?.delta?.content || "").join(""),
    pieces: data.filter((d) => d.choices?.[0]?.delta?.content).length,
    finish: data.some((d) => d.choices?.[0]?.finish_reason),
    done: events.at(-1) === "data: [DONE]",
  };
}

// --fake: a local dry run of this script's mechanics against the contract-test fake engine (never used in CI).
const FAKE = process.argv.includes("--fake");
// Counting keeps a small model generating until max_tokens (a story can end early), so the queue stays held.
const LONG = { messages: [{ role: "user", content: `Count from 1 to 3000. Write each number on its own line and nothing else.${FAKE ? " MODE:slow" : ""}` }], max_tokens: 1024, temperature: 0, stream: true };
const SHORT = (i, extra = {}) => ({ messages: [{ role: "user", content: `Reply with exactly one word: ok${i}` }], max_tokens: 8, temperature: 0, stream: false, ...extra });

// ── Processes ─────────────────────────────────────────────────────────────────────────────────────────────
// Only the engine this script's own server started is ever touched: found by the port it listens on, never by
// process name (other llama-server processes on the machine are left alone).
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
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
function killEngineHard(enginePids) {
  for (const pid of enginePids) {
    if (WIN) spawnSync("taskkill", ["/PID", String(pid), "/F"]);
    else { try { process.kill(pid, "SIGKILL"); } catch (_) { /* gone */ } }
  }
}
function rssMb(pid) {
  try {
    if (WIN) {
      const r = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`], { encoding: "utf8" });
      return Math.round(Number(r.stdout.trim()) / 1048576);
    }
    const r = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
    return Math.round(Number(r.stdout.trim()) / 1024);
  } catch (_) { return NaN; }
}

async function startServer(label, env) {
  const log = fs.openSync(path.join(LOGDIR, `chat-queue-${label}.log`), "w");
  const child = spawn(NODE, [SERVE], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), FRONTEND_PORT: String(PORT), ...env }, stdio: ["ignore", log, log], windowsHide: true });
  const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal, at: Date.now() })));
  const up = await waitUntil(async () => (await getJson(PORT, "/api/health")).status === 200, 60000, 500);
  if (!up) throw new Error(`server ${label} did not start (see chat-queue-${label}.log)`);
  const start = await call(PORT, "POST", "/api/llm/start", { model: MODEL, contextSize: 2048, gpuLayers: 0 }).promise;
  if (start.status !== 200) throw new Error(`model start ${start.status}: ${start.text.slice(0, 200)}`);
  const ready = await waitUntil(async () => (await getJson(PORT, "/api/llm/status")).json?.ready === true, 240000, 1000);
  if (!ready) throw new Error("model did not become ready");
  const enginePort = (await getJson(PORT, "/api/llm/status")).json.port;
  const enginePids = listenerPids(enginePort).filter((pid) => pid !== child.pid);
  if (!enginePids.length) throw new Error(`no engine process found listening on port ${enginePort}`);
  return { label, child, exited, enginePort, enginePids };
}
async function stopServer(srv) {
  if (!srv || srv.child.exitCode !== null || srv.child.signalCode !== null) return;
  await call(PORT, "POST", "/api/llm/stop", {}, { timeoutMs: 30000 }).promise;
  srv.child.kill("SIGTERM");
  const r = await Promise.race([srv.exited, sleep(20000).then(() => null)]);
  if (!r) { try { srv.child.kill("SIGKILL"); } catch (_) { /* gone */ } await srv.exited; }
  await waitUntil(async () => !(await portOpen(PORT)), 15000, 250);
}

const chatStats = async () => {
  const r = await getJson(PORT, "/api/resources");
  const c = r.json?.engines?.text?.chat;
  return c ? { running: c.active, waiting: c.waitingForEngineConnection } : null;
};
const idle = async (ms = 30000) => waitUntil(async () => { const s = await chatStats(); return s && s.running === 0 && s.waiting === 0; }, ms, 200);
async function metrics(enginePort) {
  const r = await call(enginePort, "GET", "/metrics", undefined, { timeoutMs: 5000 }).promise;
  if (r.status !== 200) return null;
  const m = {};
  for (const line of r.text.split("\n")) {
    const x = line.match(/^llamacpp:([a-z_]+)\s+([0-9.eE+-]+)/);
    if (x) m[x[1]] = Number(x[2]);
  }
  return m;
}
const processing = async (enginePort) => { const m = await metrics(enginePort); return m && "requests_processing" in m ? m.requests_processing : null; };

// Start one long streaming request and wait until it is generating, so later requests must queue behind it.
async function holdEngine(t = 60000) {
  const h = call(PORT, "POST", "/api/llm/chat", LONG);
  const first = await Promise.race([h.first, sleep(t).then(() => null)]);
  if (!first) { h.abort(); throw new Error("the long request produced no content"); }
  return h;
}
// Queue one request and wait until the queue shows it waiting.
async function enqueue(body, expectWaiting) {
  const r = call(PORT, "POST", "/api/llm/chat", body);
  const ok = await waitUntil(async () => (await chatStats())?.waiting === expectWaiting, 10000, 50);
  if (!ok) throw new Error(`queue did not reach ${expectWaiting} waiting`);
  return r;
}
// Two streams one after the other (the second starts right after the first ends, as a user's next message does).
async function consecutiveStreams(label) {
  const out = [];
  for (let i = 0; i < 3; i++) {
    const r = await call(PORT, "POST", "/api/llm/chat", { messages: [{ role: "user", content: `Count from 1 to ${5 + i}, separated by spaces.` }], max_tokens: 24, temperature: 0, stream: true }).promise;
    out.push({ status: r.status, ...sse(r.text) });
  }
  record(`${label}: consecutive streams all complete`, out.every((o) => o.status === 200 && o.done && o.pieces >= 2) ? "PASS" : "FAIL",
    out.map((o, i) => `stream ${i + 1}: ${o.status}, ${o.pieces} pieces, done ${o.done}`).join("; "));
}
const validRetryAfter = (r) => {
  const h = Number(r.headers?.["retry-after"]);
  const b = parseJson(r.text)?.retryAfterSeconds;
  return Number.isInteger(h) && h >= 1 && h <= 120 && h === b;
};

async function scenario(name, fn) {
  try { await fn(); } catch (err) { record(name, "FAIL", err.message); }
}

// ── Scenarios ───────────────────────────────────────────────────────────────────────────────────────────
async function queueOnScenarios(srv) {
  const res = await getJson(PORT, "/api/resources");
  record("queue on (environment only): /api/resources", res.json?.limits?.chatQueue === "on" && res.json?.scheduler?.mode === "chat-queue" ? "PASS" : "FAIL",
    `limits.chatQueue=${res.json?.limits?.chatQueue}, scheduler.mode=${res.json?.scheduler?.mode}`);

  await scenario("capacity, FIFO, QUEUE_FULL", async () => {
    const hold = await holdEngine();
    const waiters = [];
    for (let i = 1; i <= 4; i++) waiters.push(await enqueue(SHORT(i), i));
    const stats = await chatStats();
    const full = await call(PORT, "POST", "/api/llm/chat", SHORT(5)).promise;
    const fullBody = parseJson(full.text) || {};
    record("capacity: 1 running + 4 waiting", stats.running === 1 && stats.waiting === 4 ? "PASS" : "FAIL", `running ${stats.running}, waiting ${stats.waiting}`);
    record("429 QUEUE_FULL with Retry-After", full.status === 429 && fullBody.code === "QUEUE_FULL" && validRetryAfter(full) && full.ms < 2000 ? "PASS" : "FAIL",
      `status ${full.status}, code ${fullBody.code}, Retry-After ${full.headers?.["retry-after"]} (body ${fullBody.retryAfterSeconds}), answered in ${full.ms} ms`);
    hold.abort();
    const done = await Promise.all(waiters.map((w) => w.promise));
    const order = done.map((d, i) => ({ i: i + 1, at: d.at, ok: d.status === 200 })).sort((a, b) => a.at - b.at).map((x) => x.i);
    record("FIFO: waiting requests run in arrival order", done.every((d) => d.status === 200) && order.join() === "1,2,3,4" ? "PASS" : "FAIL",
      `completion order ${order.join(",")}, statuses ${done.map((d) => d.status).join(",")}`);
    record("queue slots released after a full queue", (await idle()) ? "PASS" : "FAIL", JSON.stringify(await chatStats()));
  });

  await scenario("running-request cancellation", async () => {
    const m0 = await metrics(srv.enginePort);
    const hold = await holdEngine();
    hold.abort();
    const t = Date.now();
    const freed = await idle(10000);
    const proc0 = await waitUntil(async () => (await processing(srv.enginePort)) === 0, 10000, 100);
    const m1 = await metrics(srv.enginePort);
    await sleep(2000);
    const m2 = await metrics(srv.enginePort);
    if (!m0 || !("requests_processing" in (m1 || {}))) {
      record("running cancellation stops the engine request", "SKIP", "the engine did not expose /metrics requests_processing");
    } else {
      const grew = (m2.tokens_predicted_total ?? 0) - (m1.tokens_predicted_total ?? 0);
      record("running cancellation stops the engine request", freed && proc0 && grew === 0 ? "PASS" : "FAIL",
        `queue idle ${Boolean(freed)}, engine requests_processing 0 ${proc0 ? `after ${Date.now() - t} ms` : "not reached"}, tokens predicted in the 2 s after: ${grew}`);
    }
    const next = await call(PORT, "POST", "/api/llm/chat", SHORT(6)).promise;
    record("next request after a cancelled running one", next.status === 200 && next.ms < 30000 ? "PASS" : "FAIL", `status ${next.status} in ${next.ms} ms`);
  });

  await scenario("waiting-request cancellation", async () => {
    const hold = await holdEngine();
    const big = { messages: [{ role: "user", content: "lighthouse ".repeat(700) + "\nSummarize." }], max_tokens: 8, temperature: 0, stream: false };
    const m0 = await metrics(srv.enginePort);
    const w = await enqueue(big, 1);
    w.abort();
    const gone = await waitUntil(async () => (await chatStats())?.waiting === 0, 3000, 50);
    hold.abort();
    await idle(10000);
    await sleep(2000);
    const m1 = await metrics(srv.enginePort);
    const prompt = m0 && m1 && "prompt_tokens_total" in m1 ? m1.prompt_tokens_total - m0.prompt_tokens_total : null;
    record("waiting cancellation: leaves the queue at once", gone ? "PASS" : "FAIL", `waiting 0 ${gone ? "within 3 s" : "not reached"}`);
    if (prompt === null) record("waiting cancellation: never reaches the engine", "SKIP", "the engine did not expose prompt_tokens_total");
    else record("waiting cancellation: never reaches the engine", prompt < 500 ? "PASS" : "FAIL", `engine prompt tokens during the test: ${prompt} (the cancelled ~1,400-token prompt would add ≥ 1,000)`);
  });

  await scenario("streaming through the queue", async () => {
    const a = call(PORT, "POST", "/api/llm/chat", { ...LONG, max_tokens: 64 });
    await a.first;
    const b = call(PORT, "POST", "/api/llm/chat", { messages: [{ role: "user", content: "Count from 1 to 10, separated by spaces." }], max_tokens: 48, temperature: 0, stream: true });
    const [ra, rb] = await Promise.all([a.promise, b.promise]);
    const sa = sse(ra.text); const sb = sse(rb.text);
    const bFirst = await b.first;
    const serial = bFirst !== null && bFirst >= ra.at - 50;
    const ok = [ra, rb].every((r) => r.status === 200 && /text\/event-stream/.test(r.headers["content-type"] || "")) && sa.done && sb.done && sa.finish && sb.finish && sa.pieces >= 2 && sb.pieces >= 2;
    record("streaming: complete SSE streams with finish and [DONE]", ok ? "PASS" : "FAIL", `A ${ra.status} ${sa.pieces} pieces done ${sa.done}; B ${rb.status} ${sb.pieces} pieces done ${sb.done}: ${JSON.stringify((sb.pieces ? sb.content : rb.text).slice(0, 80))}`);
    record("streaming: the second stream starts after the first ends", serial ? "PASS" : "FAIL", `B first content ${bFirst ? bFirst - ra.at : "none"} ms after A ended`);
    record("queue slots released after streams", (await idle()) ? "PASS" : "FAIL", JSON.stringify(await chatStats()));
  });

  await scenario("consecutive streams (queue on)", async () => { await consecutiveStreams("queue on"); });

  await scenario("recovery after failed requests", async () => {
    const hold = await holdEngine();
    // A prompt longer than the 2048-token context: the engine refuses it when its turn comes.
    const tooLong = FAKE ? "MODE:http-error" : "lighthouse storm ".repeat(1600);
    const bad = await enqueue({ messages: [{ role: "user", content: tooLong }], max_tokens: 8, stream: false }, 1);
    const good = await enqueue(SHORT(7), 2);
    hold.abort();
    const [rb, rg] = await Promise.all([bad.promise, good.promise]);
    const clean = await idle();
    const detail = `failed request ${rb.status} ${rb.text.slice(0, 80)}; next ${rg.status}; queue idle ${Boolean(clean)}`;
    if (rb.status === 200) record("recovery: a failed request doesn't block the next one", "SKIP", `the engine accepted the over-long prompt, so nothing failed: ${detail}`);
    else record("recovery: a failed request doesn't block the next one", rg.status === 200 && clean ? "PASS" : "FAIL", detail);
  });

  await scenario("leaks and memory", async () => {
    const pid = srv.child.pid;
    const before = rssMb(pid);
    for (let round = 0; round < 5; round++) {
      const hold = await holdEngine();
      const ws = [];
      for (let i = 1; i <= 4; i++) ws.push(await enqueue({ messages: [{ role: "user", content: "x".repeat(2 * 1024 * 1024) }], max_tokens: 1, stream: false }, i));
      const full = await call(PORT, "POST", "/api/llm/chat", SHORT(9)).promise;
      if (full.status !== 429) throw new Error(`round ${round}: expected 429, got ${full.status}`);
      ws.forEach((w) => w.abort());
      await waitUntil(async () => (await chatStats())?.waiting === 0, 5000, 50);
      hold.abort();
      if (!(await idle(15000))) throw new Error(`round ${round}: queue slots not released`);
    }
    await sleep(2000);
    const after = rssMb(pid);
    const proc = await processing(srv.enginePort);
    record("no leaked queue slots after 5 rounds (20 cancelled waiting requests)", "PASS", JSON.stringify(await chatStats()));
    record("engine idle after cancellations", proc === null ? "SKIP" : proc === 0 ? "PASS" : "FAIL", `requests_processing ${proc}`);
    const growth = after - before;
    record("server memory after 20 waiting 2 MB requests were cancelled", Number.isFinite(growth) ? (growth < 150 ? "PASS" : "FAIL") : "SKIP",
      `RSS ${before} MB before, ${after} MB after (+${growth} MB; limit +150 MB)`);
    record("memory-pressure admission", "UNSUPPORTED", "the queue doesn't check free memory; waiting requests are bounded only by count (4) and the 64 MB body limit. Step 9.9d's warn-only memory check (implemented) only reports at model load; enforced memory-aware admission is Step 9.9f, not implemented");
  });

  await scenario("engine crash while requests wait", async () => {
    const hold = call(PORT, "POST", "/api/llm/chat", LONG);
    await hold.first;
    const w1 = await enqueue(SHORT(11), 1);
    const w2 = await enqueue(SHORT(12), 2);
    const t = Date.now();
    const killed = srv.enginePids.slice();
    killEngineHard(killed);
    const [rh, r1, r2] = await Promise.all([hold.promise, w1.promise, w2.promise].map((p) => Promise.race([p, sleep(120000).then(() => ({ status: "timeout" }))])));
    const settled = [rh, r1, r2].every((r) => r.status !== "timeout");
    const streamCut = rh.status === 200 && !sse(rh.text).done;
    record("crash: running stream ends without [DONE]", streamCut ? "PASS" : "FAIL", `status ${rh.status}, ended ${rh.ended}, done ${sse(rh.text).done}`);
    record("crash: waiting requests are answered", settled ? "PASS" : "FAIL", `answered within ${Math.round((Date.now() - t) / 1000)} s`);
    const codes = [r1, r2].map((r) => `${r.status}${parseJson(r.text)?.code ? ` ${parseJson(r.text).code}` : ""}`);
    record("crash: what waiting requests get", "EXPECTED", `${codes.join(", ")} (409 ENGINE_NOT_READY when the engine is down at their turn, an engine error, or 200 after a restart)`);
    // Ready again means a NEW engine process is listening (the status can still say ready for a moment after a kill).
    const back = await waitUntil(async () => {
      const st = (await getJson(PORT, "/api/llm/status")).json;
      if (st?.ready !== true) return false;
      const pids = listenerPids(st.port).filter((pid) => pid !== srv.child.pid);
      return pids.length > 0 && pids.every((pid) => !killed.includes(pid));
    }, 180000, 500);
    record("crash: the engine is restarted by the supervisor", back ? "PASS" : "FAIL", back ? `ready again after ${Math.round((Date.now() - t) / 1000)} s` : "not ready after 180 s");
    if (back) {
      srv.enginePort = (await getJson(PORT, "/api/llm/status")).json.port;
      srv.enginePids = listenerPids(srv.enginePort).filter((pid) => pid !== srv.child.pid);
      record("crash: no leaked engine process (old one gone, one engine listening)", killed.every((pid) => !alive(pid)) && srv.enginePids.length === 1 ? "PASS" : "FAIL",
        `killed ${killed.join(",")} alive ${killed.filter(alive).join(",") || "none"}; listening now ${srv.enginePids.join(",")}`);
    }
    const after = await call(PORT, "POST", "/api/llm/chat", SHORT(13)).promise;
    const clean = await idle();
    record("crash: chat and queue work again", after.status === 200 && clean ? "PASS" : "FAIL", `status ${after.status}; queue idle ${Boolean(clean)}`);
  });

  record("timeout for a running request", "UNSUPPORTED", "no engine-side stream timeout: a running request holds the queue until it ends or is cancelled (tracked in STEP9_9_SCHEDULING.md)");
}

async function shutdownScenario(srv) {
  await scenario("shutdown with queued requests", async () => {
    const hold = call(PORT, "POST", "/api/llm/chat", LONG);
    await hold.first;
    const ws = [];
    for (let i = 1; i <= 3; i++) ws.push(await enqueue(SHORT(20 + i), i));
    const t = Date.now();
    srv.child.kill("SIGTERM"); // Windows: TerminateProcess (no signals); the engine guard must still stop llama-server
    const exit = await Promise.race([srv.exited, sleep(30000).then(() => null)]);
    const all = await Promise.all([hold, ...ws].map((r) => Promise.race([r.promise, sleep(30000).then(() => ({ status: "timeout" }))])));
    const settled = all.every((r) => r.status !== "timeout");
    const engineGone = await waitUntil(async () => srv.enginePids.every((pid) => !alive(pid)) && !(await portOpen(srv.enginePort)), 30000, 500);
    const portFree = await waitUntil(async () => !(await portOpen(PORT)), 15000, 250);
    record("shutdown: server exits with requests queued", exit ? "PASS" : "FAIL", exit ? `exited in ${exit.at - t} ms (${WIN ? "hard stop: Windows has no SIGTERM" : `code ${exit.code}, signal ${exit.signal}`})` : "still running after 30 s");
    record("shutdown: every client gets an answer or a closed connection", settled ? "PASS" : "FAIL", all.map((r) => (r.status === 0 ? `closed(${r.error})` : `${r.status}`)).join(", "));
    record("shutdown: no engine process or port left", engineGone && portFree ? "PASS" : "FAIL", `engine pids ${srv.enginePids.join(",")} alive ${srv.enginePids.filter(alive).join(",") || "none"}, engine port ${srv.enginePort} open ${await portOpen(srv.enginePort)}, app port open ${await portOpen(PORT)}`);
  });
}

async function timeoutScenario() {
  const srv = await startServer("timeout", { USAP_CHAT_QUEUE: "on", USAP_CHAT_QUEUE_MAX_WAIT_MS: "3000" });
  try {
    await scenario("queue timeout", async () => {
      const hold = await holdEngine();
      const t = Date.now();
      const w = await call(PORT, "POST", "/api/llm/chat", SHORT(30)).promise;
      const body = parseJson(w.text) || {};
      const waited = Date.now() - t;
      const holdStill = (await chatStats())?.running === 1;
      record("503 QUEUE_TIMEOUT after the configured wait", w.status === 503 && body.code === "QUEUE_TIMEOUT" && validRetryAfter(w) && waited >= 2900 && waited < 10000 && holdStill ? "PASS" : "FAIL",
        `status ${w.status}, code ${body.code}, after ${waited} ms (limit 3000), Retry-After ${w.headers?.["retry-after"]}, running request kept ${holdStill}`);
      hold.abort();
      const clean = await idle();
      const next = await call(PORT, "POST", "/api/llm/chat", SHORT(31)).promise;
      record("after a timeout the queue is free", clean && next.status === 200 ? "PASS" : "FAIL", `idle ${Boolean(clean)}, next ${next.status}`);
    });
  } finally { await stopServer(srv); }
}

async function rollbackScenario(label, env, expectResources, writeConfig) {
  const cfgDir = path.join(APP, "config");
  const cfg = path.join(cfgDir, "scheduler.json");
  const existed = fs.existsSync(cfg) ? fs.readFileSync(cfg) : null;
  if (writeConfig) { fs.mkdirSync(cfgDir, { recursive: true }); fs.writeFileSync(cfg, JSON.stringify(writeConfig)); }
  let srv;
  try {
    srv = await startServer(label, env);
    const res = await getJson(PORT, "/api/resources");
    const burst = await Promise.all(Array.from({ length: 7 }, (_, i) => call(PORT, "POST", "/api/llm/chat", SHORT(40 + i, { max_tokens: 4 })).promise));
    const statuses = burst.map((r) => r.status);
    const resOk = expectResources === 404 ? res.status === 404 : res.status === 200 && res.json?.limits?.chatQueue === "off";
    await consecutiveStreams(`queue off (${label})`);
    // Two simultaneous streams with the queue off (the behaviour before 9.9c), to tell queue bugs from older ones.
    const s1 = call(PORT, "POST", "/api/llm/chat", { ...LONG, max_tokens: 48 });
    await s1.first;
    const s2 = call(PORT, "POST", "/api/llm/chat", { messages: [{ role: "user", content: "Count from 1 to 10, separated by spaces." }], max_tokens: 32, temperature: 0, stream: true });
    const [r1, r2] = await Promise.all([s1.promise, s2.promise]);
    const both = [r1, r2].map((r) => ({ status: r.status, ...sse(r.text) }));
    record(`queue off (${label}): two overlapping streams both complete`, both.every((b) => b.status === 200 && b.done && b.pieces >= 2) ? "PASS" : "FAIL",
      both.map((b, i) => `stream ${i + 1}: ${b.status}, ${b.pieces} pieces, done ${b.done}`).join("; "));
    record(`rollback (${label}): queue off, nothing refused`, resOk && statuses.every((s) => s === 200) ? "PASS" : "FAIL",
      `/api/resources ${res.status}${res.json?.limits ? ` chatQueue=${res.json.limits.chatQueue}` : ""}; 7 simultaneous requests: ${statuses.join(",")}`);
  } catch (err) {
    record(`rollback (${label}): queue off, nothing refused`, "FAIL", err.message);
  } finally {
    await stopServer(srv);
    if (writeConfig) { if (existed) fs.writeFileSync(cfg, existed); else fs.rmSync(cfg, { force: true }); }
  }
}

(async () => {
  console.log(`\n### Chat queue with a real model (queue switched on for these test servers only; default stays off)\n`);
  console.log(`node ${process.version} (server: ${NODE.startsWith(ROOT) ? path.relative(ROOT, NODE) : "this node"}), model ${MODEL}\n`);
  console.log("| Check | Status | Detail |\n|---|---|---|");
  if (!fs.existsSync(path.join(APP, "llm-models", MODEL))) { record("chat queue validation", "FAIL", `model ${MODEL} is not installed`); process.exit(1); }
  if (await portOpen(PORT)) { record("chat queue validation", "FAIL", `port ${PORT} is already in use`); process.exit(1); }
  let srv;
  try {
    srv = await startServer("on", { USAP_CHAT_QUEUE: "on" });
    await queueOnScenarios(srv);
    await shutdownScenario(srv);
  } catch (err) {
    record("chat queue validation (queue on)", "FAIL", err.message);
  } finally {
    await stopServer(srv).catch(() => {});
    if (srv) killEngineHard(srv.enginePids.filter(alive)); // only if the checks above already failed to stop it
  }
  try { await timeoutScenario(); } catch (err) { record("queue timeout", "FAIL", err.message); }
  await rollbackScenario("USAP_SCHEDULER=off", { USAP_CHAT_QUEUE: "on", USAP_SCHEDULER: "off" }, 404, null);
  await rollbackScenario("USAP_CHAT_QUEUE=off over scheduler.json on", { USAP_CHAT_QUEUE: "off" }, 200, { chatQueue: "on" });
  console.log(failed ? "\nChat queue validation: FAILED\n" : "\nChat queue validation: all checks passed (UNSUPPORTED/EXPECTED rows are recorded, not judged)\n");
  process.exit(failed ? 1 : 0);
})();
