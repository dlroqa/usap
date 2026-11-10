// Step 9.8: router, request pipeline and the first route module. The router must match exactly
// like the original if-chain, the pipeline must keep the security order, and no module route may
// be reachable around Host/Origin/sign-in checks or the error boundary.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { createRouter } = require("../server/http/router.cjs");
const { createPipeline } = require("../server/http/pipeline.cjs");
const { systemRoutes } = require("../server/routes/system.cjs");
const errors = require("../server/errors.cjs");
const { makeRoot, startServer, stopServer, request } = require("./api-contract/harness.cjs");

const fakeRes = () => {
  const res = { status: null, body: null, headers: {}, headersSent: false, destroyed: false,
    setHeader(k, v) { this.headers[k] = v; }, writeHead(s) { this.status = s; this.headersSent = true; }, end() { this.ended = true; },
    destroy() { this.destroyed = true; } };
  return res;
};
const json = (res, status, body) => { res.status = status; res.body = body; res.headersSent = true; };

// ── Router ───────────────────────────────────────────────────────────────────
test("router: exact and prefix matching mirror the original if-chain", async () => {
  const r = createRouter();
  const hits = [];
  r.get("/api/x", () => hits.push("exact"));
  r.getPrefix("/api/files/", () => hits.push("prefix"));
  r.post("/api/x", () => hits.push("post"));
  const go = (method, url) => r.dispatch({ method, url }, {});
  assert.equal(await go("GET", "/api/x"), true);
  assert.equal(await go("GET", "/api/x?refresh=1"), false, "like `req.url === ...`, a query string doesn't match an exact route");
  assert.equal(await go("GET", "/api/xy"), false);
  assert.equal(await go("GET", "/api/files/a.png?x=1"), true);
  assert.equal(await go("POST", "/api/x"), true);
  assert.equal(await go("PUT", "/api/x"), false, "the method must match");
  assert.deepEqual(hits, ["exact", "prefix", "post"]);
});

test("router: first registered route wins; bad registrations are refused", async () => {
  const r = createRouter();
  const hits = [];
  r.getPrefix("/api/", () => hits.push("first"));
  r.get("/api/x", () => hits.push("second"));
  await r.dispatch({ method: "GET", url: "/api/x" }, {});
  assert.deepEqual(hits, ["first"]);
  assert.throws(() => r.get("/api/x", () => {}), /duplicate/);
  assert.throws(() => r.get("api/no-slash", () => {}), /must start/);
  assert.throws(() => r.get("/api/y", null), /not a function/);
  assert.deepEqual(r.routes().map((x) => `${x.method} ${x.match} ${x.path}`), ["GET prefix /api/", "GET exact /api/x"]);
});

// ── Pipeline ─────────────────────────────────────────────────────────────────
function pipelineWith(overrides = {}) {
  const calls = [];
  const deps = {
    requestPolicy: { isAllowedHost: () => true, isAllowedOrigin: () => true, corsHeadersFor: () => null },
    lanAuth: { handle: async () => { calls.push("auth"); return false; } },
    router: { dispatch: async () => { calls.push("router"); return false; } },
    fallback: async () => { calls.push("fallback"); },
    json, errors, logError: (m, e) => calls.push(`log:${m}:${String(e).split("\n")[0]}`),
    ...overrides,
  };
  return { onRequest: createPipeline(deps), calls };
}
const run = async (onRequest, req = { method: "GET", url: "/api/x", headers: {} }) => {
  const res = fakeRes();
  onRequest(req, res);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return res;
};

test("pipeline: Host, then Origin, then preflight, then sign-in, then module routes, then legacy routes", async () => {
  let p = pipelineWith({ requestPolicy: { isAllowedHost: () => false, isAllowedOrigin: () => true, corsHeadersFor: () => null } });
  let res = await run(p.onRequest);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "Host not allowed");
  assert.deepEqual(p.calls, [], "nothing else runs");

  p = pipelineWith({ requestPolicy: { isAllowedHost: () => true, isAllowedOrigin: () => false, corsHeadersFor: () => null } });
  res = await run(p.onRequest);
  assert.equal(res.body.error, "Cross-origin request blocked");
  assert.deepEqual(p.calls, []);

  p = pipelineWith({ requestPolicy: { isAllowedHost: () => true, isAllowedOrigin: () => true, corsHeadersFor: () => ({ "Access-Control-Allow-Origin": "https://tool.example" }) } });
  res = await run(p.onRequest, { method: "OPTIONS", url: "/api/x", headers: {} });
  assert.equal(res.status, 204);
  assert.equal(res.headers["Access-Control-Allow-Origin"], "https://tool.example");
  assert.deepEqual(p.calls, [], "preflight never reaches sign-in or routes");

  p = pipelineWith({ lanAuth: { handle: async () => true } });
  await run(p.onRequest);
  assert.deepEqual(p.calls, [], "a refused sign-in stops the request before any route");

  p = pipelineWith({ router: { dispatch: async () => { p.calls.push("router"); return true; } } });
  await run(p.onRequest);
  assert.deepEqual(p.calls, ["auth", "router"], "a module route ends the request; legacy routes don't run");

  p = pipelineWith();
  await run(p.onRequest);
  assert.deepEqual(p.calls, ["auth", "router", "fallback"]);
});

test("pipeline: one error boundary for module and legacy routes, with diagnostics kept server-side", async () => {
  let p = pipelineWith({ router: { dispatch: async () => { throw new Error("db exploded at /secret/path"); } } });
  let res = await run(p.onRequest);
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { ok: false, error: "Something went wrong in the local server.", code: "INTERNAL_ERROR" });
  assert.ok(p.calls.some((c) => c.startsWith("log:") && c.includes("db exploded")), "the real error is logged");

  const typeErr = (() => { try { path.basename([]); } catch (e) { return e; } })();
  p = pipelineWith({ fallback: async () => { throw typeErr; } });
  res = await run(p.onRequest);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_REQUEST");

  p = pipelineWith({ router: { dispatch: async (req, r) => { r.headersSent = true; throw new Error("mid-stream"); } } });
  res = await run(p.onRequest);
  assert.equal(res.destroyed, true, "a response already under way is closed, not overwritten");

  assert.throws(() => createPipeline({ json, errors }), /missing dependency/);
});

test("routes/system: refuses missing dependencies and registers exactly its six read-only routes", () => {
  assert.throws(() => systemRoutes({ json }), /missing dependency/);
  const r = createRouter();
  const fn = () => ({});
  r.use(systemRoutes({ json, getHealth: fn, getDiagnostics: fn, getCleanupCandidates: () => [], getHardwareSpecs: fn, getBackendOptions: fn, getTelemetry: fn }));
  assert.deepEqual(r.routes().map((x) => `${x.method} ${x.path}`), [
    "GET /api/health", "GET /api/diagnostics", "GET /api/cleanup-candidates", "GET /api/hardware-specs", "GET /api/backend-options", "GET /api/telemetry",
  ]);
});

test("serve.cjs: the pipeline is the only way in", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server", "serve.cjs"), "utf8");
  assert.equal((src.match(/http\.createServer\(/g) || []).length, 1);
  assert.match(src, /http\.createServer\(createPipeline\(\{ requestPolicy, lanAuth, router, fallback: legacyRoutes, json, errors \}\)\)/);
  assert.equal((src.match(/legacyRoutes\(/g) || []).length, 1, "legacy routes are only called by the pipeline");
});

// ── The real server ──────────────────────────────────────────────────────────
test("server: module routes stay behind sign-in, Origin and Host checks", async () => {
  const root = makeRoot();
  const srv = await startServer(root, { UAIS_AUTH: "on" }, { readyPath: "/api/auth/status" });
  try {
    const token = fs.readFileSync(path.join(root, "app", "config", "lan-access-token"), "utf8").trim();
    const fn = () => ({});
    const r = createRouter();
    r.use(systemRoutes({ json, getHealth: fn, getDiagnostics: fn, getCleanupCandidates: () => [], getHardwareSpecs: fn, getBackendOptions: fn, getTelemetry: fn }));
    for (const { method, path: p } of r.routes()) {
      assert.equal((await request(srv.port, method, p)).status, 401, `${p} without sign-in`);
      assert.equal((await request(srv.port, method, p, { headers: { Authorization: `Bearer ${token}`, Origin: "http://evil.example" } })).status, 403, `${p} cross-site`);
      assert.equal((await request(srv.port, method, p, { headers: { Authorization: `Bearer ${token}` } })).status, 200, `${p} signed in`);
    }
  } finally { stopServer(srv); fs.rmSync(root, { recursive: true, force: true }); }
});
