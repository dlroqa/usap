// Issue #52: status and diagnostics routes must not return absolute host paths (studio root, home
// folder) to any client, including localhost. Field names and types stay the same.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { makeRoot, startServer, stopServer, request } = require("./api-contract/harness.cjs");
const { configurePathRedaction } = require("../server/errors.cjs");
const { publicPath, publicPaths } = require("../server/public-paths.cjs");

const ROUTES = [
  "/api/health", "/api/diagnostics", "/api/backend-options",
  "/api/llm/status", "/api/llm/backends", "/api/llm/stats",
  "/api/speech/status", "/api/tts/status",
];

// Every string in a JSON value, with its JSON path.
function strings(value, at = "$", out = []) {
  if (typeof value === "string") out.push([at, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${at}[${i}]`, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) strings(v, `${at}.${k}`, out);
  return out;
}

// Path forms that must not appear: the studio root and home folder, with either separator.
function forbidden(root) {
  const forms = new Set();
  for (const p of [fs.realpathSync(root), path.resolve(root), os.homedir()]) {
    forms.add(p.toLowerCase());
    forms.add(p.replace(/\\/g, "/").toLowerCase());
  }
  return [...forms].filter((f) => f.length > 3);
}

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

test("#52: no status or diagnostics route returns the studio root or the home folder", async () => {
  const bad = forbidden(root);
  const leaks = [];
  for (const route of ROUTES) {
    const r = await request(srv.port, "GET", route);
    assert.equal(r.status, 200, route);
    assert.ok(r.json && typeof r.json === "object", `${route} returns JSON`);
    for (const [at, value] of strings(r.json)) {
      const v = value.toLowerCase();
      if (bad.some((b) => v.includes(b))) leaks.push(`${route} ${at}`);
    }
  }
  assert.deepEqual(leaks, [], `absolute host paths in responses:\n  ${leaks.join("\n  ")}`);
});

test("#52: shortened fields keep their names and string type (the studio root becomes '.')", async () => {
  const health = (await request(srv.port, "GET", "/api/health")).json;
  assert.equal(typeof health.root, "string");
  assert.equal(health.root, ".");
  for (const check of health.checks || []) {
    if ("path" in check) {
      assert.equal(typeof check.path, "string");
      assert.ok(!path.isAbsolute(check.path) || !check.path.toLowerCase().startsWith(os.homedir().toLowerCase()), check.path);
    }
  }
  const tts = (await request(srv.port, "GET", "/api/tts/status")).json;
  for (const k of ["runtimePath", "workerPath", "cachePath"]) assert.equal(typeof tts[k], "string", k);
  const llm = (await request(srv.port, "GET", "/api/llm/status")).json;
  assert.equal(typeof llm.backendPath, "string");
});

test("#52: the redaction applies to localhost too (Option A, owner decision)", async () => {
  // The harness talks to 127.0.0.1: a loopback client. It must get shortened paths as well.
  const diag = (await request(srv.port, "GET", "/api/diagnostics")).json;
  assert.doesNotMatch(JSON.stringify(diag), new RegExp(path.basename(root).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("publicPath / publicPaths: studio-relative, ~ for home, other paths unchanged, no mutation", () => {
  const home = path.join(path.parse(process.cwd()).root, "home-x", "alice");
  const studio = path.join(home, "Studio");
  configurePathRedaction({ root: studio, home });
  try {
    assert.equal(publicPath(studio), ".");
    assert.equal(publicPath(path.join(studio, "app", "runtime", "llama")), path.join("app", "runtime", "llama"));
    assert.equal(publicPath(path.join(home, "models", "x.gguf")), `~/${path.join("models", "x.gguf")}`);
    const system = path.join(path.parse(process.cwd()).root, "usr", "bin", "whisper-cli");
    assert.equal(publicPath(system), system, "system locations carry no user data and are kept");
    assert.equal(publicPath(""), "");
    assert.equal(publicPath(undefined), undefined);

    const input = {
      root: studio, name: studio, count: 3, ok: true,
      checks: [{ id: "a", path: path.join(studio, "app") }],
      backend: { options: { openvinoModels: [{ path: path.join(home, "ov") }] } },
      candidates: [{ pathHint: path.join(studio, "bin") }],
      openvino: { python: path.join(studio, "app", "venv", "python"), reason: `probe failed: ${path.join(home, "x", "ov.py")} not found` },
      settings: { model: path.join(home, "m.gguf") },
    };
    const snapshot = JSON.stringify(input);
    const out = publicPaths(input);
    assert.equal(JSON.stringify(input), snapshot, "the internal object is not modified");
    assert.equal(out.root, ".");
    assert.equal(out.name, studio, "only path fields are changed");
    assert.equal(out.count, 3);
    assert.equal(out.checks[0].path, "app");
    assert.equal(out.backend.options.openvinoModels[0].path, "~/ov");
    assert.equal(out.candidates[0].pathHint, "bin");
    assert.equal(out.openvino.python, path.join("app", "venv", "python"));
    assert.equal(out.openvino.reason, `probe failed: ~/${path.join("x", "ov.py")} not found`, "paths inside messages are shortened");
    assert.equal(out.settings.model, path.join(home, "m.gguf"), "settings values are not touched (the interface compares them)");
  } finally {
    configurePathRedaction({});
  }
});
