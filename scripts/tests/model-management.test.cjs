// Step 9.8f: model management and downloads (routes/models.cjs, services/model-store.cjs,
// services/downloads.cjs). The code moved unchanged from serve.cjs; these tests pin its behaviour and
// its security properties: file names, traversal, interrupted and partial installs, checksums,
// cancellation, concurrency, restricted destinations, malformed metadata and sign-in.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const http = require("node:http");
const test = require("node:test");

const { createDownloadService } = require("../server/services/downloads.cjs");
const { createModelStore } = require("../server/services/model-store.cjs");
const { modelRoutes } = require("../server/routes/models.cjs");
const { createRouter } = require("../server/http/router.cjs");
const { badRequest } = require("../server/errors.cjs");
const { detectModelKind } = require("../server/model-kind.cjs");
const { makeRoot, startServer, stopServer, request } = require("./api-contract/harness.cjs");

const made = [];
const tmp = (name) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `usap-98f-${name}-`)); made.push(d); return d; };
test.after(() => { for (const d of made) try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* Windows may hold files briefly */ } });
const GGUF = () => { const b = Buffer.alloc(64); b.write("GGUF"); return b; };

// ── services/downloads.cjs with a fake downloader (no network) ────────────────────────────────────
function downloadsWith(downloadVerified, extra = {}) {
  const dir = tmp("dl");
  const calls = [];
  const POLICY = { maxRedirects: 10, marker: "policy" };
  let invalidated = 0;
  const svc = createDownloadService({
    DOWNLOAD_POLICY: POLICY, LLM_MODELS: path.join(dir, "llm"), MODELS: path.join(dir, "img"), OPENVINO_MODELS: path.join(dir, "ov"),
    OPENVINO_NPU_MODELS: [], ROOT: dir, SPEECH_MODELS: path.join(dir, "sp"), TOOLS: path.join(dir, "tools"), TTS_MODELS: path.join(dir, "tts"),
    downloadBlockReason: (url) => (/127\.0\.0\.1|169\.254/.test(url) ? "Requests to loopback addresses are not allowed." : ""),
    downloader: { TRANSIENT: new Set(["ECONNRESET"]), downloadVerified: (url, dest, opts) => { calls.push({ url, dest, opts }); return downloadVerified(url, dest, opts); } },
    fs, getOpenVinoNpuInfo: () => ({ supported: false }), getPathSize: () => 0, integrity: {}, osPlatform: "linux", path,
    spawn: () => { throw new Error("no spawn in tests"); }, spawnSync: () => ({ status: 1 }),
    invalidateBackendOptions: () => { invalidated += 1; },
    ...extra,
  });
  return { svc, calls, dir, POLICY, invalidated: () => invalidated };
}
const settle = () => new Promise((r) => setImmediate(r));

test("9.8f downloads: a verified download records integrity and sha256 and uses the guarded policy", async () => {
  const { svc, calls, dir, POLICY } = downloadsWith(async () => ({ status: "verified", message: "ok", sha256: "ab".repeat(32), bytes: 64 }));
  svc.fns.startModelDownload("https://example.com/m/model.gguf", "model.gguf", path.join(dir, "llm"), "text");
  assert.equal(svc.getState().active, true);
  await settle();
  const s = svc.getState();
  assert.equal(s.active, false);
  assert.equal(s.error, null);
  assert.equal(s.integrity, "verified");
  assert.equal(s.sha256, "ab".repeat(32));
  assert.equal(s.progress, 100);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.policy, POLICY, "every download goes through the configured outbound policy");
  assert.equal(calls[0].opts.tempPath, `${calls[0].dest}.part`, "downloads are staged in a .part file");
  assert.equal(calls[0].dest, path.join(dir, "llm", "model.gguf"));
});

test("9.8f downloads: a checksum mismatch fails the download and records no integrity", async () => {
  const err = Object.assign(new Error("model.gguf failed its integrity check (sha256 mismatch)."), { name: "IntegrityError" });
  const { svc } = downloadsWith(async () => { throw err; });
  svc.fns.startModelDownload("https://example.com/model.gguf");
  await settle();
  const s = svc.getState();
  assert.equal(s.active, false);
  assert.equal(s.error, err.message);
  assert.equal(s.integrity, null);
  assert.equal(s.sha256, null);
});

test("9.8f downloads: an interrupted transfer is reported as retryable", async () => {
  const err = Object.assign(new Error("socket hang up."), { code: "ECONNRESET" });
  const { svc } = downloadsWith(async () => { throw err; });
  svc.fns.startModelDownload("https://example.com/model.gguf");
  await settle();
  assert.match(svc.getState().error, /^Download interrupted before model\.gguf finished: socket hang up\. Retry the download\.$/);
  assert.equal(svc.getState().active, false);
});

test("9.8f downloads: cancel aborts the transfer and a late result can't overwrite the cancelled status", async () => {
  let finish;
  let signal;
  const { svc } = downloadsWith((url, dest, opts) => { signal = opts.signal; return new Promise((r) => { finish = r; }); });
  svc.fns.startModelDownload("https://example.com/model.gguf");
  assert.equal(svc.fns.cancelModelDownload(), true);
  assert.equal(signal.aborted, true);
  finish({ status: "verified", message: "ok", sha256: "00", bytes: 1 });
  await settle();
  assert.equal(svc.getState().error, "Download cancelled");
  assert.equal(svc.getState().active, false);
  assert.equal(svc.getState().integrity, undefined);
  assert.equal(svc.fns.cancelModelDownload(), false, "nothing left to cancel");
});

test("9.8f downloads: only one download runs at a time", async () => {
  const { svc, calls } = downloadsWith(() => new Promise(() => {}));
  svc.fns.startModelDownload("https://example.com/a.gguf");
  svc.fns.startModelDownload("https://example.com/b.gguf");
  assert.equal(calls.length, 1);
  assert.equal(svc.getState().filename, "a.gguf");
});

test("9.8f downloads: a restricted destination is refused before any request", async () => {
  const { svc, calls } = downloadsWith(async () => { throw new Error("must not be called"); });
  svc.fns.startModelDownload("http://127.0.0.1/model.gguf");
  assert.equal(calls.length, 0);
  assert.equal(svc.getState().active, false);
  assert.equal(svc.getState().error, "Requests to loopback addresses are not allowed.");
});

test("9.8f downloads: responses are checked (status, HTML pages) and redirects are reported", async () => {
  const { svc, calls } = downloadsWith(() => new Promise(() => {}));
  svc.fns.startModelDownload("https://huggingface.co/org/repo/blob/main/model.gguf");
  assert.equal(calls[0].url, "https://huggingface.co/org/repo/resolve/main/model.gguf", "viewer links become direct links");
  const { checkResponse, onRedirect } = calls[0].opts;
  assert.equal(checkResponse({ statusCode: 200, headers: { "content-type": "application/octet-stream" } }, calls[0].url), null);
  assert.match(checkResponse({ statusCode: 200, headers: { "content-type": "text/html; charset=utf-8" } }, calls[0].url), /returned a web page, not a model file/);
  assert.ok(checkResponse({ statusCode: 404, headers: {} }, calls[0].url));
  onRedirect();
  assert.equal(svc.getState().speed, "Following redirect");
});

test("9.8f downloads: URL checks reject non-http(s), repository pages and links without a file", () => {
  const { svc } = downloadsWith(async () => ({}));
  const issue = svc.fns.getModelDownloadUrlIssue;
  assert.equal(issue("not a url"), "That is not a valid URL.");
  assert.equal(issue("file:///etc/passwd"), "Only http(s) download URLs are supported.");
  assert.equal(issue("ftp://example.com/x.gguf"), "Only http(s) download URLs are supported.");
  assert.match(issue("https://huggingface.co/org/repo"), /repository page/);
  assert.match(issue("https://example.com/download"), /no file extension/);
  assert.equal(issue("http://169.254.169.254/x.gguf"), "Requests to loopback addresses are not allowed.");
  assert.equal(issue("https://huggingface.co/org/repo/resolve/main/x.gguf"), "");
});

test("9.8f downloads: a missing dependency fails at start-up", () => {
  assert.throws(() => createDownloadService({}), /downloads: missing dependency/);
});

// ── services/model-store.cjs on a temporary folder ────────────────────────────────────────────────
function storeIn(dir) {
  const MODELS = path.join(dir, "models"), LLM_MODELS = path.join(dir, "llm-models");
  fs.mkdirSync(MODELS, { recursive: true });
  fs.mkdirSync(LLM_MODELS, { recursive: true });
  const store = createModelStore({
    LLM_MODELS, MODELS, OPENVINO_MODELS: path.join(dir, "ov"), OPENVINO_NPU_MODELS: [], SPEECH_MODELS: path.join(dir, "speech"),
    badRequest, describeStorageError: (err) => err.message, detectModelKindCached: detectModelKind, ensureStorageCapacity: () => {},
    formatBytes: (n) => `${n} B`, fs, getPathSize: () => 0, path,
    replaceFileWithRetry: (from, to) => fs.renameSync(from, to), withFileRetrySync: (fn) => fn(),
  });
  return { ...store.fns, MODELS, LLM_MODELS };
}
const fakeUpload = (chunks, { abort = false } = {}) => {
  const req = new PassThrough();
  req.headers = {};
  req.aborted = false;
  setImmediate(() => {
    for (const c of chunks) req.write(c);
    if (abort) { req.aborted = true; req.emit("aborted"); req.emit("close"); } else req.end();
  });
  return req;
};

test("9.8f model store: imports keep only the file name, so a path can't leave the models folder", async () => {
  const dir = tmp("store");
  const s = storeIn(dir);
  const name = `escape-${process.pid}-${Date.now()}.gguf`; // unique, so a file left by another run can't interfere
  const result = await s.streamModelUpload(fakeUpload([GGUF()]), `../../../${name}`, s.LLM_MODELS, "text");
  assert.equal(result.filename, name);
  assert.ok(fs.existsSync(path.join(s.LLM_MODELS, name)));
  assert.ok(!fs.existsSync(path.join(dir, name)) && !fs.existsSync(path.join(path.dirname(dir), name)));
  for (const [name, mode] of [["evil.exe", "image"], ["model.txt", "text"], ["", "text"], ["weights.gguf", "speech"]]) {
    await assert.rejects(s.streamModelUpload(fakeUpload([]), name, s.LLM_MODELS, mode), (err) => err.code === "INVALID_FILENAME", `${mode} ${name}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("9.8f model store: an interrupted import leaves neither the model nor its .part file", async () => {
  const dir = tmp("store");
  const s = storeIn(dir);
  await assert.rejects(s.streamModelUpload(fakeUpload([GGUF()], { abort: true }), "half.gguf", s.LLM_MODELS, "text"), /Import cancelled/);
  await settle();
  assert.deepEqual(fs.readdirSync(s.LLM_MODELS), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("9.8f model store: malformed model headers are listed as unknown instead of failing the list", () => {
  const dir = tmp("store");
  const s = storeIn(dir);
  const huge = Buffer.alloc(32); huge.write("GGUF"); huge.writeBigUInt64LE(0xffffffffffffffffn, 16); // absurd key count
  const truncated = Buffer.from("GGUF\x03\x00");
  const badLen = Buffer.alloc(40); badLen.write("GGUF"); badLen.writeBigUInt64LE(1n, 16); badLen.writeBigUInt64LE(0x7fffffffffffffffn, 24); // key length past the end
  fs.writeFileSync(path.join(s.LLM_MODELS, "huge.gguf"), huge);
  fs.writeFileSync(path.join(s.LLM_MODELS, "short.gguf"), truncated);
  fs.writeFileSync(path.join(s.LLM_MODELS, "badlen.gguf"), badLen);
  fs.writeFileSync(path.join(s.LLM_MODELS, "empty.gguf"), "");
  fs.writeFileSync(path.join(s.MODELS, "bad.safetensors"), Buffer.from([255, 255, 255, 255, 255, 255, 255, 127, 1, 2]));
  const llm = s.getLlmModels();
  assert.equal(llm.length, 4);
  for (const m of llm) assert.equal(m.detectedKind, "unknown", m.filename);
  assert.equal(s.getModelInfo("bad.safetensors").detectedKind, "unknown");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("9.8f model store: a model linked in place reports its target, and a broken link is marked missing", (t) => {
  const dir = tmp("store");
  const s = storeIn(dir);
  const target = path.join(dir, "outside.gguf");
  fs.writeFileSync(target, GGUF());
  try { fs.symlinkSync(target, path.join(s.LLM_MODELS, "linked.gguf"), "file"); } catch (_) { t.skip("symlinks unavailable"); return; }
  assert.equal(s.describeLinkedModel(path.join(s.LLM_MODELS, "linked.gguf")).linkedFrom, target);
  fs.rmSync(target);
  const [m] = s.getLlmModels();
  assert.equal(m.missing, true);
  assert.equal(m.sizeBytes, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── routes/models.cjs with fake dependencies ──────────────────────────────────────────────────────
function routesWith(over = {}) {
  const dir = tmp("routes");
  const s = storeIn(dir);
  const log = [];
  const deps = {
    IMAGE_BACKEND_DOWNLOADS: {}, LLM_MODELS: s.LLM_MODELS, MODELS: s.MODELS, OPENVINO_MODELS: path.join(dir, "ov"), SPEECH_MODELS: path.join(dir, "speech"),
    addHuggingFaceFileSize: async (m) => m, cancelModelDownload: () => false, describeLinkedModel: s.describeLinkedModel,
    detectModelKindCached: detectModelKind, downloadBlockReason: () => "", errorBody: (e) => ({ ok: false, error: e.message }), errorStatus: () => 500,
    execFile: () => { throw new Error("no dialogs in tests"); }, findOpenVinoModel: () => null, fs,
    getBackendProc: () => null, getCurrentSettings: () => ({}), getDownloadProgress: () => ({ active: false }), getDownloadState: () => ({ active: false }),
    getLlmModels: s.getLlmModels, getLlmProc: () => null, getLlmSettings: () => ({}), getModelDownloadUrlIssue: () => "", getModelInfo: s.getModelInfo,
    getOpenVinoModelInfo: () => [], getOpenVinoNpuInfo: () => ({ supported: false }), invalidateBackendOptions: () => log.push("invalidate"),
    isModelFile: s.isModelFile, json: (res, status, body) => { res.status = status; res.body = body; }, killLlm: async () => log.push("killLlm"),
    modelFolderFor: s.modelFolderFor, os, path, pathInside: (c, p) => { const r = path.relative(p, c); return r === "" || (!!r && !r.startsWith("..") && !path.isAbsolute(r)); },
    publicMessage: (e) => e.message, readJsonBody: async (req) => req.body, readdirVisible: s.readdirVisible,
    resolveHuggingFaceProjector: async () => null, searchHuggingFaceModels: async () => [], speech: { getSettings: () => ({}), isReady: () => false },
    startImageBackendDownload: () => log.push("backend"), startModelDownload: (...a) => log.push(["download", ...a]),
    startOpenVinoModelDownload: () => log.push("openvino"), streamModelUpload: s.streamModelUpload,
    ...over,
  };
  const router = createRouter();
  router.use(modelRoutes(deps));
  const call = async (method, url, body) => { const res = {}; const handled = await router.dispatch({ method, url, body, headers: {} }, res); return { handled, ...res }; };
  return { call, router, s, dir, log };
}

test("9.8f routes: the 17 moved routes keep their matching rules, plus the read-only inspect route", () => {
  const { router } = routesWith();
  const list = router.routes().map((r) => `${r.method} ${r.match} ${r.path}`);
  assert.equal(list.length, 18);
  assert.ok(list.includes("GET prefix /api/model-inspect"));
  for (const p of ["/api/huggingface/models", "/api/import-model", "/api/llm/import-model"]) assert.ok(list.some((l) => l.endsWith(` prefix ${p}`)), p);
  assert.ok(list.includes("GET exact /api/download-progress"));
  assert.ok(list.includes("POST exact /api/delete-model"));
  assert.throws(() => modelRoutes({}), /routes\/models: missing dependency/);
});

test("9.8f routes: a second download is refused while one is active", async () => {
  const { call, log } = routesWith({ getDownloadState: () => ({ active: true }) });
  assert.equal((await call("POST", "/api/llm/download-model", { url: "https://example.com/x.gguf" })).status, 409);
  assert.equal((await call("POST", "/api/download-model", { url: "https://example.com/x.gguf", filename: "x.gguf" })).status, 409);
  assert.equal((await call("POST", "/api/download-backend", { backend_id: "cpu" })).status, 409);
  assert.deepEqual(log, []);
});

test("9.8f routes: deleting keeps to the models folder; a file elsewhere is never touched", async () => {
  const { call, s, dir } = routesWith();
  const outside = path.join(dir, "keep.safetensors");
  fs.writeFileSync(outside, "x");
  fs.writeFileSync(path.join(s.LLM_MODELS, "keep.gguf"), GGUF());
  for (const filename of ["../keep.safetensors", "../../keep.safetensors", path.join(dir, "keep.safetensors")]) {
    assert.equal((await call("POST", "/api/delete-model", { filename })).status, 404, filename);
  }
  assert.equal((await call("POST", "/api/llm/delete-model", { filename: "../llm-models/../keep.safetensors" })).status, 404);
  assert.equal((await call("POST", "/api/llm/delete-model", { filename: "/" })).status, 400);
  assert.ok(fs.existsSync(outside));
  assert.ok(fs.existsSync(path.join(s.LLM_MODELS, "keep.gguf")));
});

test("9.8f routes: a loaded text model is stopped before it is deleted; a loaded model can't be moved", async () => {
  const { call, s, log } = routesWith({ getLlmSettings: () => ({ model: "busy.gguf" }), getLlmProc: () => ({ pid: 1 }) });
  fs.writeFileSync(path.join(s.LLM_MODELS, "busy.gguf"), GGUF());
  assert.equal((await call("POST", "/api/move-model", { filename: "busy.gguf", from: "text", to: "image" })).status, 409);
  assert.ok(fs.existsSync(path.join(s.LLM_MODELS, "busy.gguf")));
  assert.equal((await call("POST", "/api/llm/delete-model", { filename: "busy.gguf" })).status, 200);
  assert.deepEqual(log, ["killLlm"]);
  assert.ok(!fs.existsSync(path.join(s.LLM_MODELS, "busy.gguf")));
});

test("9.8f routes: moving and linking never overwrite an existing model", async (t) => {
  const { call, s, dir, log } = routesWith();
  fs.writeFileSync(path.join(s.LLM_MODELS, "same.gguf"), GGUF());
  fs.writeFileSync(path.join(s.MODELS, "same.gguf"), "image copy");
  assert.equal((await call("POST", "/api/move-model", { filename: "same.gguf", from: "text", to: "image" })).status, 409);
  assert.equal(fs.readFileSync(path.join(s.MODELS, "same.gguf"), "utf8"), "image copy");
  const outside = path.join(dir, "same.gguf");
  fs.writeFileSync(outside, GGUF());
  const r = await call("POST", "/api/link-model", { type: "text", path: outside });
  assert.equal(r.status, 409);
  assert.equal((await call("POST", "/api/link-model", { type: "text", path: path.join(s.LLM_MODELS, "same.gguf") })).status, 400, "already in the app's folder");
  assert.equal((await call("POST", "/api/link-model", { type: "text", path: "same.gguf" })).status, 400, "relative paths are refused");
  assert.ok(!log.includes("invalidate"));
  t.diagnostic("link + move conflicts answered 409 without changing files");
});

test("9.8f routes: download progress comes from the downloads service", async () => {
  const { call } = routesWith({ getDownloadProgress: () => ({ active: true, filename: "x.gguf", progress: 42 }) });
  const r = await call("GET", "/api/download-progress");
  assert.deepEqual(r.body, { active: true, filename: "x.gguf", progress: 42 });
  assert.equal((await call("GET", "/api/download-progress?x=1")).handled, false, "exact routes don't match a query string, as before");
});

// ── The real server: sign-in, Origin, content type, restricted destinations, partial uploads ──────
let srv;
let root;
let token;
test.before(async () => {
  root = makeRoot();
  fs.mkdirSync(path.join(root, "app", "models"), { recursive: true });
  fs.mkdirSync(path.join(root, "app", "llm-models"), { recursive: true });
  fs.writeFileSync(path.join(root, "app", "models", "guarded.safetensors"), "x");
  fs.writeFileSync(path.join(root, "app", "llm-models", "guarded.gguf"), GGUF());
  srv = await startServer(root, { UAIS_AUTH: "on" }, { readyPath: "/api/auth/status" });
  token = require("../server/lan-auth.cjs").readTokenFile(path.join(root, "app", "config", require("../server/lan-auth.cjs").TOKEN_FILE_NAME));
});
test.after(() => {
  stopServer(srv);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* Windows may hold files briefly */ }
});
const auth = () => ({ Authorization: `Bearer ${token}` });
const guarded = () => fs.existsSync(path.join(root, "app", "models", "guarded.safetensors")) && fs.existsSync(path.join(root, "app", "llm-models", "guarded.gguf"));

test("9.8f server: model changes need sign-in when sign-in is on", async () => {
  const calls = [
    ["/api/delete-model", { filename: "guarded.safetensors" }], ["/api/llm/delete-model", { filename: "guarded.gguf" }],
    ["/api/move-model", { filename: "guarded.gguf", from: "text", to: "image" }], ["/api/link-model", { type: "text", path: "/tmp/x.gguf" }],
    ["/api/download-model", { url: "https://example.com/x.gguf" }], ["/api/llm/download-model", { url: "https://example.com/x.gguf" }],
    ["/api/cancel-download", {}], ["/api/pick-model-file", { type: "text" }],
  ];
  for (const [url, body] of calls) assert.equal((await request(srv.port, "POST", url, { body })).status, 401, url);
  const up = await request(srv.port, "POST", "/api/llm/import-model?filename=sneak.gguf", { body: GGUF(), headers: { "Content-Type": "application/octet-stream" } });
  assert.equal(up.status, 401);
  assert.ok(guarded());
  assert.ok(!fs.existsSync(path.join(root, "app", "llm-models", "sneak.gguf")));
});

test("9.8f server: cross-origin and non-JSON model deletions are refused", async () => {
  const cross = await request(srv.port, "POST", "/api/delete-model", { body: { filename: "guarded.safetensors" }, headers: { ...auth(), Origin: "https://evil.example" } });
  assert.equal(cross.status, 403);
  const form = await request(srv.port, "POST", "/api/delete-model", { body: "filename=guarded.safetensors", headers: { ...auth(), "Content-Type": "application/x-www-form-urlencoded" } });
  assert.equal(form.status, 415);
  assert.ok(guarded());
});

test("9.8f server: downloads to restricted destinations are refused", async () => {
  const urls = ["http://127.0.0.1/x.gguf", "http://[::1]/x.gguf", "http://169.254.169.254/x.gguf", "http://10.0.0.5/x.gguf", "http://localhost/x.gguf", "file:///etc/passwd"];
  for (const url of urls) {
    for (const route of ["/api/download-model", "/api/llm/download-model"]) {
      const r = await request(srv.port, "POST", route, { body: { url, filename: "x.gguf" }, headers: auth() });
      assert.equal(r.status, 400, `${route} ${url}`);
      assert.equal(r.json.ok, false);
    }
  }
  const progress = await request(srv.port, "GET", "/api/download-progress", { headers: auth() });
  assert.equal(progress.json.active, false, "no download was started");
});

test("9.8f server: an upload cut off mid-way leaves no model and no .part file", async () => {
  await new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: srv.port, method: "POST", path: "/api/llm/import-model?filename=cut.gguf",
      headers: { ...auth(), "Content-Type": "application/octet-stream", "Content-Length": 1024 * 1024 } });
    req.on("error", () => resolve());
    req.on("response", (res) => { res.resume(); res.on("end", resolve); });
    req.write(GGUF());
    setTimeout(() => { req.destroy(); resolve(); }, 300);
  });
  const dir = path.join(root, "app", "llm-models");
  for (let i = 0; i < 40 && fs.readdirSync(dir).some((f) => f.startsWith("cut.gguf")); i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith("cut.gguf")), []);
});

test("9.8f server: a signed-in import keeps only the file name", async () => {
  const name = `climb-${process.pid}-${Date.now()}.gguf`; // unique, so a file left by another run can't interfere
  const r = await request(srv.port, "POST", `/api/llm/import-model?filename=${encodeURIComponent(`../../../${name}`)}`, { body: GGUF(), headers: { ...auth(), "Content-Type": "application/octet-stream" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.model.filename, name);
  assert.ok(fs.existsSync(path.join(root, "app", "llm-models", name)));
  assert.ok(!fs.existsSync(path.join(root, name)) && !fs.existsSync(path.join(path.dirname(root), name)));
});
