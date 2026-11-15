#!/usr/bin/env node
// MEASUREMENT ONLY (bench branch, never merged). Step 9.9f-3 image queue design input
// (docs/roadmap/STEP9_9F_WORKLOAD_QUEUES.md): how the real CPU sd-server behaves under concurrent requests and client
// disconnects, through the studio's /sdapi proxy and directly. It adds no queue, changes no setting (engineSlot stays
// off) and judges nothing; results are <logs>/image-measure-*.jsonl and a table. CPU only: no GPU/NPU path is measured.
//
// Workload: the native-runtime image model at 256x256, 4 steps, euler_a (the validated CPU workload); at most about
// ten images per platform, never more than two requests in flight.
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
const SD_MODEL = arg("model", "stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf");
const LOGDIR = arg("logs", path.join(ROOT, "ci-logs"));
const PORT = Number(arg("port", "14985"));
const SIZE = Number(arg("size", "256"));
const STEPS = Number(arg("steps", "4"));
const WIN = process.platform === "win32";
const LINUX = process.platform === "linux";
const PLATFORM = `${process.platform}-${process.arch}`;
const NODE = [path.join(APP, "tools", "node-win", "node.exe"), path.join(APP, "tools", "node-linux", "bin", "node"), path.join(APP, "tools", "node-mac", "bin", "node")]
  .find((p) => fs.existsSync(p)) || process.execPath;

fs.mkdirSync(LOGDIR, { recursive: true });
const RESULTS = path.join(LOGDIR, "image-measure-results.jsonl");
const SAMPLES = path.join(LOGDIR, "image-measure-samples.jsonl");
for (const f of [RESULTS, SAMPLES]) fs.writeFileSync(f, "");
const rows = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function record(name, data) {
  const row = { name, platform: PLATFORM, ...data };
  rows.push(row);
  fs.appendFileSync(RESULTS, JSON.stringify(row) + "\n");
  console.log(`- ${name}: ${JSON.stringify(data).slice(0, 600)}`);
}

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────────────────
function call(port, method, p, body, { timeoutMs = 3600000 } = {}) {
  let req;
  const t0 = Date.now();
  const promise = new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve({ ...v, ms: Date.now() - t0, endAt: Date.now() }); } };
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    req = http.request({ host: "127.0.0.1", port, path: p, method, agent: false, timeout: timeoutMs,
      headers: data ? { "content-type": "application/json", "content-length": data.length } : {} }, (res) => {
      let text = ""; res.setEncoding("utf8");
      res.on("data", (c) => { text += c; });
      res.on("end", () => done({ status: res.statusCode, text, ended: true }));
      res.on("close", () => done({ status: res.statusCode, text, ended: false }));
    });
    req.on("timeout", () => req.destroy(new Error("client timeout")));
    req.on("error", (e) => done({ status: 0, text: "", ended: false, error: e.code || e.message }));
    if (data) req.write(data);
    req.end();
  });
  return { promise, abort: () => req && req.destroy(), t0 };
}
const parseJson = (t) => { try { return JSON.parse(t); } catch (_) { return null; } };
const getJson = async (port, p) => { const r = await call(port, "GET", p, undefined, { timeoutMs: 15000 }).promise; return { status: r.status, json: parseJson(r.text) }; };
async function waitUntil(fn, ms, every = 500) {
  const end = Date.now() + ms;
  for (;;) { let v; try { v = await fn(); } catch (_) { v = undefined; } if (v) return v; if (Date.now() > end) return undefined; await sleep(every); }
}
const genBody = (seed) => ({ prompt: "a red apple on a wooden table", negative_prompt: "", width: SIZE, height: SIZE, steps: STEPS, cfg_scale: 7, seed, sampler_name: "euler_a", batch_size: 1 });
function gen(port, seed) {
  const h = call(port, "POST", "/sdapi/v1/txt2img", genBody(seed));
  const p = h.promise.then((r) => {
    const j = parseJson(r.text);
    const img = j && Array.isArray(j.images) ? j.images[0] : null;
    return { status: r.status, ms: r.ms, startAt: h.t0, endAt: r.endAt, ended: r.ended, imageBytes: img ? Math.round(img.length * 0.75) : 0, error: r.error || (j && j.error) || null };
  });
  return { promise: p, abort: h.abort, t0: h.t0 };
}

// ── Process sampling (sd-server CPU seconds and resident memory) ────────────────────────────────────────
function parsePsTime(s) {
  s = String(s || "").trim(); if (!s) return null;
  let days = 0; if (s.includes("-")) { const [d, rest] = s.split("-"); days = Number(d); s = rest; }
  let sec = 0; for (const p of s.split(":").map(Number)) sec = sec * 60 + p; return days * 86400 + sec;
}
const CLK = LINUX ? Number(spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).stdout.trim()) || 100 : 100;
function sample(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(null);
    if (LINUX) {
      try {
        const f = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
        const rss = Number((fs.readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/) || [])[1]) / 1024;
        return resolve({ cpu: (Number(f[11]) + Number(f[12])) / CLK, rssMB: Math.round(rss) });
      } catch (_) { return resolve(null); }
    }
    const cmd = WIN
      ? ["powershell", ["-NoProfile", "-NonInteractive", "-Command", `$p = Get-Process -Id ${pid}; "$($p.TotalProcessorTime.TotalSeconds) $($p.WorkingSet64)"`]]
      : ["ps", ["-o", "time=,rss=", "-p", String(pid)]];
    const c = spawn(cmd[0], cmd[1], { windowsHide: true }); let out = "";
    c.stdout.on("data", (d) => { out += d; }); c.on("error", () => resolve(null));
    c.on("close", () => {
      const [a, b] = out.trim().replace(/,/g, ".").split(/\s+/);
      if (!a) return resolve(null);
      resolve(WIN ? { cpu: Number(a), rssMB: Math.round(Number(b) / 1048576) } : { cpu: parsePsTime(a), rssMB: Math.round(Number(b) / 1024) });
    });
  });
}
// A background sampler: every second, records CPU rate (cores) and RSS of the engine.
function sampler(getPid, tag) {
  let stop = false; let last = null; const out = [];
  (async () => {
    while (!stop) {
      const t = Date.now(); const s = await sample(getPid());
      if (s && last) { const cores = (s.cpu - last.s.cpu) / ((t - last.t) / 1000); const e = { tag: tag(), t, cores: +cores.toFixed(2), rssMB: s.rssMB }; out.push(e); fs.appendFileSync(SAMPLES, JSON.stringify(e) + "\n"); }
      if (s) last = { t, s };
      await sleep(WIN ? 2000 : 1000);
    }
  })();
  return { stop: () => { stop = true; }, since: (a, b = Date.now()) => out.filter((e) => e.t >= a && e.t <= b) };
}
const peak = (xs) => xs.reduce((m, e) => Math.max(m, e.rssMB || 0), 0);
const meanCores = (xs) => (xs.length ? +(xs.reduce((s, e) => s + e.cores, 0) / xs.length).toFixed(2) : null);

function listenerPids(port) {
  if (WIN) {
    const r = spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" });
    return [...new Set((r.stdout || "").split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 5 && /LISTENING/i.test(c[3]) && c[1].endsWith(`:${port}`)).map((c) => Number(c[4])).filter((n) => n > 0))];
  }
  const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  return [...new Set((r.stdout || "").split("\n").map(Number).filter((n) => n > 0))];
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };

(async () => {
  let child = null; let smp = null; let tag = "start"; let pid = null;
  const env = { platform: PLATFORM, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, totalMemMB: Math.round(os.totalmem() / 1048576), size: SIZE, steps: STEPS, model: SD_MODEL };
  try {
    const log = fs.openSync(path.join(LOGDIR, "image-measure-studio.log"), "w");
    child = spawn(NODE, [SERVE], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), FRONTEND_PORT: String(PORT) }, stdio: ["ignore", log, log], windowsHide: true });
    if (!(await waitUntil(async () => (await getJson(PORT, "/api/health")).status === 200, 60000))) throw new Error("studio did not start");
    record("engineSlot setting (must be off: default)", { engineSlot: (await getJson(PORT, "/api/resources")).json?.limits?.engineSlot ?? "absent (off)" });

    // Load.
    const tLoad = Date.now();
    const start = await call(PORT, "POST", "/api/restart-backend", { model: SD_MODEL, width: SIZE, height: SIZE, steps: STEPS, backend_type: "cpu", use_gpu: false }).promise;
    const ready = await waitUntil(async () => { const s = (await getJson(PORT, "/api/backend-status")).json; return s && (s.ready || s.error) ? s : null; }, 900000, 1000);
    if (!ready || !ready.ready) throw new Error(`image engine did not load: ${start.status} ${String(start.text).slice(0, 160)} ${JSON.stringify(ready).slice(0, 200)}`);
    const bport = ready.port;
    pid = listenerPids(bport).filter((p) => p !== child.pid)[0];
    smp = sampler(() => pid, () => tag);
    await sleep(3000);
    const idle = await sample(pid);
    record("load", { loadMs: Date.now() - tLoad - 3000, enginePid: pid, enginePort: bport, idleRssMB: idle?.rssMB });

    // M1: single request baseline.
    tag = "M1";
    const one = await gen(PORT, 1).promise;
    const T = one.ms;
    record("M1 single request (proxy)", { status: one.status, ms: one.ms, imageBytes: one.imageBytes, peakRssMB: peak(smp.since(one.startAt, one.endAt)), meanCores: meanCores(smp.since(one.startAt, one.endAt)) });

    // M2: two concurrent requests through the proxy.
    tag = "M2"; await sleep(2000);
    const a = gen(PORT, 2); const b = gen(PORT, 3);
    const [ra, rb] = await Promise.all([a.promise, b.promise]);
    const first = Math.min(ra.ms, rb.ms); const second = Math.max(ra.ms, rb.ms);
    record("M2 two concurrent requests (proxy)", { statuses: [ra.status, rb.status], msA: ra.ms, msB: rb.ms, firstDoneMs: first, secondDoneMs: second, singleMs: T,
      reading: second > 1.6 * T && first < 1.4 * T ? "serialized (one after the other)" : (first > 1.4 * T ? "overlapped (both slowed down)" : "unclear"),
      bothImages: ra.imageBytes > 1000 && rb.imageBytes > 1000, peakRssMB: peak(smp.since(a.t0)), meanCores: meanCores(smp.since(a.t0)) });

    // M3/M4: disconnect of the running request, through the proxy and directly; then a probe request.
    for (const [name, port] of [["M3 running request, client disconnects (proxy)", PORT], ["M4 running request, client disconnects (direct to sd-server)", bport]]) {
      tag = name.slice(0, 2); await sleep(2000);
      const h = gen(port, 4);
      await sleep(Math.round(0.3 * T));
      const abortAt = Date.now(); h.abort(); const ab = await h.promise;
      await sleep(8000);
      const after = smp.since(abortAt + 1000);
      const busyAfter = meanCores(after);
      const p0 = Date.now(); const probe = await gen(PORT, 5).promise;
      record(name, { abortedAtMs: abortAt - h.t0, abortedStatus: ab.status, coresInThe8sAfterAbort: busyAfter,
        engineKeptComputing: busyAfter !== null ? busyAfter > 0.5 : null, probeStatus: probe.status, probeMs: probe.ms, singleMs: T,
        probeReading: probe.ms > 1.35 * T ? "probe waited for the abandoned job (it kept running)" : "probe ran at single-request speed (abandoned job did not hold the engine)",
        enginePidSame: listenerPids(bport).includes(pid), waitedMsBeforeProbe: p0 - abortAt });
    }

    // M5: disconnect of a request that is waiting behind a running one (proxy).
    tag = "M5"; await sleep(2000);
    const r1 = gen(PORT, 6); await sleep(2000);
    const r2 = gen(PORT, 7); await sleep(2000);
    const w0 = Date.now(); r2.abort(); const r2r = await r2.promise;
    const r1r = await r1.promise;
    await sleep(8000);
    const afterFirst = meanCores(smp.since(r1r.endAt + 1000));
    // Wait until the engine is idle (or 2.5 T), to know how long a ghost job held it.
    const idleSince = await waitUntil(async () => { const xs = smp.since(Date.now() - 4000); return xs.length >= 2 && xs.every((e) => e.cores < 0.3) ? Date.now() : null; }, Math.round(2.5 * T) + 60000, 1000);
    record("M5 waiting request, client disconnects (proxy)", { abortedWaitingAfterMs: w0 - r2.t0, abortedStatus: r2r.status, runningStatus: r1r.status, runningMs: r1r.ms, singleMs: T,
      coresInThe8sAfterRunningEnded: afterFirst, waitingJobRanAnyway: afterFirst !== null ? afterFirst > 0.5 : null,
      engineIdleAfterRunningEndedMs: idleSince ? idleSince - r1r.endAt - 4000 : null });

    // M6: state afterwards.
    tag = "M6";
    const st = (await getJson(PORT, "/api/backend-status")).json;
    const last = await gen(PORT, 8).promise;
    record("M6 after the concurrent and disconnect runs", { ready: st?.ready, error: st?.error ?? null, enginePidSame: listenerPids(bport).includes(pid), status: last.status, ms: last.ms, imageBytes: last.imageBytes, singleMs: T });

    // M7: unload.
    tag = "M7";
    const u0 = Date.now(); const stop = await call(PORT, "POST", "/api/stop-backend", {}).promise;
    const gone = await waitUntil(() => !alive(pid) && listenerPids(bport).length === 0, 60000, 200);
    record("M7 unload", { stopStatus: stop.status, stopAnsweredMs: stop.ms, processGoneMs: gone ? Date.now() - u0 : null });
  } catch (err) {
    record("measurement error", { error: err.message });
  } finally {
    if (smp) smp.stop();
    if (child) { try { await call(PORT, "POST", "/api/stop-backend", {}, { timeoutMs: 30000 }).promise; } catch (_) { /* gone */ } child.kill("SIGTERM"); await sleep(3000); try { child.kill("SIGKILL"); } catch (_) { /* gone */ } }
  }
  fs.writeFileSync(path.join(LOGDIR, "image-measure-environment.json"), JSON.stringify(env, null, 2));
  console.log(`\n(${PLATFORM}, ${env.cpus} logical CPUs, ${env.totalMemMB} MB; ${SIZE}x${SIZE}, ${STEPS} steps, CPU only)`);
  process.exit(0); // measurement: never fails the job
})();
