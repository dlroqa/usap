// #90: an engine error response that is cut off before its body ends (engine crash, connection reset) must still be
// answered, exactly once, without retrying and without leaking the partial engine body. Before the fix the client
// waited forever and, with the chat queue on, its slot stayed held.
"use strict";
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const http = require("node:http");
const net = require("node:net");
const test = require("node:test");

const { createChatService, onEngineResponseSettled } = require("../server/services/chat.cjs");
const errors = require("../server/errors.cjs");

// ── The helper on its own: each terminal event, once ─────────────────────────────────────────────────────
function fakeResponse(complete = false) { const e = new EventEmitter(); e.complete = complete; return e; }
function settle(e) { const calls = []; onEngineResponseSettled(e, (c) => calls.push(c)); return calls; }

test("settle: a normal end is complete; the close after it changes nothing", () => {
  const e = fakeResponse(); const calls = settle(e);
  e.complete = true; e.emit("end"); e.emit("close");
  assert.deepEqual(calls, [true]);
});
test("settle: aborted without end is interrupted", () => {
  const e = fakeResponse(); const calls = settle(e);
  e.emit("aborted"); e.emit("close");
  assert.deepEqual(calls, [false]);
});
test("settle: an error is interrupted, and does not throw", () => {
  const e = fakeResponse(); const calls = settle(e);
  e.emit("error", new Error("aborted"));
  assert.deepEqual(calls, [false]);
});
test("settle: a premature close (body incomplete) is interrupted; a close after a complete body is complete", () => {
  const a = fakeResponse(false); const ca = settle(a); a.emit("close");
  assert.deepEqual(ca, [false]);
  const b = fakeResponse(true); const cb = settle(b); b.emit("close");
  assert.deepEqual(cb, [true]);
});
test("settle: repeated and late events never call back twice; listeners are removed; a late error doesn't throw", () => {
  const e = fakeResponse(); const calls = settle(e);
  e.emit("aborted"); e.emit("aborted"); e.emit("end"); e.emit("close");
  assert.doesNotThrow(() => e.emit("error", new Error("late")));
  assert.deepEqual(calls, [false]);
  for (const ev of ["end", "aborted", "close"]) assert.equal(e.listenerCount(ev), 0, ev);
});

// ── The chat service against a raw engine ──────────────────────────────────────────────────────────────
const PRIVATE = "/home/someone/private/models/x.gguf";
/** mode: "cut" (500, part of the body, then dropped), "hold" (500, part of the body, connection kept), "full". */
async function engine(mode) {
  const seen = { requests: 0 };
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    let buf = "";
    socket.on("data", (d) => {
      buf += d;
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const len = Number((buf.slice(0, end).match(/content-length:\s*(\d+)/i) || [])[1] || 0);
      if (buf.length < end + 4 + len) return;
      buf = "";
      seen.requests += 1;
      if (mode === "full") {
        const body = JSON.stringify({ error: { code: 500, message: `engine failed at ${PRIVATE}` } });
        socket.write(`HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
        return;
      }
      socket.write(`HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: 400\r\n\r\n{"error":{"message":"engine failed at ${PRIVATE}`);
      if (mode === "cut") setTimeout(() => socket.destroy(), 100);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, seen, close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }) };
}
async function chatApp(enginePort) {
  const state = Object.freeze({ get PORT_LLM() { return enginePort; }, get llmSettings() { return { model: "m.gguf", contextSize: 4096 }; } });
  const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  let responses = 0;
  const chat = createChatService({ state, errorBody: errors.errorBody, errorStatus: errors.errorStatus, http, json, redactPaths: errors.redactPaths,
    requestJson: async () => { throw new Error("not used"); }, runExclusiveLlmOperation: async (fn) => fn(), startLlm: async () => { throw new Error("no restarts"); },
    webSearch: { augmentMessagesWithWebSearch: async (messages) => ({ messages, webSources: [], webContext: "" }) } });
  const app = http.createServer((req, res) => {
    const writeHead = res.writeHead.bind(res);
    res.writeHead = (...a) => { responses += 1; return writeHead(...a); }; // counts responses started
    let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => chat.doLlmChat(req, res, JSON.parse(b)));
  });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  return { port: app.address().port, responses: () => responses, close: () => new Promise((r) => { app.closeAllConnections?.(); app.close(r); }) };
}
function stream(port, { abortAfterMs } = {}) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ messages: [{ role: "user", content: "hi" }], stream: true });
    const t0 = Date.now();
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/", agent: false, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode, text, ms: Date.now() - t0 }));
    });
    req.on("error", () => resolve({ status: 0, text: "", ms: Date.now() - t0 }));
    req.on("close", () => resolve({ status: 0, text: "", ms: Date.now() - t0 }));
    req.end(data);
    if (abortAfterMs) setTimeout(() => req.destroy(), abortAfterMs);
  });
}

test("cut-off engine error body: the client gets 500 ENGINE_CONNECTION_ERROR promptly, once, without the engine's text, and nothing is resent", async () => {
  const e = await engine("cut"); const a = await chatApp(e.port);
  try {
    const r = await Promise.race([stream(a.port), new Promise((res) => setTimeout(() => res({ status: "no answer" }), 5000))]);
    assert.equal(r.status, 500, "answered (before #90 the client waited forever)");
    const body = JSON.parse(r.text);
    assert.equal(body.code, "ENGINE_CONNECTION_ERROR");
    assert.ok(r.ms < 3000, `answered in ${r.ms} ms`);
    assert.doesNotMatch(r.text, /\/home|someone|private|engine failed at|x\.gguf|127\.0\.0\.1/, "no partial engine body, path or address");
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(e.seen.requests, 1, "never retried: the engine had answered");
    assert.equal(a.responses(), 1, "exactly one response");
  } finally { await a.close(); await e.close(); }
});

test("complete engine error body: answered as before (the engine's status and message, paths redacted)", async () => {
  const e = await engine("full"); const a = await chatApp(e.port);
  try {
    const r = await stream(a.port);
    assert.equal(r.status, 500);
    const body = JSON.parse(r.text);
    assert.equal(body.ok, false);
    assert.match(body.error, /engine failed at/);
    assert.equal(e.seen.requests, 1);
    assert.equal(a.responses(), 1);
  } finally { await a.close(); await e.close(); }
});

test("client leaves while the engine's error body is still arriving: nothing is written to it, nothing resent, the server keeps working", async () => {
  const e = await engine("hold"); const a = await chatApp(e.port);
  try {
    const r = await stream(a.port, { abortAfterMs: 200 });
    assert.equal(r.status, 0, "the client gave up");
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(e.seen.requests, 1);
    assert.equal(a.responses(), 0, "no response started for a client that left");
  } finally { await a.close(); await e.close(); }
  const e2 = await engine("cut"); const a2 = await chatApp(e2.port);
  try { assert.equal((await stream(a2.port)).status, 500, "a new request is answered normally afterwards"); }
  finally { await a2.close(); await e2.close(); }
});
