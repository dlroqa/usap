#!/usr/bin/env node
// Step 9.9f-3 native check: the image-generation queue (docs/roadmap/STEP9_9F_IMAGE_QUEUE.md §11.2) with the real
// sd-server and Stable Diffusion 1.5 Q4_0 on the CPU (installed by runtime-validate).
//
// Starts its own test servers on port 14985 (`--port`) from this checkout. imageQueue and engineSlot are switched on
// only in their environment; the installed default stays off (its first check). GPU and NPU paths are not exercised
// (CPU only) and are recorded as UNAVAILABLE, never as passed. Timings are evidence, not pass/fail.
//
// The D6 memory measurement (design §5.5): the studio holds three 64 MiB request bodies at once (one still being
// received by the job that has the running turn, two complete and waiting), with the real engine loaded and idle.
// The resident memory of the studio process, the engine process and this client is sampled separately before,
// during and after; the bodies are never sent to the engine (their clients leave while they wait). Stop condition:
// the scenario ends at once if the studio grows past 2 GiB or available memory (availableBytes) drops below 1 GiB.
//
//   node scripts/ci/image-queue-validate.cjs --image stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf --results out.jsonl --logs ci-logs
"use strict";
const { matchGcSample, writeTrigger } = require("./memprobe-gc.cjs"); // D6 post-GC sample ownership

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
const IMAGE = arg("image", "stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf");
const RESULTS = arg("results", path.join(ROOT, "ci-logs", "image-queue-results.jsonl"));
const LOGDIR = arg("logs", path.join(ROOT, "ci-logs"));
const PORT = Number(arg("port", "14985"));
const MiB = 1024 * 1024;
const NODE = [path.join(APP, "tools", "node-win", "node.exe"), path.join(APP, "tools", "node-linux", "bin", "node"), path.join(APP, "tools", "node-mac", "bin", "node")]
  .find((p) => fs.existsSync(p)) || process.execPath;
const GEN = { prompt: "a red apple", steps: 2, width: 128, height: 128, seed: 42, batch_size: 1 };
const STOP_STUDIO_RSS_KIB = 2 * 1024 * 1024;
const STOP_FREE_BYTES = 1024 * MiB;

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
function call(method, p, body, { timeoutMs = 900000 } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: "127.0.0.1", port: PORT, path: p, method, agent: false, timeout: timeoutMs,
      headers: data ? { "content-type": "application/json", "content-length": data.length } : {} }, (res) => {
      let text = ""; res.setEncoding("utf8");
      res.on("data", (c) => { text += c; });
      res.on("end", () => { let json = null; try { json = JSON.parse(text); } catch (_) { json = null; } resolve({ status: res.statusCode, text, json }); });
    });
    req.on("timeout", () => req.destroy(new Error("client timeout")));
    req.on("error", (err) => resolve({ status: 0, text: String(err.message), json: null }));
    if (data) req.write(data);
    req.end();
  });
}
// A generation that can be abandoned: resolves when answered; abort() makes the client leave.
function generation(body = GEN) {
  const data = Buffer.from(JSON.stringify(body));
  const t0 = Date.now();
  const req = http.request({ host: "127.0.0.1", port: PORT, path: "/sdapi/v1/txt2img", method: "POST", agent: false,
    headers: { "content-type": "application/json", "content-length": data.length } });
  const done = new Promise((resolve) => {
    req.on("response", (res) => { let t = ""; res.on("data", (c) => { t += c; }); res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch (_) { j = null; } resolve({ status: res.statusCode, json: j, ms: Date.now() - t0, endedAt: Date.now() }); }); res.on("error", () => resolve({ status: 0, ms: Date.now() - t0 })); });
    req.on("error", (e) => resolve({ status: 0, error: e.code || e.message, ms: Date.now() - t0 }));
  });
  req.end(data);
  return { done, abort: () => req.destroy() };
}
const resources = async () => (await call("GET", "/api/resources", undefined, { timeoutMs: 10000 })).json || {};
const queueNow = async () => { const r = await resources(); return { q: (r.engines && r.engines.image && r.engines.image.queue) || {}, iq: r.imageQueue || null, limits: r.limits || {} }; };
const imageLoad = () => call("POST", "/api/restart-backend", { model: IMAGE, backend_type: "cpu", use_gpu: false, width: 128, height: 128, steps: 2 });
const imageReady = () => waitUntil(async () => (await call("GET", "/api/backend-status", undefined, { timeoutMs: 10000 })).json.ready === true, 900000, 1000);
const idleEngine = () => waitUntil(async () => { const { q } = await queueNow(); return q.running === 0 && q.waiting === 0; }, 900000, 500);

function rssKiB(pid) {
  if (!pid) return null;
  try {
    if (process.platform === "linux") { const m = fs.readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+) kB/); return m ? Number(m[1]) : null; }
    if (process.platform === "darwin") { const r = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }); const n = Number(String(r.stdout).trim()); return n > 0 ? n : null; }
    if (process.platform === "win32") {
      const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`], { encoding: "utf8", windowsHide: true });
      const n = Number(String(r.stdout).trim()); return n > 0 ? Math.round(n / 1024) : null;
    }
  } catch (_) { /* unavailable */ }
  return null;
}
// The native image engine's process, verified: the supervisor's record gives the guard and the engine PID it
// reported; the engine must be a stable-diffusion.cpp binary (the names in serve.cjs BACKEND_PATHS) whose parent is
// that guard. No fallback to the guard (a Node process): an unverified identity is reported as such, never measured.
const ENGINE_NAME = /^(sd|sd-(cpu|cuda|vulkan)\.exe|sd-server-(cpu|vulkan|rocm|cuda))$/i;
function processInfo(pid) {
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      return { name: path.basename(fs.readlinkSync(`/proc/${pid}/exe`)), ppid };
    }
    if (process.platform === "darwin") {
      const r = spawnSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" });
      const m = String(r.stdout).trim().match(/^(\d+)\s+(.+)$/);
      return m ? { name: path.basename(m[2]), ppid: Number(m[1]) } : null;
    }
    if (process.platform === "win32") {
      const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}"; if ($p) { "$($p.ParentProcessId)|$($p.Name)" }`], { encoding: "utf8", windowsHide: true, timeout: 20000 });
      const m = String(r.stdout).trim().match(/^(\d+)\|(.+)$/);
      return m ? { name: m[2].trim(), ppid: Number(m[1]) } : null;
    }
  } catch (_) { /* unavailable */ }
  return null;
}
async function engineIdentity() {
  const d = (await call("GET", "/api/diagnostics", undefined, { timeoutMs: 10000 })).json;
  const r = ((d && d.engines && d.engines.processes && d.engines.processes.supervised) || []).find((x) => x.label === "image");
  if (!r) return { verified: false, why: "no supervised image engine" };
  const id = { guardPid: r.guardPid, enginePid: Number.isInteger(r.enginePid) ? r.enginePid : null, verified: false };
  if (!id.enginePid) return { ...id, why: "the guard reported no engine PID" };
  const info = processInfo(id.enginePid);
  if (!info) return { ...id, why: "engine process not readable" };
  Object.assign(id, { name: info.name, ppid: info.ppid });
  if (!ENGINE_NAME.test(info.name)) return { ...id, why: `PID ${id.enginePid} is ${info.name}, not an sd binary` };
  if (info.ppid !== id.guardPid) return { ...id, why: `parent ${info.ppid} is not the guard ${id.guardPid}` };
  return { ...id, verified: true, why: "" };
}
async function enginePid() { const id = await engineIdentity(); return id.verified ? id.enginePid : null; }
// Memory the system can still give out, per platform. os.freemem() is right on Windows (available physical memory)
// but on macOS it counts only never-used pages (inactive and purgeable memory, which macOS reclaims at once, are left
// out), so it is often a few hundred MiB on a healthy Mac; on Linux MemAvailable is the kernel's own estimate.
function availableBytes() {
  try {
    if (process.platform === "linux") { const m = fs.readFileSync("/proc/meminfo", "utf8").match(/MemAvailable:\s+(\d+) kB/); if (m) return Number(m[1]) * 1024; }
    if (process.platform === "darwin") {
      const out = String(spawnSync("vm_stat", [], { encoding: "utf8" }).stdout || "");
      const pageSize = Number((out.match(/page size of (\d+) bytes/) || [])[1]) || 4096;
      const pages = (name) => Number((out.match(new RegExp(`${name}:\\s+(\\d+)`)) || [])[1]) || 0;
      const n = pages("Pages free") + pages("Pages inactive") + pages("Pages speculative") + pages("Pages purgeable");
      if (n > 0) return n * pageSize;
    }
  } catch (_) { /* fall back */ }
  return os.freemem();
}
const mib = (kib) => (kib === null || kib === undefined ? "n/a" : `${Math.round(kib / 1024)} MiB`);

async function startServer(label, env) {
  const logPath = path.join(LOGDIR, `image-queue-${label}.log`);
  const log = fs.openSync(logPath, "w");
  const child = spawn(NODE, [SERVE], {
    cwd: ROOT, windowsHide: true, stdio: ["ignore", log, log],
    env: { ...process.env, PORT: String(PORT), FRONTEND_PORT: String(PORT), LLM_PORT: String(PORT + 1), BACKEND_PORT: String(PORT + 2), SD_BACKEND_PORT: String(PORT + 2), SPEECH_PORT: String(PORT + 3), ...env },
  });
  const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
  const srv = { label, child, exited, logPath, log: () => { try { return fs.readFileSync(logPath, "utf8"); } catch (_) { return ""; } } };
  const up = await waitUntil(async () => (await call("GET", "/api/health", undefined, { timeoutMs: 3000 })).status === 200, 60000, 500);
  if (!up) throw new Error(`server ${label} did not start (see image-queue-${label}.log)`);
  return srv;
}
async function stopServer(srv) {
  if (!srv || srv.child.exitCode !== null || srv.child.signalCode !== null) return;
  await call("POST", "/api/stop-backend", {}, { timeoutMs: 30000 });
  srv.child.kill("SIGTERM");
  let timer = null;
  const gone = await Promise.race([srv.exited, new Promise((r) => { timer = setTimeout(() => r(false), 20000); })]);
  clearTimeout(timer);
  if (!gone) { try { srv.child.kill("SIGKILL"); } catch (_) { /* gone */ } await srv.exited; }
  await waitUntil(async () => !(await portOpen(PORT)), 15000);
}
async function scenario(name, fn) { try { await fn(); } catch (err) { record(name, "FAIL", err.message); } }
const ON = { USAP_ENGINE_SLOT: "on", USAP_IMAGE_QUEUE: "on" };

// A large body held by the studio: `declared` bytes announced; `send` bytes written now; the rest only on finish().
function heldUpload(declared, send) {
  const req = http.request({ host: "127.0.0.1", port: PORT, path: "/sdapi/v1/txt2img", method: "POST", agent: false,
    headers: { "content-type": "application/json", "content-length": declared } });
  const done = new Promise((resolve) => {
    req.on("response", (res) => { let t = ""; res.on("data", (c) => { t += c; }); res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch (_) { j = null; } resolve({ status: res.statusCode, json: j }); }); });
    req.on("error", (e) => resolve({ status: 0, error: e.code || e.message }));
  });
  req.flushHeaders(); // the request reaches the server even before any body byte is written
  const block = Buffer.alloc(MiB, 97);
  let written = 0;
  const writeSome = (target) => new Promise((resolve) => {
    const more = () => {
      while (written < target) {
        const n = Math.min(block.length, target - written);
        written += n;
        if (!req.write(n === block.length ? block : block.subarray(0, n))) { req.once("drain", more); return; }
      }
      resolve();
    };
    more();
  });
  const sent = writeSome(send);
  return { done, sent, abort: () => req.destroy(), finish: () => writeSome(declared).then(() => req.end()) };
}

// A valid generation request of exactly `size` bytes: the normal JSON body followed by JSON whitespace (RFC 8259
// allows whitespace after the value), so the engine parses and runs the ordinary request. No unknown fields.
function paddedGeneration(size) {
  const head = Buffer.from(JSON.stringify(GEN));
  if (head.length > size) throw new Error("padded body smaller than the request");
  return Buffer.concat([head, Buffer.alloc(size - head.length, 0x20)]);
}
function sendBody(buf) {
  const req = http.request({ host: "127.0.0.1", port: PORT, path: "/sdapi/v1/txt2img", method: "POST", agent: false,
    headers: { "content-type": "application/json", "content-length": buf.length } });
  const done = new Promise((resolve) => {
    req.on("response", (res) => { let t = ""; res.on("data", (c) => { t += c; }); res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch (_) { j = null; } resolve({ status: res.statusCode, json: j }); }); });
    req.on("error", (e) => resolve({ status: 0, error: e.code || e.message }));
  });
  req.end(buf);
  return { done, abort: () => req.destroy() };
}
// What the verified engine process's memory figures mean, per OS (never the guard):
//   Windows: working set (resident pages, incl. shared/mapped), private working set (resident pages only this
//   process can use), private bytes (committed private memory, resident or paged out); shared = working set minus
//   private working set (mapped files such as the model, DLLs). None of these alone is "all memory of the model":
//   model file pages that are mapped but not resident appear in none of them.
//   Linux: RSS split into anonymous (heap, tensors copied into memory), file-backed (mapped model and libraries) and
//   shared memory, from /proc/<pid>/status.  macOS: resident size only (ps); no breakdown is recorded.
function engineMemory(pid) {
  try {
    if (process.platform === "win32") {
      const ps = `$p = Get-Process -Id ${Number(pid)}; $f = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter "IDProcess=${Number(pid)}"; ` +
        `"$($p.WorkingSet64)|$($p.PrivateMemorySize64)|$($f.WorkingSetPrivate)"`;
      const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true, timeout: 30000 });
      const [ws, priv, wsPriv] = String(r.stdout).trim().split("|").map(Number);
      if (!(ws > 0)) return null;
      const M = (b) => (b > 0 ? `${Math.round(b / MiB)} MiB` : "n/a");
      return { detail: `working set ${M(ws)}; private working set ${M(wsPriv)}; shared working set ${wsPriv > 0 ? M(ws - wsPriv) : "n/a"} (mapped files and DLLs); private bytes ${M(priv)} (committed, resident or paged out). Mapped model pages that are not resident appear in none of these.` };
    }
    if (process.platform === "linux") {
      const t = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const kb = (k) => { const m = t.match(new RegExp(`${k}:\\s+(\\d+) kB`)); return m ? Math.round(Number(m[1]) / 1024) : null; };
      return { detail: `RSS ${kb("VmRSS")} MiB = anonymous ${kb("RssAnon")} MiB + file-backed ${kb("RssFile")} MiB (mapped model and libraries) + shared ${kb("RssShmem")} MiB` };
    }
    if (process.platform === "darwin") {
      const k = rssKiB(pid);
      return k ? { detail: `resident ${Math.round(k / 1024)} MiB (ps; macOS gives no private/shared split here)` } : null;
    }
  } catch (_) { /* unavailable */ }
  return null;
}

(async () => {
  console.log(`| Check | Result | Detail |\n|---|---|---|`);
  if (!fs.existsSync(path.join(APP, "models", IMAGE))) {
    record("Model installed", "FAIL", `need app/models/${IMAGE} (runtime-validate installs it)`);
    process.exit(1);
  }
  await scenario("Default: imageQueue off", async () => {
    const srv = await startServer("default", { USAP_IMAGE_QUEUE: "", USAP_ENGINE_SLOT: "" });
    try {
      const r = await resources();
      const q = r.engines && r.engines.image && r.engines.image.queue;
      const ok = !("imageQueue" in r) && !("imageQueue" in (r.limits || {})) && q && q.known === false;
      record("Default: imageQueue off", ok ? "PASS" : "FAIL", `imageQueue key ${"imageQueue" in r ? "present" : "absent"}; image queue known ${q && q.known}`);
      const load = await imageLoad(); await imageReady();
      const g = await generation().done;
      record("Default: a generation answers as before", load.status === 200 && g.status === 200 && g.json && Array.isArray(g.json.images) ? "PASS" : "FAIL", `load ${load.status}, generate ${g.status} in ${g.ms} ms`);
    } finally { await stopServer(srv); }
  });
  await scenario("imageQueue on without engineSlot stays off", async () => {
    const srv = await startServer("noslot", { USAP_IMAGE_QUEUE: "on", USAP_ENGINE_SLOT: "" });
    try {
      const r = await resources();
      const logged = /image queue "on" is not supported without engineSlot and stays off/.test(srv.log());
      record("imageQueue on without engineSlot stays off", !("imageQueue" in r) && logged ? "PASS" : "FAIL", `imageQueue key ${"imageQueue" in r ? "present" : "absent"}; refusal logged ${logged}`);
    } finally { await stopServer(srv); }
  });
  await scenario("USAP_SCHEDULER=off rollback", async () => {
    const srv = await startServer("rollback", { ...ON, USAP_SCHEDULER: "off" });
    try {
      const r = await call("GET", "/api/resources", undefined, { timeoutMs: 10000 });
      const notQueued = !/Image queue on/.test(srv.log());
      record("USAP_SCHEDULER=off rollback", notQueued ? "PASS" : "FAIL", `queue started ${!notQueued}; /api/resources ${r.status} (left out when the scheduler is off)`);
    } finally { await stopServer(srv); }
  });

  let srv = null;
  try {
    srv = await startServer("on", ON);
    const load = await imageLoad();
    await imageReady();
    record("Load with imageQueue + engineSlot on", load.status === 200 ? "PASS" : "FAIL", `load ${load.status}`);
    const pid = await enginePid();

    await scenario("Two requests run one after the other", async () => {
      const a = generation();
      await waitUntil(async () => (await queueNow()).q.running === 1, 30000, 100);
      const b = generation({ ...GEN, seed: 43 });
      const mid = await waitUntil(async () => { const { q } = await queueNow(); return q.running === 1 && q.waiting === 1 ? q : null; }, 30000, 100);
      const [ra, rb] = await Promise.all([a.done, b.done]);
      const { q } = await queueNow();
      const ok = ra.status === 200 && rb.status === 200 && rb.endedAt - ra.endedAt >= Math.min(ra.ms * 0.5, 1000);
      record("Two requests run one after the other", ok ? "PASS" : "FAIL", `A ${ra.status} in ${ra.ms} ms, B ${rb.status} in ${rb.ms} ms (B ended ${rb.endedAt - ra.endedAt} ms after A); saw running 1 / waiting ${mid ? mid.waiting : "?"}; now running ${q.running}`);
    });
    await scenario("A waiting request whose client leaves never reaches the engine", async () => {
      const before = (await queueNow()).iq.counts;
      const a = generation(); await waitUntil(async () => (await queueNow()).q.running === 1, 30000, 100);
      const b = generation({ ...GEN, seed: 44 }); await waitUntil(async () => (await queueNow()).q.waiting === 1, 30000, 100);
      b.abort();
      await waitUntil(async () => (await queueNow()).q.waiting === 0, 10000, 100);
      const ra = await a.done;
      await sleep(3000);
      const after = (await queueNow()).iq.counts;
      const progress = (await call("GET", "/api/generation-progress", undefined, { timeoutMs: 10000 })).json || {};
      const forwarded = after.forwarded - before.forwarded;
      const ok = ra.status === 200 && forwarded === 1 && after.leftWhileWaiting - before.leftWhileWaiting === 1 && progress.active !== true;
      record("A waiting request whose client leaves never reaches the engine", ok ? "PASS" : "FAIL", `forwarded ${forwarded} (only A); left while waiting ${after.leftWhileWaiting - before.leftWhileWaiting}; engine generating 3 s after A: ${Boolean(progress.active)}`);
    });
    await scenario("A running request whose client leaves keeps ownership until the engine finishes", async () => {
      const before = (await queueNow()).iq.counts;
      const a = generation(); await waitUntil(async () => (await queueNow()).q.running === 1, 30000, 100);
      await sleep(200);
      a.abort();
      const abandoned = await waitUntil(async () => { const { q } = await queueNow(); return q.abandoned === true && q.running === 1 ? q : null; }, 10000, 100);
      const b = generation({ ...GEN, seed: 45 });
      const rb = await b.done;
      const after = (await queueNow()).iq.counts;
      const ok = Boolean(abandoned) && rb.status === 200 && after.completed - before.completed === 2 && after.leftWhileRunning - before.leftWhileRunning === 1;
      record("A running request whose client leaves keeps ownership until the engine finishes", ok ? "PASS" : "FAIL", `shown abandoned ${Boolean(abandoned)}; next ${rb.status} in ${rb.ms} ms; completed +${after.completed - before.completed} (the abandoned job ran to its end)`);
    });
    await scenario("Stop refuses waiting requests", async () => {
      const a = generation(); await waitUntil(async () => (await queueNow()).q.running === 1, 30000, 100);
      const b = generation({ ...GEN, seed: 46 }); await waitUntil(async () => (await queueNow()).q.waiting === 1, 30000, 100);
      const st = await call("POST", "/api/stop-backend", {});
      const [ra, rb] = await Promise.all([a.done, b.done]);
      const ok = st.status === 200 && rb.status === 503 && rb.json && rb.json.code === "ENGINE_NOT_READY" && /^Generation failed: /.test(rb.json.detail || "");
      record("Stop refuses waiting requests", ok ? "PASS" : "FAIL", `stop ${st.status}; waiting ${rb.status} ${rb.json && rb.json.code}; running ${ra.status || ra.error}`);
      const after = await queueNow();
      record("Nothing held after stop", after.iq.memory.reservedBytes === 0 && after.iq.memory.heldJobs === 0 && after.q.running === 0 ? "PASS" : "FAIL", JSON.stringify(after.iq.memory));
    });
    void pid;
  } finally { await stopServer(srv); srv = null; }

  // ── D6 memory measurement ──
  // Studio: resident memory from the OS, plus heap / external / arrayBuffers from a validator-only probe loaded into
  // this studio only (image-queue-memprobe.cjs, --expose-gc). Engine: the verified sd process (engineIdentity), never
  // the guard. Client: this process. "Released" is judged on arrayBuffers after a forced GC (buffers still referenced),
  // not on RSS (Node and the allocator need not return freed memory to the OS). Bounded repeated cycles then check that
  // retained buffers do not grow: cancellation (all three clients leave) x4, and one body forwarded to the engine.
  await scenario("D6 peak memory, three 64 MiB bodies held", async () => {
    const probeFile = path.join(LOGDIR, "image-queue-memprobe.json");
    try { fs.unlinkSync(probeFile); } catch (_) { /* none */ }
    srv = await startServer("memory", { ...ON, USAP_IMAGE_QUEUE_BODY_BUDGET_BYTES: String(192 * MiB), USAP_IQ_MEMPROBE: probeFile,
      NODE_OPTIONS: `--expose-gc --require ${JSON.stringify(path.join(__dirname, "image-queue-memprobe.cjs"))}` });
    const uploads = [];
    let stopped = null;
    const readProbe = () => { try { return JSON.parse(fs.readFileSync(probeFile, "utf8")); } catch (_) { return null; } };
    let gcSeq = 0;
    // Each request has its own id (this run's nonce + sequence); the answer must come from the studio process being
    // measured, taken after the request (scripts/ci/memprobe-gc.cjs). The probe keeps its last post-GC sample until the
    // next request, so a late read still finds it. Same 10 s bound; a sample that never comes is still missing.
    const gcNonce = require("crypto").randomBytes(4).toString("hex");
    const gcSample = async (pid) => {
      const id = `gc-${gcNonce}-${++gcSeq}`;
      const requestedAt = Date.now();
      writeTrigger(`${probeFile}.gc`, id);
      return waitUntil(() => matchGcSample(readProbe(), { id, pid, requestedAt }), 10000, 100);
    };
    const MB = (b) => (typeof b === "number" ? `${Math.round(b / MiB)} MiB` : "n/a");
    try {
      const load = await imageLoad(); await imageReady();
      if (load.status !== 200) throw new Error(`load ${load.status}`);
      const eng = await engineIdentity();
      record("D6 engine process identity", eng.verified ? "PASS" : "FAIL", eng.verified
        ? `engine PID ${eng.enginePid} is ${eng.name}, child of guard PID ${eng.guardPid}; the guard is measured separately`
        : `not verified (${eng.why}); engine memory is not reported`);
      const ePid = eng.verified ? eng.enginePid : null;
      const gPid = eng.guardPid || null;
      const sPid = srv.child.pid;
      const sample = () => ({ studio: rssKiB(sPid), engine: ePid ? rssKiB(ePid) : null, guard: gPid ? rssKiB(gPid) : null, client: Math.round(process.memoryUsage().rss / 1024), free: availableBytes(), probe: readProbe() });
      const overLimit = (s) => (s.studio && s.studio > STOP_STUDIO_RSS_KIB) || s.free < STOP_FREE_BYTES;
      await sleep(2000);
      const probeOk = Boolean(await waitUntil(() => { const p = readProbe(); return p && p.pid === sPid && p.gcAvailable; }, 10000, 200));
      const baseGc = probeOk ? await gcSample(sPid) : null;
      const base = sample();
      const before = (await queueNow()).iq.counts;
      // One cycle: A has the running turn with 63 of 64 MiB sent (its upload stays open), B and C complete and waiting;
      // then every client leaves (waiting first, so the turn is never handed to a held body). Nothing is forwarded.
      const holdCycle = async () => {
        const A = heldUpload(64 * MiB, 63 * MiB); uploads.push(A);
        await waitUntil(async () => (await queueNow()).q.running === 1, 20000, 100);
        await A.sent;
        const B = heldUpload(64 * MiB, 64 * MiB); uploads.push(B); await B.sent;
        const C = heldUpload(64 * MiB, 64 * MiB); uploads.push(C); await C.sent;
        const held = await waitUntil(async () => { const { iq, q } = await queueNow(); return iq.memory.reservedBytes === 192 * MiB && q.waiting === 2 ? iq.memory : null; }, 60000, 200);
        await sleep(1500); // let the last chunks land
        let peak = sample();
        for (let i = 0; i < 10; i += 1) {
          const s = sample();
          if (s.studio && (!peak.studio || s.studio > peak.studio)) peak = s;
          if (overLimit(s)) { stopped = s; break; }
          await sleep(500);
        }
        C.abort(); B.abort();
        await waitUntil(async () => (await queueNow()).q.waiting === 0, 10000, 100);
        A.abort();
        const released = await waitUntil(async () => { const { iq, q } = await queueNow(); return iq.memory.reservedBytes === 0 && iq.memory.heldJobs === 0 && q.running === 0 && q.waiting === 0 ? iq : null; }, 30000, 200);
        await sleep(1000);
        const after = sample();
        const afterGc = probeOk ? await gcSample(sPid) : null;
        return { held, peak, released: Boolean(released), after, afterGc };
      };
      const c1 = await holdCycle();
      const forwarded1 = (await queueNow()).iq.counts.forwarded - before.forwarded;
      const peakP = c1.peak.probe || {};
      record("D6 peak memory, three 64 MiB bodies held", stopped ? "FAIL" : "MEASURED",
        `held ${c1.held ? Math.round(c1.held.reservedBytes / MiB) : "?"} MiB in ${c1.held ? c1.held.heldJobs : "?"} jobs; studio RSS ${mib(base.studio)} -> peak ${mib(c1.peak.studio)} (+${base.studio && c1.peak.studio ? Math.round((c1.peak.studio - base.studio) / 1024) : "?"} MiB) -> ${mib(c1.after.studio)} after release; studio arrayBuffers ${MB(baseGc && baseGc.arrayBuffers)} -> ${MB(peakP.arrayBuffers)} at the peak, heapUsed ${MB(baseGc && baseGc.heapUsed)} -> ${MB(peakP.heapUsed)}, external ${MB(baseGc && baseGc.external)} -> ${MB(peakP.external)}; engine RSS ${eng.verified ? `${mib(base.engine)} -> ${mib(c1.peak.engine)} (loaded, idle)` : "n/a (identity not verified)"}; guard RSS ${mib(base.guard)}; client ${mib(c1.peak.client)}; available memory ${Math.round(base.free / MiB)} MiB before, ${Math.round(c1.peak.free / MiB)} MiB at the peak${stopped ? `; STOP CONDITION at studio ${mib(stopped.studio)}, available ${Math.round(stopped.free / MiB)} MiB` : ""}`);
      record("D6 bodies released, none forwarded to the engine", c1.released && forwarded1 === 0 ? "PASS" : "FAIL", `queue count: reserved 0 and held jobs 0 ${c1.released ? "reached" : "NOT reached"}; forwarded ${forwarded1}`);
      // Buffers still referenced after a full GC: back near the baseline (64 MiB margin, a third of one body).
      const RETAIN_MARGIN = 64 * MiB;
      const gcOk = (g) => Boolean(g && baseGc && g.arrayBuffers <= baseGc.arrayBuffers + RETAIN_MARGIN);
      record("D6 body buffers unreferenced after release (forced GC)", probeOk && gcOk(c1.afterGc) ? "PASS" : "FAIL",
        probeOk ? `studio arrayBuffers after GC: baseline ${MB(baseGc.arrayBuffers)}, after release ${MB(c1.afterGc && c1.afterGc.arrayBuffers)} (192 MiB were held; margin ${MB(RETAIN_MARGIN)}); heapUsed ${MB(baseGc.heapUsed)} -> ${MB(c1.afterGc && c1.afterGc.heapUsed)}; RSS after release ${mib(c1.after.studio)} (resident, not a leak measure)` : "studio memory probe unavailable");
      if (stopped) return;
      // Bounded repetition: seven more cancellation cycles (8 in all), each sampled after release before and after a
      // forced GC, then one valid 64 MiB generation request forwarded to the engine (the forwarded path's release).
      const series = [c1];
      for (let i = 2; i <= 8 && !stopped; i += 1) series.push(await holdCycle());
      const ab = series.map((c) => (c.afterGc ? Math.round(c.afterGc.arrayBuffers / MiB) : "?"));
      const abPre = series.map((c) => (c.after.probe ? Math.round(c.after.probe.arrayBuffers / MiB) : "?"));
      const rss = series.map((c) => (c.after.studio ? Math.round(c.after.studio / 1024) : "?"));
      const grew = probeOk && series.length >= 2 && series[series.length - 1].afterGc && series[0].afterGc
        && series[series.length - 1].afterGc.arrayBuffers - series[0].afterGc.arrayBuffers > 16 * MiB;
      const half = Math.floor(series.length / 2);
      const rssStep = (a, b) => (series[a].after.studio && series[b].after.studio ? Math.round((series[b].after.studio - series[a].after.studio) / 1024) : "?");
      const okCycles = probeOk && !stopped && series.every((c) => c.released && gcOk(c.afterGc)) && !grew;
      record("D6 repeated cycles: no growing retained buffers", okCycles ? "PASS" : "FAIL",
        `${series.length} cancellation cycles of 192 MiB; studio arrayBuffers after release: before forced GC ${abPre.join(",")} MiB, after forced GC ${ab.join(",")} MiB (baseline ${MB(baseGc && baseGc.arrayBuffers)}); studio RSS after each ${rss.join(",")} MiB (cycles 1-${half}: ${rssStep(0, half - 1)} MiB, ${half + 1}-${series.length}: ${rssStep(half, series.length - 1)} MiB; resident memory and allocator retention, not referenced buffers)${stopped ? `; STOP CONDITION at studio ${mib(stopped.studio)}, available ${Math.round(stopped.free / MiB)} MiB` : ""}`);
      if (!stopped) {
        await idleEngine();
        const before2 = (await queueNow()).iq.counts.forwarded;
        const body = paddedGeneration(64 * MiB);
        const F = sendBody(body); uploads.push(F);
        const rf = await Promise.race([F.done, sleep(300000).then(() => ({ status: "timeout" }))]);
        await waitUntil(async () => { const { iq, q } = await queueNow(); return iq.memory.reservedBytes === 0 && q.running === 0 ? iq : null; }, 60000, 200);
        await sleep(1000);
        const s = sample(); if (overLimit(s)) stopped = s;
        const pre = s.probe;
        const post = probeOk ? await gcSample(sPid) : null;
        const images = rf.json && Array.isArray(rf.json.images) ? rf.json.images.length : 0;
        const fwdOk = rf.status === 200 && images >= 1 && (await queueNow()).iq.counts.forwarded - before2 === 1 && gcOk(post) && !stopped;
        record("D6 valid 64 MiB request forwarded and released", fwdOk ? "PASS" : "FAIL",
          `a ${Math.round(body.length / MiB)} MiB generation request (the normal JSON body followed by JSON whitespace, valid under the engine's parser) answered ${rf.status} with ${images} image(s); studio arrayBuffers after release ${MB(pre && pre.arrayBuffers)} before forced GC, ${MB(post && post.arrayBuffers)} after; studio RSS ${mib(s.studio)}; engine RSS ${eng.verified ? mib(s.engine) : "n/a"}${stopped ? "; STOP CONDITION" : ""}`);
      }
      if (eng.verified) {
        const m = engineMemory(eng.enginePid);
        record("D6 engine memory breakdown (verified engine process)", m ? "MEASURED" : "UNAVAILABLE", m ? m.detail : "no breakdown available on this OS");
      }
    } finally { for (const u of uploads) u.abort(); await stopServer(srv); srv = null; try { fs.unlinkSync(`${probeFile}.gc`); } catch (_) { /* none */ } try { for (const f of fs.readdirSync(path.dirname(probeFile))) if (f.startsWith(`${path.basename(probeFile)}.gc.`) && f.endsWith(".tmp")) fs.unlinkSync(path.join(path.dirname(probeFile), f)); } catch (_) { /* none */ } }
  });
  await scenario("Default budget refuses a third 64 MiB body", async () => {
    srv = await startServer("budget", ON);
    const uploads = [];
    try {
      const load = await imageLoad(); await imageReady();
      if (load.status !== 200) throw new Error(`load ${load.status}`);
      const A = heldUpload(64 * MiB, 63 * MiB); uploads.push(A); await A.sent;
      const B = heldUpload(64 * MiB, 64 * MiB); uploads.push(B); await B.sent;
      await waitUntil(async () => (await queueNow()).iq.memory.reservedBytes === 128 * MiB, 30000, 200);
      const C = heldUpload(64 * MiB, 0); uploads.push(C); // sends nothing: refused at admission, before any body byte
      const rc = await Promise.race([C.done, sleep(30000).then(() => ({ status: "timeout" }))]);
      const ok = rc.status === 429 && rc.json && rc.json.reason === "body-budget";
      record("Default budget refuses a third 64 MiB body", ok ? "PASS" : "FAIL", `third ${rc.status} ${rc.json && rc.json.code} ${rc.json && rc.json.reason}`);
    } finally { for (const u of uploads) u.abort(); await stopServer(srv); srv = null; }
  });
  record("GPU / NPU image queue", "UNAVAILABLE", "CPU only on hosted runners; Vulkan, CUDA, ROCm, Metal, Core ML and OpenVINO are not exercised");
  process.exit(failed ? 1 : 0);
})().catch((err) => { record("validator", "FAIL", err.stack || err.message); process.exit(1); });
