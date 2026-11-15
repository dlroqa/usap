#!/usr/bin/env node
// Fake llama-server used ONLY by the API contract tests (copied into a temp root, never shipped).
// Speaks the subset the studio server relies on: GET /v1/models (readiness) and
// POST /v1/chat/completions in OpenAI-style streaming (SSE) and non-streaming JSON.
// On Windows it is started through fake-llama-launcher.cs (compiled to llama-server.exe).
//
// Test modes, chosen by a marker anywhere in the chat messages:
//   (none)          3 chunks "Contract", " test", " reply."
//   MODE:count=N    N numbered chunks "0 ".."N-1 " (ordering checks)
//   MODE:http-error HTTP 400 with an OpenAI-style error body, before any streaming
//   MODE:error-cut  HTTP 500 announcing a longer body, part of it, then the connection is destroyed (#90)
//   MODE:crash-mid  2 chunks, then the connection is destroyed (no finish, no [DONE])
//   MODE:slow       a chunk every 50 ms for 5 s (client-disconnect checks)
//   MODE:echo       one chunk (or message) whose content is the exact JSON request the engine received
//   MODE:oom        HTTP 500 with a llama.cpp-style allocation failure, before any streaming (Step 9.8h)
//   MODE:garbage    HTTP 200 event stream with bytes that are not SSE, then the end (malformed stream)
//   MODE:delay=MS   one chunk naming the request's TAG:<x> (if any), then the end after MS ms (queue order checks)
//   MODE:hold       like delay, but the end waits for POST /fake/release, so a test controls exactly when the
//                   request finishes instead of racing a timer. A safety limit (HOLD_MAX_MS) ends it anyway and
//                   counts it in stats.holdTimeouts, which tests assert is 0.
//   MODE:stall      streaming: the status line, then nothing; non-streaming: nothing at all (Step 9.9f-1)
//   MODE:partial-stall  streaming: 2 chunks, then nothing (Step 9.9f-1)
// GET /metrics answers like llama-server's (Prometheus text, Process-Start-Time-Unix header): requests_processing
// is the number of chat requests still open, plus POST /fake/busy {"ms": N} extra time after one closes ("engine
// still computing after the abort"); POST /fake/metrics {"mode":"hang"|"missing"|"no-header"|"normal"} breaks it.
// GET /fake/stats reports {requests, completed, aborted, pid, held, holdTimeouts} so tests can observe aborts;
// POST /fake/release ends every held request now (and is harmless when nothing is held);
// GET /fake/last returns the last chat request body as received (prompt order and role checks).
//
// Lifecycle modes for the engine-supervision tests (Step 9.6), chosen by a marker in the model
// file name (so they work through the normal /api/llm/start path):
//   fail-start      exit with code 3 before listening (a failed launch)
//   slow-start      wait 60 s before listening (an interrupted or cancelled startup)
//   never-ready     listen, but /v1/models answers 503 forever (a startup timeout)
//   oom-after-ready become ready, then after 3 s print a llama.cpp-style allocation failure and exit 1
//   hold-start      don't listen until the file "<model path>.release" exists (issue #105 tests: a load held
//                   after its spawn, released exactly when the test says)
//   crash-once      become ready, then after 3 s exit with code 3 unless "<model path>.crashed" exists (it is
//                   created first), so an automatic restart succeeds (issue #105 tests)
//   ignore-sigterm  ignore SIGTERM, so stopping needs SIGKILL (issue #105 tests)
// and by flags (used when a test starts the fake directly):
//   --fake-ignore-sigterm         ignore SIGTERM (forces the forced-termination path)
//   --fake-exit-after-ms N        exit after N ms with --fake-exit-code (default 3)
//   --fake-abort-after-ms N       process.abort() after N ms (SIGABRT on POSIX)
"use strict";
const http = require("node:http");
const path = require("node:path");
const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
if (args.includes("--version")) { console.log("version: 0 (contract-test fake llama-server)"); process.exit(0); }
// FAKE_LLAMA_HELP_LOAD_MODE=1 (Step 9.9f-2 tests only): --help lists --load-mode, so the studio passes --load-mode
// like with a current llama.cpp build. Unset: the original output, so other tests see the older flags as before.
if (args.includes("--help") || args.includes("--list-devices")) { console.log("contract-test fake llama-server" + (process.env.FAKE_LLAMA_HELP_LOAD_MODE === "1" && args.includes("--help") ? "\n  --load-mode MODE" : "")); process.exit(0); }
const model = path.basename(arg("--model", "fake.gguf"));
const WORDS = ["Contract", " test", " reply."];
const stats = { requests: 0, completed: 0, aborted: 0, pid: process.pid, held: 0, holdTimeouts: 0, open: 0, metricsRequests: 0 };
const START = String(Math.floor(Date.now() / 1000));
let metricsMode = "normal";
let busyTailMs = 0;
let busyUntil = 0;
let decodes = 0;
const HOLD_MAX_MS = 30000;
const held = new Set(); // end functions of requests in MODE:hold
let lastBody = null;
if (model.includes("oom-after-ready")) setTimeout(() => { console.error("ggml_backend_cpu_buffer_type_alloc_buffer: failed to allocate buffer of size 4294967296"); process.exit(1); }, 3000);
if (model.includes("fail-start")) { console.error("fake engine: failed to load model (fail-start)"); process.exit(3); }
if (args.includes("--fake-ignore-sigterm") || model.includes("ignore-sigterm")) process.on("SIGTERM", () => { console.error("fake engine: ignoring SIGTERM"); });
if (args.includes("--fake-exit-after-ms")) setTimeout(() => process.exit(Number(arg("--fake-exit-code", "3"))), Number(arg("--fake-exit-after-ms", "0")));
if (args.includes("--fake-abort-after-ms")) setTimeout(() => process.abort(), Number(arg("--fake-abort-after-ms", "0")));

const chunk = (content) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;
const finish = (n) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], timings: { predicted_n: n, predicted_ms: 30 } })}\n\n`;

function modeOf(body) {
  const text = JSON.stringify(body.messages || []);
  const tag = (text.match(/TAG:([A-Za-z0-9_-]+)/) || [])[1] || "";
  const d = text.match(/MODE:delay=(\d+)/);
  if (d) return { name: "delay", ms: Math.min(60000, Number(d[1])), tag };
  if (/MODE:hold\b/.test(text)) return { name: "hold", tag };
  const m = text.match(/MODE:(count=(\d+)|http-error|error-cut|crash-mid|slow|echo|oom|garbage|partial-stall|stall)/);
  if (!m) return { name: "default" };
  return m[2] ? { name: "count", n: Math.min(500, Number(m[2])) } : { name: m[1] };
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/v1/models") && model.includes("never-ready")) {
    res.writeHead(503, { "content-type": "application/json" });
    return res.end('{"error":{"message":"Loading model","code":503}}');
  }
  if (req.url.startsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: [{ id: model, object: "model" }] }));
  }
  if (req.url.startsWith("/health")) { res.writeHead(200, { "content-type": "application/json" }); return res.end('{"status":"ok"}'); }
  if (req.url.startsWith("/fake/last")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(lastBody)); }
  if (req.url.startsWith("/fake/release") && req.method === "POST") {
    const n = held.size;
    for (const end of [...held]) end();
    res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ released: n }));
  }
  if (req.url.startsWith("/metrics")) {
    stats.metricsRequests++;
    if (metricsMode === "hang") return; // never answers (a stuck engine)
    const processing = stats.open + (Date.now() < busyUntil ? 1 : 0);
    const lines = metricsMode === "missing" ? ["llamacpp:prompt_tokens_total 1"] : [
      `llamacpp:prompt_tokens_total ${decodes}`, `llamacpp:tokens_predicted_total ${decodes}`, `llamacpp:n_decode_total ${decodes}`,
      `llamacpp:requests_processing ${processing}`, "llamacpp:requests_deferred 0"];
    const headers = { "content-type": "text/plain; version=0.0.4" };
    if (metricsMode !== "no-header") headers["Process-Start-Time-Unix"] = START;
    res.writeHead(200, headers);
    return res.end(lines.map((l) => `# TYPE x gauge\n${l}`).join("\n") + "\n");
  }
  if ((req.url.startsWith("/fake/metrics") || req.url.startsWith("/fake/busy")) && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let b = {};
      try { b = JSON.parse(raw || "{}"); } catch (_) { /* empty */ }
      if (req.url.startsWith("/fake/metrics")) metricsMode = ["hang", "missing", "no-header", "normal"].includes(b.mode) ? b.mode : "normal";
      else busyTailMs = Math.max(0, Math.min(120000, Number(b.ms) || 0));
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ metricsMode, busyTailMs }));
    });
    return;
  }
  if (req.url.startsWith("/fake/args")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(args)); } // Step 9.9f-2 tests
  if (req.url.startsWith("/fake/stats")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(stats)); }
  if (req.url.startsWith("/v1/chat/completions") && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      stats.requests++;
      stats.open++;
      decodes++;
      let closed = false;
      res.on("close", () => { if (closed) return; closed = true; stats.open--; if (busyTailMs) busyUntil = Date.now() + busyTailMs; });
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch (_) { /* empty */ }
      lastBody = body;
      const mode = modeOf(body);
      if (mode.name === "oom") {
        res.writeHead(500, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { code: 500, message: "ggml_backend_cpu_buffer_type_alloc_buffer: failed to allocate buffer", type: "server_error" } }));
      }
      if (mode.name === "echo" && !body.stream) {
        stats.completed++;
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: raw }, finish_reason: "stop" }] }));
      }
      if (mode.name === "error-cut") {
        res.writeHead(500, { "content-type": "application/json", "content-length": "400" });
        res.write('{"error":{"code":500,"message":"engine failed at /home/someone/private/models/x.gguf');
        return setTimeout(() => res.socket.destroy(), 100);
      }
      if (mode.name === "http-error") {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { code: 400, message: "fake engine rejected the request", type: "invalid_request_error" } }));
      }
      if (mode.name === "stall" && !body.stream) {
        res.on("close", () => { if (!res.writableEnded) stats.aborted++; });
        return; // never answers
      }
      if (!body.stream) {
        stats.completed++;
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content: WORDS.join("") }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: WORDS.length, total_tokens: 3 + WORDS.length },
        }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (mode.name === "stall" || mode.name === "partial-stall") {
        res.flushHeaders();
        if (mode.name === "partial-stall") { res.write(chunk("partial-1 ")); res.write(chunk("partial-2 ")); decodes += 2; }
        res.on("close", () => { if (!res.writableEnded) stats.aborted++; });
        return; // then nothing: the studio's deadlines must end it
      }
      if (mode.name === "garbage") {
        stats.completed++;
        res.write("this is not an event stream\n");
        res.write(Buffer.from([0xff, 0xfe, 0x00, 0x0a]));
        return res.end("data: {not json\n\n");
      }
      if (mode.name === "echo") {
        stats.completed++;
        res.write(chunk(raw));
        res.write(finish(1));
        return res.end("data: [DONE]\n\n");
      }
      if (mode.name === "delay") {
        stats.order = (stats.order || []).concat(mode.tag);
        res.write(chunk(`tag=${mode.tag} `));
        const t = setTimeout(() => { stats.completed++; res.write(finish(1)); res.end("data: [DONE]\n\n"); }, mode.ms);
        res.on("close", () => { if (!res.writableEnded) { clearTimeout(t); stats.aborted++; } });
        return;
      }
      if (mode.name === "hold") {
        stats.order = (stats.order || []).concat(mode.tag);
        res.write(chunk(`tag=${mode.tag} `));
        const end = (timedOut) => {
          if (!held.delete(end)) return;
          clearTimeout(safety); stats.held = held.size;
          if (timedOut === true) stats.holdTimeouts++;
          if (res.writableEnded || res.destroyed) return;
          stats.completed++; res.write(finish(1)); res.end("data: [DONE]\n\n");
        };
        const safety = setTimeout(() => end(true), HOLD_MAX_MS);
        held.add(end); stats.held = held.size;
        res.on("close", () => { if (!res.writableEnded) { stats.aborted++; held.delete(end); clearTimeout(safety); stats.held = held.size; } });
        return;
      }
      if (mode.name === "crash-mid") {
        res.write(chunk("partial-1 "));
        res.write(chunk("partial-2 "));
        return setTimeout(() => req.socket.destroy(), 50);
      }
      if (mode.name === "slow") {
        let i = 0;
        let done = false;
        const timer = setInterval(() => {
          if (i >= 100) { clearInterval(timer); done = true; stats.completed++; res.write(finish(i)); return res.end("data: [DONE]\n\n"); }
          res.write(chunk(`s${i++} `));
        }, 50);
        res.on("close", () => { clearInterval(timer); if (!done) stats.aborted++; });
        return;
      }
      const words = mode.name === "count" ? Array.from({ length: mode.n }, (_, i) => `${i} `) : WORDS;
      for (const w of words) res.write(chunk(w));
      res.write(finish(words.length));
      stats.completed++;
      res.end("data: [DONE]\n\n");
    });
    return;
  }
  res.writeHead(404); res.end();
});
const listen = () => server.listen(Number(arg("--port", "10086")), arg("--host", "127.0.0.1"));
const modelPath = arg("--model", "");
if (model.includes("crash-once")) {
  server.once("listening", () => setTimeout(() => {
    const flag = `${modelPath}.crashed`;
    if (require("node:fs").existsSync(flag)) return;
    require("node:fs").writeFileSync(flag, "1");
    console.error("fake engine: crash-once");
    process.exit(3);
  }, 3000));
}
if (model.includes("slow-start")) setTimeout(listen, 60000);
else if (model.includes("hold-start")) { const t = setInterval(() => { if (require("node:fs").existsSync(`${modelPath}.release`)) { clearInterval(t); listen(); } }, 25); }
else listen();
