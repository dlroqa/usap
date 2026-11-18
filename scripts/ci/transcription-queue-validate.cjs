#!/usr/bin/env node
// Step 9.9f-3 (transcription) native check with the real whisper-cli (ggml-tiny.en, CPU) and the pinned JFK sample, both
// installed by runtime-validate. Starts its own test servers on port 14975 (`--port`) from this checkout.
//   * Baseline (default settings): one transcription (time, text), a burst of 6 (all accepted: no bound today).
//   * Default and rollback: the queue is off by default (no report keys, no upload folder); USAP_SCHEDULER=off turns it
//     off even when it is requested.
//   * Queue on (only for its own test servers): a long running job holds the engine while the checks queue behind it:
//     capacity and 429 with Retry-After; FIFO order; 413 before reading; 507 from a small storage budget; a waiting
//     disconnect never reaching whisper-cli; a running disconnect not stopping it; /api/speech/stop refusing waiting
//     jobs; server memory while 4 x 64 MB uploads wait; the logical-CPU cap; nothing left behind (folder, booked
//     storage, whisper-cli processes).
//   * Upload connection gate (#131, queue on, default limit 4 -> gate 6): a burst of 12 while a job runs fills the gate
//     (running + waiting + uploading + draining = 6) and the rest get the gate's 429 at once; the open count never
//     exceeds 6; disconnects, completions, early refusals and a shutdown release every place exactly once (never
//     negative, nothing stale after a restart); refused requests never reach whisper-cli. Off by default and with
//     USAP_SCHEDULER=off: no gate (8 open uploads, none refused).
//
//   node scripts/ci/transcription-queue-validate.cjs --model ggml-tiny.en.bin --wav .ci-model-cache/jfk.wav \
//     --results ci-logs/transcription-queue-results.jsonl --logs ci-logs
"use strict";

const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const APP = path.join(ROOT, "app");
const SERVE = path.join(ROOT, "scripts", "server", "serve.cjs");
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const MODEL = arg("model", "ggml-tiny.en.bin");
const WAV = path.resolve(ROOT, arg("wav", path.join(".ci-model-cache", "jfk.wav")));
const RESULTS = arg("results", path.join(ROOT, "ci-logs", "transcription-queue-results.jsonl"));
const LOGDIR = arg("logs", path.join(ROOT, "ci-logs"));
const PORT = Number(arg("port", "14975"));
const WIN = process.platform === "win32";
const UPLOAD_DIR = path.join(APP, "cache", "speech-uploads");
const NODE = [path.join(APP, "tools", "node-win", "node.exe"), path.join(APP, "tools", "node-linux", "bin", "node"), path.join(APP, "tools", "node-mac", "bin", "node")]
  .find((p) => fs.existsSync(p)) || process.execPath;
const MiB = 1024 * 1024;

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
function get(p) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path: p, method: p.startsWith("POST ") ? "POST" : "GET", agent: false, timeout: 15000 }, (res) => {
      let t = ""; res.setEncoding("utf8"); res.on("data", (c) => { t += c; });
      res.on("end", () => { let json = null; try { json = JSON.parse(t); } catch (_) { /* not json */ } resolve({ status: res.statusCode, json }); });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve({ status: 0, json: null }));
    req.end();
  });
}
function post(p, body) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const req = http.request({ host: "127.0.0.1", port: PORT, path: p, method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": data.length } }, (res) => {
      let t = ""; res.on("data", (c) => { t += c; }); res.on("end", () => resolve({ status: res.statusCode }));
    });
    req.on("error", () => resolve({ status: 0 }));
    req.end(data);
  });
}
/** Upload `body` to /api/speech/transcribe. `claim` overrides Content-Length; `stopAfterBytes` sends that much and
 *  leaves the request open; `abortAfterMs` disconnects. Resolves { status, json, headers, ms, at }. */
function transcribeCtl(body, query, { claim = body.length, stopAfterBytes = null, abortAfterMs = null, timeoutMs = 900000 } = {}) {
  let req;
  let finish = () => {};
  const promise = new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve({ ...v, ms: Date.now() - t0, at: Date.now() }); } };
    finish = fin;
    req = http.request({ host: "127.0.0.1", port: PORT, method: "POST", agent: false, path: `/api/speech/transcribe?model=${MODEL}&language=en${query}`,
      headers: { "content-type": "audio/wav", "content-length": claim } }, (res) => {
      let t = ""; res.setEncoding("utf8"); res.on("data", (c) => { t += c; });
      res.on("end", () => { let json = null; try { json = JSON.parse(t); } catch (_) { /* not json */ } fin({ status: res.statusCode, json, headers: res.headers }); });
      res.on("error", () => fin({ status: res.statusCode, cut: true }));
    });
    req.on("error", (e) => fin({ status: 0, error: e.code || e.message }));
    if (stopAfterBytes !== null) req.write(body.subarray(0, stopAfterBytes)); else req.end(body);
    if (abortAfterMs !== null) setTimeout(() => { req.destroy(); fin({ status: 0, aborted: true }); }, abortAfterMs);
    const t = setTimeout(() => { req.destroy(); fin({ status: 0, error: "client timeout" }); }, timeoutMs); if (t.unref) t.unref();
  });
  return { promise, abort: () => { if (req) req.destroy(); finish({ status: 0, aborted: true }); } };
}
const transcribe = (body, query, opts) => transcribeCtl(body, query, opts).promise;

// ── Audio ────────────────────────────────────────────────────────────────────
// The JFK sample's PCM data, repeated `times` (a longer job for whisper-cli), or zero-padded to `bytes` (a large upload
// that is never transcribed: it is disconnected while it waits).
function wavParts(buf) {
  let off = 12; let fmt = null; let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4); const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = buf.subarray(off + 8, off + 8 + size);
    if (id === "data") { data = buf.subarray(off + 8, off + 8 + size); break; }
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("the sample is not a plain PCM WAV");
  return { fmt, data };
}
function makeWav(fmt, data) {
  const h = Buffer.alloc(20); h.write("RIFF", 0); h.writeUInt32LE(4 + 8 + fmt.length + 8 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(fmt.length, 16);
  const d = Buffer.alloc(8); d.write("data", 0); d.writeUInt32LE(data.length, 4);
  return Buffer.concat([h, fmt, d, data]);
}

// ── Processes ────────────────────────────────────────────────────────────────
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; } };
async function whispers() {
  const d = (await get("/api/diagnostics")).json;
  const sup = (d && d.engines && d.engines.processes && d.engines.processes.supervised) || [];
  return sup.filter((r) => /whisper/i.test(String(r.label))).map((r) => r.enginePid || r.guardPid).filter((pid) => pid && alive(pid));
}
function rssMb(pid) {
  try {
    if (WIN) {
      const r = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`], { encoding: "utf8", timeout: 10000 });
      const n = Number(String(r.stdout).trim()); return Number.isFinite(n) && n > 0 ? Math.round(n / MiB) : null;
    }
    const r = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
    const n = Number(String(r.stdout).trim()); return Number.isFinite(n) && n > 0 ? Math.round(n / 1024) : null;
  } catch (_) { return null; }
}
let current = null;
async function startServer(label, env) {
  const logPath = path.join(LOGDIR, `transcription-queue-${label}.log`);
  const log = fs.openSync(logPath, "w");
  const child = spawn(NODE, [SERVE], { cwd: ROOT, windowsHide: true, stdio: ["ignore", log, log],
    env: { ...process.env, PORT: String(PORT), FRONTEND_PORT: String(PORT), LLM_PORT: String(PORT + 1), BACKEND_PORT: String(PORT + 2), SD_BACKEND_PORT: String(PORT + 2), SPEECH_PORT: String(PORT + 3), TTS_PORT: String(PORT + 4), ...env } });
  const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
  const srv = { label, child, exited, logPath, startsBefore: 0 };
  const up = await waitUntil(async () => (await get("/api/health")).status === 200, 60000, 500);
  if (!up) throw new Error(`server ${label} did not start (see transcription-queue-${label}.log)`);
  current = srv;
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
// whisper-cli starts the server logged so far ("[speech] Starting: <cli> ... -t N ...").
function starts(srv) {
  try { return fs.readFileSync(srv.logPath, "utf8").split(/\r?\n/).filter((l) => l.includes("[speech] Starting:")); } catch (_) { return []; }
}
const threadsOf = (line) => { const m = / -t (\d+)/.exec(line); return m ? Number(m[1]) : null; };
async function scenario(name, fn) { try { await fn(); } catch (err) { record(name, "FAIL", err.message); } }
const resources = async () => (await get("/api/resources")).json || {};
const queue = async () => ((await resources()).engines || {}).speech?.queue || {};
// #131 gate: the server's own counters (uploadConnections { open, limit } and counts.connectionsRefused).
const GATE_TEXT = /Too many audio uploads are in progress/;
const gate = async () => { const t = (await resources()).transcriptionQueue || {}; return { open: t.uploadConnections?.open, limit: t.uploadConnections?.limit, refused: t.counts?.connectionsRefused }; };
// The server's own record of each transcription request (test-only preload scripts/tests/api-contract/
// connection-log-preload.cjs, loaded only into this script's queue-on server): arrival and response close (the gate's
// release point) give the true number of admitted requests open at once, independent of polling.
const CONN_LOG = path.join(LOGDIR, "transcription-gate-conn-log.jsonl");
const connLogEnv = () => ({ USAP_TEST_CONN_LOG: CONN_LOG,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require "${path.join(ROOT, "scripts", "tests", "api-contract", "connection-log-preload.cjs").replace(/\\/g, "/")}"`.trim() });
const connLog = () => { try { return fs.readFileSync(CONN_LOG, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } };
function maxAdmittedAtOnce(records) {
  const ev = [];
  for (const r of records.filter((x) => !GATE_TEXT.test(x.body || ""))) { ev.push([r.arrivedAt, 1]); ev.push([r.resCloseAt ?? r.sockCloseAt, -1]); }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let open = 0, max = 0; for (const [, d] of ev) { open += d; max = Math.max(max, open); }
  return max;
}
// Uploads that declare `claim` bytes, send 64 KiB and then stay silent (bounded by the queue's 30 s inactivity limit).
const openUploads = (body, n, tag) => Array.from({ length: n }, (_, i) => transcribeCtl(body, `&save=false&filename=${tag}${i}.wav`, { stopAfterBytes: 64 * 1024, timeoutMs: 60000 }));
// Samples the open count every 50 ms while `p` is pending: { max, min } (a stale or negative count shows here).
async function sampleOpen(p, ms = 3000) {
  let max = -Infinity, min = Infinity, done = false; p.then(() => { done = true; }, () => { done = true; });
  const end = Date.now() + ms;
  while (!done && Date.now() < end) { const g = await gate(); if (typeof g.open === "number") { max = Math.max(max, g.open); min = Math.min(min, g.open); } await sleep(50); }
  return { max, min };
}

(async () => {
  if (!fs.existsSync(path.join(APP, "speech-models", MODEL)) || !fs.existsSync(WAV)) {
    record("whisper model and sample installed", "FAIL", `model ${fs.existsSync(path.join(APP, "speech-models", MODEL))}, sample ${fs.existsSync(WAV)} (runtime-validate installs both)`);
    process.exit(1);
  }
  const sample = fs.readFileSync(WAV);
  const { fmt, data } = wavParts(sample);
  const long = makeWav(fmt, Buffer.concat(Array(20).fill(data))); // about 3.7 minutes of audio: holds the engine
  const big = makeWav(fmt, Buffer.alloc(64 * MiB));               // never transcribed (disconnected while waiting)
  const gateBody = makeWav(fmt, Buffer.alloc(2 * MiB));           // #131: declared 2 MiB, only 64 KiB sent
  let single = null;

  // ── Baseline ──
  try {
    const srv = await startServer("baseline", { USAP_TRANSCRIPTION_QUEUE: "" });
    try {
      await scenario("Baseline: one transcription (real whisper-cli)", async () => {
        const r = await transcribe(sample, "&save=false&filename=jfk.wav");
        const text = r.json && r.json.transcription && r.json.transcription.text || "";
        single = r.ms;
        record("Baseline: one transcription (real whisper-cli)", r.status === 200 && /ask not/i.test(text) ? "PASS" : "FAIL", `status ${r.status} in ${r.ms} ms; text "${text.slice(0, 80)}"`);
      });
      await scenario("Baseline: burst of 6 is unbounded (no 429)", async () => {
        const t0 = Date.now();
        const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => transcribe(sample, `&save=false&filename=b${i}.wav`)));
        record("Baseline: burst of 6 is unbounded (no 429)", rs.every((r) => r.status === 200) ? "EXPECTED" : "FAIL", `statuses ${rs.map((r) => r.status).join("/")} in ${Date.now() - t0} ms (today: no limit, no deadline)`);
      });
    } finally { await stopServer(srv); }
  } catch (err) { record("Baseline", "FAIL", err.message); }

  // ── Default and rollback ──
  try {
    try { fs.rmSync(UPLOAD_DIR, { recursive: true, force: true }); } catch (_) { /* absent */ }
    const srv = await startServer("default", { USAP_TRANSCRIPTION_QUEUE: "" });
    try {
      const r = await resources();
      await transcribe(sample, "&save=false&filename=d.wav");
      record("Default: transcriptionQueue off", !("transcriptionQueue" in r) && !("transcriptionQueue" in (r.limits || {})) && !fs.existsSync(UPLOAD_DIR) ? "PASS" : "FAIL",
        `limits ${JSON.stringify(r.limits)}; upload folder exists ${fs.existsSync(UPLOAD_DIR)}`);
      await scenario("Gate: off by default (8 open uploads, none refused)", async () => {
        const ups = openUploads(gateBody, 8, "dg");
        await sleep(2000);
        for (const u of ups) u.abort();
        const rs = await Promise.all(ups.map((u) => u.promise));
        const g = await resources();
        record("Gate: off by default (8 open uploads, none refused)", rs.every((x) => x.status !== 429) && !("transcriptionQueue" in g) ? "PASS" : "FAIL",
          `statuses ${rs.map((x) => x.status).join("/")} (0 = still uploading when the client left); report keys ${"transcriptionQueue" in g}`);
      });
    } finally { await stopServer(srv); }
  } catch (err) { record("Default: transcriptionQueue off", "FAIL", err.message); }
  try {
    const srv = await startServer("scheduler-off", { USAP_TRANSCRIPTION_QUEUE: "on", USAP_SCHEDULER: "off" });
    try {
      const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => transcribe(sample, `&save=false&filename=s${i}.wav`)));
      const r = await resources();
      record("Rollback: USAP_SCHEDULER=off", rs.every((x) => x.status === 200) && !("transcriptionQueue" in r) ? "PASS" : "FAIL", `6 concurrent -> ${rs.map((x) => x.status).join("/")} (legacy: no 429); report keys ${"transcriptionQueue" in r}`);
      await scenario("Gate: USAP_SCHEDULER=off removes it (8 open uploads, none refused)", async () => {
        const ups = openUploads(gateBody, 8, "rg");
        await sleep(2000);
        for (const u of ups) u.abort();
        const us = await Promise.all(ups.map((u) => u.promise));
        record("Gate: USAP_SCHEDULER=off removes it (8 open uploads, none refused)", us.every((x) => x.status !== 429) ? "PASS" : "FAIL", `statuses ${us.map((x) => x.status).join("/")}`);
      });
    } finally { await stopServer(srv); }
  } catch (err) { record("Rollback: USAP_SCHEDULER=off", "FAIL", err.message); }

  // ── Queue on ──
  // Starts a long transcription and resolves once whisper-cli runs it. Returns { done } (the job's promise, wrapped:
  // an async function returning a bare promise would make its caller wait for the whole job).
  const holdEngine = async (srv, tag) => {
    const before = starts(srv).length;
    const done = transcribe(long, `&save=false&filename=${tag}.wav`);
    const ok = await waitUntil(async () => starts(srv).length > before && (await queue()).running === 1, 60000, 100);
    if (!ok) throw new Error("the long job did not start");
    return { done };
  };
  let srv = null;
  try {
    try { fs.rmSync(CONN_LOG, { force: true }); } catch (_) { /* absent */ }
    srv = await startServer("on", { USAP_TRANSCRIPTION_QUEUE: "on", ...connLogEnv() });
    await scenario("Queue: capacity, 429 and FIFO", async () => {
      const startsBefore = starts(srv).length;
      const held = (await holdEngine(srv, "hold")).done;
      const waiting = [];
      for (let i = 1; i <= 4; i += 1) { waiting.push(transcribe(sample, `&save=false&filename=w${i}.wav`)); await waitUntil(async () => (await queue()).waiting === i, 10000, 50); }
      const full = await transcribe(sample, "&save=false&filename=full.wav");
      const rs = await Promise.all([held, ...waiting]);
      const order = rs.slice(1).map((r, i) => ({ i: i + 1, at: r.at })).sort((a, b) => a.at - b.at).map((x) => x.i).join(",");
      const ran = starts(srv).length - startsBefore;
      record("Queue: capacity, 429 and FIFO", full.status === 429 && full.json && full.json.code === "QUEUE_FULL" && Number(full.headers["retry-after"]) >= 1 && full.ms < 5000
        && rs.every((r) => r.status === 200) && order === "1,2,3,4" && ran === 5 ? "PASS" : "FAIL",
        `held ${rs[0].status} in ${rs[0].ms} ms; waiting ${rs.slice(1).map((r) => r.status).join("/")} completed in order ${order}; 6th: ${full.status} ${full.json && full.json.code} Retry-After ${full.headers && full.headers["retry-after"]} in ${full.ms} ms; whisper-cli runs ${ran}`);
    });
    await scenario("Queue: 413 before reading (declared over 1 GiB)", async () => {
      const r = await transcribe(sample, "&save=false&filename=big.wav", { claim: 2 * 1024 * MiB, stopAfterBytes: 4096, timeoutMs: 30000 });
      record("Queue: 413 before reading (declared over 1 GiB)", r.status === 413 && r.json && r.json.code === "UPLOAD_TOO_LARGE" && r.ms < 5000 ? "PASS" : "FAIL", `status ${r.status} ${r.json && r.json.code} in ${r.ms} ms`);
    });
    await scenario("Queue: memory while 4 x 64 MB uploads wait", async () => {
      const startsBefore = starts(srv).length;
      const held = (await holdEngine(srv, "hold2")).done;
      const rssBefore = rssMb(srv.child.pid);
      const ws = [1, 2, 3, 4].map((i) => transcribeCtl(big, `&save=false&filename=big${i}.wav`));
      const allIn = await waitUntil(async () => { const q = await queue(); return q.waiting === 4 && q.uploading === 0; }, 90000, 200);
      const rssAfter = rssMb(srv.child.pid);
      const files = fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR).length : 0;
      const booked = (await resources()).transcriptionQueue.storage.reservedBytes;
      record("Queue: memory while 4 x 64 MB uploads wait", allIn && rssBefore && rssAfter && rssAfter - rssBefore < 100 ? "PASS" : "FAIL",
        `all uploaded and waiting ${Boolean(allIn)}; server RSS ${rssBefore} -> ${rssAfter} MB for 256 MB waiting (today about 2x each body); files ${files}; booked ${Math.round(booked / MiB)} MB`);
      // The four clients leave while waiting: none of them may reach whisper-cli.
      for (const w of ws) w.abort();
      await Promise.all(ws.map((w) => w.promise));
      const left = await waitUntil(async () => (await queue()).waiting === 0, 15000, 100);
      const h = await held;
      await sleep(1000);
      const ran = starts(srv).length - startsBefore;
      const q = await resources();
      const filesLeft = fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR).length : 0;
      record("Queue: waiting disconnects never reach whisper-cli", Boolean(left) && h.status === 200 && ran === 1 && q.transcriptionQueue.storage.reservedBytes === 0 && filesLeft === 0 ? "PASS" : "FAIL",
        `left the queue ${Boolean(left)}; held job ${h.status}; whisper-cli runs ${ran} (1 = only the held job); booked ${q.transcriptionQueue.storage.reservedBytes}; files left ${filesLeft}`);
    });
    await scenario("Queue: a running disconnect doesn't stop whisper-cli; the next job waits for it", async () => {
      const before = starts(srv).length;
      const held = transcribe(long, "&filename=running-gone.wav", { abortAfterMs: 3000 });
      await waitUntil(async () => starts(srv).length > before, 60000, 100);
      const r = await held;
      const w = await whispers();
      const next = transcribe(sample, "&save=false&filename=after.wav");
      const waited = await waitUntil(async () => (await queue()).waiting === 1, 10000, 100);
      const n = await next;
      const ran = starts(srv).length - before;
      record("Queue: a running disconnect doesn't stop whisper-cli; the next job waits for it", r.aborted && w.length === 1 && Boolean(waited) && n.status === 200 && ran === 2 ? "PASS" : "FAIL",
        `aborted ${r.aborted}; whisper-cli alive after the disconnect ${w.length}; next waited ${Boolean(waited)} then ${n.status} in ${n.ms} ms; runs ${ran}`);
    });
    await scenario("Queue: /api/speech/stop refuses waiting jobs", async () => {
      const held = (await holdEngine(srv, "hold3")).done;
      const w = transcribe(sample, "&save=false&filename=refused.wav");
      await waitUntil(async () => (await queue()).waiting === 1, 10000, 100);
      const st = await post("/api/speech/stop", {});
      const r = await w;
      const h = await held;
      record("Queue: /api/speech/stop refuses waiting jobs", st.status === 200 && r.status === 409 && r.json && r.json.code === "ENGINE_NOT_READY" && h.status === 200 ? "PASS" : "FAIL",
        `stop ${st.status}; waiting ${r.status} ${r.json && r.json.code}; running ${h.status}`);
    });
    await scenario("Queue: logical-CPU cap still applies", async () => {
      const before = starts(srv).length;
      const r = await transcribe(sample, "&save=false&filename=threads.wav&threads=999");
      const line = starts(srv).slice(before)[0] || "";
      const t = threadsOf(line);
      record("Queue: logical-CPU cap still applies", r.status === 200 && t !== null && t >= 1 && t <= os.cpus().length ? "PASS" : "FAIL", `requested 999 -> -t ${t} (logical CPUs ${os.cpus().length})`);
    });
    let gateBurst = null;
    await scenario("Gate: disconnects and completion release every place exactly once; refused requests never reach whisper-cli", async () => {
      const startsBefore = starts(srv).length;
      const g0 = await gate();
      const held = (await holdEngine(srv, "hold-gate")).done;
      // 12 while one job runs. How many fit depends on arrival order (a client refused by the full queue may leave and
      // free its place before a later one arrives; seen on Windows), so the invariants are checked, not a fixed split:
      // the open count reaches 6 and never exceeds it, some are refused, and every gate refusal the server counted is a
      // gate answer a client received (429, the gate's text, Retry-After 5), with no other outcome for the rest.
      const ups = openUploads(gateBody, 12, "g");
      const answered = [];
      for (const u of ups) u.promise.then((r) => answered.push(r));
      const sampled = sampleOpen(Promise.all(ups.map((u) => u.promise)), 4000);
      await waitUntil(async () => (await gate()).refused > g0.refused, 20000, 100);
      const { max } = await sampled; // a 50 ms poll: a bound only; the exact peak comes from the server log below
      const g1 = await gate();
      const refusedNow = g1.refused - g0.refused;
      await waitUntil(() => answered.filter((r) => r.json && GATE_TEXT.test(r.json.error || "")).length >= refusedNow, 10000, 100);
      const gateRefusals = answered.filter((r) => r.status === 429 && r.json && GATE_TEXT.test(r.json.error || "") && Number(r.headers["retry-after"]) === 5);
      const other = answered.filter((r) => !(r.json && GATE_TEXT.test(r.json.error || "")) && !(r.status === 429 && r.json && r.json.code === "QUEUE_FULL"));
      gateBurst = { g1, max, refusedNow, gateRefusals: gateRefusals.length, other: other.map((r) => r.status), answered: answered.map((r) => r.status) };
      // Release: the admitted clients leave (uploading, waiting and the drained early refusal alike), then the job ends.
      for (const u of ups) u.abort();
      await Promise.all(ups.map((u) => u.promise));
      // At most the held job remains (it may already have ended on a fast runner).
      const afterLeave = await waitUntil(async () => (await gate()).open === (await queue()).running, 20000, 100);
      const h = await held;
      const zero = await waitUntil(async () => (await gate()).open === 0, 20000, 100);
      await sleep(1000);
      const ran = starts(srv).length - startsBefore;
      const g2 = await gate();
      record("Gate: disconnects and completion release every place exactly once; refused requests never reach whisper-cli",
        Boolean(afterLeave) && Boolean(zero) && g2.open === 0 && h.status === 200 && ran === 1 ? "PASS" : "FAIL",
        `open after the 12 left = running jobs ${Boolean(afterLeave)}; after the job ${g2.open}; held job ${h.status}; whisper-cli runs ${ran} (1 = only the held job)`);
      // The burst, judged from the server's own events (every connection of this scenario has closed by now).
      await waitUntil(() => connLog().filter((r) => /filename=g\d+\.wav/.test(r.url)).length >= 12, 15000, 200);
      const log = connLog();
      const burstLog = log.filter((r) => /filename=(g\d+|hold-gate)\.wav/.test(r.url));
      const peak = maxAdmittedAtOnce(burstLog), peakAll = maxAdmittedAtOnce(log);
      const refusedLog = burstLog.filter((r) => GATE_TEXT.test(r.body || "") && r.status === 429);
      const b = gateBurst;
      record("Gate: at most 6 upload connections at the default limit; a burst is admitted atomically",
        b && b.g1.limit === 6 && peak === 6 && peakAll <= 6 && b.max <= 6 && b.refusedNow >= 1 && refusedLog.length === b.refusedNow && b.gateRefusals === b.refusedNow && b.other.length === 0 && burstLog.length === 13 ? "PASS" : "FAIL",
        `limit ${b && b.g1.limit}; admitted open at once (server events): burst ${peak}, whole run ${peakAll}; polled max ${b && b.max}; gate refusals: counter ${b && b.refusedNow}, server log ${refusedLog.length}, client answers ${b && b.gateRefusals}; other client outcomes ${JSON.stringify(b && b.other)}; records ${burstLog.length} of 13 (12 + held job)`);
    });
    await scenario("Gate: early refusals and normal completions release exactly once (never negative)", async () => {
      const checks = [];
      const watch = { stop: false, min: Infinity };
      const watcher = (async () => { while (!watch.stop) { const g = await gate(); if (typeof g.open === "number") watch.min = Math.min(watch.min, g.open); await sleep(50); } })();
      const r413 = await transcribe(sample, "&save=false&filename=gate413.wav", { claim: 2 * 1024 * MiB, stopAfterBytes: 4096, timeoutMs: 30000 });
      checks.push(["413", r413.status, await waitUntil(async () => (await gate()).open === 0, 10000, 100)]);
      for (let i = 0; i < 3; i += 1) {
        const r = await transcribe(sample, `&save=false&filename=gate-ok${i}.wav`);
        checks.push([`job ${i}`, r.status, await waitUntil(async () => (await gate()).open === 0, 10000, 100)]);
      }
      watch.stop = true; await watcher;
      record("Gate: early refusals and normal completions release exactly once (never negative)",
        checks[0][1] === 413 && checks.slice(1).every((c) => c[1] === 200) && checks.every((c) => c[2]) && watch.min >= 0 ? "PASS" : "FAIL",
        `${checks.map((c) => `${c[0]} ${c[1]} -> open 0 ${Boolean(c[2])}`).join("; ")}; lowest open seen ${watch.min}`);
    });
    await scenario("Queue: nothing left behind", async () => {
      await waitUntil(async () => (await whispers()).length === 0, 60000, 250);
      const q = await resources();
      const files = fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR) : [];
      const live = (await whispers()).length;
      record("Queue: nothing left behind", q.engines.speech.queue.running === 0 && q.engines.speech.queue.waiting === 0 && q.transcriptionQueue.storage.reservedBytes === 0 && files.length === 0 && live === 0 ? "PASS" : "FAIL",
        `queue ${JSON.stringify(q.engines.speech.queue)}; booked ${q.transcriptionQueue.storage.reservedBytes}; files ${files.length}; whisper-cli alive ${live}`);
    });
  } catch (err) { record("Queue on", "FAIL", err.message); }
  finally { await stopServer(srv); }

  // #131: a shutdown with places taken leaves nothing stale: the next server starts at 0 with no files.
  try {
    let sd = await startServer("gate-shutdown", { USAP_TRANSCRIPTION_QUEUE: "on" });
    let ups = [];
    try {
      await holdEngine(sd, "hold-sd");
      ups = openUploads(gateBody, 3, "sd");
      await waitUntil(async () => (await gate()).open === 4, 20000, 100);
      const before = await gate();
      await stopServer(sd);
      for (const u of ups) u.abort();
      await Promise.all(ups.map((u) => u.promise));
      const code = (await sd.exited);
      sd = await startServer("gate-restart", { USAP_TRANSCRIPTION_QUEUE: "on" });
      const after = await gate();
      const files = fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR).length : 0;
      const live = (await whispers()).length;
      record("Gate: a shutdown with places taken leaves nothing stale", before.open === 4 && after.open === 0 && after.refused === 0 && live === 0 ? "PASS" : "FAIL",
        `open before shutdown ${before.open}; exit ${JSON.stringify(code)}; after restart open ${after.open}, refused ${after.refused}; whisper-cli alive ${live}`);
      // Upload files of the stopped server: deleted by its exit handler when it can run (SIGTERM on Linux/macOS). On
      // Windows the stop is a hard termination, and there is no start-up sweep yet (not implemented), so they remain.
      record("Shutdown: upload files of the stopped server", files === 0 ? "PASS" : WIN ? "EXPECTED" : "FAIL",
        `${files} file(s) after a ${WIN ? "hard termination (Windows; start-up stale-file sweep not implemented)" : "SIGTERM"}`);
      for (const f of fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR) : []) { try { fs.rmSync(path.join(UPLOAD_DIR, f), { force: true }); } catch (_) { /* recorded above */ } }
    } finally { for (const u of ups) u.abort(); await stopServer(sd); }
  } catch (err) { record("Gate: a shutdown with places taken leaves nothing stale", "FAIL", err.message); }

  try {
    const srv = await startServer("budget", { USAP_TRANSCRIPTION_QUEUE: "on", USAP_TRANSCRIPTION_QUEUE_STORAGE_BUDGET_BYTES: String(64 * MiB) });
    try {
      await scenario("Queue: 507 when the storage budget is booked", async () => {
        const held = (await holdEngine(srv, "hold4")).done;
        // Booked: the held job (about 7 MB) + A (40 MB declared, sent slowly) = about 47 of 64 MiB; B (20 MB) can't fit.
        const a = transcribe(makeWav(fmt, Buffer.alloc(40 * MiB)), "&save=false&filename=a.wav", { stopAfterBytes: 1 * MiB, abortAfterMs: 15000 });
        await waitUntil(async () => (await resources()).transcriptionQueue.storage.reservedBytes > 45 * MiB, 10000, 100);
        const b = await transcribe(makeWav(fmt, Buffer.alloc(20 * MiB)), "&save=false&filename=b.wav", { timeoutMs: 30000 });
        await a; await held;
        await waitUntil(async () => (await resources()).transcriptionQueue.storage.reservedBytes === 0, 30000, 250);
        record("Queue: 507 when the storage budget is booked", b.status === 507 && b.json && b.json.code === "INSUFFICIENT_STORAGE" && b.ms < 5000 ? "PASS" : "FAIL", `status ${b.status} ${b.json && b.json.code} in ${b.ms} ms`);
      });
    } finally { await stopServer(srv); }
  } catch (err) { record("Queue: 507 when the storage budget is booked", "FAIL", err.message); }

  record("Measured: one transcription of the JFK sample", single ? "PASS" : "FAIL", `${single} ms on ${os.cpus().length} logical CPUs`);
  record("GPU and NPU transcription paths", "UNAVAILABLE", "whisper-cli runs on the CPU here; no GPU or NPU path is exercised");
  process.exit(failed ? 1 : 0);
})();
