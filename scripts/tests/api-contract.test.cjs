// API contract tests (Step 9.1): pin today's API behaviour before any backend refactoring.
// A copy of the server runs in an isolated temp root (no models, no engines, no access to the
// checkout's data). Response shapes are recorded in api-contract/contract.json: a missing key, a
// changed type or a changed status code fails; additional keys are allowed (additive changes).
// See api-contract/README.md for what is covered and how to change the contract deliberately.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { makeRoot, startServer, stopServer, request, checkShape, fakeLlamaPath } = require("./api-contract/harness.cjs");
const { GET_ROUTES } = require("./api-contract/routes.cjs");

const contract = JSON.parse(fs.readFileSync(path.join(__dirname, "api-contract", "contract.json"), "utf8"));

// Keys that legitimately differ by OS/hardware: missing on some platforms, or null where nothing
// is installed. Each entry needs a reason.
const OPTIONAL = {
  // null when no llama.cpp text backend is installed (the Windows test root has none; Linux and
  // macOS get the fake llama-server). The frontend does not read these fields.
  "GET /api/llm/status": ["$.selectedBackend"],
  "GET /api/llm/stats": ["$.selectedBackend"],
  "GET /api/llm/backends": ["$.selected"],
};

let srv;
let root;

test.before(async () => {
  root = makeRoot();
  srv = await startServer(root);
});

test.after(() => {
  stopServer(srv);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* Windows may hold files briefly */ }
});

// ── 1. Recorded contract: routes, status codes, content types, response shapes ──
test("contract: every recorded call keeps its status code, JSON content type and response shape", async (t) => {
  const failures = [];
  for (const c of contract.calls) {
    const label = `${c.method} ${c.path}${c.body !== undefined ? " " + JSON.stringify(c.body) : ""}`;
    const r = await request(srv.port, c.method, c.path, { body: c.body });
    if (r.status !== c.status) { failures.push(`${label}: status ${r.status}, contract ${c.status}`); continue; }
    if (!String(r.headers["content-type"] || "").startsWith(c.contentType)) failures.push(`${label}: content-type ${r.headers["content-type"]}, contract ${c.contentType}`);
    if (r.json === undefined) { failures.push(`${label}: body is not JSON`); continue; }
    for (const p of checkShape(r.json, c.shape, "$", OPTIONAL[`${c.method} ${c.path}`] || [])) failures.push(`${label}: ${p}`);
  }
  assert.deepEqual(failures, [], `API contract broken (${failures.length}):\n  ${failures.join("\n  ")}`);
});

test("contract: error responses carry a human-readable error string", async () => {
  for (const c of contract.calls.filter((x) => x.status >= 400)) {
    const r = await request(srv.port, c.method, c.path, { body: c.body });
    assert.equal(typeof r.json?.error, "string", `${c.method} ${c.path} should return { error: string }`);
    assert.ok(r.json.error.length > 0, `${c.method} ${c.path} error message is empty`);
    if ("ok" in r.json) assert.equal(r.json.ok, false, `${c.method} ${c.path}: ok must be false on errors`);
  }
});

test("contract: the route list and the recorded contract match", () => {
  const recorded = new Set(contract.calls.filter((c) => c.method === "GET" && c.status === 200).map((c) => c.path));
  for (const r of GET_ROUTES) assert.ok(recorded.has(r.path), `${r.path} is listed in routes.cjs but not recorded; run record.cjs`);
});

// ── 2. Origin and Host security apply to every route ────────────────────────
test("security: a foreign Origin is refused on every GET route, without CORS headers", async () => {
  for (const { path: p } of GET_ROUTES) {
    const r = await request(srv.port, "GET", p, { headers: { Origin: "https://evil.example" } });
    assert.equal(r.status, 403, `${p} with a foreign Origin`);
    assert.equal(r.headers["access-control-allow-origin"], undefined, `${p} must not send CORS headers to a foreign origin`);
  }
});

test("security: a foreign Origin cannot trigger state-changing POSTs", async () => {
  for (const p of ["/api/llm/stop", "/api/delete-outputs", "/api/llm/save-conversation", "/api/cleanup"]) {
    const r = await request(srv.port, "POST", p, { body: {}, headers: { Origin: "https://evil.example" } });
    assert.equal(r.status, 403, `POST ${p} with a foreign Origin`);
  }
  const conv = await request(srv.port, "GET", "/api/llm/conversations");
  assert.equal(conv.json.conversations.length, 0, "the refused save-conversation must not have created anything");
});

test("security: a non-loopback Host is refused (DNS rebinding) and CORS preflight from a foreign origin fails", async () => {
  for (const { path: p } of GET_ROUTES.slice(0, 5)) {
    const r = await request(srv.port, "GET", p, { headers: { Host: "evil.example" } });
    assert.equal(r.status, 403, `${p} with Host evil.example`);
  }
  const pre = await request(srv.port, "OPTIONS", "/api/llm/chat", { headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
  assert.equal(pre.status, 403);
  assert.equal(pre.headers["access-control-allow-origin"], undefined);
});

test("security: same-origin requests from the studio's own page are allowed", async () => {
  const r = await request(srv.port, "GET", "/api/health", { headers: { Origin: `http://127.0.0.1:${srv.port}` } });
  assert.equal(r.status, 200);
});

// ── 3. File access stays inside the data folders ────────────────────────────
test("files: traversal attempts can neither delete nor read files outside the data folders", async () => {
  const attempts = [
    ["POST", "/api/delete-model", { filename: "../SENTINEL.safetensors" }],
    ["POST", "/api/llm/delete-model", { filename: "../SENTINEL.gguf" }],
    ["POST", "/api/tts/delete-output", { filename: "../SENTINEL.wav" }],
    ["POST", "/api/speech/delete-transcription", { filename: "../SENTINEL.txt" }],
    ["POST", "/api/delete-outputs", { files: ["../SENTINEL.png"], filenames: ["../SENTINEL.png"] }],
  ];
  for (const [m, p, body] of attempts) {
    const r = await request(srv.port, m, p, { body });
    assert.notEqual(r.json?.deleted?.length, 1, `${p} reported deleting a file outside its folder`);
  }
  for (const f of ["SENTINEL.safetensors", "SENTINEL.gguf", "SENTINEL.wav", "SENTINEL.txt", "SENTINEL.png"]) {
    assert.ok(fs.existsSync(path.join(root, "app", f)), `${f} outside the data folders was deleted`);
  }
  for (const q of ["file=../SENTINEL.png", "path=../SENTINEL.png", "file=..%2FSENTINEL.png", "file=%2E%2E/SENTINEL.png"]) {
    const r = await request(srv.port, "GET", `/api/output-file?${q}`, { raw: true });
    assert.notEqual(r.status, 200, `/api/output-file?${q} served a file outside outputs/`);
    assert.ok(!r.text.includes("outside outputs/"), `/api/output-file?${q} leaked file content`);
  }
  for (const p of ["/tts-outputs/../SENTINEL.wav", "/tts-outputs/..%2FSENTINEL.wav"]) {
    const r = await request(srv.port, "GET", p, { raw: true });
    assert.ok(!r.text.includes("outside tts-outputs/"), `${p} leaked file content`);
  }
});

// ── 4. Model management and configuration ───────────────────────────────────
test("models: model files placed in the data folders are listed, and deleting by name removes only that file", async () => {
  fs.writeFileSync(path.join(root, "app", "llm-models", "contract-list.gguf"), Buffer.from("GGUF\x03\x00\x00\x00"));
  fs.writeFileSync(path.join(root, "app", "models", "contract-image.safetensors"), Buffer.alloc(16));
  const llm = await request(srv.port, "GET", "/api/llm/models");
  assert.ok(JSON.stringify(llm.json).includes("contract-list.gguf"), "GET /api/llm/models should list the GGUF file");
  const img = await request(srv.port, "GET", "/api/models");
  assert.ok(JSON.stringify(img.json).includes("contract-image.safetensors"), "GET /api/models should list the image model");

  const del = await request(srv.port, "POST", "/api/llm/delete-model", { body: { filename: "contract-list.gguf" } });
  assert.equal(del.status, 200, `delete-model: ${del.text}`);
  assert.ok(!fs.existsSync(path.join(root, "app", "llm-models", "contract-list.gguf")));
  assert.ok(fs.existsSync(path.join(root, "app", "SENTINEL.gguf")));
  const missing = await request(srv.port, "POST", "/api/llm/delete-model", { body: { filename: "contract-list.gguf" } });
  assert.equal(missing.status, 404);
});

test("config: conversations round-trip through save, list and delete", async () => {
  const saved = await request(srv.port, "POST", "/api/llm/save-conversation", {
    body: { title: "Contract chat", model: "m.gguf", messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }] },
  });
  assert.equal(saved.status, 200);
  const id = saved.json.conversation.id;
  assert.equal(typeof id, "string");
  const list = await request(srv.port, "GET", "/api/llm/conversations");
  const found = list.json.conversations.find((c) => c.id === id);
  assert.ok(found, "saved conversation is listed");
  assert.equal(found.title, "Contract chat");
  const del = await request(srv.port, "POST", "/api/llm/delete-conversation", { body: { id } });
  assert.equal(del.status, 200, del.text);
  const after = await request(srv.port, "GET", "/api/llm/conversations");
  assert.ok(!after.json.conversations.some((c) => c.id === id), "deleted conversation is gone");
});

// ── 5. Engines unavailable: clear errors, server stays up ───────────────────
test("engines unavailable: requests fail with an explanation and the server keeps serving", async () => {
  const cases = [
    ["POST", "/api/speech/start", {}, /whisper/i],
    ["POST", "/api/tts/speak", { text: "hi" }, /runtime|kokoro|tts/i],
    ["POST", "/sdapi/v1/txt2img", { prompt: "x" }, /not reachable|backend/i],
    ["POST", "/api/llm/chat", { messages: [{ role: "user", content: "hi" }] }, /model/i],
  ];
  for (const [m, p, body, re] of cases) {
    const r = await request(srv.port, m, p, { body });
    assert.ok(r.status >= 400, `${p} should fail without an engine (got ${r.status})`);
    assert.match(r.json.error, re, `${p} error should explain the cause`);
  }
  const health = await request(srv.port, "GET", "/api/health");
  assert.equal(health.status, 200);
});

// ── 6. Streaming chat (through a fake llama-server; a compiled stand-in .exe on Windows) ──
const net = require("node:net");
const http = require("node:http");

function sseEvents(text) {
  return text.split("\n\n").map((e) => e.trim()).filter(Boolean);
}
function deltas(events) {
  return events.filter((e) => e.startsWith("data: {")).map((e) => JSON.parse(e.slice(6)).choices?.[0]?.delta?.content || "").join("");
}
const chat = (content, stream = true, raw = true) =>
  request(srv.port, "POST", "/api/llm/chat", { body: { messages: [{ role: "user", content }], stream }, raw });
const engineStats = async () => JSON.parse((await request(srv.llmPort, "GET", "/fake/stats", { raw: true })).text);
const portOpen = (port) => new Promise((resolve) => {
  const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); resolve(true); });
  s.on("error", () => resolve(false));
});

test("streaming: the fake engine starts through the normal backend path on this OS", async () => {
  assert.ok(fs.existsSync(fakeLlamaPath(root)), `fake llama-server installed at ${fakeLlamaPath(root)}`);
  fs.writeFileSync(path.join(root, "app", "llm-models", "contract-stream.gguf"), Buffer.from("GGUF\x03\x00\x00\x00"));
  const start = await request(srv.port, "POST", "/api/llm/start", { body: { model: "contract-stream.gguf", contextSize: 512, gpuLayers: 0 } });
  assert.equal(start.status, 200, `llm/start: ${start.text}\n${srv.log().slice(-2000)}`);
  assert.equal(start.json.ok, true);
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    ready = (await request(srv.port, "GET", "/api/llm/status")).json.ready === true;
    if (!ready) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(ready, `LLM reports ready\n${srv.log().slice(-2000)}`);
  srv.llmPort = (await request(srv.port, "GET", "/api/llm/status")).json.port;
});

test("streaming: OpenAI-style SSE chunks end with finish_reason and [DONE]; non-stream returns JSON", async () => {
  const s = await chat("hi");
  assert.equal(s.status, 200);
  assert.match(String(s.headers["content-type"]), /^text\/event-stream/);
  const events = sseEvents(s.text);
  assert.ok(events.every((e) => e.startsWith("data: ")), "every SSE event is a data: line");
  assert.equal(events.at(-1), "data: [DONE]");
  assert.equal(deltas(events), "Contract test reply.");
  assert.equal(JSON.parse(events.at(-2).slice(6)).choices[0].finish_reason, "stop");

  const n = await chat("hi", false, false);
  assert.equal(n.status, 200);
  assert.equal(n.json.choices[0].message.content, "Contract test reply.");
});

test("streaming: many chunks arrive complete and in order", async () => {
  const s = await chat("MODE:count=200");
  assert.equal(s.status, 200);
  const events = sseEvents(s.text);
  assert.equal(events.at(-1), "data: [DONE]");
  assert.equal(deltas(events), Array.from({ length: 200 }, (_, i) => `${i} `).join(""));
});

test("streaming: an engine error before streaming becomes a JSON error with the engine's status and message", async () => {
  const s = await chat("MODE:http-error", true, false);
  assert.equal(s.status, 400);
  assert.equal(s.json.ok, false);
  assert.equal(s.json.error, "fake engine rejected the request");
});

test("streaming: an engine failure mid-stream cuts the client's stream promptly (no [DONE]); the next request works", async () => {
  const t0 = Date.now();
  const outcome = await chat("MODE:crash-mid").then((r) => ({ completed: true, text: r.text }), (err) => ({ completed: false, text: err.partial || "" }));
  assert.equal(outcome.completed, false, "a stream whose engine died must not end as a normal response");
  assert.ok(Date.now() - t0 < 10000, "the client is released promptly, not left waiting");
  assert.ok(!outcome.text.includes("[DONE]"), "a broken stream must not look complete");
  assert.ok(deltas(sseEvents(outcome.text)).startsWith("partial-1 partial-2"), "chunks sent before the failure arrive in order");
  const ok = await chat("hi");
  assert.equal(ok.status, 200);
  assert.equal(sseEvents(ok.text).at(-1), "data: [DONE]");
});

test("streaming: when the client disconnects, the request to the engine is aborted", async () => {
  const before = await engineStats();
  await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: srv.port, method: "POST", path: "/api/llm/chat", headers: { "Content-Type": "application/json" } }, (res) => {
      let got = 0;
      res.on("data", () => { if (++got === 3) { req.destroy(); resolve(); } });
    });
    req.on("error", () => {});
    req.on("timeout", () => reject(new Error("timeout")));
    req.end(JSON.stringify({ messages: [{ role: "user", content: "MODE:slow" }], stream: true }));
  });
  let after = before;
  for (let i = 0; i < 50 && after.aborted === before.aborted; i++) {
    await new Promise((r) => setTimeout(r, 100));
    after = await engineStats();
  }
  assert.equal(after.aborted, before.aborted + 1, "the engine saw the abort");
  assert.equal(after.completed, before.completed, "the aborted generation did not run to completion");
});

test("cleanup: stopping the text model stops the engine process and releases its port", async () => {
  const port = srv.llmPort;
  assert.equal(await portOpen(port), true, "engine is listening before stop");
  const stop = await request(srv.port, "POST", "/api/llm/stop", { body: {} });
  assert.equal(stop.json.ok, true);
  let open = true;
  for (let i = 0; i < 50 && open; i++) {
    await new Promise((r) => setTimeout(r, 100));
    open = await portOpen(port);
  }
  assert.equal(open, false, "engine port still open after stop (orphaned engine process)");
  const status = await request(srv.port, "GET", "/api/llm/status");
  assert.equal(status.json.running, false);
});
