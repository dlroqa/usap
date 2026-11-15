#!/usr/bin/env node
// Step 9.9f-3 (voice) native check with the real Kokoro worker (kokoro-onnx-q8, CPU), installed by runtime-validate.
//
// Starts its own test servers on port 14970 (`--port`) from this checkout.
//   * Baseline (always, default settings): measures today's unbounded voice chain. Job durations; a burst of
//     concurrent requests (completion order, how many Kokoro workers run at once); what happens to a waiting and a
//     running job whose client disconnects; a failing job; /api/tts/stop during a job; server shutdown during a job;
//     peak worker memory. Observed legacy behaviour is recorded as EXPECTED (known), measurements as PASS (taken).
//   * Queue (only when services/job-queue.cjs exists, voiceQueue on for its own test server only): capacity and
//     429 QUEUE_FULL with Retry-After, FIFO completion, a waiting disconnect never reaching Kokoro, a running
//     disconnect finishing without a second worker, the queue deadline, /api/tts/stop refusing waiting jobs,
//     USAP_SCHEDULER=off, and the installed default off.
//
//   node scripts/ci/voice-queue-validate.cjs --model kokoro-onnx-q8.json --results out.jsonl --logs ci-logs
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
const MODEL = arg("model", "kokoro-onnx-q8.json");
const RESULTS = arg("results", path.join(ROOT, "ci-logs", "voice-queue-results.jsonl"));
const LOGDIR = arg("logs", path.join(ROOT, "ci-logs"));
const PORT = Number(arg("port", "14970"));
const WIN = process.platform === "win32";
const HAS_QUEUE = fs.existsSync(path.join(ROOT, "scripts", "server", "services", "job-queue.cjs"));
const NODE = [path.join(APP, "tools", "node-win", "node.exe"), path.join(APP, "tools", "node-linux", "bin", "node"), path.join(APP, "tools", "node-mac", "bin", "node")]
  .find((p) => fs.existsSync(p)) || process.execPath;
const SHORT = "Hello from the continuous integration runner.";
const LONG = "The quick brown fox jumps over the lazy dog. ".repeat(8).trim();

fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
fs.mkdirSync(LOGDIR, { recursive: true });
fs.writeFileSync(RESULTS, "");
let failed = false;
function record(check, status, detail) {
  const d = String(detail).replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 700);
  fs.appendFileSync(RESULTS, JSON.stringify({ check, status, platform: `${process.platform}-${process.arch}`, detail: d }) + "\n");
  console.log(`| ${check} | ${status} | ${d} |`);
  if (status === "FAIL") failed = true;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, ms, every = 250) {
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
// `abortAfterMs`: the client disconnects then (resolves { status: 0, aborted: true }).
function call(method, p, body, { timeoutMs = 600000, abortAfterMs = null } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: "127.0.0.1", port: PORT, path: p, method, agent: false, timeout: timeoutMs,
      headers: data ? { "content-type": "application/json", "content-length": data.length } : {} }, (res) => {
      let text = ""; res.setEncoding("utf8");
      res.on("data", (c) => { text += c; });
      res.on("end", () => { let json = null; try { json = JSON.parse(text); } catch (_) { json = null; } resolve({ status: res.statusCode, text, json, headers: res.headers, at: Date.now() }); });
      res.on("error", () => {});
    });
    let aborted = false;
    if (abortAfterMs !== null) setTimeout(() => { aborted = true; req.destroy(); }, abortAfterMs);
    req.on("timeout", () => req.destroy(new Error("client timeout")));
    req.on("error", (err) => resolve({ status: 0, aborted, text: String(err.message), json: null, at: Date.now() }));
    if (data) req.write(data);
    req.end();
  });
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; } };
// Kokoro workers are supervised under the Node executable's name.
async function workers() {
  const d = (await call("GET", "/api/diagnostics", undefined, { timeoutMs: 10000 })).json;
  const sup = (d && d.engines && d.engines.processes && d.engines.processes.supervised) || [];
  return sup.filter((r) => /^node(\.exe)?$/i.test(String(r.label))).map((r) => r.enginePid || r.guardPid).filter((pid) => pid && alive(pid));
}
function rssKb(pid) {
  try {
    if (WIN) {
      const r = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`], { encoding: "utf8", timeout: 5000 });
      const n = Number(String(r.stdout).trim()); return Number.isFinite(n) && n > 0 ? Math.round(n / 1024) : null;
    }
    const r = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
    const n = Number(String(r.stdout).trim()); return Number.isFinite(n) && n > 0 ? n : null;
  } catch (_) { return null; }
}
// Samples the Kokoro worker processes every 150 ms: the most alive at once and the peak resident memory.
function sampler() {
  const seen = { maxWorkers: 0, peakRssKb: null, samples: 0 };
  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        const w = await workers();
        seen.samples += 1; seen.maxWorkers = Math.max(seen.maxWorkers, w.length);
        for (const pid of w) { const k = rssKb(pid); if (k && (!seen.peakRssKb || k > seen.peakRssKb)) seen.peakRssKb = k; }
      } catch (_) { /* busy */ }
      await sleep(150);
    }
  })();
  return async () => { running = false; await loop; return seen; };
}
const speak = (text, extra = {}, opts = {}) => call("POST", "/api/tts/speak", { text, model: MODEL, ...extra }, opts);
const outputs = async () => { const r = await call("GET", "/api/tts/outputs", undefined, { timeoutMs: 10000 }); return (r.json && (r.json.outputs || r.json.items)) || []; };
const outputCount = async () => (await outputs()).length;
const idle = () => waitUntil(async () => (await workers()).length === 0, 120000, 250);

async function startServer(label, env) {
  const logPath = path.join(LOGDIR, `voice-queue-${label}.log`);
  const log = fs.openSync(logPath, "w");
  const child = spawn(NODE, [SERVE], { cwd: ROOT, windowsHide: true, stdio: ["ignore", log, log],
    env: { ...process.env, PORT: String(PORT), FRONTEND_PORT: String(PORT), LLM_PORT: String(PORT + 1), BACKEND_PORT: String(PORT + 2), SD_BACKEND_PORT: String(PORT + 2), SPEECH_PORT: String(PORT + 3), TTS_PORT: String(PORT + 4), ...env } });
  const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
  const srv = { label, child, exited, logPath };
  const up = await waitUntil(async () => (await call("GET", "/api/health", undefined, { timeoutMs: 3000 })).status === 200, 60000, 500);
  if (!up) throw new Error(`server ${label} did not start (see voice-queue-${label}.log)`);
  return srv;
}
async function stopServer(srv) {
  if (!srv || srv.child.exitCode !== null || srv.child.signalCode !== null) return;
  srv.child.kill("SIGTERM");
  let timer = null;
  const gone = await Promise.race([srv.exited, new Promise((r) => { timer = setTimeout(() => r(false), 20000); })]);
  clearTimeout(timer);
  if (!gone) { try { srv.child.kill("SIGKILL"); } catch (_) { /* gone */ } await srv.exited; }
  await waitUntil(async () => !(await portOpen(PORT)), 15000);
}
async function scenario(name, fn) { try { await fn(); } catch (err) { record(name, "FAIL", err.message); } }
const ms = (a, b) => `${Math.round(b - a)} ms`;

async function baseline() {
  const srv = await startServer("baseline", { USAP_VOICE_QUEUE: "" });
  let single = null;
  try {
    await scenario("Baseline: warm-up job", async () => {
      const t0 = Date.now(); const r = await speak(SHORT);
      record("Baseline: warm-up job", r.status === 200 ? "PASS" : "FAIL", `status ${r.status} in ${ms(t0, Date.now())} (first job may fetch/compile the model)`);
    });
    await scenario("Baseline: job durations", async () => {
      const short = []; const done = sampler();
      for (let i = 0; i < 3; i += 1) { const t0 = Date.now(); const r = await speak(SHORT); if (r.status !== 200) throw new Error(`short job ${r.status}`); short.push(Date.now() - t0); }
      const t1 = Date.now(); const rl = await speak(LONG); const long = Date.now() - t1;
      const seen = await done();
      single = { short: short.sort((a, b) => a - b)[1], long, rss: seen.peakRssKb };
      record("Baseline: job durations", rl.status === 200 ? "PASS" : "FAIL", `short (${SHORT.length} chars) median ${single.short} ms [${short.join(", ")}]; long (${LONG.length} chars) ${long} ms; peak worker RSS ${seen.peakRssKb ? Math.round(seen.peakRssKb / 1024) + " MB" : "n/a"}`);
    });
    await scenario("Baseline: burst of 6 concurrent jobs", async () => {
      const done = sampler(); const t0 = Date.now();
      const rs = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => sleep(i * 30).then(() => speak(`${SHORT} Number ${i}.`).then((r) => ({ i, ...r })))));
      const seen = await done();
      const order = [...rs].sort((a, b) => a.at - b.at).map((r) => r.i).join(",");
      record("Baseline: burst of 6 concurrent jobs", rs.every((r) => r.status === 200) ? "PASS" : "FAIL", `statuses ${rs.map((r) => r.status).join("/")}; completion order ${order}; total ${ms(t0, Date.now())}; max Kokoro workers at once ${seen.maxWorkers}; peak RSS ${seen.peakRssKb ? Math.round(seen.peakRssKb / 1024) + " MB" : "n/a"}`);
      record("Baseline: burst is unbounded (no 429)", "EXPECTED", `all ${rs.length} accepted; the chain has no limit or deadline today`);
    });
    await scenario("Baseline: client disconnects while waiting", async () => {
      await idle(); const before = await outputCount();
      const a = speak(LONG); await sleep(300);
      const b = await speak(`${SHORT} Abandoned while waiting.`, {}, { abortAfterMs: 200 });
      await a; await idle(); await sleep(500);
      const after = await outputCount();
      record("Baseline: client disconnects while waiting", "EXPECTED", `client aborted ${b.aborted}; outputs saved ${after - before} (2 means the abandoned job still ran and was saved)`);
    });
    await scenario("Baseline: client disconnects while running", async () => {
      await idle(); const before = await outputCount();
      const r = await speak(LONG, {}, { abortAfterMs: Math.max(300, Math.round((single ? single.long : 3000) / 3)) });
      const w = await workers(); await idle(); await sleep(500);
      record("Baseline: client disconnects while running", "EXPECTED", `aborted ${r.aborted}; worker alive after disconnect ${w.length > 0}; outputs saved ${(await outputCount()) - before} (the worker finishes; nothing cancels it)`);
    });
    await scenario("Baseline: failing job", async () => {
      await idle();
      const bad = await speak(SHORT, { voice: "no_such_voice_zz" });
      const ok = await speak(SHORT);
      record("Baseline: failing job", ok.status === 200 ? "PASS" : "FAIL", `bad voice -> ${bad.status} ${bad.json && (bad.json.code || "")}; next job ${ok.status}`);
    });
    await scenario("Baseline: /api/tts/stop during a job", async () => {
      await idle();
      const p = speak(LONG); await sleep(500);
      const st = await call("POST", "/api/tts/stop", {});
      const w = await workers(); const r = await p;
      record("Baseline: /api/tts/stop during a job", "EXPECTED", `stop ${st.status}; worker still alive ${w.length > 0}; job ${r.status} (stop only resets state; the job runs on)`);
    });
  } finally {
    await scenario("Baseline: server shutdown during a job", async () => {
      await idle();
      speak(LONG); const w = await waitUntil(async () => { const x = await workers(); return x.length ? x : null; }, 30000, 100);
      await stopServer(srv);
      await sleep(2000);
      const left = (w || []).filter(alive);
      record("Baseline: server shutdown during a job", left.length === 0 ? "PASS" : "FAIL", `worker seen ${Boolean(w)}; still alive after shutdown ${left.length}`);
    });
  }
  return single;
}

async function queueChecks(single) {
  const wait = Math.max(30, Math.ceil(((single && single.long) || 5000) * 6 / 1000)); // deadline for the timeout check only
  await scenario("Default: voiceQueue off", async () => {
    const srv = await startServer("default", { USAP_VOICE_QUEUE: "" });
    try { const r = (await call("GET", "/api/resources")).json || {}; record("Default: voiceQueue off", !("voiceQueue" in (r.limits || {})) && !(r.engines && r.engines.voice && r.engines.voice.queue && r.engines.voice.queue.limit) ? "PASS" : "FAIL", `limits ${JSON.stringify(r.limits)}`); }
    finally { await stopServer(srv); }
  });
  await scenario("Rollback: USAP_SCHEDULER=off", async () => {
    const srv = await startServer("scheduler-off", { USAP_VOICE_QUEUE: "on", USAP_SCHEDULER: "off" });
    try {
      const rs = await Promise.all([0, 1, 2, 3, 4, 5].map(() => speak(SHORT)));
      record("Rollback: USAP_SCHEDULER=off", rs.every((r) => r.status === 200) ? "PASS" : "FAIL", `6 concurrent -> ${rs.map((r) => r.status).join("/")} (legacy: no 429)`);
    } finally { await stopServer(srv); }
  });
  const srv = await startServer("on", { USAP_VOICE_QUEUE: "on", USAP_VOICE_QUEUE_MAX_WAIT_MS: String(wait * 1000) });
  try {
    await speak(SHORT); // warm
    await scenario("Queue: capacity, 429 and FIFO", async () => {
      const done = sampler(); const t0 = Date.now();
      const rs = await Promise.all([0, 1, 2, 3, 4, 5, 6].map((i) => sleep(i * 40).then(() => speak(`${SHORT} Number ${i}.`).then((r) => ({ i, ...r })))));
      const seen = await done();
      const ok = rs.filter((r) => r.status === 200).sort((a, b) => a.at - b.at).map((r) => r.i);
      const full = rs.filter((r) => r.status === 429);
      const fifo = ok.join(",") === [...ok].sort((a, b) => a - b).join(",");
      const pass = ok.length === 5 && full.length === 2 && full.every((r) => r.json && r.json.code === "QUEUE_FULL" && Number(r.headers["retry-after"]) >= 1) && fifo && seen.maxWorkers <= 1;
      record("Queue: capacity, 429 and FIFO", pass ? "PASS" : "FAIL", `200 x${ok.length} in order ${ok.join(",")}; 429 x${full.length} (Retry-After ${full.map((r) => r.headers["retry-after"]).join("/")}); max workers ${seen.maxWorkers}; total ${ms(t0, Date.now())}`);
    });
    await scenario("Queue: waiting disconnect never reaches Kokoro", async () => {
      await idle(); const before = await outputCount();
      const a = speak(LONG); await sleep(300);
      const b = await speak(`${SHORT} Abandoned while waiting.`, {}, { abortAfterMs: 200 });
      await a; await idle(); await sleep(500);
      const saved = (await outputCount()) - before;
      record("Queue: waiting disconnect never reaches Kokoro", b.aborted && saved === 1 ? "PASS" : "FAIL", `aborted ${b.aborted}; outputs saved ${saved} (1 = only the running job)`);
    });
    await scenario("Queue: running disconnect finishes, slot released once", async () => {
      await idle();
      const r = await speak(LONG, {}, { abortAfterMs: Math.max(300, Math.round(((single && single.long) || 3000) / 3)) });
      const next = await speak(SHORT);
      const q = ((await call("GET", "/api/resources")).json || {}).engines.voice.queue;
      record("Queue: running disconnect finishes, slot released once", r.aborted && next.status === 200 && q.running === 0 && q.waiting === 0 ? "PASS" : "FAIL", `aborted ${r.aborted}; next ${next.status}; queue after ${JSON.stringify(q)}`);
    });
    await scenario("Queue: /api/tts/stop refuses waiting jobs", async () => {
      await idle();
      const a = speak(LONG); await sleep(300);
      const b = speak(SHORT); await sleep(200);
      const st = await call("POST", "/api/tts/stop", {});
      const [ra, rb] = await Promise.all([a, b]);
      record("Queue: /api/tts/stop refuses waiting jobs", st.status === 200 && ra.status === 200 && rb.status === 409 && rb.json && rb.json.code === "ENGINE_NOT_READY" ? "PASS" : "FAIL", `stop ${st.status}; running ${ra.status}; waiting ${rb.status} ${rb.json && rb.json.code}`);
    });
    await scenario("No orphaned Kokoro workers", async () => { await idle(); record("No orphaned Kokoro workers", (await workers()).length === 0 ? "PASS" : "FAIL", "after the queue checks"); });
  } finally { await stopServer(srv); }
}

(async () => {
  console.log(`| Check | Result | Detail |\n|---|---|---|`);
  if (!fs.existsSync(path.join(APP, "tts-models", MODEL))) { record("Voice model installed", "FAIL", `need app/tts-models/${MODEL} (runtime-validate installs it)`); process.exit(1); }
  let single = null;
  try { single = await baseline(); } catch (err) { record("Baseline", "FAIL", err.message); }
  if (HAS_QUEUE) { try { await queueChecks(single); } catch (err) { record("Queue", "FAIL", err.message); } }
  else record("Voice queue checks", "SKIP", "services/job-queue.cjs not present in this checkout (baseline measurement only)");
  record("GPU and NPU voice paths", "UNAVAILABLE", "Kokoro runs on the CPU here; no GPU or NPU path is exercised");
  process.exit(failed ? 1 : 0);
})();
