"use strict";
// scripts/ci/observe-json.cjs: the native validators' recorded observation of a JSON endpoint (#163 native run, where
// a failed /api/resources check said only "undefined"). Real local HTTP servers; no retries, no timeout changes.
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const test = require("node:test");
const path = require("node:path");
const os = require("node:os");
const { observeJson, describeObservation, runtimeLabel } = require("../ci/observe-json.cjs");

const EXPECT = { "limits.chatQueue": "on", "scheduler.mode": "chat-queue" };
const OPTS = { knownKeys: ["ok", "scheduler", "limits"], allowedValues: { "limits.chatQueue": ["on", "off"], "scheduler.mode": ["observe", "off", "chat-queue"] } };
const SECRET = "tok_9f8e7d6c5b4a39281706";
const PRIVATE_PATH = "/Users/someone/private/models/x.gguf";

async function serve(handler) {
  const sockets = new Set();
  const s = http.createServer(handler);
  s.on("connection", (c) => { sockets.add(c); c.on("close", () => sockets.delete(c)); });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return { port: s.address().port, close: () => new Promise((r) => { for (const c of sockets) c.destroy(); s.close(() => r()); }) };
}
const json = (res, status, body, type = "application/json; charset=utf-8") => { res.writeHead(status, { "Content-Type": type }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
function noLeak(detail) {
  assert.ok(!detail.includes(SECRET), `token-like value leaked: ${detail}`);
  assert.ok(!detail.includes("someone") && !detail.includes("x.gguf"), `path leaked: ${detail}`);
}

test("observe-json: a good answer passes and reports status, time, content type and the expected values", async () => {
  const s = await serve((req, res) => json(res, 200, { limits: { chatQueue: "on" }, scheduler: { mode: "chat-queue" }, auth: { token: SECRET }, model: PRIVATE_PATH }));
  try {
    const o = await observeJson(s.port, "/api/resources", { timeoutMs: 5000 });
    const d = describeObservation(o, EXPECT, OPTS);
    assert.equal(d.ok, true);
    assert.match(d.detail, /status 200 in \d+ ms/);
    assert.match(d.detail, /timeout no/);
    assert.match(d.detail, /content-type application\/json/);
    assert.match(d.detail, /limits\.chatQueue="on", scheduler\.mode="chat-queue"/);
    assert.match(d.detail, /JSON object: 4 keys; known present \[scheduler,limits\]; known missing \[ok\]; other keys 2/);
    assert.ok(!/\bauth\b|\bmodel\b/.test(d.detail), "keys outside the allowlist are counted, never named");
    noLeak(d.detail);
  } finally { await s.close(); }
});

test("observe-json: missing fields fail and are named MISSING; other values are reduced to their type", async () => {
  const s = await serve((req, res) => json(res, 200, { limits: { chatQueue: SECRET }, other: PRIVATE_PATH }));
  try {
    const d = describeObservation(await observeJson(s.port, "/api/resources"), EXPECT, OPTS);
    assert.equal(d.ok, false);
    assert.match(d.detail, /scheduler\.mode=MISSING/);
    assert.match(d.detail, /limits\.chatQueue=<other string>/, "a value outside the field's allowlist is never printed");
    noLeak(d.detail);
  } finally { await s.close(); }
});

test("observe-json: a non-success, non-JSON answer reports its status, content type and size, never its text", async () => {
  const s = await serve((req, res) => json(res, 503, `<html>${SECRET} ${PRIVATE_PATH}</html>`, "text/html"));
  try {
    const d = describeObservation(await observeJson(s.port, "/api/resources"), EXPECT, OPTS);
    assert.equal(d.ok, false);
    assert.match(d.detail, /status 503/);
    assert.match(d.detail, /content-type text\/html/);
    assert.match(d.detail, /not JSON/);
    assert.match(d.detail, /body \d+ B/);
    assert.match(d.detail, /limits\.chatQueue=MISSING, scheduler\.mode=MISSING/);
    noLeak(d.detail);
  } finally { await s.close(); }
});

test("observe-json: a server that never answers is reported as a client timeout after the unchanged timeout", async () => {
  const s = await serve(() => { /* never answers */ });
  try {
    const o = await observeJson(s.port, "/api/resources", { timeoutMs: 300 });
    const d = describeObservation(o, EXPECT, OPTS);
    assert.equal(d.ok, false);
    assert.equal(o.timedOut, true);
    assert.ok(o.durationMs >= 250 && o.durationMs < 5000, `bounded by the timeout (${o.durationMs} ms)`);
    assert.match(d.detail, /no response/);
    assert.match(d.detail, /timeout YES \(300 ms\)/);
    assert.match(d.detail, /error client-timeout/);
  } finally { await s.close(); }
});

test("observe-json: a refused connection is reported with its error code, no retry", async () => {
  const free = await new Promise((r) => { const t = net.createServer(); t.listen(0, "127.0.0.1", () => { const p = t.address().port; t.close(() => r(p)); }); });
  const o = await observeJson(free, "/api/resources", { timeoutMs: 2000 });
  const d = describeObservation(o, EXPECT, OPTS);
  assert.equal(d.ok, false);
  assert.equal(o.timedOut, false);
  assert.match(d.detail, /no response/);
  assert.match(d.detail, /error ECONNREFUSED/);
});

test("observe-json: an answer cut off mid-body is marked incomplete", async () => {
  const s = await serve((req, res) => { res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "1000" }); res.write('{"limits":'); setTimeout(() => res.socket.destroy(), 50); });
  try {
    const d = describeObservation(await observeJson(s.port, "/api/resources"), EXPECT, OPTS);
    assert.equal(d.ok, false);
    assert.match(d.detail, /\(incomplete\)/);
    assert.match(d.detail, /not JSON/);
  } finally { await s.close(); }
});

test("observe-json: the server's lifecycle state is included when given", () => {
  const o = { path: "/api/resources", status: 0, durationMs: 10000, timedOut: true, timeoutMs: 10000, error: "client-timeout", contentType: null, bodyBytes: 0, ended: false, json: null };
  assert.match(describeObservation(o, EXPECT, { server: () => ({ alive: true, upMs: 4321 }) }).detail, /server alive, up 4321 ms/);
  assert.match(describeObservation(o, EXPECT, { server: () => ({ alive: false, code: null, signal: "SIGKILL", upMs: 9 }) }).detail, /server exited \(code null, signal SIGKILL\)/);
});

test("observe-json: allowlists — a word-like value or key outside them is never printed; an allowed other value is", async () => {
  const s = await serve((req, res) => json(res, 200, { limits: { chatQueue: "off" }, scheduler: { mode: "secret" }, password: "x", alice: 1 }));
  try {
    const d = describeObservation(await observeJson(s.port, "/api/resources"), EXPECT, OPTS);
    assert.equal(d.ok, false);
    assert.match(d.detail, /limits\.chatQueue="off"/, "an allowed value of the field is printed");
    assert.match(d.detail, /scheduler\.mode=<other string>/, "a word-like value outside the allowlist is not");
    assert.ok(!/secret|password|alice/.test(d.detail), `nothing outside the allowlists is named: ${d.detail}`);
  } finally { await s.close(); }
});

test("observe-json: runtime label names the validator's and the launched server's Node separately", () => {
  const label = runtimeLabel(process.execPath, "/nowhere-root");
  assert.match(label, new RegExp(`^validator node ${process.version.replace(/\./g, "\\.")}; server node v\\d+\\.\\d+\\.\\d+ \\(the validator's own node\\)$`));
  const root = path.join(os.tmpdir(), "usap-no-such-root");
  const missing = path.join(root, "no-such", "node");
  const fake = runtimeLabel(missing, root);
  assert.equal(fake, `validator node ${process.version}; server node unknown (${path.relative(root, missing)})`, "an unreadable server node is reported as unknown, not guessed");
});
