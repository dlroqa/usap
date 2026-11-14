#!/usr/bin/env node
// Step 9.9f-2 native check: memory-aware text-model load admission with a real model (Qwen2.5 0.5B Q4_K_M, CPU).
//
// Starts its own test servers on port 14950 (`--port`) from this checkout, with memory admission switched on only in
// their environment; the installed default stays off. It never tries to exhaust a runner's memory: the test-only
// setting USAP_TEST_MEMORY_ADMISSION_INFLATE_BYTES adds to the estimated need (it can only make a refusal more
// likely), so a "may-not-fit" verdict is produced on purpose.
//
// What it checks (one line per result: PASS / FAIL / UNSUPPORTED, never a pass for something that didn't run):
//   * off (default): the start response has no admission object; the model loads and answers.
//   * observe: the inflated load still loads and answers; the decision is recorded (Linux: would-refuse;
//     Windows/macOS: allowed with low confidence, because their memory readings aren't validated for refusals).
//   * enforce, memory mapping off (`mmap: false`, the only kind of load that can be refused):
//       Linux: 409 MEMORY_INSUFFICIENT, overridable false, no llama-server started, memoryOverride:true still refused.
//       Windows/macOS: allowed (C3, unvalidated source): the designed result, recorded as such.
//   * enforce, memory mapping on (default): allowed, loads and answers (C8).
//   * enforce: a killed engine is restarted (the restart is assessed as exempt, never refused).
// And records measurements as evidence (not pass/fail): the 9.9d estimate against the engine's resident memory
// after load and after a chat, the available reading at the decision against the drop after load, the reading's
// source and age, Linux cgroup state, Windows commit limit and charge, macOS cached against fresh vm_stat.
//
//   node scripts/ci/memory-admission-validate.cjs --model qwen2.5-0.5b-instruct-q4_k_m.gguf --results out.jsonl
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
const MODEL = arg("model", "qwen2.5-0.5b-instruct-q4_k_m.gguf");
const RESULTS = arg("results", path.join(ROOT, "ci-logs", "memory-admission-results.jsonl"));
const LOGDIR = arg("logs", path.join(ROOT, "ci-logs"));
const PORT = Number(arg("port", "14950"));
const WIN = process.platform === "win32";
const LINUX = process.platform === "linux";
const NODE = [path.join(APP, "tools", "node-win", "node.exe"), path.join(APP, "tools", "node-linux", "bin", "node"), path.join(APP, "tools", "node-mac", "bin", "node")]
  .find((p) => fs.existsSync(p)) || process.execPath;
const GIB = 1024 ** 3;
const INFLATE = { USAP_TEST_MEMORY_ADMISSION_INFLATE_BYTES: String(64 * 1024 * GIB) }; // 64 TiB: never fits anywhere

fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
fs.mkdirSync(LOGDIR, { recursive: true });
fs.writeFileSync(RESULTS, "");
let failed = false;
function record(check, status, detail) {
  const d = String(detail).replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 600);
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
function call(method, p, body, { timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: "127.0.0.1", port: PORT, path: p, method, agent: false, timeout: timeoutMs,
      headers: data ? { "content-type": "application/json", "content-length": data.length } : {} }, (res) => {
      let text = ""; res.setEncoding("utf8");
      res.on("data", (c) => { text += c; });
      res.on("end", () => { let json = null; try { json = JSON.parse(text); } catch (_) { json = null; } resolve({ status: res.statusCode, text, json }); });
    });
    req.on("timeout", () => req.destroy(new Error("client timeout")));
    req.on("error", (e) => resolve({ status: 0, text: "", json: null, error: e.code || e.message }));
    if (data) req.write(data);
    req.end();
  });
}
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
const ps = (cmd) => spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], { encoding: "utf8", timeout: 60000 });
/** Resident memory of a process in bytes, or null. */
function rssBytes(pid) {
  try {
    if (LINUX) { const m = fs.readFileSync(`/proc/${pid}/status`, "utf8").match(/^VmRSS:\s+(\d+)\s+kB/m); return m ? Number(m[1]) * 1024 : null; }
    if (WIN) { const n = Number(String(ps(`(Get-Process -Id ${pid}).WorkingSet64`).stdout || "").trim()); return n > 0 ? n : null; }
    const r = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
    const n = Number(String(r.stdout || "").trim()); return n > 0 ? n * 1024 : null;
  } catch (_) { return null; }
}
const gb = (n) => (typeof n === "number" && Number.isFinite(n) ? `${(n / GIB).toFixed(2)} GB` : "n/a");

// ── Servers ─────────────────────────────────────────────────────────────────────────────────────────────
let current = null;
async function startServer(label, env) {
  const log = fs.openSync(path.join(LOGDIR, `memory-admission-${label}.log`), "w");
  const child = spawn(NODE, [SERVE], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), FRONTEND_PORT: String(PORT), ...env }, stdio: ["ignore", log, log], windowsHide: true });
  const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
  const srv = { label, child, exited, logPath: path.join(LOGDIR, `memory-admission-${label}.log`) };
  current = srv;
  const up = await waitUntil(async () => (await call("GET", "/api/health", undefined, { timeoutMs: 3000 })).status === 200, 60000, 500);
  if (!up) throw new Error(`server ${label} did not start (see memory-admission-${label}.log)`);
  return srv;
}
async function stopServer(srv) {
  if (!srv || srv.child.exitCode !== null || srv.child.signalCode !== null) return;
  await call("POST", "/api/llm/stop", {}, { timeoutMs: 30000 });
  srv.child.kill("SIGTERM");
  let timer = null;
  const gone = await Promise.race([srv.exited, new Promise((r) => { timer = setTimeout(() => r(false), 20000); })]);
  clearTimeout(timer);
  if (!gone) { try { srv.child.kill("SIGKILL"); } catch (_) { /* gone */ } await srv.exited; }
  await waitUntil(async () => !(await portOpen(PORT)), 15000);
  current = null;
}
const start = (body = {}) => call("POST", "/api/llm/start", { model: MODEL, contextSize: 2048, gpuLayers: 0, ...body });
const status = async () => (await call("GET", "/api/llm/status", undefined, { timeoutMs: 10000 })).json || {};
const resources = async () => (await call("GET", "/api/resources", undefined, { timeoutMs: 10000 })).json || {};
const ready = () => waitUntil(async () => (await status()).ready === true, 240000, 1000);
const chatOk = async () => {
  const r = await call("POST", "/api/llm/chat", { messages: [{ role: "user", content: "Say hello in three words." }], max_tokens: 16, temperature: 0, stream: false });
  return r.status === 200 && r.json && Array.isArray(r.json.choices) ? r : null;
};
const logText = (srv) => { try { return fs.readFileSync(srv.logPath, "utf8"); } catch (_) { return ""; } };

async function scenario(name, fn) { try { await fn(); } catch (err) { record(name, "FAIL", err.message); } }

// ── Evidence ──────────────────────────────────────────────────────────────────────────────────────────────
function platformMemoryEvidence() {
  const out = {};
  if (LINUX) {
    try { out.cgroup = require(path.join(ROOT, "scripts", "server", "services", "memory-admission.cjs")).cgroupMemoryLimit({ totalBytes: os.totalmem() }).state; } catch (e) { out.cgroup = `error ${e.message}`; }
    try { const m = fs.readFileSync("/proc/meminfo", "utf8"); out.memAvailable = gb(Number((m.match(/^MemAvailable:\s+(\d+)/m) || [])[1]) * 1024); out.commitLimit = gb(Number((m.match(/^CommitLimit:\s+(\d+)/m) || [])[1]) * 1024); out.committed = gb(Number((m.match(/^Committed_AS:\s+(\d+)/m) || [])[1]) * 1024); } catch (_) { /* recorded as missing */ }
  } else if (WIN) {
    const r = ps("$o = Get-CimInstance Win32_OperatingSystem; \"$($o.TotalVisibleMemorySize) $($o.FreePhysicalMemory) $($o.TotalVirtualMemorySize) $($o.FreeVirtualMemory)\"");
    const [tot, free, vtot, vfree] = String(r.stdout || "").trim().split(/\s+/).map((n) => Number(n) * 1024);
    out.physicalFree = gb(free); out.physicalTotal = gb(tot); out.commitLimit = gb(vtot); out.commitCharge = gb(vtot - vfree);
  } else {
    const r = spawnSync("vm_stat", [], { encoding: "utf8" });
    const page = Number((String(r.stdout).match(/page size of (\d+) bytes/) || [])[1]) || 4096;
    const v = (k) => Number((String(r.stdout).match(new RegExp(`${k}:\\s+(\\d+)\\.`)) || [])[1]) || 0;
    out.vmStatFresh = gb((v("Pages free") + v("Pages inactive") + v("Pages speculative")) * page);
    out.vmStatPurgeable = gb(v("Pages purgeable") * page);
    out.vmStatCompressed = gb(v("Pages occupied by compressor") * page);
  }
  return out;
}

(async () => {
  if (!fs.existsSync(path.join(APP, "llm-models", MODEL))) { record("Memory admission (9.9f-2)", "FAIL", `model ${MODEL} is not installed`); process.exit(1); }

  // A. off (default): legacy start response, no admission anywhere.
  await scenario("Memory admission off (default): legacy response", async () => {
    const srv = await startServer("off", {});
    try {
      const r = await start({ mmap: false, memoryOverride: true });
      await ready();
      const res = await resources();
      const legacy = r.status === 200 && r.json && r.json.memoryCheck && !("admission" in r.json.memoryCheck) && !r.text.includes("memoryOverride") && !("memoryAdmission" in res) && !/\[memory\] admission/.test(logText(srv));
      const answered = Boolean(await chatOk());
      record("Memory admission off (default): legacy response", legacy && answered ? "PASS" : "FAIL",
        `start ${r.status}; admission object: ${r.json && r.json.memoryCheck && "admission" in r.json.memoryCheck}; /api/resources memoryAdmission: ${"memoryAdmission" in res}; chat answered: ${answered}`);
    } finally { await stopServer(srv); }
  });

  // B. observe, inflated, mapping off: loads and answers; decision recorded. Plus the measurements.
  await scenario("Memory admission observe: outcome unchanged", async () => {
    const srv = await startServer("observe", { USAP_MEMORY_ADMISSION: "observe", ...INFLATE });
    try {
      const r = await start({ mmap: false });
      const a = r.json && r.json.memoryCheck && r.json.memoryCheck.admission;
      const ok = r.status === 200 && Boolean(await ready());
      const answered = ok && Boolean(await chatOk());
      const expected = LINUX ? ["would-refuse", "allowed"] : ["allowed"];
      const decisionOk = a && expected.includes(a.decision) && (a.decision === "would-refuse" || a.confidence === "low");
      record("Memory admission observe: outcome unchanged", ok && answered && decisionOk ? "PASS" : "FAIL",
        `start ${r.status}, chat answered: ${answered}; decision ${a && a.decision} (${a && a.confidence}${a && a.confidenceReasons.length ? `: ${a.confidenceReasons.join(", ")}` : ""}); loadMode ${a && a.loadMode}`);
      if (LINUX && a && a.decision !== "would-refuse") record("Memory admission observe: Linux high confidence", "FAIL", `expected would-refuse on Linux; low because ${a.confidenceReasons.join(", ")}`);
    } finally { await stopServer(srv); }
  });

  // C. Measurements without inflation (evidence only): estimate against resident memory, reading against the drop.
  await scenario("Memory admission evidence: estimate and readings", async () => {
    const srv = await startServer("evidence", { USAP_MEMORY_ADMISSION: "observe" });
    try {
      const before = platformMemoryEvidence();
      const freeBefore = os.freemem();
      const r = await start({});
      await ready();
      const mc = r.json && r.json.memoryCheck;
      const port = (await status()).port;
      const pid = listenerPids(port).find((p) => p !== srv.child.pid);
      await sleep(1000);
      const rssLoad = pid ? rssBytes(pid) : null;
      await chatOk();
      const rssChat = pid ? rssBytes(pid) : null;
      const freeAfter = os.freemem();
      const a = mc && mc.admission;
      record("Memory admission evidence: estimate and readings", "PASS",
        `estimate ${gb(mc && mc.required && mc.required.estimateBytes.value)} (files ${gb(mc && mc.required && mc.required.lowerBoundBytes.value)}); engine RSS after load ${gb(rssLoad)}, after chat ${gb(rssChat)}; ` +
        `available at decision ${gb(mc && mc.available && mc.available.ramBytes.value)} (source ${a && a.measurement && a.measurement.source}, age ${a && a.measurement && a.measurement.ageMs} ms, ${a && a.measurement && a.measurement.state}); ` +
        `os.freemem before ${gb(freeBefore)}, after ${gb(freeAfter)} (drop ${gb(freeBefore - freeAfter)}); platform ${JSON.stringify(before)}`);
    } finally { await stopServer(srv); }
  });

  // D. enforce: mapping off (refusable on Linux only), the override field, then an ordinary mapped load, then a crash.
  await scenario("Memory admission enforce", async () => {
    const srv = await startServer("enforce", { USAP_MEMORY_ADMISSION: "enforce", ...INFLATE });
    try {
      const r = await start({ mmap: false });
      const a = r.json && (r.json.admission || (r.json.memoryCheck && r.json.memoryCheck.admission));
      if (LINUX) {
        const st = await status();
        const spawned = /\[llm\] Starting:/.test(logText(srv));
        const ok = r.status === 409 && r.json.code === "MEMORY_INSUFFICIENT" && a && a.decision === "refused" && a.confidence === "high" && r.json.admission && r.json.admission.overridable !== true && st.running === false && !spawned;
        record("Memory admission enforce (Linux): refused, nothing started", ok ? "PASS" : "FAIL",
          `start ${r.status} ${r.json && r.json.code}; decision ${a && a.decision} (${a && a.confidence}${a && a.confidenceReasons && a.confidenceReasons.length ? `: ${a.confidenceReasons.join(", ")}` : ""}); engine running: ${st.running}; llama-server started: ${spawned}`);
        const o = await start({ mmap: false, memoryOverride: true });
        const oa = o.json && o.json.admission;
        record("Memory admission enforce (Linux): memoryOverride ignored", o.status === 409 && oa && oa.override && oa.override.accepted === false ? "PASS" : "FAIL",
          `with memoryOverride: start ${o.status}; override ${JSON.stringify(oa && oa.override)}`);
      } else {
        const ok = r.status === 200 && a && a.decision === "allowed" && a.confidenceReasons.includes("c3-source-unvalidated");
        record("Memory admission enforce (Windows/macOS): never refused (C3, unvalidated reading)", ok ? "PASS" : "FAIL",
          `start ${r.status}; decision ${a && a.decision} (${a && a.confidence}: ${a && a.confidenceReasons.join(", ")}); source ${a && a.measurement && a.measurement.source}`);
        record("Memory admission enforce: refusal path", "UNSUPPORTED", `${process.platform}: refusals need a validated memory reading (Linux MemAvailable only, by design); not exercised here`);
        await call("POST", "/api/llm/stop", {});
      }
      // An ordinary (memory-mapped) load right after: allowed, loads and answers.
      const m = await start({});
      const ma = m.json && m.json.memoryCheck && m.json.memoryCheck.admission;
      const loaded = m.status === 200 && Boolean(await ready());
      const answered = loaded && Boolean(await chatOk());
      record("Memory admission enforce: memory-mapped load allowed", loaded && answered && ma && ma.decision === "allowed" && ma.confidenceReasons.includes("c8-memory-mapped") ? "PASS" : "FAIL",
        `start ${m.status}; decision ${ma && ma.decision} (${ma && ma.confidenceReasons && ma.confidenceReasons.join(", ")}); chat answered: ${answered}`);
      // Kill the engine: the bounded automatic restart is assessed as exempt and the model is back.
      const port = (await status()).port;
      const pid = listenerPids(port).find((p) => p !== srv.child.pid);
      if (!pid) { record("Memory admission enforce: crash restart exempt", "FAIL", "no engine process found on its port"); return; }
      try { process.kill(pid, "SIGKILL"); } catch (e) { record("Memory admission enforce: crash restart exempt", "FAIL", `kill failed: ${e.code}`); return; }
      const back = await waitUntil(async () => { const st = await status(); return st.ready && st.engine && st.engine.restartsInWindow === 1; }, 240000, 1000);
      const last = (await resources()).memoryAdmission;
      const lastDecision = last && last.last;
      const answeredAfter = back && Boolean(await chatOk());
      record("Memory admission enforce: crash restart exempt", back && answeredAfter && lastDecision && lastDecision.path === "restart" && lastDecision.decision === "exempt" ? "PASS" : "FAIL",
        `restarted: ${Boolean(back)}; last decision ${lastDecision && lastDecision.path}/${lastDecision && lastDecision.decision}; chat answered after restart: ${answeredAfter}; counts ${JSON.stringify(last && last.counts)}`);
    } finally { await stopServer(srv); }
  });

  process.exit(failed ? 1 : 0);
})().catch(async (err) => { record("Memory admission (9.9f-2)", "FAIL", err.message); try { await stopServer(current); } catch (_) { /* best effort */ } process.exit(1); });
