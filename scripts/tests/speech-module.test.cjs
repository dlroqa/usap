// Step 9.8c: the speech-recognition module (services/speech-engine.cjs + routes/speech.cjs), exercised
// through the real server with a stand-in whisper-cli (real inference runs in native-runtime CI).
// The stand-in honours the real CLI contract: -m model, -f input.wav, -of base, -otxt, -oj, -l lang,
// -tr; it writes <base>.txt and <base>.json. Behaviours are chosen by the model file name.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { createSpeechService } = require("../server/services/speech-engine.cjs");
const { speechRoutes } = require("../server/routes/speech.cjs");
const { createRouter } = require("../server/http/router.cjs");
const { makeRoot, startServer, stopServer, request, fakeLlamaPath, IS_WIN } = require("./api-contract/harness.cjs");

const FAKE_WHISPER = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const a = process.argv.slice(2);
const arg = (k) => { const i = a.indexOf(k); return i === -1 ? null : a[i + 1]; };
const model = String(arg("-m") || "");
const log = process.env.FAKE_WHISPER_LOG;
const note = (s) => { if (log) fs.appendFileSync(log, s + "\\n"); };
if (/corrupt/.test(model)) { console.error("whisper_init_from_file_with_params_no_state: failed to load model"); process.exit(1); }
if (/crash/.test(model)) { process.abort(); }
const wav = fs.readFileSync(arg("-f"));
if (wav.toString("ascii", 0, 4) !== "RIFF") { console.error("failed to read WAV file"); process.exit(2); }
const finish = () => {
  const text = "fake transcript lang=" + arg("-l") + " translate=" + (a.includes("-tr") ? "yes" : "no");
  fs.writeFileSync(arg("-of") + ".txt", " " + text + "\\n");
  fs.writeFileSync(arg("-of") + ".json", JSON.stringify({ result: { language: arg("-l") }, transcription: [{ text }] }));
  note("end " + Date.now());
  process.exit(0);
};
note("start " + Date.now());
if (/slow/.test(model)) setTimeout(finish, 1500); else finish();
`;

function cliPath(root) {
  const os = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
  return path.join(root, "app", "speech-backend", os, "cpu", process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
}

function installFakeWhisper(root) {
  const cli = cliPath(root);
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  if (IS_WIN) {
    // The harness's compiled launcher runs "fake-llama-server.cjs" from its own folder with its arguments.
    fs.copyFileSync(fakeLlamaPath(root), cli);
    fs.writeFileSync(path.join(path.dirname(cli), "fake-llama-server.cjs"), FAKE_WHISPER);
  } else {
    fs.writeFileSync(cli, FAKE_WHISPER);
    fs.chmodSync(cli, 0o755);
  }
  for (const m of ["ggml-test.bin", "ggml-corrupt.bin", "ggml-crash.bin", "ggml-slow.bin"]) {
    fs.writeFileSync(path.join(root, "app", "speech-models", m), "fake whisper model");
  }
}

function wav(seconds = 0.1) {
  const rate = 16000, n = Math.round(rate * seconds), data = Buffer.alloc(n * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

let root;
let srv;
let log;
test.before(async () => {
  root = makeRoot();
  installFakeWhisper(root);
  log = path.join(root, "whisper-calls.log");
  srv = await startServer(root, { FAKE_WHISPER_LOG: log });
});
test.after(() => { stopServer(srv); fs.rmSync(root, { recursive: true, force: true }); });

const transcribe = (query, body = wav(), type = "audio/wav") =>
  request(srv.port, "POST", `/api/speech/transcribe?${query}`, { body, headers: { "Content-Type": type } });
const post = (p, body) => request(srv.port, "POST", p, { body });
const get = (p) => request(srv.port, "GET", p);
const leftovers = () => fs.readdirSync(path.join(root, "app", "transcriptions")).filter((f) => f.startsWith(".speech-"));

// ── The modules on their own ────────────────────────────────────────────────
test("speech modules: refuse missing dependencies; the same 10 routes and model catalog", () => {
  assert.throws(() => createSpeechService({ paths: {}, osPlatform: "linux", fs, path, supervisor: {}, errors: {}, helpers: {}, preferredPort: 1 }), /missing dependency/);
  assert.throws(() => speechRoutes({}), /missing dependency/);
  const r = createRouter();
  const stub = () => {};
  r.use(speechRoutes({ speech: {}, SPEECH_MODELS: "m", TRANSCRIPTIONS: "t", downloadBlockReason: stub, getDownloadState: stub, errorBody: stub, errorStatus: stub, fs, json: stub, jsonErrorStatus: stub, path, pathInside: stub, readBinaryBody: stub, readJsonBody: stub, startModelDownload: stub, streamModelUpload: stub }));
  assert.deepEqual(r.routes().map((x) => `${x.method} ${x.match} ${x.path}`), [
    "GET exact /api/speech/status", "GET exact /api/speech/models", "POST exact /api/speech/start", "POST exact /api/speech/stop",
    "POST prefix /api/speech/transcribe", "POST exact /api/speech/download-model", "POST prefix /api/speech/import-model",
    "POST exact /api/speech/delete-model", "GET exact /api/speech/transcriptions", "POST exact /api/speech/delete-transcription",
  ]);
});

// ── Through the real server ──────────────────────────────────────────────────
test("server: transcription, language selection and translation reach whisper-cli unchanged", async () => {
  let r = await transcribe("model=ggml-test.bin&language=en&save=false");
  assert.equal(r.status, 200, r.text + srv.log().slice(-1200));
  assert.equal(r.json.transcription.text, "fake transcript lang=en translate=no");
  assert.equal(r.json.transcription.model, "ggml-test.bin");
  r = await transcribe("model=ggml-test.bin&save=false");
  assert.equal(r.json.transcription.text, "fake transcript lang=auto translate=no", "language detection when none is chosen");
  r = await transcribe("model=ggml-test.bin&language=de&translate=true&save=false");
  assert.equal(r.json.transcription.text, "fake transcript lang=de translate=yes");
  assert.deepEqual(leftovers(), [], "temporary input/output files are removed");
});

test("server: transcription history is saved, listed and deleted; deletes can't escape the folder", async () => {
  const r = await transcribe("model=ggml-test.bin&language=en&filename=meeting.wav");
  assert.equal(r.status, 200);
  const saved = r.json.transcription;
  assert.equal(saved.sourceFilename, "meeting.wav");
  assert.match(saved.metadata, /^transcript-.*\.json$/);
  assert.ok((await get("/api/speech/transcriptions")).json.transcriptions.some((t) => t.metadata === saved.metadata));
  assert.equal((await post("/api/speech/delete-transcription", { filename: "../SENTINEL.txt" })).status, 400);
  assert.equal((await post("/api/speech/delete-transcription", { filename: "../../app/SENTINEL.json" })).status === 200, false);
  assert.equal((await post("/api/speech/delete-transcription", { filename: saved.metadata })).status, 200);
  assert.ok(!(await get("/api/speech/transcriptions")).json.transcriptions.some((t) => t.metadata === saved.metadata));
  assert.equal(fs.existsSync(path.join(root, "app", "SENTINEL.txt")), true);
});

test("server: unsupported, malformed and empty audio is refused without starting the engine", async () => {
  const before = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  for (const [label, body, type] of [["mp3 bytes", Buffer.from("ID3\x03\x00fake mp3"), "audio/mpeg"], ["text", "not audio", "text/plain"], ["empty", Buffer.alloc(0), "audio/wav"], ["truncated header", Buffer.from("RIFF"), "audio/wav"]]) {
    const r = await transcribe("model=ggml-test.bin&save=false", body, type);
    assert.ok(r.status >= 400, `${label}: ${r.status}`);
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /WAV/i, `${label}: explains that WAV is expected`);
  }
  assert.equal(fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "", before, "whisper-cli never started");
  assert.equal((await get("/api/health")).status, 200);
});

test("server: missing, corrupted and crashing models fail clearly; the next request still works", async () => {
  // Existing behaviour, kept: an unknown name falls back to an installed model...
  let r = await transcribe("model=ggml-unknown.bin&language=en&save=false");
  assert.doesNotMatch(String(r.json.error || ""), /Download or import|not installed/, "an installed model was used instead");
  // ...a catalog model that isn't downloaded is refused...
  r = await transcribe("model=ggml-tiny.en.bin&save=false");
  assert.ok(r.status >= 400);
  assert.match(r.json.error, /Speech model is not installed: ggml-tiny\.en\.bin/);
  // ...and with no model at all, the user is told to download one.
  const modelsDir = path.join(root, "app", "speech-models");
  const parked = path.join(root, "parked-models");
  fs.renameSync(modelsDir, parked);
  fs.mkdirSync(modelsDir);
  try {
    r = await transcribe("model=ggml-test.bin&save=false");
    assert.ok(r.status >= 400);
    assert.match(r.json.error, /Download or import a Whisper model first/);
  } finally { fs.rmSync(modelsDir, { recursive: true, force: true }); fs.renameSync(parked, modelsDir); }
  r = await transcribe("model=ggml-corrupt.bin&save=false");
  assert.ok(r.status >= 400);
  assert.match(r.json.error, /failed to load model/);
  r = await transcribe("model=ggml-crash.bin&save=false");
  assert.ok(r.status >= 400, "an engine crash is reported, not a hang");
  assert.equal(r.json.ok, false);
  assert.equal((await get("/api/speech/status")).json.transcription.phase, "Failed");
  r = await transcribe("model=ggml-test.bin&language=en&save=false");
  assert.equal(r.status, 200, "the server and engine path recover");
  assert.deepEqual(leftovers(), []);
});

test("server: concurrent transcriptions are queued one at a time (existing behaviour) and all succeed", async () => {
  fs.writeFileSync(log, "");
  const results = await Promise.all([1, 2, 3].map(() => transcribe("model=ggml-slow.bin&language=en&save=false")));
  for (const r of results) assert.equal(r.status, 200);
  const events = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => l.split(" ")[0]);
  assert.deepEqual(events, ["start", "end", "start", "end", "start", "end"], "never two whisper-cli runs at once");
});

test("server: start/stop, model listing, import and deletion keep their behaviour", async () => {
  let r = await post("/api/speech/start", { model: "ggml-test.bin", language: "en", threads: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.json.ready, true);
  let st = (await get("/api/speech/status")).json;
  assert.equal(st.ready, true);
  assert.equal(st.settings.model, "ggml-test.bin");
  assert.equal(st.settings.threads, 2);
  assert.equal(st.settings.backendMode, "whisper.cpp CPU");
  assert.equal((await post("/api/speech/start", { model: "ggml-tiny.en.bin" })).status, 404, "catalog model not downloaded");
  assert.equal((await post("/api/speech/stop")).status, 200);
  assert.equal((await get("/api/speech/status")).json.ready, false);

  const models = (await get("/api/speech/models")).json.models;
  assert.ok(models.some((m) => m.filename === "ggml-test.bin"));
  assert.ok(models.some((m) => m.filename === "ggml-tiny.en.bin"), "catalog entries are listed too");
  const imp = await request(srv.port, "POST", "/api/speech/import-model?filename=ggml-imported.bin", { body: "weights", headers: { "Content-Type": "application/octet-stream" } });
  assert.equal(imp.status, 200);
  assert.ok(fs.existsSync(path.join(root, "app", "speech-models", "ggml-imported.bin")));
  assert.equal((await request(srv.port, "POST", "/api/speech/import-model?filename=evil.exe", { body: "x", headers: { "Content-Type": "application/octet-stream" } })).status, 400);
  // A traversal attempt is reduced to a bare file name inside the models folder (so: not found there).
  assert.equal((await post("/api/speech/delete-model", { filename: "../SENTINEL.gguf" })).status, 404);
  assert.equal((await post("/api/speech/delete-model", { filename: "ggml-imported.bin" })).status, 200);
  assert.equal(fs.existsSync(path.join(root, "app", "speech-models", "ggml-imported.bin")), false);
  assert.equal(fs.existsSync(path.join(root, "app", "SENTINEL.gguf")), true);
  // Downloads still go through the outbound guard.
  r = await post("/api/speech/download-model", { url: "http://127.0.0.1:9/ggml-x.bin" });
  assert.equal(r.status, 400);
});

test("server: every speech route stays behind sign-in and the Origin check", async () => {
  const r2 = makeRoot();
  const s2 = await startServer(r2, { UAIS_AUTH: "on" }, { readyPath: "/api/auth/status" });
  try {
    const checks = [["GET", "/api/speech/status"], ["GET", "/api/speech/models"], ["GET", "/api/speech/transcriptions"], ["POST", "/api/speech/start"],
      ["POST", "/api/speech/stop"], ["POST", "/api/speech/transcribe?model=x"], ["POST", "/api/speech/download-model"], ["POST", "/api/speech/import-model?filename=x.bin"],
      ["POST", "/api/speech/delete-model"], ["POST", "/api/speech/delete-transcription"]];
    for (const [m, p] of checks) {
      assert.equal((await request(s2.port, m, p, { body: m === "POST" ? {} : undefined })).status, 401, `${m} ${p}`);
      assert.equal((await request(s2.port, m, p, { body: m === "POST" ? {} : undefined, headers: { Origin: "http://evil.example" } })).status, 403, `${m} ${p} cross-site`);
    }
  } finally { stopServer(s2); fs.rmSync(r2, { recursive: true, force: true }); }
});
