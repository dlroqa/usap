// Step 9.7: consistent API errors. Every error keeps `{ ok: false, error }`, gains a
// machine-readable `code`, uses the status that matches its cause, never leaks a stack or the
// host's paths, and a malformed request can never take the server down.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const errors = require("../server/errors.cjs");
const { makeRoot, startServer, stopServer, request } = require("./api-contract/harness.cjs");

// ── The error model ──────────────────────────────────────────────────────────
test("errors: status by cause, codes, compatible bodies", () => {
  const { badRequest, notFound, conflict, notInstalled, ApiError, errorStatus, errorBody } = errors;
  assert.equal(errorStatus(badRequest("X", "m")), 400);
  assert.equal(errorStatus(notFound("X", "m")), 404);
  assert.equal(errorStatus(conflict("X", "m")), 409);
  assert.equal(errorStatus(notInstalled("m")), 503);
  assert.equal(errorStatus(new ApiError(502, "X", "m")), 502);
  assert.equal(errorStatus(new Error("boom")), 500);
  assert.equal(errorStatus(Object.assign(new Error("busy"), { code: "MODEL_ALREADY_ACTIVE" })), 409, "legacy code kept");
  assert.equal(errorStatus(Object.assign(new Error("x"), { statusCode: 999 })), 500, "nonsense status ignored");

  assert.deepEqual(errorBody(badRequest("MODEL_REQUIRED", "Pick a model.")), { ok: false, error: "Pick a model.", code: "MODEL_REQUIRED" });
  assert.deepEqual(errorBody(new Error("disk full")), { ok: false, error: "disk full", code: "INTERNAL_ERROR" });
  const legacy = errorBody(new Error("x"), { error: "engine said no", code: "", activeRuntime: null, port: 1 });
  assert.deepEqual(legacy, { ok: false, error: "engine said no", code: "", activeRuntime: null, port: 1 }, "a route's existing fields are kept");
  assert.equal(errorBody(badRequest("X", "m", { hint: "try y" })).hint, "try y");
  assert.equal(errorBody(new Error("")).error, "Something went wrong in the local server.");
});

test("errors: a wrongly typed request field is a 400 with a generic message (Node's text names internals)", () => {
  const nodeErr = (() => { try { path.basename([]); } catch (e) { return e; } })();
  assert.equal(nodeErr.code, "ERR_INVALID_ARG_TYPE");
  assert.equal(errors.errorStatus(nodeErr), 400);
  const body = errors.errorBody(nodeErr);
  assert.equal(body.code, "INVALID_REQUEST");
  assert.equal(body.error, "A request field has the wrong type or value.");
  assert.doesNotMatch(JSON.stringify(body), /path|argument|Array|node:/);
});

test("errors: host paths are shortened and stacks never appear", () => {
  const root = path.join(os.tmpdir(), "studio-root");
  errors.configurePathRedaction({ root, home: path.join(os.tmpdir(), "home-of-someone") });
  const m = errors.publicMessage(new Error(`Copy a binary to ${path.join(root, "app", "speech-backend", "cpu")}. Log: ${path.join(os.tmpdir(), "home-of-someone", "x.log")}`));
  assert.ok(!m.includes(root), m);
  assert.ok(!m.includes("home-of-someone"), m);
  assert.match(m, /app[\\/]speech-backend[\\/]cpu/);
  assert.match(m, /~\/x\.log/);
  assert.ok(!errors.publicMessage(new Error(`at ${root.replace(/\\/g, "/")}/scripts`)).includes(root.replace(/\\/g, "/")), "forward-slash form too");
  const err = new Error("short message");
  assert.equal(errors.errorBody(err).error, "short message", "the message, not err.stack");
  assert.ok(!JSON.stringify(errors.errorBody(err)).includes("at "), "no stack frames");
  errors.configurePathRedaction({});
});

// ── The real server ──────────────────────────────────────────────────────────
let root;
let srv;
test.before(async () => { root = makeRoot(); srv = await startServer(root); });
test.after(() => { stopServer(srv); fs.rmSync(root, { recursive: true, force: true }); });

const post = (p, body, headers) => request(srv.port, "POST", p, { body, headers });
function expectError(r, status, code, label) {
  assert.equal(r.status, status, `${label}: ${r.text}`);
  assert.equal(r.json.ok, false, label);
  assert.equal(typeof r.json.error, "string", label);
  assert.ok(r.json.error.length > 0, label);
  if (code !== undefined) assert.equal(r.json.code, code, label);
}

test("server: invalid requests are 400, missing items 404, wrong state 409, missing engines 503 (not 500)", async () => {
  fs.writeFileSync(path.join(root, "app", "llm-models", "notes.txt"), "x");
  const cases = [
    ["/api/llm/start", {}, 400, "MODEL_REQUIRED"],
    ["/api/llm/start", { model: "does-not-exist.gguf" }, 404, "MODEL_NOT_FOUND"],
    ["/api/llm/start", { model: "notes.txt" }, 400, "MODEL_UNSUPPORTED"],
    ["/api/llm/benchmark", {}, 400, "MODEL_REQUIRED"],
    ["/api/llm/benchmark", { model: "does-not-exist.gguf" }, 404, "MODEL_NOT_FOUND"],
    ["/api/llm/delete-conversation", {}, 400, "INVALID_REQUEST"],
    ["/api/save-output", {}, 400, "INVALID_IMAGE"],
    ["/api/speech/start", {}, 503, "ENGINE_NOT_INSTALLED"],
    ["/api/tts/start", {}, 503, "ENGINE_NOT_INSTALLED"],
    ["/api/tts/speak", { text: "hi" }, 503, "ENGINE_NOT_INSTALLED"],
    ["/api/openvino-generate", {}, 409, "ENGINE_NOT_READY"],
  ];
  for (const [p, body, status, code] of cases) expectError(await post(p, body), status, code, `${p} ${JSON.stringify(body)}`);
  for (const p of ["/api/import-model", "/api/llm/import-model"]) {
    expectError(await post(`${p}?filename=evil.exe`, "x", { "Content-Type": "application/octet-stream" }), 400, "INVALID_FILENAME", p);
  }
  // Existing route-specific fields are still there.
  const start = await post("/api/llm/start", {});
  for (const k of ["ok", "error", "code", "activeRuntime"]) assert.ok(k in start.json, `llm/start keeps ${k}`);
  assert.equal(start.json.error, "Select a downloaded GGUF text model first.", "message unchanged");
});

test("server: malformed bodies get 400/415 with codes; a POST without a body still works", async () => {
  expectError(await post("/api/llm/save-conversation", "{not json"), 400, "INVALID_JSON", "broken JSON");
  for (const b of ["null", "[]", "7", "\"text\"", "true"]) {
    expectError(await post("/api/cleanup", b), 400, "INVALID_REQUEST", `body ${b}`);
  }
  expectError(await post("/api/cleanup", '{"ids":[]}', { "Content-Type": "text/plain" }), 415, "UNSUPPORTED_MEDIA_TYPE", "text/plain");
  assert.equal((await request(srv.port, "POST", "/api/llm/stop")).status, 200);
});

test("server: wrongly typed fields never crash the server (they get 400), on any JSON route", async () => {
  // Regression: a single request with a field of the wrong type used to stop the whole server.
  expectError(await post("/api/delete-model", { filename: [] }), 400, "INVALID_REQUEST", "delete-model");
  expectError(await post("/api/restart-backend", { model: {} }), 400, "INVALID_REQUEST", "restart-backend");
  const confused = { model: {}, filename: [], id: {}, ids: "x", text: {}, url: {}, messages: "x", name: [], title: {}, settings: "x", backendType: {}, prompt: [], steps: "x", voice: {}, language: [] };
  const routes = ["/api/delete-model", "/api/restart-backend", "/api/move-model", "/api/link-model", "/api/llm/delete-model", "/api/llm/save-conversation",
    "/api/llm/delete-conversation", "/api/llm/model-settings", "/api/speech/delete-model", "/api/speech/delete-transcription", "/api/tts/delete-model",
    "/api/tts/delete-output", "/api/cleanup", "/api/delete-outputs", "/api/save-output", "/api/settings", "/api/llm/start", "/api/speech/start", "/api/tts/start"];
  for (const p of routes) {
    const r = await post(p, confused);
    assert.ok(r.status < 500 || r.status === 503, `${p}: ${r.status} ${r.text.slice(0, 200)}`);
    assert.equal(srv.proc.exitCode, null, `server still running after ${p}`);
  }
  assert.equal((await request(srv.port, "GET", "/api/health")).status, 200);
});

test("server: no error leaks the host's paths or a stack trace", async () => {
  const r = await post("/api/speech/start", {});
  assert.ok(!r.text.includes(root), r.text);
  assert.ok(!r.text.includes(os.homedir()) || os.homedir().length < 4, r.text);
  assert.doesNotMatch(r.text, /\n\s+at |node:internal|\.cjs:\d+/);
  assert.match(r.json.error, /app[\\/]speech-backend/, "still says where to put the engine, relative to the studio folder");
  const crash = await post("/api/delete-model", { filename: [] });
  assert.doesNotMatch(crash.text, /node:|TypeError|ERR_INVALID_ARG_TYPE|\.cjs/);
});

test("server: existing status codes and messages the frontend relies on are kept", async () => {
  const unknown = await request(srv.port, "GET", "/api/does-not-exist");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error, "Unknown API endpoint", "the frontend matches this text");
  const cross = await request(srv.port, "POST", "/api/cleanup", { body: {}, headers: { Origin: "http://evil.example" } });
  assert.equal(cross.status, 403);
  const chat = await post("/api/llm/chat", { messages: [{ role: "user", content: "hi" }] });
  assert.equal(chat.status, 409);
  assert.equal(chat.json.error, "Load a text model before sending a message.");
  assert.equal((await request(srv.port, "GET", "/api/llm/start")).status, 404, "wrong method stays 404");
});
