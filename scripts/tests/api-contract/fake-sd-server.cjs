#!/usr/bin/env node
// Fake stable-diffusion.cpp sd-server used ONLY by the image-engine tests (Step 9.8g; copied into a temp
// root, never shipped). It prints the log lines the studio server parses and speaks the subset of the
// HTTP API it relies on: GET /v1/models (readiness) and POST /sdapi/v1/txt2img (returns PNG images).
// On Windows it is started through fake-llama-launcher.cs (compiled to sd-cpu.exe; it runs <exe name>.cjs).
//
// Modes, chosen by a marker in the model file name (so they work through POST /api/restart-backend):
//   (none)            load, become ready, generate a 1x1 PNG per image in ~0.3 s
//   fail-load         print a stable-diffusion.cpp [ERROR] line and exit 1 before listening
//   crash-on-generate become ready; the first txt2img request kills the process (SIGSEGV-like exit 139)
//   slow-generate     each txt2img takes 3 s, with step lines (concurrency and cancellation tests)
//   hold-load         don't listen until the file "<model path>.release" exists (issue #105 tests)
//   ignore-sigterm    ignore SIGTERM, so stopping needs SIGKILL (issue #105 tests)
//   exit-when-told    exit on its own, with the code written in the file "<model path>.exit", as soon as that file
//                     appears (issue #120 tests; combine with hold-load for an exit before listening)
// GET /fake/stats reports {requests, completed, aborted, pid, args}.
//
// Diagnostics (#142): every start, listen result and exit is appended as one JSON line to fake-sd-diag.jsonl next to
// this file (inside the test's temporary root; harness fakeSdDiag(root) reads it). A failed listen is reported as an
// "[ERROR] fake: listen ... failed: <code>" line and exits 1, as before (it used to be an uncaught exception, also
// exit code 1); for EADDRINUSE the record names the port's holders (lsof / netstat), so the next occurrence of an
// unexplained start-up exit says whether the port was taken.
"use strict";
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
const model = path.basename(arg("--model", "model.gguf"));
const DIAG = path.join(__dirname, "fake-sd-diag.jsonl");
const diag = (e, extra = {}) => { try { fs.appendFileSync(DIAG, JSON.stringify({ e, t: Date.now(), pid: process.pid, ...extra }) + "\n"); } catch (_) {} };
diag("start", { ppid: process.ppid, port: Number(arg("--listen-port", "8080")), model });
process.on("exit", (code) => diag("exit", { code }));
function portHolders(port) { // diagnostics only: who has this port (bounded; never throws)
  const { execFileSync } = require("node:child_process");
  try {
    if (process.platform === "win32") {
      return execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8", timeout: 3000, windowsHide: true })
        .split(/\r?\n/).filter((l) => l.includes(`:${port} `)).join("\n").slice(0, 2000);
    }
    return execFileSync("lsof", ["-nP", `-iTCP:${port}`], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).slice(0, 2000);
  } catch (err) { return `unavailable: ${err.status === 1 ? "no process found" : (err.code || err.message)}`; }
}
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// The studio probes each backend with a missing model and expects stable-diffusion.cpp log output.
if (model.startsWith("__backend_probe_missing__")) {
  console.log(`[INFO ] stable-diffusion.cpp:200  - loading model from '${arg("--model", "")}'`);
  console.error("[ERROR] model.cpp:1000 - init model loader from file failed");
  process.exit(1);
}

console.log(`[INFO ] stable-diffusion.cpp:200  - loading model from '${arg("--model", "")}'`);
if (model.includes("fail-load")) {
  console.error("[ERROR] stable-diffusion.cpp:300 - load tensors from model loader failed");
  process.exit(1);
}
console.log("  |==================================================| 2/2 - 1.00it/s");
console.log("[INFO ] model.cpp:1200 - model files processing completed");

const stats = { requests: 0, completed: 0, aborted: 0, pid: process.pid, args };
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: [{ id: model, object: "model" }] }));
  }
  if (req.method === "GET" && req.url === "/fake/stats") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(stats));
  }
  if (req.method === "POST" && req.url === "/sdapi/v1/txt2img") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      stats.requests += 1;
      let params = {};
      try { params = JSON.parse(body || "{}"); } catch (_) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "invalid json" }));
      }
      if (model.includes("crash-on-generate")) { console.error("[ERROR] fake: segmentation fault"); process.exit(139); }
      const steps = Math.max(1, Math.min(50, Number(params.steps) || 4));
      const total = model.includes("slow-generate") ? 3000 : 300;
      console.log("[INFO ] stable-diffusion.cpp:2000 - generate_image 1x1");
      let step = 0;
      let done = false;
      const tick = setInterval(() => {
        step += 1;
        console.log(`  |=====     | ${Math.min(step, steps)}/${steps} - 2.00it/s`);
      }, Math.max(10, Math.floor(total / steps)));
      res.on("close", () => { if (!done) { stats.aborted += 1; clearInterval(tick); } });
      setTimeout(() => {
        clearInterval(tick);
        if (res.destroyed) return;
        done = true;
        console.log("[INFO ] stable-diffusion.cpp:2100 - decoding 1 latents");
        console.log("[INFO ] stable-diffusion.cpp:2200 - generate_image completed in 0.30s");
        stats.completed += 1;
        const n = Math.max(1, Math.min(4, Number(params.batch_size) || 1));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ images: Array.from({ length: n }, () => PNG), parameters: params, info: "{}" }));
      }, total);
    });
    return undefined;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  return res.end(JSON.stringify({ error: "not found" }));
});
const port = Number(arg("--listen-port", "8080"));
if (model.includes("ignore-sigterm")) process.on("SIGTERM", () => console.error("[WARN ] fake: ignoring SIGTERM"));
if (model.includes("exit-when-told")) {
  const exitFile = `${arg("--model", "")}.exit`;
  setInterval(() => {
    if (!fs.existsSync(exitFile)) return;
    const code = Number.parseInt(fs.readFileSync(exitFile, "utf8"), 10);
    diag("told-to-exit", { code });
    process.exit(Number.isInteger(code) ? code : 0);
  }, 25);
}
server.on("error", (err) => {
  const holders = err.code === "EADDRINUSE" ? portHolders(port) : "";
  diag("listen-error", { code: err.code, message: err.message, port, holders });
  console.error(`[ERROR] fake: listen on 127.0.0.1:${port} failed: ${err.code || err.message} (pid ${process.pid}, ppid ${process.ppid})`);
  process.exit(1);
});
const listenNow = () => server.listen(port, "127.0.0.1", () => {
  diag("listening", { address: server.address() });
  console.log(`[INFO ] main.cpp:500 - listening on: 127.0.0.1:${port}`);
});
if (model.includes("hold-load")) {
  const t = setInterval(() => { if (require("node:fs").existsSync(`${arg("--model", "")}.release`)) { clearInterval(t); listenNow(); } }, 25);
} else listenNow();
