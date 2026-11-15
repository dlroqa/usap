#!/usr/bin/env node
// Issue #105 native check: cross-engine model-load coordination (engineSlot) with real engines on the CPU:
// llama-server with Qwen2.5 0.5B Q4_K_M and sd-server with Stable Diffusion 1.5 Q4_0 (installed by runtime-validate).
//
// Starts its own test servers on port 14960 (`--port`) from this checkout, with engineSlot switched on only in their
// environment; the installed default stays off (its first check). Every scenario samples the live engine processes
// (supervisor records + PID liveness) and checks that at most one heavy engine process is ever alive.
//
// Results (one line each): PASS / FAIL / UNAVAILABLE. GPU and NPU paths are not exercised (CPU only) and are recorded
// as UNAVAILABLE, never as passed. Timings are evidence, not pass/fail.
//
//   node scripts/ci/engine-lifecycle-validate.cjs --text qwen2.5-0.5b-instruct-q4_k_m.gguf \
//     --image stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf --results out.jsonl --logs ci-logs
"use strict";

const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const APP = path.join(ROOT, "app");
const SERVE = path.join(ROOT, "scripts", "server", "serve.cjs");
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const TEXT = arg("text", "qwen2.5-0.5b-instruct-q4_k_m.gguf");
const IMAGE = arg("image", "stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf");
const RESULTS = arg("results", path.join(ROOT, "ci-logs", "engine-lifecycle-results.jsonl"));
const LOGDIR = arg("logs", path.join(ROOT, "ci-logs"));
const PORT = Number(arg("port", "14960"));
const LLM_PORT = PORT + 1;
const SD_PORT = PORT + 2;
const NODE = [path.join(APP, "tools", "node-win", "node.exe"), path.join(APP, "tools", "node-linux", "bin", "node"), path.join(APP, "tools", "node-mac", "bin", "node")]
  .find((p) => fs.existsSync(p)) || process.execPath;

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
function call(method, p, body, { timeoutMs = 600000 } = {}) {
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
const allPids = new Set(); // every engine PID seen, to check for orphans at the end
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; } };
async function engines() {
  const d = (await call("GET", "/api/diagnostics", undefined, { timeoutMs: 10000 })).json;
  const sup = (d && d.engines && d.engines.processes && d.engines.processes.supervised) || [];
  const list = sup.filter((r) => r.label === "llm" || r.label === "image").map((r) => ({ label: r.label, pid: r.enginePid || r.guardPid }));
  for (const r of list) if (r.pid) allPids.add(r.pid);
  return list.filter((r) => r.pid && alive(r.pid));
}
function sampler() {
  const seen = { max: 0, maxImage: 0, samples: 0 };
  let running = true;
  const loop = (async () => {
    while (running) {
      try { const e = await engines(); seen.samples += 1; seen.max = Math.max(seen.max, e.length); seen.maxImage = Math.max(seen.maxImage, e.filter((x) => x.label === "image").length); } catch (_) { /* busy */ }
      await sleep(100);
    }
  })();
  return async () => { running = false; await loop; return seen; };
}

// ── Servers ─────────────────────────────────────────────────────────────────────────────────────────────
async function startServer(label, env) {
  const logPath = path.join(LOGDIR, `engine-lifecycle-${label}.log`);
  const log = fs.openSync(logPath, "w");
  const child = spawn(NODE, [SERVE], {
    cwd: ROOT, windowsHide: true, stdio: ["ignore", log, log],
    env: { ...process.env, PORT: String(PORT), FRONTEND_PORT: String(PORT), LLM_PORT: String(LLM_PORT), BACKEND_PORT: String(SD_PORT), SD_BACKEND_PORT: String(SD_PORT), SPEECH_PORT: String(PORT + 3), TTS_PORT: String(PORT + 4), ...env },
  });
  const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
  const srv = { label, child, exited, logPath };
  const up = await waitUntil(async () => (await call("GET", "/api/health", undefined, { timeoutMs: 3000 })).status === 200, 60000, 500);
  if (!up) throw new Error(`server ${label} did not start (see engine-lifecycle-${label}.log)`);
  return srv;
}
async function stopServer(srv) {
  if (!srv || srv.child.exitCode !== null || srv.child.signalCode !== null) return;
  for (const e of await engines().catch(() => [])) allPids.add(e.pid);
  await call("POST", "/api/stop-backend", {}, { timeoutMs: 30000 });
  await call("POST", "/api/llm/stop", {}, { timeoutMs: 30000 });
  srv.child.kill("SIGTERM");
  let timer = null;
  const gone = await Promise.race([srv.exited, new Promise((r) => { timer = setTimeout(() => r(false), 20000); })]);
  clearTimeout(timer);
  if (!gone) { try { srv.child.kill("SIGKILL"); } catch (_) { /* gone */ } await srv.exited; }
  await waitUntil(async () => !(await portOpen(PORT)), 15000);
}
const textLoad = () => call("POST", "/api/llm/start", { model: TEXT, contextSize: 2048, gpuLayers: 0 });
const imageLoad = (extra = {}) => call("POST", "/api/restart-backend", { model: IMAGE, backend_type: "cpu", use_gpu: false, width: 128, height: 128, steps: 1, ...extra });
const resources = async () => (await call("GET", "/api/resources", undefined, { timeoutMs: 10000 })).json || {};
const slot = async () => (await resources()).engineSlot || {};
const imageReady = () => waitUntil(async () => (await call("GET", "/api/backend-status", undefined, { timeoutMs: 10000 })).json.ready === true, 600000, 1000);
const textReady = () => waitUntil(async () => (await call("GET", "/api/llm/status", undefined, { timeoutMs: 10000 })).json.ready === true, 600000, 1000);
const idle = () => waitUntil(async () => { const s = await slot(); return s.phase === "idle" && s.owner === null; }, 30000, 250);
async function holdTextPort() {
  const b = net.createServer().listen(LLM_PORT, "127.0.0.1");
  await new Promise((r, j) => { b.once("listening", r); b.once("error", j); });
  return () => new Promise((r) => b.close(r));
}
async function scenario(name, fn) { try { await fn(); } catch (err) { record(name, "FAIL", err.message); } }
const SLOT = { USAP_ENGINE_SLOT: "on" };

(async () => {
  console.log(`| Check | Result | Detail |\n|---|---|---|`);
  if (!fs.existsSync(path.join(APP, "llm-models", TEXT)) || !fs.existsSync(path.join(APP, "models", IMAGE))) {
    record("Models installed", "FAIL", `need app/llm-models/${TEXT} and app/models/${IMAGE} (runtime-validate installs them)`);
    process.exit(1);
  }

  await scenario("Default: engineSlot off", async () => {
    const srv = await startServer("default", { USAP_ENGINE_SLOT: "" });
    try {
      const r = await resources();
      record("Default: engineSlot off", !("engineSlot" in r) && !("engineSlot" in (r.limits || {})) ? "PASS" : "FAIL", `engineSlot key ${"engineSlot" in r ? "present" : "absent"} in /api/resources`);
    } finally { await stopServer(srv); }
  });

  let srv = null;
  try {
    srv = await startServer("on", SLOT);

    await scenario("R1 text load then image load (slot on)", async () => {
      const free = await holdTextPort();
      const done = sampler();
      const pText = textLoad();
      await sleep(100);
      const img = await imageLoad();
      const txt = await pText;
      await free();
      await textReady();
      const seen = await done();
      const ok = txt.status === 200 && img.status === 409 && img.json && img.json.code === "MODEL_ALREADY_ACTIVE" && /already loaded as a text model/i.test(img.json.error) && seen.max <= 1;
      record("R1 text load then image load (slot on)", ok ? "PASS" : "FAIL", `text ${txt.status}, image ${img.status} ${img.json && img.json.code}, phase ${img.json && img.json.activeRuntime && img.json.activeRuntime.phase}, max heavy alive ${seen.max} over ${seen.samples} samples`);
    });

    await scenario("Chat answers with the slot on", async () => {
      const r = await call("POST", "/api/llm/chat", { messages: [{ role: "user", content: "Say hello in three words." }], max_tokens: 16, temperature: 0, stream: false });
      record("Chat answers with the slot on", r.status === 200 && r.json && Array.isArray(r.json.choices) ? "PASS" : "FAIL", `status ${r.status}`);
    });

    await scenario("Text stop confirms the exit", async () => {
      const before = (await engines()).filter((e) => e.label === "llm");
      const t0 = Date.now();
      const st = await call("POST", "/api/llm/stop", {});
      const ms = Date.now() - t0;
      const gone = before.every((e) => !alive(e.pid));
      const released = await idle();
      record("Text stop confirms the exit", st.status === 200 && gone && released ? "PASS" : "FAIL", `stop ${st.status} in ${ms} ms; engine PID gone ${gone}; slot idle ${Boolean(released)}`);
    });

    await scenario("R5 image load then text load (slot on)", async () => {
      const done = sampler();
      const pImg = imageLoad();
      await sleep(100);
      const txt = await textLoad();
      const img = await pImg;
      await imageReady();
      const seen = await done();
      const ok = img.status === 200 && txt.status === 409 && txt.json && txt.json.code === "MODEL_ALREADY_ACTIVE" && seen.max <= 1;
      record("R5 image load then text load (slot on)", ok ? "PASS" : "FAIL", `image ${img.status}, text ${txt.status} ${txt.json && txt.json.code}, max heavy alive ${seen.max}`);
    });

    await scenario("R3 text load while image loaded: 409", async () => {
      const r = await textLoad();
      const ok = r.status === 409 && r.json && r.json.code === "MODEL_ALREADY_ACTIVE" && r.json.activeRuntime && r.json.activeRuntime.type === "image";
      record("R3 text load while image loaded: 409", ok ? "PASS" : "FAIL", `status ${r.status} ${r.json && r.json.code}`);
    });

    await scenario("Image generates with the slot on", async () => {
      const r = await call("POST", "/sdapi/v1/txt2img", { prompt: "a red apple", steps: 1, width: 128, height: 128, seed: 42, batch_size: 1 });
      const ok = r.status === 200 && r.json && Array.isArray(r.json.images) && r.json.images.length === 1;
      record("Image generates with the slot on", ok ? "PASS" : "FAIL", `status ${r.status}`);
      await waitUntil(async () => (await call("GET", "/api/generation-progress", undefined, { timeoutMs: 10000 })).json.active === false, 60000, 500);
    });

    await scenario("R2 three image loads at once", async () => {
      const done = sampler();
      const rs = await Promise.all([1, 2, 3].map((steps) => imageLoad({ steps })));
      await sleep(1500);
      const seen = await done();
      const live = await engines();
      const tracked = (await call("GET", "/api/backend-status", undefined, { timeoutMs: 10000 })).json.running === true;
      const ok = rs.every((r) => [200, 409].includes(r.status)) && seen.maxImage <= 1 && live.length === 1 && tracked;
      record("R2 three image loads at once", ok ? "PASS" : "FAIL", `answers ${rs.map((r) => r.status).join("/")}; max image processes ${seen.maxImage}; live ${live.length}; tracked ${tracked}`);
    });

    await scenario("Image stop confirms the exit (no orphan)", async () => {
      const before = (await engines()).filter((e) => e.label === "image");
      const t0 = Date.now();
      const st = await call("POST", "/api/stop-backend", {});
      const ms = Date.now() - t0;
      const gone = before.every((e) => !alive(e.pid));
      const released = await idle();
      record("Image stop confirms the exit (no orphan)", st.status === 200 && gone && released && (await engines()).length === 0 ? "PASS" : "FAIL", `stop ${st.status} in ${ms} ms; engine PID gone ${gone}; slot idle ${Boolean(released)}`);
    });

    await scenario("R4 stop during an image load cancels it", async () => {
      const p = imageLoad();
      await sleep(150);
      const st = await call("POST", "/api/stop-backend", {});
      const r = await p;
      await sleep(1500);
      const live = await engines();
      const ok = st.status === 200 && r.status === 409 && r.json && r.json.code === "ENGINE_START_CANCELLED" && live.length === 0;
      record("R4 stop during an image load cancels it", ok ? "PASS" : "FAIL", `stop ${st.status}; load ${r.status} ${r.json && r.json.code}; live ${live.length}`);
    });

    await scenario("Switch text, image, text (timings)", async () => {
      const t = [];
      let s = Date.now(); const a = await textLoad(); await textReady(); t.push(`text load ${Date.now() - s} ms`);
      s = Date.now(); await call("POST", "/api/llm/stop", {}); await idle(); t.push(`text stop to slot idle ${Date.now() - s} ms`);
      s = Date.now(); const b = await imageLoad(); await imageReady(); t.push(`image load ${Date.now() - s} ms`);
      s = Date.now(); await call("POST", "/api/stop-backend", {}); await idle(); t.push(`image stop to slot idle ${Date.now() - s} ms`);
      s = Date.now(); const c = await textLoad(); await textReady(); t.push(`text load ${Date.now() - s} ms`);
      record("Switch text, image, text (timings)", a.status === 200 && b.status === 200 && c.status === 200 ? "PASS" : "FAIL", t.join("; "));
    });
  } catch (err) {
    record("Slot-on server", "FAIL", err.message);
  } finally {
    await stopServer(srv);
  }

  await scenario("No orphaned engine processes", async () => {
    await sleep(2000);
    const left = [...allPids].filter(alive);
    record("No orphaned engine processes", left.length === 0 ? "PASS" : "FAIL", `${allPids.size} engine PIDs seen; ${left.length} still alive`);
  });
  record("GPU and NPU lifecycle paths", "UNAVAILABLE", "not exercised: this check runs the CPU engines only (no usable GPU or NPU on hosted runners)");
  process.exit(failed ? 1 : 0);
})();
