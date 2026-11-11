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
//   MODE:crash-mid  2 chunks, then the connection is destroyed (no finish, no [DONE])
//   MODE:slow       a chunk every 50 ms for 5 s (client-disconnect checks)
//   MODE:echo       one chunk (or message) whose content is the exact JSON request the engine received
//   MODE:oom        HTTP 500 with a llama.cpp-style allocation failure, before any streaming (Step 9.8h)
//   MODE:garbage    HTTP 200 event stream with bytes that are not SSE, then the end (malformed stream)
// GET /fake/stats reports {requests, completed, aborted, pid} so tests can observe aborts;
// GET /fake/last returns the last chat request body as received (prompt order and role checks).
//
// Lifecycle modes for the engine-supervision tests (Step 9.6), chosen by a marker in the model
// file name (so they work through the normal /api/llm/start path):
//   fail-start      exit with code 3 before listening (a failed launch)
//   slow-start      wait 60 s before listening (an interrupted or cancelled startup)
//   never-ready     listen, but /v1/models answers 503 forever (a startup timeout)
//   oom-after-ready become ready, then after 3 s print a llama.cpp-style allocation failure and exit 1
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
if (args.includes("--help") || args.includes("--list-devices")) { console.log("contract-test fake llama-server"); process.exit(0); }
const model = path.basename(arg("--model", "fake.gguf"));
const WORDS = ["Contract", " test", " reply."];
const stats = { requests: 0, completed: 0, aborted: 0, pid: process.pid };
let lastBody = null;
if (model.includes("oom-after-ready")) setTimeout(() => { console.error("ggml_backend_cpu_buffer_type_alloc_buffer: failed to allocate buffer of size 4294967296"); process.exit(1); }, 3000);
if (model.includes("fail-start")) { console.error("fake engine: failed to load model (fail-start)"); process.exit(3); }
if (args.includes("--fake-ignore-sigterm")) process.on("SIGTERM", () => { console.error("fake engine: ignoring SIGTERM"); });
if (args.includes("--fake-exit-after-ms")) setTimeout(() => process.exit(Number(arg("--fake-exit-code", "3"))), Number(arg("--fake-exit-after-ms", "0")));
if (args.includes("--fake-abort-after-ms")) setTimeout(() => process.abort(), Number(arg("--fake-abort-after-ms", "0")));

const chunk = (content) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;
const finish = (n) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], timings: { predicted_n: n, predicted_ms: 30 } })}\n\n`;

function modeOf(body) {
  const text = JSON.stringify(body.messages || []);
  const m = text.match(/MODE:(count=(\d+)|http-error|crash-mid|slow|echo|oom|garbage)/);
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
  if (req.url.startsWith("/fake/stats")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(stats)); }
  if (req.url.startsWith("/v1/chat/completions") && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      stats.requests++;
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
      if (mode.name === "http-error") {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { code: 400, message: "fake engine rejected the request", type: "invalid_request_error" } }));
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
if (model.includes("slow-start")) setTimeout(listen, 60000); else listen();
