#!/usr/bin/env node
// Step 9.9e prerequisite: CPU contention measurements with real models (docs/roadmap/STEP9_9E_THREADS.md).
//
// Measurement only. It changes no setting, thread count or default: it starts its OWN studio server from this
// checkout (port 14930) with the models the native-runtime validation installed, and measures each workload alone
// and while another one runs, exactly as the studio runs them today:
//
//   baselines: chat (Qwen2.5 0.5B Q4_K_M, llama.cpp CPU), transcription (whisper tiny.en, JFK 11 s), voice
//              (Kokoro 82M q8), image (SD 1.5 Q4_0, 256x256, 4 steps, CPU)
//   overlaps:  chat + transcription, chat + voice, image + transcription, image + voice (all reachable in the
//              studio), and image + chat, which the studio does NOT allow today (one heavy model at a time,
//              decision B): there the chat engine is a second llama-server started from the studio's own logged
//              command line, outside the studio, labelled as such.
//
// For each overlap the longer job runs in the foreground N times while the other runs back to back in the
// background; both are timed. Recorded per window: wall times (median, min, max, coefficient of variation),
// engine-reported tokens/s for chat, system CPU busy % (os.cpus deltas, all logical cores), the lowest available
// RAM the studio reported (/api/resources, the same source as the 9.9d memory check), and per engine process the
// largest resident memory and OS thread count seen (/api/diagnostics engine PIDs; Linux /proc, macOS ps, Windows
// Get-Process). OS thread counts include idle and I/O threads: they are an upper bound, not compute threads.
//
//   node scripts/ci/thread-bench.cjs --jfk .ci-model-cache/jfk.wav --out ci-logs/thread-bench [--reps 5 --image-reps 3]
//
// Policy comparison (Step 9.9e implementation): `--set whisper` runs only the windows a transcription thread budget
// affects (chat, transcription, voice and image alone; chat + transcription, voice + transcription, image +
// transcription), with transcriptions explicitly requesting 4 threads. (4 is NOT the WebUI's unconditional
// default: the WebUI defaults to min(8, navigator.hardwareConcurrency), and 4 only when the browser reports no CPU
// count; the server defaults to min(8, logical CPUs). On the 4-logical-CPU runners 4 equals both defaults; on the
// 3-vCPU macOS arm64 runner it is one more than the CPUs, like an API or LAN client asking for more threads than the
// server has.) `--studio-env K=V,...` adds environment variables for the studio server (e.g. USAP_THREADS=on) and
// `--label` names the run. Run it once per setting in the same job, then `--compare <dirA> <dirB>` prints the
// side-by-side table.
//
// Whisper thread sweep: `--set whisper-sweep [--threads-list 2,3,4,default]` runs one transcription at a time with
// nothing else busy, each configuration in rotating order per round, first with no other engine loaded and then
// with the text engine loaded and idle; it records the CPU counts and affinity the OS reports and checks each job's
// `-t` and whisper.cpp's own thread line in the studio log. Output: whisper-sweep.md and thread-bench.jsonl.
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
const OUT = path.resolve(arg("out", path.join(ROOT, "ci-logs", "thread-bench")));
const JFK = path.resolve(arg("jfk", path.join(ROOT, ".ci-model-cache", "jfk.wav")));
const REPS = Number(arg("reps", "5"));
const SET = arg("set", "full");
const LABEL = arg("label", SET === "full" ? "default" : "run");
const STUDIO_ENV = Object.fromEntries(String(arg("studio-env", "")).split(",").filter(Boolean).map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)]; }));
const UI_WHISPER_THREADS = 4; // fixed request for `--set whisper` (the WebUI's fallback when the browser reports no CPU count)
const IMAGE_REPS = Number(arg("image-reps", "3"));
const PORT = Number(arg("port", "14930"));
const SIDE_PORT = PORT + 1; // the standalone llama-server for image + chat
const QWEN = "qwen2.5-0.5b-instruct-q4_k_m.gguf";
const SD = "stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf";
const WHISPER = "ggml-tiny.en.bin";
const WIN = process.platform === "win32";
const NODE = [path.join(APP, "tools", "node-win", "node.exe"), path.join(APP, "tools", "node-linux", "bin", "node"), path.join(APP, "tools", "node-mac", "bin", "node")]
  .find((p) => fs.existsSync(p)) || process.execPath;
const PLATFORM = `${process.platform}-${process.arch}`;

fs.mkdirSync(OUT, { recursive: true });
const RESULTS = path.join(OUT, "thread-bench.jsonl");
if (!process.argv.includes("--compare")) fs.writeFileSync(RESULTS, ""); // compare mode only reads
const SERVER_LOG = path.join(OUT, "studio.log");
const rows = [];
function emit(row) {
  const r = { platform: PLATFORM, label: LABEL, ...row };
  rows.push(r);
  fs.appendFileSync(RESULTS, JSON.stringify(r) + "\n");
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

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────────────────
function call(port, method, p, body, { timeoutMs = 1800000, type = "application/json" } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const data = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: "127.0.0.1", port, path: p, method, agent: false, timeout: timeoutMs,
      headers: data ? { "content-type": type, "content-length": data.length } : {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); let json = null; try { json = JSON.parse(text); } catch (_) { /* not JSON */ } resolve({ status: res.statusCode, text, json, ms: Date.now() - t0 }); });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ status: 0, text: String(e.message), json: null, ms: Date.now() - t0 }));
    if (data) req.write(data);
    req.end();
  });
}
const get = (p, port = PORT) => call(port, "GET", p, undefined, { timeoutMs: 15000 });

// ── Process facts (measured; unknown when the OS doesn't answer) ─────────────────────────────────────────────
function procInfo(pid) {
  try {
    if (process.platform === "linux") {
      const st = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const rss = Number((st.match(/VmRSS:\s+(\d+)/) || [])[1]);
      const thr = Number((st.match(/Threads:\s+(\d+)/) || [])[1]);
      return { rssMb: Number.isFinite(rss) ? Math.round(rss / 1024) : null, threads: Number.isFinite(thr) ? thr : null };
    }
    if (process.platform === "darwin") {
      const r = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
      const t = spawnSync("ps", ["-M", "-p", String(pid)], { encoding: "utf8" });
      const rss = Number(String(r.stdout).trim());
      const lines = String(t.stdout).trim().split("\n").length - 1;
      return { rssMb: Number.isFinite(rss) && rss > 0 ? Math.round(rss / 1024) : null, threads: lines > 0 ? lines : null };
    }
    if (WIN) {
      const r = spawnSync("powershell", ["-NoProfile", "-Command", `$p=Get-Process -Id ${pid} -ErrorAction Stop; "$($p.WorkingSet64) $($p.Threads.Count)"`], { encoding: "utf8", timeout: 5000 });
      const [ws, th] = String(r.stdout).trim().split(/\s+/).map(Number);
      return { rssMb: Number.isFinite(ws) && ws > 0 ? Math.round(ws / 1048576) : null, threads: Number.isFinite(th) && th > 0 ? th : null };
    }
  } catch (_) { /* gone */ }
  return { rssMb: null, threads: null };
}
async function supervised() {
  const d = await get("/api/diagnostics");
  return ((d.json && d.json.engines && d.json.engines.processes && d.json.engines.processes.supervised) || []).map((p) => ({ label: p.label, pid: p.enginePid })).filter((p) => p.pid);
}
const cpuTimes = () => os.cpus().map((c) => c.times);
function busyPct(a, b) {
  let busy = 0; let total = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = (k) => b[i][k] - a[i][k];
    const t = d("user") + d("nice") + d("sys") + d("idle") + d("irq");
    total += t; busy += t - d("idle");
  }
  return total > 0 ? Math.round((busy / total) * 1000) / 10 : null;
}

// Samples CPU, available RAM and engine processes while a window runs.
function sampler(extraPids = () => []) {
  const startTimes = cpuTimes();
  const engines = {};
  let minFree = null; let samples = 0; let running = true;
  const loop = (async () => {
    while (running) {
      try {
        const r = await get("/api/resources");
        const free = r.json && r.json.memory && r.json.memory.ram.freeBytes;
        if (free && free.known) minFree = minFree === null ? free.value : Math.min(minFree, free.value);
        for (const p of [...(await supervised()), ...extraPids()]) {
          const info = procInfo(p.pid);
          const e = engines[p.label] || (engines[p.label] = { maxRssMb: null, maxThreads: null });
          if (info.rssMb !== null) e.maxRssMb = Math.max(e.maxRssMb || 0, info.rssMb);
          if (info.threads !== null) e.maxThreads = Math.max(e.maxThreads || 0, info.threads);
        }
        samples++;
      } catch (_) { /* a sample can fail; others count */ }
      await sleep(500);
    }
  })();
  return async () => { running = false; await loop; return { cpuBusyPct: busyPct(startTimes, cpuTimes()), minAvailableRamMb: minFree === null ? null : Math.round(minFree / 1048576), samples, engines }; };
}

// ── Workloads ───────────────────────────────────────────────────────────────────────────────────────────────
// Counting keeps a small model generating until max_tokens, so every chat job does the same work.
const CHAT_BODY = { messages: [{ role: "user", content: "Count from 1 to 500, separated by commas. Write only the numbers." }], max_tokens: 128, temperature: 0, seed: 1, stream: false };
const timingsOf = (j) => (j && j.timings) || {};
async function chatJob() {
  const r = await call(PORT, "POST", "/api/llm/chat", CHAT_BODY);
  const t = timingsOf(r.json);
  return { ok: r.status === 200, ms: r.ms, tps: t.predicted_per_second ? Math.round(t.predicted_per_second * 10) / 10 : null, tokens: t.predicted_n ?? null, error: r.status === 200 ? null : r.text.slice(0, 160) };
}
async function sideChatJob() { // the standalone llama-server (outside the studio; decision B)
  const r = await call(SIDE_PORT, "POST", "/v1/chat/completions", CHAT_BODY);
  const t = timingsOf(r.json);
  return { ok: r.status === 200, ms: r.ms, tps: t.predicted_per_second ? Math.round(t.predicted_per_second * 10) / 10 : null, tokens: t.predicted_n ?? null, error: r.status === 200 ? null : r.text.slice(0, 160) };
}
const jfk = fs.existsSync(JFK) ? fs.readFileSync(JFK) : null;
async function whisperJob(threads = null) {
  const r = await call(PORT, "POST", `/api/speech/transcribe?model=${WHISPER}&language=en&save=false&filename=jfk.wav${threads ? `&threads=${threads}` : ""}`, jfk, { type: "audio/wav" });
  const ok = r.status === 200 && /your country/i.test(r.text);
  return { ok, ms: r.ms, error: ok ? null : r.text.slice(0, 160) };
}
async function ttsJob() {
  const r = await call(PORT, "POST", "/api/tts/speak", { text: "The lighthouse keeper climbed the stairs at dusk and lit the lamp for the ships at sea.", model: "kokoro-onnx-q8.json" });
  const ok = r.status === 200 && r.json && r.json.ok === true;
  return { ok, ms: r.ms, error: ok ? null : r.text.slice(0, 160) };
}
async function imageJob() {
  const r = await call(PORT, "POST", "/sdapi/v1/txt2img", { prompt: "a red apple on a wooden table", negative_prompt: "", width: 256, height: 256, steps: 4, cfg_scale: 7, seed: 42, sampler_name: "euler_a", batch_size: 1 });
  const ok = r.status === 200 && r.json && Array.isArray(r.json.images) && r.json.images.length > 0;
  return { ok, ms: r.ms, error: ok ? null : r.text.slice(0, 160) };
}

function stats(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  const median = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  return { n: v.length, median: Math.round(median * 10) / 10, min: v[0], max: v[v.length - 1], cv: mean ? Math.round((sd / mean) * 1000) / 1000 : null };
}
const summarize = (jobs) => ({ ok: jobs.filter((j) => j.ok).length, failed: jobs.filter((j) => !j.ok).length, ms: stats(jobs.filter((j) => j.ok).map((j) => j.ms)), tps: stats(jobs.filter((j) => j.ok && j.tps).map((j) => j.tps)), errors: [...new Set(jobs.filter((j) => j.error).map((j) => j.error))].slice(0, 2) });

async function baseline(name, job, reps, extraPids) {
  await job(); // warm-up (model load, caches), not counted
  const stop = sampler(extraPids);
  const jobs = [];
  for (let i = 0; i < reps; i++) jobs.push(await job());
  emit({ kind: "baseline", workload: name, ...summarize(jobs), window: await stop() });
  console.log(`baseline ${name}: ${JSON.stringify(summarize(jobs).ms)}`);
}
async function overlap(name, fg, fgName, bg, bgName, reps, { outsideStudio = false, extraPids } = {}) {
  let running = true;
  const bgJobs = [];
  // A failing background job backs off and stops after 3 failures in a row, so it can't spin the CPU.
  const bgLoop = (async () => {
    let fails = 0;
    while (running && fails < 3) { const j = await bg(); bgJobs.push(j); if (j.ok) fails = 0; else { fails++; await sleep(1000); } }
  })();
  await sleep(500); // the background job is running
  const stop = sampler(extraPids);
  const fgJobs = [];
  for (let i = 0; i < reps; i++) fgJobs.push(await fg());
  running = false;
  const window = await stop();
  await bgLoop;
  emit({ kind: "overlap", workload: name, outsideStudio, foreground: { workload: fgName, ...summarize(fgJobs) }, background: { workload: bgName, ...summarize(bgJobs) }, window });
  console.log(`overlap ${name}: fg ${JSON.stringify(summarize(fgJobs).ms)} bg ${JSON.stringify(summarize(bgJobs).ms)}`);
}

// ── Studio server ───────────────────────────────────────────────────────────────────────────────────────────
let studio = null; let side = null;
async function startStudio() {
  const log = fs.openSync(SERVER_LOG, "w");
  studio = spawn(NODE, [SERVE], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), FRONTEND_PORT: String(PORT), ...STUDIO_ENV }, stdio: ["ignore", log, log], windowsHide: true });
  if (!(await waitUntil(async () => (await get("/api/health")).status === 200, 60000, 500))) throw new Error("studio did not start");
}
function loggedLine(re) {
  const lines = fs.readFileSync(SERVER_LOG, "utf8").split(/\r?\n/).filter((l) => re.test(l));
  return lines.length ? lines[lines.length - 1] : null;
}
const threadsArg = (line, flag) => { const m = line && line.match(new RegExp(`(?:^|\\s)${flag}\\s+(\\d+)`)); return m ? Number(m[1]) : null; };
async function stopAll() {
  if (side && side.exitCode === null) { try { side.kill(WIN ? undefined : "SIGKILL"); } catch (_) { /* gone */ } if (WIN) spawnSync("taskkill", ["/PID", String(side.pid), "/T", "/F"]); }
  try { await call(PORT, "POST", "/api/llm/stop", {}, { timeoutMs: 30000 }); } catch (_) { /* down */ }
  try { await call(PORT, "POST", "/api/stop-backend", {}, { timeoutMs: 30000 }); } catch (_) { /* down */ }
  if (studio && studio.exitCode === null) { studio.kill("SIGTERM"); await waitUntil(() => studio.exitCode !== null || studio.signalCode !== null, 20000); if (studio.exitCode === null) { try { studio.kill("SIGKILL"); } catch (_) { /* gone */ } } }
}

async function mainWhisperSet() {
  if (!jfk) throw new Error(`the transcription sample is missing: ${JFK}`);
  const wj = () => whisperJob(UI_WHISPER_THREADS);
  const start = await call(PORT, "POST", "/api/llm/start", { model: QWEN, contextSize: 2048, gpuLayers: 0 });
  if (start.status !== 200 || !(await waitUntil(async () => (await get("/api/llm/status")).json?.ready === true, 240000, 1000))) throw new Error(`text model did not load: ${start.text.slice(0, 200)}`);
  await baseline("chat", chatJob, REPS);
  await baseline("transcription", wj, REPS);
  await baseline("voice", ttsJob, REPS);
  await overlap("chat + transcription", chatJob, "chat", wj, "transcription", REPS);
  await overlap("voice + transcription", ttsJob, "voice", wj, "transcription", REPS);
  await call(PORT, "POST", "/api/llm/stop", {});
  const img = await call(PORT, "POST", "/api/restart-backend", { model: SD, width: 256, height: 256, steps: 4, backend_type: "cpu", use_gpu: false });
  if (img.status !== 200 || !(await waitUntil(async () => (await get("/api/backend-status")).json?.ready === true, 900000, 2000))) throw new Error(`image model did not load: ${img.text.slice(0, 200)}`);
  await baseline("image", imageJob, IMAGE_REPS);
  await overlap("image + transcription", imageJob, "image", wj, "transcription", IMAGE_REPS);
  const r = (await get("/api/resources")).json || {};
  emit({ kind: "policy", limitsThreads: r.limits && r.limits.threads, lastTranscription: r.threads ? r.threads.lastTranscription : null });
}

// ── Whisper thread sweep (`--set whisper-sweep`) ─────────────────────────────────────────────────────────────
// One transcription at a time, nothing else running: the same audio, model and studio, only `threads` differs.
// Configurations rotate every round (round r starts at configuration r mod k), so each one runs equally often in
// each position and slow drift on the runner does not favour one. The first job of each configuration is a
// warm-up and is not counted. Every job is checked against the studio log: the `-t` the studio passed and
// whisper.cpp's own `n_threads = N / M` line (M = the hardware concurrency whisper sees) and total time.
const SWEEP = String(arg("threads-list", "2,3,4,default")).split(",").map((s) => s.trim()).filter(Boolean);
function cpuFacts() {
  const run = (cmd, args) => { try { const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 10000 }); return r.status === 0 ? String(r.stdout).trim() : null; } catch (_) { return null; } };
  const f = { osCpusLength: os.cpus().length, availableParallelism: typeof os.availableParallelism === "function" ? os.availableParallelism() : null, cpuModel: (os.cpus()[0] || {}).model || null, totalRamMb: Math.round(os.totalmem() / 1048576) };
  if (process.platform === "darwin") {
    for (const k of ["hw.ncpu", "hw.activecpu", "hw.physicalcpu", "hw.logicalcpu", "hw.perflevel0.logicalcpu", "hw.perflevel1.logicalcpu", "machdep.cpu.brand_string", "kern.hv_vmm_present"]) f[k] = run("sysctl", ["-n", k]);
    f.affinity = "not available (macOS has no CPU affinity mask for processes)";
  } else if (process.platform === "linux") {
    f.nproc = run("nproc", []); f.nprocAll = run("nproc", ["--all"]);
    try { f.cpusAllowedList = (fs.readFileSync("/proc/self/status", "utf8").match(/Cpus_allowed_list:\s+(\S+)/) || [])[1] || null; } catch (_) { f.cpusAllowedList = null; }
    try { f.cgroupCpuMax = fs.readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim(); } catch (_) { f.cgroupCpuMax = null; }
    f.affinity = f.cpusAllowedList;
  } else if (WIN) {
    f.NUMBER_OF_PROCESSORS = process.env.NUMBER_OF_PROCESSORS || null;
    f.win32Processor = run("powershell", ["-NoProfile", "-Command", "$p=Get-CimInstance Win32_Processor; \"$($p.NumberOfCores) cores / $($p.NumberOfLogicalProcessors) logical\""]);
    f.affinity = run("powershell", ["-NoProfile", "-Command", "[Convert]::ToString([int64](Get-Process -Id $PID).ProcessorAffinity, 2)"]);
  }
  return f;
}
const logSize = () => { try { return fs.statSync(SERVER_LOG).size; } catch (_) { return 0; } };
function logSince(offset) {
  try { const fd = fs.openSync(SERVER_LOG, "r"); const size = fs.fstatSync(fd).size; const buf = Buffer.alloc(Math.max(0, size - offset)); fs.readSync(fd, buf, 0, buf.length, offset); fs.closeSync(fd); return buf.toString("utf8"); } catch (_) { return ""; }
}
async function sweepJob(config) {
  const off = logSize(); const t0 = cpuTimes(); const l0 = os.loadavg()[0];
  const j = await whisperJob(config === "default" ? null : Number(config));
  await sleep(200); // let the log flush
  const text = logSince(off);
  const passed = (text.match(/\[speech\] Starting:.*?\s-t\s+(\d+)/) || [])[1];
  const nt = text.match(/n_threads\s*=\s*(\d+)\s*\/\s*(\d+)/);
  const total = (text.match(/total time\s*=\s*([\d.]+)\s*ms/) || [])[1];
  const backend = [...new Set((text.match(/[^\n]*(Metal|Vulkan|CUDA|BLAS|no GPU found|using .*? backend)[^\n]*/gi) || []).map((s) => s.replace(/^\s*\[speech-err\]\s*/, "").trim().slice(0, 120)))].slice(0, 4);
  return { ...j, config, passedT: passed ? Number(passed) : null, whisperThreads: nt ? Number(nt[1]) : null, whisperHwThreads: nt ? Number(nt[2]) : null, whisperTotalMs: total ? Number(total) : null, cpuBusyPct: busyPct(t0, cpuTimes()), load1Before: l0, backend };
}
// Seeded bootstrap of the ratio of medians (b / a), for a 95% interval; deterministic per input.
function bootRatio(a, b, iters = 4000) {
  if (a.length < 3 || b.length < 3) return null;
  let s = 12345; const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const med = (v) => { const x = [...v].sort((p, q) => p - q); return x.length % 2 ? x[(x.length - 1) / 2] : (x[x.length / 2 - 1] + x[x.length / 2]) / 2; };
  const pick = (v) => v.map(() => v[Math.floor(rnd() * v.length)]);
  const r = []; for (let i = 0; i < iters; i++) r.push(med(pick(b)) / med(pick(a)));
  r.sort((p, q) => p - q);
  return { ratio: Math.round((med(b) / med(a)) * 100) / 100, lo: Math.round(r[Math.floor(iters * 0.025)] * 100) / 100, hi: Math.round(r[Math.floor(iters * 0.975)] * 100) / 100 };
}
async function sweepBlock(block) {
  for (const c of SWEEP) { const w = await sweepJob(c); emit({ kind: "sweep-warmup", block, ...w }); } // not counted
  for (let r = 0; r < REPS; r++) {
    for (let p = 0; p < SWEEP.length; p++) {
      const c = SWEEP[(r + p) % SWEEP.length];
      const j = await sweepJob(c);
      emit({ kind: "sweep-job", block, round: r, position: p, ...j });
      console.log(`sweep ${block} round ${r} pos ${p} t=${c}: ${j.ms} ms (whisper ${j.whisperTotalMs} ms, n_threads ${j.whisperThreads}/${j.whisperHwThreads})${j.ok ? "" : ` FAILED ${j.error}`}`);
    }
  }
}
async function mainWhisperSweep() {
  if (!jfk) throw new Error(`the transcription sample is missing: ${JFK}`);
  const res = (await get("/api/resources")).json || {};
  const speechStatus = (await get("/api/speech/status")).json || {};
  emit({ kind: "hardware", ...cpuFacts(), studioLogicalCores: res.cpu && res.cpu.logicalCores.value, studioPhysicalCores: res.cpu && res.cpu.physicalCores.value, serverDefaultThreads: (speechStatus.settings && speechStatus.settings.threads) ?? null, sweep: SWEEP, reps: REPS, studioEnv: STUDIO_ENV });
  // Block A (primary): no other engine loaded.
  await sweepBlock("no other engine");
  // Block B: the text engine loaded and idle, as in the earlier thread-bench runs.
  const start = await call(PORT, "POST", "/api/llm/start", { model: QWEN, contextSize: 2048, gpuLayers: 0 });
  if (start.status === 200 && (await waitUntil(async () => (await get("/api/llm/status")).json?.ready === true, 240000, 1000))) {
    await sweepBlock("text engine loaded, idle");
    await call(PORT, "POST", "/api/llm/stop", {});
  } else emit({ kind: "skipped", workload: "sweep with text engine idle", reason: `text model did not load: ${start.text.slice(0, 160)}` });
}
function sweepReport() {
  const hw = rows.find((r) => r.kind === "hardware") || {};
  const jobs = rows.filter((r) => r.kind === "sweep-job");
  const blocks = [...new Set(jobs.map((j) => j.block))];
  const fmtS = (s) => (s ? `${(s.median / 1000).toFixed(2)} s (${(s.min / 1000).toFixed(2)}–${(s.max / 1000).toFixed(2)}, cv ${s.cv})` : "none");
  const lines = [`## Whisper thread sweep (${PLATFORM}): ${hw.cpuModel || "?"}`, "",
    `os.cpus ${hw.osCpusLength}; availableParallelism ${hw.availableParallelism}; studio logical/physical ${hw.studioLogicalCores}/${hw.studioPhysicalCores}; server default threads ${hw.serverDefaultThreads}; affinity ${hw.affinity ?? "unknown"}` +
    (process.platform === "darwin" ? `; hw.ncpu ${hw["hw.ncpu"]}, activecpu ${hw["hw.activecpu"]}, physicalcpu ${hw["hw.physicalcpu"]}, perflevel0/1 logical ${hw["hw.perflevel0.logicalcpu"]}/${hw["hw.perflevel1.logicalcpu"]}, VM ${hw["kern.hv_vmm_present"]}` : "") +
    (process.platform === "linux" ? `; nproc ${hw.nproc} (all ${hw.nprocAll}); cgroup cpu.max ${hw.cgroupCpuMax}` : "") +
    (WIN ? `; NUMBER_OF_PROCESSORS ${hw.NUMBER_OF_PROCESSORS}; ${hw.win32Processor}` : ""),
    "", `Rounds: ${REPS}; order rotates each round; one warm-up per configuration not counted. Wall = HTTP request to the studio; whisper = whisper.cpp's own total time.`];
  for (const b of blocks) {
    const bj = jobs.filter((j) => j.block === b);
    lines.push("", `### ${b}`, "", "| threads requested | -t passed | whisper n_threads / hw | n ok (failed) | Wall median (min–max, CV) | whisper total median (CV) | CPU busy median | vs 3 threads (wall, 95% CI) |", "|---|---|---|---|---|---|---|---|");
    const wallOf = (c) => bj.filter((j) => j.config === c && j.ok).map((j) => j.ms);
    for (const c of SWEEP) {
      const cj = bj.filter((j) => j.config === c);
      const ok = cj.filter((j) => j.ok);
      const uniq = (k) => [...new Set(ok.map((j) => j[k]))].join("/");
      const ws = stats(ok.map((j) => j.whisperTotalMs));
      const bs = bootRatio(wallOf("3"), wallOf(c));
      lines.push(`| ${c} | ${uniq("passedT")} | ${uniq("whisperThreads")} / ${uniq("whisperHwThreads")} | ${ok.length} (${cj.length - ok.length}) | ${fmtS(stats(ok.map((j) => j.ms)))} | ${ws ? `${(ws.median / 1000).toFixed(2)} s (${ws.cv})` : "n/a"} | ${stats(ok.map((j) => j.cpuBusyPct))?.median ?? "?"}% | ${c === "3" || !bs ? "" : `×${bs.ratio} (${bs.lo}–${bs.hi})`} |`);
    }
    // Position check: median wall per position for each configuration (ordering bias would show here).
    lines.push("", "Median wall time by position in the round (s):", "", `| threads | ${SWEEP.map((_, p) => `pos ${p}`).join(" | ")} |`, `|---|${SWEEP.map(() => "---").join("|")}|`);
    for (const c of SWEEP) lines.push(`| ${c} | ${SWEEP.map((_, p) => { const s = stats(bj.filter((j) => j.config === c && j.ok && j.position === p).map((j) => j.ms)); return s ? (s.median / 1000).toFixed(2) : "–"; }).join(" | ")} |`);
    const be = [...new Set(bj.flatMap((j) => j.backend || []))];
    if (be.length) lines.push("", `whisper backend lines: ${be.join("; ")}`);
  }
  for (const r of rows.filter((x) => x.kind === "skipped" || x.kind === "error")) lines.push("", `**${r.kind}:** ${r.workload || ""} ${r.reason || r.error}`);
  const md = lines.join("\n");
  fs.writeFileSync(path.join(OUT, "whisper-sweep.md"), md + "\n");
  console.log(md);
}

function compare(dirA, dirB) {
  const load = (d) => fs.readFileSync(path.join(d, "thread-bench.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const A = load(dirA); const B = load(dirB);
  const cells = (rows) => { const o = {}; for (const r of rows) { if (r.kind === "baseline") o[`alone | ${r.workload}`] = r; if (r.kind === "overlap") { o[`${r.workload} | ${r.foreground.workload}`] = r.foreground; o[`${r.workload} | ${r.background.workload} (behind)`] = r.background; } } return o; };
  const a = cells(A); const b = cells(B);
  const la = (A.find((r) => r.label) || {}).label; const lb = (B.find((r) => r.label) || {}).label;
  const ms = (s) => (s && s.ms ? s.ms.median : null);
  const fmt = (s) => (s && s.ms ? `${(s.ms.median / 1000).toFixed(2)} s (cv ${s.ms.cv}, n ${s.ms.n})` : "none");
  const lines = [`## Policy comparison (${PLATFORM}): ${la} vs ${lb}`, "", `| Window | Workload | ${la} | ${lb} | Change |`, "|---|---|---|---|---|"];
  for (const k of Object.keys(a)) {
    const [w, wl] = k.split(" | ");
    const ch = ms(a[k]) && ms(b[k]) ? `${Math.round((ms(b[k]) / ms(a[k]) - 1) * 100)}%` : "n/a";
    lines.push(`| ${w} | ${wl} | ${fmt(a[k])} | ${fmt(b[k])} | ${ch} |`);
  }
  const pol = B.find((r) => r.kind === "policy");
  if (pol) lines.push("", `${lb}: limits.threads ${pol.limitsThreads}; last transcription ${JSON.stringify(pol.lastTranscription)}`);
  return lines.join("\n");
}

async function main() {
  await startStudio();
  if (SET === "whisper-sweep") return mainWhisperSweep();
  if (SET === "whisper") {
    const res = (await get("/api/resources")).json || {};
    emit({ kind: "hardware", cpuModel: (os.cpus()[0] || {}).model || null, logicalCores: res.cpu && res.cpu.logicalCores.value, physicalCores: res.cpu && res.cpu.physicalCores.value, totalRamMb: Math.round(os.totalmem() / 1048576), reps: REPS, imageReps: IMAGE_REPS, studioEnv: STUDIO_ENV });
    return mainWhisperSet();
  }
  const res = (await get("/api/resources")).json || {};
  const hw = {
    cpuModel: (os.cpus()[0] || {}).model || null,
    logicalCores: res.cpu && res.cpu.logicalCores.value, physicalCores: res.cpu && res.cpu.physicalCores.value,
    totalRamMb: Math.round(os.totalmem() / 1048576),
  };
  emit({ kind: "hardware", ...hw, reps: REPS, imageReps: IMAGE_REPS, inputs: { jfk: Boolean(jfk) } });
  console.log(`hardware: ${JSON.stringify(hw)}`);

  // Text phase: chat + speech + voice.
  const start = await call(PORT, "POST", "/api/llm/start", { model: QWEN, contextSize: 2048, gpuLayers: 0 });
  if (start.status !== 200 || !(await waitUntil(async () => (await get("/api/llm/status")).json?.ready === true, 240000, 1000))) throw new Error(`text model did not load: ${start.text.slice(0, 200)}`);
  const llmLine = loggedLine(/\[llm\] Starting:/);
  const speechStatus = (await get("/api/speech/status")).json || {};
  emit({ kind: "threads", engine: "text (llama.cpp)", configured: (await get("/api/llm/status")).json?.settings?.threads ?? null, passedToEngine: threadsArg(llmLine, "--threads"), source: "studio default min(16, logical CPUs); --threads on the logged command line", fixedAtStart: true });
  emit({ kind: "threads", engine: "speech (whisper.cpp)", configured: (speechStatus.settings && speechStatus.settings.threads) ?? null, passedToEngine: null, source: "studio default min(8, logical CPUs), passed per job as -t", fixedAtStart: false });
  emit({ kind: "threads", engine: "voice (Kokoro, onnxruntime-node)", configured: null, passedToEngine: null, source: "not set by the studio, kokoro-js or transformers.js: ONNX Runtime defaults (intra-op = physical cores)", fixedAtStart: false });

  await baseline("chat", chatJob, REPS);
  if (jfk) await baseline("transcription", whisperJob, REPS);
  await baseline("voice", ttsJob, REPS);
  if (jfk) {
    await overlap("chat + transcription", chatJob, "chat", whisperJob, "transcription", REPS);
    // The per-job lever a budget would use: whisper with 2 threads (the proposed minimum), alone and next to chat.
    await baseline("transcription (2 threads)", () => whisperJob(2), REPS);
    await overlap("chat + transcription (2 threads)", chatJob, "chat", () => whisperJob(2), "transcription (2 threads)", REPS);
  }
  await overlap("chat + voice", chatJob, "chat", ttsJob, "voice", REPS);
  // Single-engine check for a physical-core budget: chat with threads = physical cores (today: logical, max 16).
  if (hw.physicalCores && hw.logicalCores && hw.physicalCores !== hw.logicalCores) {
    await call(PORT, "POST", "/api/llm/stop", {});
    const r2 = await call(PORT, "POST", "/api/llm/start", { model: QWEN, contextSize: 2048, gpuLayers: 0, threads: hw.physicalCores });
    if (r2.status === 200 && (await waitUntil(async () => (await get("/api/llm/status")).json?.ready === true, 240000, 1000))) {
      await baseline(`chat (threads = ${hw.physicalCores} physical cores)`, chatJob, REPS);
    } else emit({ kind: "skipped", workload: "chat at physical-core threads", reason: r2.text.slice(0, 160) });
  } else emit({ kind: "skipped", workload: "chat at physical-core threads", reason: "physical and logical core counts are equal or unknown" });
  await call(PORT, "POST", "/api/llm/stop", {});

  // Image phase: image + speech + voice; image + chat outside the studio (decision B).
  const img = await call(PORT, "POST", "/api/restart-backend", { model: SD, width: 256, height: 256, steps: 4, backend_type: "cpu", use_gpu: false });
  if (img.status !== 200 || !(await waitUntil(async () => (await get("/api/backend-status")).json?.ready === true, 900000, 2000))) throw new Error(`image model did not load: ${img.text.slice(0, 200)}`);
  const sdLine = loggedLine(/\[backend\] Starting:/);
  emit({ kind: "threads", engine: "image (stable-diffusion.cpp)", configured: (await get("/api/backend-status")).json?.settings?.threads ?? null, passedToEngine: threadsArg(sdLine, "--threads"), source: "setting (default 8), at most 4 with a GPU, at most the logical CPUs (#9 cap); --threads on the logged command line", fixedAtStart: true });
  await baseline("image", imageJob, IMAGE_REPS);
  if (jfk) {
    await overlap("image + transcription", imageJob, "image", whisperJob, "transcription", IMAGE_REPS);
    await overlap("image + transcription (2 threads)", imageJob, "image", () => whisperJob(2), "transcription (2 threads)", IMAGE_REPS);
  }
  await overlap("image + voice", imageJob, "image", ttsJob, "voice", IMAGE_REPS);

  // The studio's own llama-server command line, on another port, outside the studio.
  const m = llmLine && llmLine.match(/\[llm\] Starting:\s+(.+?\S)\s+(--model .+)$/);
  if (m && fs.existsSync(m[1])) {
    const argv = m[2].split(/\s+/);
    const pi = argv.indexOf("--port"); if (pi >= 0) argv[pi + 1] = String(SIDE_PORT);
    // The same library path the studio sets for its engine (services/llm-engine.cjs).
    const env = { ...process.env };
    const dir = path.dirname(m[1]);
    if (process.platform === "linux") env.LD_LIBRARY_PATH = dir + (env.LD_LIBRARY_PATH ? `:${env.LD_LIBRARY_PATH}` : "");
    if (process.platform === "darwin") env.DYLD_LIBRARY_PATH = dir + (env.DYLD_LIBRARY_PATH ? `:${env.DYLD_LIBRARY_PATH}` : "");
    side = spawn(m[1], argv, { cwd: ROOT, env, stdio: ["ignore", fs.openSync(path.join(OUT, "side-llama.log"), "w"), fs.openSync(path.join(OUT, "side-llama.log"), "a")], windowsHide: true });
    const up = await waitUntil(async () => (await call(SIDE_PORT, "GET", "/health", undefined, { timeoutMs: 3000 })).status === 200, 180000, 1000);
    if (up) {
      const sidePid = () => [{ label: "llm (outside studio)", pid: side.pid }];
      await baseline("chat (outside studio, image engine loaded and idle)", sideChatJob, REPS, sidePid);
      await overlap("image + chat (outside studio: decision B)", imageJob, "image", sideChatJob, "chat", IMAGE_REPS, { outsideStudio: true, extraPids: sidePid });
    } else emit({ kind: "skipped", workload: "image + chat", reason: "the standalone llama-server did not become ready" });
  } else emit({ kind: "skipped", workload: "image + chat", reason: "the studio's llama-server command line was not found in its log" });
}

function report() {
  const base = Object.fromEntries(rows.filter((r) => r.kind === "baseline").map((r) => [r.workload, r]));
  const hw = rows.find((r) => r.kind === "hardware") || {};
  const med = (s) => (s && s.ms ? s.ms.median : null);
  const pct = (a, b) => (a && b ? `${Math.round((a / b - 1) * 100)}%` : "n/a");
  const lines = [`## Thread contention (${PLATFORM}): ${hw.cpuModel || "?"}, ${hw.physicalCores ?? "?"} physical / ${hw.logicalCores ?? "?"} logical cores, ${hw.totalRamMb} MB`, "",
    "| Window | Workload | Median ms (min-max, CV) | Chat tok/s | Change vs alone | CPU busy | Lowest available RAM | Engine max RSS / OS threads |", "|---|---|---|---|---|---|---|---|"];
  const engines = (w) => Object.entries(w.engines || {}).map(([k, e]) => `${k} ${e.maxRssMb ?? "?"} MB/${e.maxThreads ?? "?"}`).join("; ");
  const cell = (s) => (s && s.ms ? `${s.ms.median} (${s.ms.min}-${s.ms.max}, ${s.ms.cv})${s.failed ? `, ${s.failed} failed` : ""}` : `none completed${s && s.errors && s.errors.length ? `: ${s.errors[0]}` : ""}`);
  const baseFor = (w) => base[w] || (w === "chat" ? base.chat : null);
  for (const r of rows) {
    if (r.kind === "baseline") lines.push(`| alone | ${r.workload} | ${cell(r)} | ${r.tps ? r.tps.median : ""} | | ${r.window.cpuBusyPct}% | ${r.window.minAvailableRamMb} MB | ${engines(r.window)} |`);
    if (r.kind === "overlap") {
      const fb = r.outsideStudio && r.foreground.workload === "chat" ? base["chat (outside studio, image engine loaded and idle)"] : baseFor(r.foreground.workload);
      const bb = r.outsideStudio && r.background.workload === "chat" ? base["chat (outside studio, image engine loaded and idle)"] : baseFor(r.background.workload);
      lines.push(`| ${r.workload} | ${r.foreground.workload} (foreground) | ${cell(r.foreground)} | ${r.foreground.tps ? r.foreground.tps.median : ""} | ${pct(med(r.foreground), med(fb))} | ${r.window.cpuBusyPct}% | ${r.window.minAvailableRamMb} MB | ${engines(r.window)} |`);
      lines.push(`| ${r.workload} | ${r.background.workload} (background) | ${cell(r.background)} | ${r.background.tps ? r.background.tps.median : ""} | ${pct(med(r.background), med(bb))} | | | |`);
    }
  }
  lines.push("", "| Engine | Threads configured | Passed to the engine | Source |", "|---|---|---|---|");
  for (const r of rows.filter((x) => x.kind === "threads")) lines.push(`| ${r.engine} | ${r.configured ?? "not set"} | ${r.passedToEngine ?? (r.fixedAtStart ? "?" : "per job")} | ${r.source} |`);
  for (const r of rows.filter((x) => x.kind === "skipped" || x.kind === "error")) lines.push("", `**${r.kind}:** ${r.workload || ""} ${r.reason || r.error}`);
  const md = lines.join("\n");
  fs.writeFileSync(path.join(OUT, "thread-bench.md"), md + "\n");
  console.log(md);
}

if (process.argv.includes("--compare")) {
  const i = process.argv.indexOf("--compare");
  const md = compare(process.argv[i + 1], process.argv[i + 2]);
  fs.writeFileSync(path.join(OUT, "compare.md"), md + "\n");
  console.log(md);
} else main().catch((e) => { emit({ kind: "error", error: String(e && e.message || e) }); console.error(e); })
  .finally(async () => { await stopAll(); if (SET === "whisper-sweep") sweepReport(); else report(); });
