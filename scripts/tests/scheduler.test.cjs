// Step 9.9b: read-only resource accounting (services/scheduler.cjs, GET /api/resources). The stage makes no
// scheduling decisions; these tests pin that it only observes, reports unknowns as unknown, leaks no
// identifiers, stays behind the request pipeline, and that USAP_SCHEDULER=off restores the previous behaviour.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { makeRoot, startServer, stopServer, request } = require("./api-contract/harness.cjs");
const { createScheduler, schedulerMode } = require("../server/services/scheduler.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000, label = "condition") {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(100);
  }
}
const fakeEngines = (over = {}) => ({
  text: () => ({ state: "stopped", loaded: false, pendingOperations: () => 0, chatActive: () => 0, chatWaiting: () => 0 }),
  image: () => ({ state: "stopped", loaded: false, generating: false }),
  speech: () => ({ state: "stopped", active: false, pendingOperations: () => 0 }),
  voice: () => ({ state: "stopped", active: false, pendingOperations: () => 0 }),
  download: () => ({ active: false }),
  heavyModel: () => null,
  ...over,
});
const cpu = { logicalCores: () => 8, physicalCores: () => 4 };

// ── Unit ─────────────────────────────────────────────────────────────────────
test("mode: observe by default; USAP_SCHEDULER and app/config/scheduler.json can turn it off; the environment wins", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usap-sched-"));
  try {
    assert.equal(schedulerMode({ env: {}, configDir: dir }), "observe");
    assert.equal(schedulerMode({ env: { USAP_SCHEDULER: "OFF" }, configDir: dir }), "off");
    assert.equal(schedulerMode({ env: { USAP_SCHEDULER: "enforce" }, configDir: dir }), "observe", "no enforcing mode exists in 9.9b");
    fs.writeFileSync(path.join(dir, "scheduler.json"), JSON.stringify({ scheduler: "off" }));
    assert.equal(schedulerMode({ env: {}, configDir: dir }), "off");
    assert.equal(schedulerMode({ env: { USAP_SCHEDULER: "observe" }, configDir: dir }), "observe");
    fs.writeFileSync(path.join(dir, "scheduler.json"), "{ not json");
    assert.equal(schedulerMode({ env: {}, configDir: dir }), "observe");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("memory: unknown values are reported as unknown, never as zero or as enough", () => {
  const s = createScheduler({ cpu, engines: fakeEngines(), budget: {
    totalRamBytes: () => 16e9, freeRamBytes: () => { throw new Error("poll failed"); }, totalVramBytes: () => 0, freeVramBytes: () => null } }).snapshot();
  assert.deepEqual(s.memory.ram.totalBytes, { value: 16e9, known: true });
  assert.deepEqual(s.memory.ram.freeBytes, { value: null, known: false });
  assert.deepEqual(s.memory.vram.totalBytes, { value: null, known: false }, "0 VRAM means none detected, not none needed");
  assert.deepEqual(s.memory.vram.freeBytes, { value: null, known: false });
  const g = createScheduler({ cpu, engines: fakeEngines(), budget: {
    totalRamBytes: () => 16e9, freeRamBytes: () => 8e9, totalVramBytes: () => 8e9, freeVramBytes: () => 6e9 } }).snapshot();
  assert.deepEqual(g.memory.vram, { totalBytes: { value: 8e9, known: true }, freeBytes: { value: 6e9, known: true } });
});

test("snapshot: counts become running/waiting; broken accessors are unknown; every limit is off and no decision is made", () => {
  const s = createScheduler({ cpu, budget: { totalRamBytes: () => 1, freeRamBytes: () => 1, totalVramBytes: () => 0, freeVramBytes: () => null },
    engines: fakeEngines({
      text: () => ({ state: "ready", loaded: true, pendingOperations: () => 3, chatActive: () => 2, chatWaiting: () => 1 }),
      speech: () => ({ state: "stopped", active: false, pendingOperations: () => { throw new Error("x"); } }),
      heavyModel: () => ({ type: "text" }),
    }) }).snapshot();
  assert.deepEqual(s.engines.text.operations, { running: 1, waiting: 2, known: true });
  assert.deepEqual(s.engines.text.chat, { active: 2, waitingForEngineConnection: 1 });
  assert.deepEqual(s.engines.speech.operations, { running: null, waiting: null, known: false });
  assert.deepEqual(s.engines.image.queue, { running: null, waiting: null, known: false }, "the studio keeps no image queue");
  assert.deepEqual(s.limits, { chatQueue: "off", memoryCheck: "off", threads: "off", queueTimeouts: "off" });
  assert.deepEqual(s.scheduler, { mode: "observe", stage: "9.9c", decisions: false }, "the chat queue is off by default");
  const on = createScheduler({ cpu, budget: { totalRamBytes: () => 1, freeRamBytes: () => 1, totalVramBytes: () => 0, freeVramBytes: () => null }, engines: fakeEngines(), chatQueue: { mode: "on" } }).snapshot();
  assert.deepEqual(on.scheduler, { mode: "chat-queue", stage: "9.9c", decisions: true });
  assert.deepEqual(on.limits, { chatQueue: "on", memoryCheck: "off", threads: "off", queueTimeouts: "chat" });
  assert.deepEqual(s.heavyModel, { type: "text" });
  assert.throws(() => createScheduler({}), /scheduler: missing dependency/);
});

test("source: the scheduler only reads; it has no way to refuse, queue, unload or change settings", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server", "services", "scheduler.cjs"), "utf8").replace(/\/\/.*$/gm, "");
  for (const forbidden of [/\bkill\w*\(/, /\bstop\w*\(/, /\bstart\w*\(/, /setTimeout|setInterval/, /writeFile|unlink|rmSync/, /\b429\b|\b409\b/, /\.(threads|contextSize|gpuLayers)\s*=/]) {
    assert.doesNotMatch(src, forbidden, `scheduler.cjs must not contain ${forbidden}`);
  }
});

// ── Real server ──────────────────────────────────────────────────────────────
let root, srv;
test.before(async () => {
  root = makeRoot();
  fs.writeFileSync(path.join(root, "app", "llm-models", "secret-project-name.gguf"), Buffer.from("GGUF\x03\x00\x00\x00"));
  srv = await startServer(root);
});
test.after(async () => {
  try { await request(srv.port, "POST", "/api/llm/stop", { body: {} }); } catch (_) { /* down */ }
  stopServer(srv);
  await sleep(300);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* Windows may hold files briefly */ }
});
const resources = async () => (await request(srv.port, "GET", "/api/resources")).json;
const slowChat = (content) => new Promise((resolve) => {
  const req = http.request({ host: "127.0.0.1", port: srv.port, method: "POST", path: "/api/llm/chat", headers: { "Content-Type": "application/json" } }, (res) => {
    let text = ""; res.on("data", (c) => { text += c; }); res.on("end", () => resolve(text)); res.on("error", () => resolve(text));
  });
  req.on("error", () => resolve(""));
  req.end(JSON.stringify({ messages: [{ role: "user", content }], stream: true }));
});

test("server: chats in progress are counted while they run, all complete normally, and the counts return to zero", async () => {
  const start = await request(srv.port, "POST", "/api/llm/start", { body: { model: "secret-project-name.gguf", gpuLayers: 0 } });
  assert.equal(start.status, 200, start.text);
  await waitFor(async () => (await request(srv.port, "GET", "/api/llm/status")).json.ready, 20000, "ready");
  const chats = [slowChat("MODE:slow PRIVATE_PROMPT_TEXT"), slowChat("MODE:slow PRIVATE_PROMPT_TEXT"), slowChat("MODE:slow PRIVATE_PROMPT_TEXT")];
  const during = await waitFor(async () => { const r = await resources(); return r.engines.text.chat.active === 3 ? r : null; }, 10000, "3 active chats");
  assert.equal(during.engines.text.chat.waitingForEngineConnection, 2, "streams share one engine connection, as before (maxSockets 1)");
  assert.equal(during.engines.text.state, "ready");
  assert.equal(during.engines.text.loaded, true);
  assert.deepEqual(during.heavyModel, { type: "text" });
  const text = JSON.stringify(during);
  for (const secret of ["secret-project-name", "PRIVATE_PROMPT_TEXT", root, root.replace(/\\/g, "/"), "127.0.0.1"]) assert.ok(!text.includes(secret), `no ${secret} in /api/resources`);
  const outputs = await Promise.all(chats);
  for (const o of outputs) assert.ok(o.trimEnd().endsWith("data: [DONE]"), "every counted chat completes unchanged");
  const after = await waitFor(async () => { const r = await resources(); return r.engines.text.chat.active === 0 ? r : null; }, 10000, "counts back to 0");
  assert.equal(after.engines.text.chat.waitingForEngineConnection, 0);
  assert.deepEqual(after.engines.text.operations, { running: 0, waiting: 0, known: true });
});

test("server: queued engine operations are counted (a slow load running, a second load waiting) without changing their order", async () => {
  writeFileSafe(path.join(root, "app", "llm-models", "slow-start.gguf"));
  const first = request(srv.port, "POST", "/api/llm/start", { body: { model: "slow-start.gguf", gpuLayers: 0 } });
  const second = request(srv.port, "POST", "/api/llm/start", { body: { model: "secret-project-name.gguf", gpuLayers: 0 } });
  const busy = await waitFor(async () => { const r = await resources(); return r.engines.text.operations.waiting === 1 ? r : null; }, 10000, "one running, one waiting");
  assert.equal(busy.engines.text.operations.running, 1);
  assert.equal(busy.engines.text.state, "starting");
  await request(srv.port, "POST", "/api/llm/stop", { body: {} });
  assert.equal((await first).json.code, "ENGINE_START_CANCELLED");
  assert.equal((await second).status, 200, "the waiting load runs after the first, as before");
  await waitFor(async () => (await resources()).engines.text.operations.running === 0, 20000, "queue empty");
});
function writeFileSafe(file) { fs.writeFileSync(file, Buffer.from("GGUF\x03\x00\x00\x00")); }

test("server: GET only, behind sign-in and the Origin check", async () => {
  assert.equal((await request(srv.port, "POST", "/api/resources", { body: {} })).status, 404);
  const r2 = makeRoot();
  const s2 = await startServer(r2, { UAIS_AUTH: "on" }, { readyPath: "/api/auth/status" });
  try {
    assert.equal((await request(s2.port, "GET", "/api/resources")).status, 401);
    const lanAuth = require("../server/lan-auth.cjs");
    const token = lanAuth.readTokenFile(path.join(r2, "app", "config", lanAuth.TOKEN_FILE_NAME));
    const cross = await request(s2.port, "GET", "/api/resources", { headers: { Authorization: `Bearer ${token}`, Origin: "https://evil.example" } });
    assert.equal(cross.status, 403);
    const ok = await request(s2.port, "GET", "/api/resources", { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(ok.status, 200);
    assert.ok(!ok.text.includes(token), "no credentials");
  } finally {
    stopServer(s2);
    await sleep(300);
    try { fs.rmSync(r2, { recursive: true, force: true }); } catch (_) { /* Windows may hold files briefly */ }
  }
});

// ── Rollback ─────────────────────────────────────────────────────────────────
async function sampleBehaviour(port) {
  const out = [];
  for (const [m, u, body] of [["GET", "/api/resources"], ["GET", "/api/llm/status"], ["GET", "/api/llm/conversations"],
    ["POST", "/api/llm/save-conversation", { id: "c1", title: "t", messages: [{ role: "user", content: "x" }], timestamp: 1 }],
    ["GET", "/api/llm/conversations"], ["POST", "/api/llm/chat", { messages: [{ role: "user", content: "hi" }] }], ["GET", "/api/nope"]]) {
    const r = await request(port, m, u, body ? { body } : {});
    out.push([m, u, r.status, String(r.text).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<T>").replace(/"(port|preferredPort|modifiedAt|sizeBytes)":[^,}]+/g, '"$1":0')]);
  }
  return out;
}
test("rollback: with USAP_SCHEDULER=off (or scheduler.json) the route is gone and every other answer is unchanged", async () => {
  const runs = {};
  for (const [label, env, file] of [["on", {}, null], ["off-env", { USAP_SCHEDULER: "off" }, null], ["off-file", {}, { scheduler: "off" }]]) {
    const r = makeRoot();
    if (file) { fs.mkdirSync(path.join(r, "app", "config"), { recursive: true }); fs.writeFileSync(path.join(r, "app", "config", "scheduler.json"), JSON.stringify(file)); }
    const s = await startServer(r, env);
    try { runs[label] = (await sampleBehaviour(s.port)).map((row) => row.map((v) => (typeof v === "string" ? v.split(r).join("<ROOT>") : v))); }
    finally { stopServer(s); await sleep(300); try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) { /* Windows */ } }
  }
  const unknown = runs["off-env"].find((x) => x[1] === "/api/nope");
  for (const off of ["off-env", "off-file"]) {
    const gone = runs[off].find((x) => x[1] === "/api/resources");
    assert.equal(gone[2], 404, `${off}: route not registered`);
    assert.equal(gone[3], unknown[3], `${off}: answers exactly like any unknown endpoint`);
    assert.deepEqual(runs[off].filter((x) => x[1] !== "/api/resources"), runs.on.filter((x) => x[1] !== "/api/resources"), `${off}: every other answer is identical`);
  }
  assert.equal(runs.on.find((x) => x[1] === "/api/resources")[2], 200);
});
