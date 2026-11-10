// Step 9.8b: the text-to-speech module (services/tts-engine.cjs + routes/tts.cjs). The moved code is
// exercised end to end with a stand-in Kokoro runtime and worker (the real one needs model weights),
// through the service directly and through the real server and its security pipeline.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createTtsService } = require("../server/services/tts-engine.cjs");
const { ttsRoutes } = require("../server/routes/tts.cjs");
const { createRouter } = require("../server/http/router.cjs");
const supervisor = require("../server/supervisor.cjs");
const errors = require("../server/errors.cjs");
const { makeRoot, startServer, stopServer, request } = require("./api-contract/harness.cjs");

// A stand-in worker with the real worker's contract: a JSON job on stdin, a WAV file written to
// job.output (32-bit float, like Kokoro), "@@progress" lines on stderr, a JSON result on stdout.
const FAKE_WORKER = `
let raw = "";
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  const job = JSON.parse(raw);
  process.stderr.write("@@progress " + JSON.stringify({ phase: "generating", done: 1, total: 2 }) + "\\n");
  const rate = 24000, n = 2400, data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) data.writeFloatLE(Math.sin(i / 10) * 0.5, i * 4);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(3, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(32, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  require("fs").writeFileSync(job.output, Buffer.concat([h, data]));
  process.stdout.write(JSON.stringify({ ok: true, output: job.output, sampleRate: rate, durationMs: 100, chunks: 1,
    segments: [{ text: job.text, start: 0, end: 0.1 }], echo: { voice: job.voice, dtype: job.dtype, modelId: job.modelId } }));
});
`;

function installFakeRuntime(appDir, workerPath) {
  fs.mkdirSync(path.join(appDir, "tts-runtime", "node_modules", "kokoro-js"), { recursive: true });
  fs.mkdirSync(path.dirname(workerPath), { recursive: true });
  fs.writeFileSync(workerPath, FAKE_WORKER);
}

const helpers = {
  formatBytes: (n) => `${n} B`,
  getPathSize: (p) => { try { return fs.statSync(p).size; } catch (_) { return 0; } },
  isWaveBuffer: (b) => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WAVE",
  pathInside: (p, dir) => { const rel = path.relative(path.resolve(dir), path.resolve(p)); return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel); },
  readdirVisible: (d) => { try { return fs.readdirSync(d).filter((f) => !f.startsWith(".")); } catch (_) { return []; } },
  safeOutputName: (v) => String(v || "").replace(/[^a-z0-9._-]/gi, "_").slice(0, 120),
};

function serviceIn(dir) {
  const app = path.join(dir, "app");
  const paths = {
    ROOT: dir, TTS_MODELS: path.join(app, "tts-models"), TTS_OUTPUTS: path.join(app, "tts-outputs"),
    TTS_CACHE: path.join(app, "tts-cache"), TTS_RUNTIME: path.join(app, "tts-runtime"), TTS_WORKER: path.join(dir, "worker.cjs"),
  };
  for (const d of [paths.TTS_MODELS, paths.TTS_OUTPUTS]) fs.mkdirSync(d, { recursive: true });
  const tts = createTtsService({ paths, preferredPort: 10089, fs, path, supervisor, errors: { badRequest: errors.badRequest, notFound: errors.notFound, notInstalled: errors.notInstalled }, helpers });
  return { tts, paths, app };
}

// ── The service ──────────────────────────────────────────────────────────────
test("tts service: refuses missing dependencies; exposes the same catalog, voices and defaults", () => {
  assert.throws(() => createTtsService({ paths: {}, preferredPort: 1, fs, path, supervisor, errors: {}, helpers: {} }), /missing dependency/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usap-tts-"));
  try {
    const { tts } = serviceIn(dir);
    assert.deepEqual(tts.catalog.map((m) => m.id), ["kokoro-onnx-q8", "kokoro-onnx-fp32"]);
    assert.deepEqual(tts.voices.map((v) => v.id), ["af_heart", "af_bella", "af_nicole", "af_sarah", "am_michael", "am_fenrir", "bf_emma", "bm_george"]);
    assert.equal(tts.isReady(), false);
    assert.equal(tts.getPort(), 10089);
    assert.equal(tts.getSettings().voice, "af_heart");
    assert.equal(tts.getSettings().dtype, "q8");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("tts service: clear errors without a runtime, a model or valid text", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usap-tts-"));
  try {
    const { tts, app, paths } = serviceIn(dir);
    await assert.rejects(tts.startTts({}), (e) => e.statusCode === 503 && e.code === "ENGINE_NOT_INSTALLED");
    installFakeRuntime(app, paths.TTS_WORKER);
    await assert.rejects(tts.startTts({ model: "missing.json" }), (e) => e.statusCode === 404 && e.code === "MODEL_NOT_FOUND");
    await assert.rejects(tts.synthesizeTts("   "), (e) => e.statusCode === 400 && e.code === "INVALID_REQUEST");
    await assert.rejects(tts.synthesizeTts("x".repeat(5001)), (e) => e.statusCode === 400 && e.code === "TEXT_TOO_LONG");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("tts service: install, start, synthesize (float WAV converted to 16-bit PCM), list, stop", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usap-tts-"));
  try {
    const { tts, app, paths } = serviceIn(dir);
    installFakeRuntime(app, paths.TTS_WORKER);
    const model = tts.installTtsCatalogModel("kokoro-onnx-q8");
    assert.equal(model.filename, "kokoro-onnx-q8.json");
    assert.ok(tts.getTtsModels().some((m) => m.filename === "kokoro-onnx-q8.json" && m.installed !== false));
    await tts.runExclusiveTtsOperation(() => tts.startTts({ model: "kokoro-onnx-q8.json", voice: "bf_emma", speed: 1.25 }));
    assert.equal(tts.isReady(), true);
    assert.equal(tts.getSettings().voice, "bf_emma");
    assert.equal(tts.getSettings().speed, 1.25);
    const out = await tts.runExclusiveTtsOperation(() => tts.synthesizeTts("Hello there.", { voice: "bf_emma" }));
    assert.equal(out.voice, "bf_emma");
    assert.equal(out.voiceName, "Emma");
    assert.match(out.url, /^\/tts-outputs\/tts-.*\.wav$/);
    assert.deepEqual(out.segments, [{ text: "Hello there.", start: 0, end: 0.1 }]);
    const wav = fs.readFileSync(path.join(paths.TTS_OUTPUTS, out.audioFile));
    assert.equal(wav.readUInt16LE(20), 1, "PCM format, playable in every browser");
    assert.equal(wav.readUInt16LE(34), 16, "16-bit");
    assert.ok(!fs.readdirSync(paths.TTS_OUTPUTS).some((f) => f.startsWith(".tts-")), "temporary file removed");
    assert.equal(tts.listTtsOutputs()[0].filename, out.filename);
    assert.equal(tts.getError(), null);
    assert.equal(tts.getGenerationState().active, false);
    await tts.stopTts();
    assert.equal(tts.isReady(), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("routes/tts: refuses missing dependencies and registers the same 11 routes", () => {
  assert.throws(() => ttsRoutes({}), /missing dependency/);
  const r = createRouter();
  const stub = () => {};
  r.use(ttsRoutes({ tts: {}, json: stub, readJsonBody: stub, jsonErrorStatus: stub, errorStatus: stub, errorBody: stub, streamModelUpload: stub, pathInside: stub, fs, path, MIME: {}, TTS_MODELS: "m", TTS_OUTPUTS: "o" }));
  assert.deepEqual(r.routes().map((x) => `${x.method} ${x.match} ${x.path}`), [
    "GET exact /api/tts/status", "GET exact /api/tts/models", "POST exact /api/tts/start", "POST exact /api/tts/stop",
    "POST exact /api/tts/speak", "POST exact /api/tts/download-model", "POST prefix /api/tts/import-model",
    "POST exact /api/tts/delete-model", "GET exact /api/tts/outputs", "POST exact /api/tts/delete-output", "GET prefix /tts-outputs/",
  ]);
});

// ── The real server ──────────────────────────────────────────────────────────
test("server: the whole TTS flow works through the moved routes, unchanged", async () => {
  const root = makeRoot();
  installFakeRuntime(path.join(root, "app"), path.join(root, "scripts", "workers", "tts-kokoro-worker.mjs"));
  // The real worker is an ES module; the stand-in is CommonJS-compatible code saved under its name.
  fs.writeFileSync(path.join(root, "scripts", "workers", "tts-kokoro-worker.mjs"), FAKE_WORKER.replace('require("fs")', "(await import('node:fs'))").replace("process.stdin.on(\"end\", () => {", "process.stdin.on(\"end\", async () => {"));
  const srv = await startServer(root);
  try {
    const post = (p, body) => request(srv.port, "POST", p, { body });
    let st = (await request(srv.port, "GET", "/api/tts/status")).json;
    assert.equal(st.runtimeInstalled, true);
    assert.equal(st.voices.length, 8);
    assert.equal((await post("/api/tts/download-model", { modelId: "kokoro-onnx-q8" })).status, 200);
    const speak = await post("/api/tts/speak", { text: "Hello from the module.", model: "kokoro-onnx-q8.json", voice: "am_michael" });
    assert.equal(speak.status, 200, speak.text + srv.log().slice(-1500));
    const out = speak.json.output;
    assert.equal(out.voiceName, "Michael");
    st = (await request(srv.port, "GET", "/api/tts/status")).json;
    assert.equal(st.ready, true);
    assert.equal(st.settings.model, "kokoro-onnx-q8.json");
    assert.equal((await request(srv.port, "GET", "/api/tts/outputs")).json.outputs[0].filename, out.filename);
    const audio = await request(srv.port, "GET", out.url, { raw: true });
    assert.equal(audio.status, 200);
    assert.match(audio.headers["content-type"], /audio\/(wav|x-wav|wave)/);
    assert.equal(audio.headers["accept-ranges"], "bytes");
    const part = await request(srv.port, "GET", out.url, { raw: true, headers: { Range: "bytes=0-43" } });
    assert.equal(part.status, 206);
    assert.match(part.headers["content-range"], /^bytes 0-43\//);
    assert.equal((await request(srv.port, "GET", "/tts-outputs/does-not-exist.wav")).status, 404);
    assert.equal((await request(srv.port, "GET", "/tts-outputs/..%2f..%2fSENTINEL.wav")).status, 404, "no traversal");
    assert.equal((await post("/api/tts/delete-output", { filename: out.filename })).status, 200);
    assert.equal((await request(srv.port, "GET", "/api/tts/outputs")).json.outputs.length, 0);
    assert.equal((await post("/api/tts/delete-model", { filename: "../SENTINEL.wav" })).status, 400);
    assert.equal((await post("/api/tts/stop")).status, 200);
    assert.equal(fs.existsSync(path.join(root, "app", "SENTINEL.wav")), true);
  } finally { stopServer(srv); fs.rmSync(root, { recursive: true, force: true }); }
});

test("server: every TTS route stays behind sign-in and the Origin check", async () => {
  const root = makeRoot();
  const srv = await startServer(root, { UAIS_AUTH: "on" }, { readyPath: "/api/auth/status" });
  try {
    const checks = [["GET", "/api/tts/status"], ["GET", "/api/tts/models"], ["GET", "/api/tts/outputs"], ["POST", "/api/tts/start"], ["POST", "/api/tts/stop"],
      ["POST", "/api/tts/speak"], ["POST", "/api/tts/download-model"], ["POST", "/api/tts/import-model?filename=x.json"], ["POST", "/api/tts/delete-model"],
      ["POST", "/api/tts/delete-output"], ["GET", "/tts-outputs/x.wav"]];
    for (const [m, p] of checks) {
      assert.equal((await request(srv.port, m, p, { body: m === "POST" ? {} : undefined })).status, 401, `${m} ${p}`);
      assert.equal((await request(srv.port, m, p, { body: m === "POST" ? {} : undefined, headers: { Origin: "http://evil.example" } })).status, 403, `${m} ${p} cross-site`);
    }
  } finally { stopServer(srv); fs.rmSync(root, { recursive: true, force: true }); }
});
