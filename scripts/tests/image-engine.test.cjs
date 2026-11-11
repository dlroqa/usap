// Step 9.8g: image generation (services/image-engine.cjs, routes/image.cjs), end to end through the real
// server with a fake stable-diffusion.cpp sd-server (api-contract/fake-sd-server.cjs). Covers loading a
// quantized GGUF model, generating, saved outputs, load failures, crashes and clean-up, concurrent and
// cancelled generation, no fixed proxy timeout, output path safety, sign-in and Origin checks.
// Real CPU image generation with a real model runs in .github/workflows/native-runtime.yml on all 4 OS.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const test = require("node:test");

const { makeRoot, startServer, stopServer, request, installFakeSdServer } = require("./api-contract/harness.cjs");

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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
// A quantized image GGUF (architecture sd1, file type Q4_0), sparse-extended past the 128 MB minimum.
function writeModel(dir, name) {
  const kv = (key, type, val) => {
    const k = Buffer.from(key); const head = Buffer.alloc(8 + k.length + 4); head.writeBigUInt64LE(BigInt(k.length)); k.copy(head, 8); head.writeUInt32LE(type, 8 + k.length);
    if (type === 8) { const v = Buffer.from(val); const b = Buffer.alloc(8 + v.length); b.writeBigUInt64LE(BigInt(v.length)); v.copy(b, 8); return Buffer.concat([head, b]); }
    const b = Buffer.alloc(4); b.writeUInt32LE(val); return Buffer.concat([head, b]);
  };
  const header = Buffer.alloc(24); header.write("GGUF"); header.writeUInt32LE(3, 4); header.writeBigUInt64LE(0n, 8); header.writeBigUInt64LE(2n, 16);
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.concat([header, kv("general.architecture", 8, "sd1"), kv("general.file_type", 4, 2)]));
  fs.truncateSync(file, 130 * 1024 * 1024);
  return file;
}
const getBuffer = (port, urlPath) => new Promise((resolve, reject) => {
  http.get({ host: "127.0.0.1", port, path: urlPath }, (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], body: Buffer.concat(c) })); }).on("error", reject);
});
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };

let srv;
let root;
const MODELS = () => path.join(root, "app", "models");
async function load(model, extra = {}) {
  const r = await request(srv.port, "POST", "/api/restart-backend", { body: { model, backend_type: "cpu", use_gpu: false, width: 64, height: 64, steps: 4, ...extra } });
  return r;
}
const status = async () => (await request(srv.port, "GET", "/api/backend-status")).json;
const stop = () => request(srv.port, "POST", "/api/stop-backend", { body: {} });
const engineStats = async () => {
  const st = await status();
  return new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port: st.port, path: "/fake/stats" }, (res) => { let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => resolve(JSON.parse(b))); }).on("error", () => resolve(null));
  });
};
const txt2img = (body, { signal } = {}) => new Promise((resolve, reject) => {
  const data = JSON.stringify({ prompt: "a red apple", steps: 4, width: 64, height: 64, seed: 42, batch_size: 1, ...body });
  const req = http.request({ host: "127.0.0.1", port: srv.port, method: "POST", path: "/sdapi/v1/txt2img", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
    let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => { let j; try { j = JSON.parse(b); } catch (_) { j = undefined; } resolve({ status: res.statusCode, json: j }); });
  });
  req.on("error", reject);
  if (signal) signal.addEventListener("abort", () => req.destroy(new Error("aborted by test")));
  req.end(data);
});

test.before(async () => {
  root = makeRoot();
  installFakeSdServer(root);
  for (const name of ["sd1-test-q4_0.gguf", "sd1-fail-load-q4_0.gguf", "sd1-crash-on-generate-q4_0.gguf", "sd1-slow-generate-q4_0.gguf"]) writeModel(MODELS(), name);
  fs.writeFileSync(path.join(MODELS(), "tiny-q4_0.gguf"), "GGUF too small");
  srv = await startServer(root);
});
test.after(async () => {
  try { await stop(); } catch (_) { /* server may be gone */ }
  stopServer(srv);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* Windows may hold files briefly */ }
});

test("9.8g: the CPU image engine is detected and offered", async () => {
  const opts = (await request(srv.port, "GET", "/api/backend-options")).json;
  assert.ok(opts.options.some((o) => o.id === "cpu" && o.available), JSON.stringify(opts));
});

test("9.8g: a quantized GGUF model loads and generates a PNG; progress, outputs and stop work", async (t) => {
  t.after(() => stop());
  const start = await load("sd1-test-q4_0.gguf");
  assert.equal(start.status, 200, JSON.stringify(start.json));
  const ready = await waitFor(async () => { const s = await status(); return s.ready ? s : (s.error ? s : null); }, 30000, "image engine ready");
  assert.equal(ready.ready, true, JSON.stringify(ready));
  const stats = await engineStats();
  assert.ok(stats.args.includes("--model") && stats.args[stats.args.indexOf("--model") + 1].endsWith("sd1-test-q4_0.gguf"), "the GGUF file is passed to the engine as is");
  assert.ok(stats.args.includes("--backend") ? stats.args[stats.args.indexOf("--backend") + 1] === "cpu" : true);

  const gen = await txt2img({});
  assert.equal(gen.status, 200);
  const png = Buffer.from(gen.json.images[0], "base64");
  assert.ok(png.subarray(0, 8).equals(PNG_MAGIC), "a real PNG comes back");
  const progress = await waitFor(async () => { const p = (await request(srv.port, "GET", "/api/generation-progress")).json; return p.active === false ? p : null; }, 5000, "generation finished");
  assert.equal(progress.step, 0);

  const saved = await request(srv.port, "POST", "/api/save-output", { body: { image: `data:image/png;base64,${gen.json.images[0]}`, metadata: { prompt: "a red apple", seed: 42 } } });
  assert.equal(saved.status, 200);
  const list = (await request(srv.port, "GET", "/api/outputs")).json.outputs;
  assert.equal(list.length, 1);
  const file = await getBuffer(srv.port, list[0].url);
  assert.equal(file.status, 200);
  assert.equal(file.type, "image/png");
  assert.ok(file.body.subarray(0, 8).equals(PNG_MAGIC));

  const pid = stats.pid;
  assert.equal((await stop()).status, 200);
  await waitFor(() => !pidAlive(pid), 10000, "engine process gone after stop");
  assert.equal((await status()).ready, false);
});

test("9.8g: invalid and unsupported models are refused before the engine starts", async (t) => {
  t.after(() => stop());
  for (const [model, pattern] of [
    ["missing.gguf", /Model file not found: missing\.gguf/],
    ["../../SENTINEL.gguf", /Model file not found: SENTINEL\.gguf/],
    ["tiny-q4_0.gguf", /too small to be a complete image model/],
  ]) {
    const r = await load(model);
    assert.notEqual(r.status, 200, model);
    assert.match(r.json.error, pattern, model);
  }
  assert.equal((await status()).ready, false);
  assert.ok(fs.existsSync(path.join(root, "app", "SENTINEL.gguf")), "a file outside the models folder is never used");
});

test("9.8g: a model that fails to load reports the engine's error and leaves no engine running", async (t) => {
  t.after(() => stop());
  await load("sd1-fail-load-q4_0.gguf");
  const s = await waitFor(async () => { const st = await status(); return st.error ? st : null; }, 20000, "load error reported");
  assert.equal(s.ready, false);
  assert.match(String(s.error), /load|failed|exited/i);
  await stop();
});

test("9.8g: an engine crash during generation is reported, and the process is cleaned up", async (t) => {
  t.after(() => stop());
  await load("sd1-crash-on-generate-q4_0.gguf");
  await waitFor(async () => (await status()).ready, 30000, "ready");
  const { pid } = await engineStats();
  const gen = await txt2img({});
  assert.ok(gen.status >= 500, `the request fails instead of hanging (${gen.status})`);
  await waitFor(() => !pidAlive(pid), 10000, "crashed engine gone");
  const s = await waitFor(async () => { const st = await status(); return !st.ready ? st : null; }, 10000, "not ready after crash");
  assert.equal(s.ready, false);
  await stop();
});

test("9.8g: concurrent generation, restart protection, a slow generation without a proxy timeout, and cancellation", async (t) => {
  t.after(() => stop());
  await load("sd1-slow-generate-q4_0.gguf");
  await waitFor(async () => (await status()).ready, 30000, "ready");

  // Two requests at once both complete (the engine queues them); a 3 s generation is not cut off.
  const t0 = Date.now();
  const [a, b] = await Promise.all([txt2img({ seed: 1 }), (async () => { await sleep(100); return txt2img({ seed: 2 }); })()]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.ok(Date.now() - t0 >= 2900, "the slow generation ran to completion");

  // While a generation runs: progress is reported, and a restart with other settings is refused.
  const running = txt2img({ seed: 3 });
  await waitFor(async () => (await request(srv.port, "GET", "/api/generation-progress")).json.active, 5000, "progress active");
  const p = (await request(srv.port, "GET", "/api/generation-progress")).json;
  assert.ok(p.steps > 0 || p.step >= 0);
  const restart = await load("sd1-slow-generate-q4_0.gguf", { steps: 8 }); // same model, new settings
  assert.equal(restart.status, 409, JSON.stringify(restart.json));
  assert.match(restart.json.error, /Image generation is in progress/);
  assert.equal((await running).status, 200);

  // Existing behaviour, kept by the move: a client that disconnects does not cancel the engine's work (the
  // proxy doesn't forward the disconnect, and stable-diffusion.cpp can't stop mid-generation). The engine
  // finishes, stays usable, and stopping the engine is the way to cancel (below). Follow-up: issue #64.
  const before = await engineStats();
  const ctl = new AbortController();
  const cancelled = txt2img({ seed: 4 }, { signal: ctl.signal }).catch((e) => e);
  await sleep(500);
  ctl.abort();
  assert.ok((await cancelled) instanceof Error, "the client's request ends at once");
  await waitFor(async () => (await engineStats()).completed > before.completed, 10000, "engine finished the abandoned job");
  assert.equal((await engineStats()).pid, before.pid, "the engine kept running");
  assert.equal((await txt2img({ seed: 6 })).status, 200, "and still generates");

  // Stopping during a generation ends the engine.
  const { pid } = await engineStats();
  const during = txt2img({ seed: 5 });
  await sleep(300);
  assert.equal((await stop()).status, 200);
  const r = await during;
  assert.notEqual(r.status, 200);
  await waitFor(() => !pidAlive(pid), 10000, "engine gone after stop during generation");
});

test("9.8g: saved outputs keep to the outputs folder", async () => {
  const bad = await getBuffer(srv.port, "/api/output-file?filename=..%2FSENTINEL.png");
  assert.equal(bad.status, 404);
  const del = await request(srv.port, "POST", "/api/delete-outputs", { body: { outputs: ["../SENTINEL.png", "../../app/SENTINEL.png"] } });
  assert.equal(del.status, 200);
  assert.ok(fs.existsSync(path.join(root, "app", "SENTINEL.png")));
  const notImage = await request(srv.port, "POST", "/api/save-output", { body: { image: "data:text/html;base64,PHNjcmlwdD4=" } });
  assert.equal(notImage.status, 400);
  for (const f of fs.readdirSync(path.join(root, "app", "outputs"))) assert.match(f, /^output-[\w-]+\.(png|json)$/);
});

test("9.8g: with sign-in on, image routes need sign-in, and cross-origin requests are refused", async () => {
  const r2 = makeRoot();
  const s2 = await startServer(r2, { UAIS_AUTH: "on" }, { readyPath: "/api/auth/status" });
  try {
    for (const [m, u] of [["GET", "/api/backend-status"], ["GET", "/api/generation-progress"], ["GET", "/api/outputs"], ["GET", "/api/output-file?filename=x.png"],
      ["POST", "/api/restart-backend"], ["POST", "/api/stop-backend"], ["POST", "/api/save-output"], ["POST", "/api/delete-outputs"], ["POST", "/api/openvino-generate"],
      ["GET", "/v1/models"], ["POST", "/sdapi/v1/txt2img"]]) {
      const r = await request(s2.port, m, u, m === "POST" ? { body: {} } : {});
      assert.equal(r.status, 401, `${m} ${u}`);
    }
    const lanAuth = require("../server/lan-auth.cjs");
    const token = lanAuth.readTokenFile(path.join(r2, "app", "config", lanAuth.TOKEN_FILE_NAME));
    const cross = await request(s2.port, "POST", "/api/stop-backend", { body: {}, headers: { Authorization: `Bearer ${token}`, Origin: "https://evil.example" } });
    assert.equal(cross.status, 403);
    const ok = await request(s2.port, "GET", "/api/backend-status", { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(ok.status, 200);
    for (const k of ["ready", "running", "port", "error", "loading", "settings"]) assert.ok(k in ok.json, `backend-status keeps ${k}`);
  } finally {
    stopServer(s2);
    try { fs.rmSync(r2, { recursive: true, force: true }); } catch (_) { /* Windows may hold files briefly */ }
  }
});
