#!/usr/bin/env node
// Bench only (issue #120; never merged): repeat engine-lifecycle R2 (three image loads at once, engineSlot on for this
// test server only) and record, with timestamps, what happens to each image engine: the studio's log lines (Starting,
// READY, exited with code), guard and engine PIDs from /api/diagnostics, /api/backend-status, the slot, and on a loss
// who listens on the image port. Measurement only: always exits 0.
//   node scripts/ci/r2-loop-diagnose.cjs --image <sd model> --runs 20 --logs ci-logs
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const APP = path.join(ROOT, "app");
const SERVE = path.join(ROOT, "scripts", "server", "serve.cjs");
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const IMAGE = arg("image", "stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf");
const RUNS = Number(arg("runs", "20"));
const LOGDIR = arg("logs", path.join(ROOT, "ci-logs"));
const PORT = 14990;
const SD_PORT = PORT + 2;
const WIN = process.platform === "win32";
const NODE = [path.join(APP, "tools", "node-win", "node.exe"), path.join(APP, "tools", "node-linux", "bin", "node"), path.join(APP, "tools", "node-mac", "bin", "node")]
  .find((p) => fs.existsSync(p)) || process.execPath;
fs.mkdirSync(LOGDIR, { recursive: true });
const RESULTS = path.join(LOGDIR, "r2-loop-results.jsonl");
const TIMELINE = path.join(LOGDIR, "r2-loop-timeline.jsonl");
const STUDIO_LOG = path.join(LOGDIR, "r2-loop-studio.log");
for (const f of [RESULTS, TIMELINE, STUDIO_LOG]) fs.writeFileSync(f, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function call(method, p, body, timeoutMs = 600000) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: "127.0.0.1", port: PORT, path: p, method, agent: false, timeout: timeoutMs,
      headers: data ? { "content-type": "application/json", "content-length": data.length } : {} }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (c) => { text += c; });
      res.on("end", () => { let json = null; try { json = JSON.parse(text); } catch (_) { json = null; } resolve({ status: res.statusCode, json, text }); });
    });
    req.on("timeout", () => req.destroy(new Error("client timeout")));
    req.on("error", (e) => resolve({ status: 0, json: null, text: String(e.message) }));
    if (data) req.write(data);
    req.end();
  });
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const imageLoad = (steps) => call("POST", "/api/restart-backend", { model: IMAGE, backend_type: "cpu", use_gpu: false, width: 128, height: 128, steps });
async function snapshot() {
  const [d, b, r] = await Promise.all([call("GET", "/api/diagnostics", undefined, 10000), call("GET", "/api/backend-status", undefined, 10000), call("GET", "/api/resources", undefined, 10000)]);
  const sup = ((d.json && d.json.engines && d.json.engines.processes && d.json.engines.processes.supervised) || []).filter((x) => x.label === "image")
    .map((x) => ({ guardPid: x.guardPid, enginePid: x.enginePid, guardAlive: x.guardPid ? alive(x.guardPid) : null, engineAlive: x.enginePid ? alive(x.enginePid) : null }));
  const slot = (r.json && r.json.engineSlot) || {};
  return { t: Date.now(), image: sup, running: b.json && b.json.running, ready: b.json && b.json.ready, error: b.json && b.json.error ? String(b.json.error).slice(0, 160) : null,
    slot: { owner: slot.owner, phase: slot.phase, epoch: slot.epoch, unconfirmed: (slot.unconfirmedExits || []).length } };
}
function portOwners() {
  if (!WIN) return null;
  const r = spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" });
  return (r.stdout || "").split(/\r?\n/).filter((l) => l.includes(`:${SD_PORT} `)).map((l) => l.trim().replace(/\s+/g, " "));
}

(async () => {
  const lines = [];
  const child = spawn(NODE, [SERVE], { cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, USAP_ENGINE_SLOT: "on", PORT: String(PORT), FRONTEND_PORT: String(PORT), LLM_PORT: String(PORT + 1), BACKEND_PORT: String(SD_PORT), SD_BACKEND_PORT: String(SD_PORT), SPEECH_PORT: String(PORT + 3), TTS_PORT: String(PORT + 4) } });
  const onData = (d) => { const t = Date.now(); for (const l of String(d).split(/\r?\n/)) if (l.trim()) { lines.push({ t, l }); fs.appendFileSync(STUDIO_LOG, `${t} ${l}\n`); } };
  child.stdout.on("data", onData); child.stderr.on("data", onData);
  const summary = { runs: 0, lost: 0, exitCodes: {} };
  try {
    for (let i = 0; i < 120; i++) { if ((await call("GET", "/api/health", undefined, 3000)).status === 200) break; await sleep(500); }
    const first = await imageLoad(1);
    for (let i = 0; i < 600; i++) { const b = await call("GET", "/api/backend-status", undefined, 10000); if (b.json && b.json.ready) break; await sleep(1000); }
    for (let run = 1; run <= RUNS; run++) {
      const t0 = Date.now();
      const from = lines.length;
      const rs = await Promise.all([1, 2, 3].map((s) => imageLoad(s)));
      const tAns = Date.now();
      const snaps = [];
      for (let k = 0; k < 40; k++) { const s = await snapshot(); snaps.push(s); fs.appendFileSync(TIMELINE, JSON.stringify({ run, ...s, sinceAnswersMs: s.t - tAns }) + "\n"); await sleep(100); }
      const at1500 = snaps.find((s) => s.t - tAns >= 1500) || snaps[snaps.length - 1];
      const live = at1500.image.filter((x) => x.engineAlive).length;
      const lost = !(at1500.running && live === 1);
      const log = lines.slice(from).filter((x) => /\[backend\] (Starting|READY|exited|stale)|\[api\] Restart backend|listening on|\[engine-slot\]|error/i.test(x.l))
        .map((x) => `${x.t - t0} ${x.l.trim().slice(0, 160)}`);
      for (const x of lines.slice(from)) { const m = /\[backend\] exited with code (\S+)/.exec(x.l); if (m) summary.exitCodes[m[1]] = (summary.exitCodes[m[1]] || 0) + 1; }
      const row = { run, answers: rs.map((r) => r.status), answersMs: tAns - t0, lost, at1500: { running: at1500.running, ready: at1500.ready, live, image: at1500.image, slot: at1500.slot, error: at1500.error },
        log, portOwners: lost ? portOwners() : null };
      fs.appendFileSync(RESULTS, JSON.stringify(row) + "\n");
      console.log(`run ${run}: answers ${row.answers.join("/")} lost ${lost} live ${live} running ${at1500.running}`);
      summary.runs += 1; if (lost) summary.lost += 1;
      // Make sure the next run starts from a loaded, ready engine.
      if (lost) { await imageLoad(1); }
      for (let i = 0; i < 600; i++) { const b = await call("GET", "/api/backend-status", undefined, 10000); if (b.json && b.json.ready) break; await sleep(1000); }
      await sleep(500);
    }
    summary.firstLoad = first.status;
  } catch (e) {
    summary.error = e.message;
  } finally {
    await call("POST", "/api/stop-backend", {}, 30000);
    try { child.kill(); } catch (_) { /* gone */ }
    await sleep(2000);
    fs.writeFileSync(path.join(LOGDIR, "r2-loop-summary.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
    process.exit(0);
  }
})();
