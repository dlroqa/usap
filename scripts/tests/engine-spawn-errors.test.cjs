// #68: an engine file that exists but can't be started must not stop the studio server. Covers the text
// (llama.cpp), image (stable-diffusion.cpp) and speech (whisper.cpp) engines through the real server:
//   * a file without execute permission (EACCES; POSIX only: Windows has no execute bit),
//   * a folder where the engine file should be (EACCES/UNKNOWN on every OS),
//   * a damaged binary (started through the engine guard, which reports it as a failed launch).
// Each case: the server keeps running, the request fails with a safe message (no paths), nothing is left
// running, and once the engine is repaired the next start works.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { makeRoot, startServer, stopServer, request, fakeLlamaPath, installFakeSdServer, fakeSdPath, IS_WIN } = require("./api-contract/harness.cjs");
const { describeSpawnError, isLaunchFailure } = require("../server/spawn-error.cjs");

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

// Replace an engine file with a broken one; returns a function that puts the working file back.
function breakEngine(file, how) {
  const saved = fs.readFileSync(file);
  const mode = fs.statSync(file).mode;
  fs.rmSync(file, { force: true });
  if (how === "no-exec") { fs.writeFileSync(file, saved); fs.chmodSync(file, 0o644); }
  if (how === "directory") fs.mkdirSync(file);
  if (how === "damaged") { fs.writeFileSync(file, Buffer.from("\x7fELF\x02\x01\x01 this is not a real program MZ\x90\x00")); if (!IS_WIN) fs.chmodSync(file, 0o755); }
  return () => { fs.rmSync(file, { recursive: true, force: true }); fs.writeFileSync(file, saved); if (!IS_WIN) fs.chmodSync(file, mode & 0o777); };
}
const CASES = [
  ...(IS_WIN ? [] : [["no-exec", "a file without execute permission"]]),
  ["directory", "a folder in place of the engine file"],
  ["damaged", "a damaged engine file"],
];

let root, srv;
const alive = async () => (await request(srv.port, "GET", "/api/health")).status === 200 && srv.proc.exitCode === null;
const liveEngines = async () => (await request(srv.port, "GET", "/api/diagnostics")).json.engines.processes.supervised;

test.before(async () => {
  root = makeRoot();
  installFakeSdServer(root);
  fs.writeFileSync(path.join(root, "app", "llm-models", "spawn.gguf"), Buffer.from("GGUF\x03\x00\x00\x00"));
  srv = await startServer(root);
});
test.after(async () => {
  stopServer(srv);
  await sleep(300);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* Windows may hold files briefly */ }
});

test("messages: launch failures become a short, path-free explanation", () => {
  const m = describeSpawnError(Object.assign(new Error("spawn /home/user/secret/llama-server EACCES"), { code: "EACCES" }), "text engine (llama.cpp)");
  assert.match(m, /^Could not start the text engine \(llama\.cpp\) \(EACCES\)\. /);
  assert.match(m, /FAT32 or exFAT/);
  assert.doesNotMatch(m, /\/home|secret|[A-Z]:\\/);
  assert.match(describeSpawnError({ code: "ENOENT" }, "x"), /missing/);
  assert.match(describeSpawnError({ code: "UNKNOWN" }, "x"), /damaged/);
  assert.match(describeSpawnError({}, "x"), /^Could not start the x\. Run setup again/);
  assert.equal(isLaunchFailure({ pid: undefined }), true);
  assert.equal(isLaunchFailure({ pid: 1234 }), false);
});

for (const [how, label] of CASES) {
  test(`text engine: ${label} fails the start, the server keeps running, and a repaired engine starts`, async () => {
    const restore = breakEngine(fakeLlamaPath(root), how);
    try {
      const r = await request(srv.port, "POST", "/api/llm/start", { body: { model: "spawn.gguf", gpuLayers: 0 } });
      assert.ok(await alive(), `server still running\n${srv.log().slice(-1500)}`);
      assert.ok(r.status >= 400, `start refused (${r.status})`);
      assert.equal(r.json.ok, false);
      assert.equal(r.json.code, "ENGINE_START_FAILED");
      if (how !== "damaged") assert.match(r.json.error, /Could not start the text engine/);
      assert.ok(!r.text.includes(root), "no paths in the response");
      const s = (await request(srv.port, "GET", "/api/llm/status")).json;
      assert.equal(s.running, false);
      assert.equal(s.ready, false);
      assert.equal(s.engine.state, "stopped", "no automatic restart after a failed launch");
      assert.deepEqual((await liveEngines()).filter((p) => p.label === "llm"), [], "nothing left running");
    } finally { restore(); }
    const ok = await request(srv.port, "POST", "/api/llm/start", { body: { model: "spawn.gguf", gpuLayers: 0 } });
    assert.equal(ok.status, 200, ok.text);
    await waitFor(async () => (await request(srv.port, "GET", "/api/llm/status")).json.ready, 20000, "ready after repair");
    const chat = await request(srv.port, "POST", "/api/llm/chat", { body: { messages: [{ role: "user", content: "hi" }], stream: false } });
    assert.equal(chat.json.choices[0].message.content, "Contract test reply.");
    await request(srv.port, "POST", "/api/llm/stop", { body: {} });
  });
}

// A quantized image GGUF header (architecture sd1, Q4_0), sparse-extended past the 128 MB minimum.
function writeImageModel(name) {
  const kv = (key, type, val) => {
    const k = Buffer.from(key); const head = Buffer.alloc(8 + k.length + 4); head.writeBigUInt64LE(BigInt(k.length)); k.copy(head, 8); head.writeUInt32LE(type, 8 + k.length);
    if (type === 8) { const v = Buffer.from(val); const b = Buffer.alloc(8 + v.length); b.writeBigUInt64LE(BigInt(v.length)); v.copy(b, 8); return Buffer.concat([head, b]); }
    const b = Buffer.alloc(4); b.writeUInt32LE(val); return Buffer.concat([head, b]);
  };
  const header = Buffer.alloc(24); header.write("GGUF"); header.writeUInt32LE(3, 4); header.writeBigUInt64LE(0n, 8); header.writeBigUInt64LE(2n, 16);
  const file = path.join(root, "app", "models", name);
  fs.writeFileSync(file, Buffer.concat([header, kv("general.architecture", 8, "sd1"), kv("general.file_type", 4, 2)]));
  fs.truncateSync(file, 130 * 1024 * 1024);
}

for (const [how, label] of CASES) {
  test(`image engine: ${label} fails the start, the server keeps running, and a repaired engine starts`, async () => {
    writeImageModel("spawn-sd.gguf");
    const restore = breakEngine(fakeSdPath(root), how);
    try {
      // The image engine starts in the background: the request is accepted and the status reports the failure.
      const r = await request(srv.port, "POST", "/api/restart-backend", { body: { model: "spawn-sd.gguf", backendType: "cpu" } });
      assert.equal(r.status, 200, r.text);
      const st = await waitFor(async () => { const x = (await request(srv.port, "GET", "/api/backend-status")).json; return !x.running && x.error ? x : null; }, 20000, "image failure reported");
      assert.ok(await alive(), `server still running\n${srv.log().slice(-1500)}`);
      assert.equal(st.ready, false);
      if (how !== "damaged") assert.match(st.error, /Could not start the image engine/);
      if (how !== "damaged") assert.ok(!String(st.error).includes(root), "no paths in the error");
      assert.deepEqual((await liveEngines()).filter((p) => p.label === "image"), [], "nothing left running");
    } finally { restore(); }
    const ok = await request(srv.port, "POST", "/api/restart-backend", { body: { model: "spawn-sd.gguf", backendType: "cpu" } });
    assert.equal(ok.status, 200, ok.text);
    await waitFor(async () => (await request(srv.port, "GET", "/api/backend-status")).json.ready, 20000, "image ready after repair");
    await request(srv.port, "POST", "/api/stop-backend", { body: {} });
  });
}

const FAKE_WHISPER = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const a = process.argv.slice(2);
const arg = (k) => { const i = a.indexOf(k); return i === -1 ? null : a[i + 1]; };
fs.writeFileSync(arg("-of") + ".txt", " fake transcript\\n");
process.exit(0);
`;
function installFakeWhisper() {
  const osDir = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
  const cli = path.join(root, "app", "speech-backend", osDir, "cpu", IS_WIN ? "whisper-cli.exe" : "whisper-cli");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  if (IS_WIN) {
    fs.copyFileSync(fakeLlamaPath(root), cli); // the compiled test launcher runs fake-llama-server.cjs next to it
    fs.writeFileSync(path.join(path.dirname(cli), "fake-llama-server.cjs"), FAKE_WHISPER);
  } else {
    fs.writeFileSync(cli, FAKE_WHISPER);
    fs.chmodSync(cli, 0o755);
  }
  fs.writeFileSync(path.join(root, "app", "speech-models", "ggml-spawn.bin"), "fake whisper model");
  return cli;
}
function wav() {
  const data = Buffer.alloc(3200), h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const transcribe = () => request(srv.port, "POST", "/api/speech/transcribe?model=ggml-spawn.bin&language=en&save=false", { body: wav(), headers: { "Content-Type": "audio/wav" } });

for (const [how, label] of CASES) {
  test(`speech engine: ${label} fails the transcription, the server keeps running, and a repaired engine works`, async () => {
    const cli = installFakeWhisper();
    const works = await transcribe();
    assert.equal(works.status, 200, `fake whisper works before breaking it: ${works.text}`);
    const restore = breakEngine(cli, how);
    try {
      const r = await transcribe();
      assert.ok(await alive(), `server still running\n${srv.log().slice(-1500)}`);
      assert.ok(r.status >= 400, `transcription refused (${r.status})`);
      assert.equal(r.json.ok, false);
      if (how !== "damaged") assert.match(r.json.error, /Could not start the speech engine/);
      // A damaged binary is reported with whisper's own output, which can contain paths (existing behaviour, #39).
      if (how !== "damaged") assert.ok(!r.text.includes(root), "no paths in the response");
      if (process.env.SPAWN_DEBUG) console.log(how, r.text);
      const state = (await request(srv.port, "GET", "/api/speech/status")).json;
      assert.ok(!state.transcription || state.transcription.active === false, "the transcription is not left marked active");
      assert.deepEqual((await liveEngines()).filter((p) => p.label !== "llm" && p.label !== "image"), [], "nothing left running");
    } finally { restore(); }
    const again = await transcribe();
    assert.equal(again.status, 200, again.text);
  });
}
