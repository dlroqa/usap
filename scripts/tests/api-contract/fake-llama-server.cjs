#!/usr/bin/env node
// Fake llama-server used ONLY by the API contract tests (copied into a temp root, never shipped).
// Speaks the subset the studio server relies on: GET /v1/models (readiness) and
// POST /v1/chat/completions in OpenAI-style streaming (SSE) and non-streaming JSON.
"use strict";
const http = require("node:http");
const path = require("node:path");
const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
if (args.includes("--version")) { console.log("version: 0 (contract-test fake llama-server)"); process.exit(0); }
if (args.includes("--help") || args.includes("--list-devices")) { console.log("contract-test fake llama-server"); process.exit(0); }
const model = path.basename(arg("--model", "fake.gguf"));
const WORDS = ["Contract", " test", " reply."];
http.createServer((req, res) => {
  if (req.url.startsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: [{ id: model, object: "model" }] }));
  }
  if (req.url.startsWith("/health")) { res.writeHead(200, { "content-type": "application/json" }); return res.end('{"status":"ok"}'); }
  if (req.url.startsWith("/v1/chat/completions") && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let stream = false;
      try { stream = Boolean(JSON.parse(body || "{}").stream); } catch (_) { /* treat as non-stream */ }
      if (!stream) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content: WORDS.join("") }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: WORDS.length, total_tokens: 3 + WORDS.length },
        }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const w of WORDS) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: w } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], timings: { predicted_n: WORDS.length, predicted_ms: 30 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(Number(arg("--port", "10086")), arg("--host", "127.0.0.1"));
