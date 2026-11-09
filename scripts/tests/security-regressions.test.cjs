// Security regression tests for the local server (S-1 static confinement,
// S-2 cross-origin policy, S-3 Host validation). Runs serve.cjs as a real
// subprocess on a random port; needs no models or native backends.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "..");
const { createRequestPolicy, resolveStaticPath, withoutCorsHeaders } = require(path.join(root, "scripts/server/request-policy.cjs"));
const DIST = path.join(root, "app", "dist");
const CHAT_HISTORY = path.join(root, "app", "chat-history");

// ── Unit: request-policy ────────────────────────────────────────────────────
const fakeReq = (headers) => ({ headers });

test("policy: no Origin and same-origin requests are allowed", () => {
  const p = createRequestPolicy({ env: {} });
  assert.equal(p.isAllowedOrigin(fakeReq({ host: "127.0.0.1:1420" })), true);
  assert.equal(p.isAllowedOrigin(fakeReq({ host: "localhost:1420", origin: "http://localhost:1420" })), true);
  assert.equal(p.isAllowedOrigin(fakeReq({ host: "localhost:1435", origin: "http://localhost:1435" })), true);
  assert.equal(p.isAllowedOrigin(fakeReq({ host: "[::1]:1420", origin: "http://[::1]:1420" })), true);
});

test("policy: foreign, null and non-http origins are refused", () => {
  const p = createRequestPolicy({ env: {} });
  for (const origin of ["https://evil.example", "null", "file://", "chrome-extension://abc", "http://localhost:9999", "garbage"]) {
    assert.equal(p.isAllowedOrigin(fakeReq({ host: "127.0.0.1:1420", origin })), false, origin);
  }
});

test("policy: Vite dev origin and UAIS_ALLOWED_ORIGINS are trusted; only the latter get CORS headers", () => {
  const p = createRequestPolicy({ env: { UAIS_ALLOWED_ORIGINS: "https://tool.example, http://localhost:3000/" } });
  assert.equal(p.isAllowedOrigin(fakeReq({ host: "127.0.0.1:1422", origin: "http://localhost:1420" })), true);
  assert.equal(p.corsHeadersFor(fakeReq({ origin: "http://localhost:1420" })), null);
  assert.equal(p.isAllowedOrigin(fakeReq({ host: "127.0.0.1:1420", origin: "http://localhost:3000" })), true);
  assert.equal(p.corsHeadersFor(fakeReq({ origin: "https://tool.example" }))["Access-Control-Allow-Origin"], "https://tool.example");
  assert.equal(p.corsHeadersFor(fakeReq({ origin: "https://evil.example" })), null);
});

test("policy: Host must be loopback when bound to loopback, unrestricted in LAN mode", () => {
  const local = createRequestPolicy({ listenHost: "127.0.0.1", env: { UAIS_ALLOWED_HOSTS: "studio.lan" } });
  for (const host of ["127.0.0.1:1420", "localhost:1420", "[::1]:1420", "studio.lan:1420"]) {
    assert.equal(local.isAllowedHost(fakeReq({ host })), true, host);
  }
  for (const host of ["evil.example:1420", "127.0.0.1.evil.example", "", undefined]) {
    assert.equal(local.isAllowedHost(fakeReq({ host })), false, String(host));
  }
  const lan = createRequestPolicy({ listenHost: "0.0.0.0", env: {} });
  assert.equal(lan.isAllowedHost(fakeReq({ host: "192.168.1.20:1420" })), true);
  assert.equal(lan.isAllowedOrigin(fakeReq({ host: "192.168.1.20:1420", origin: "http://192.168.1.20:1420" })), true);
  assert.equal(lan.isAllowedOrigin(fakeReq({ host: "192.168.1.20:1420", origin: "https://evil.example" })), false);
});

test("static path resolution stays inside dist", () => {
  const dist = path.join(os.tmpdir(), "dist-root");
  assert.equal(resolveStaticPath(dist, "/"), path.join(dist, "index.html"));
  assert.equal(resolveStaticPath(dist, "/assets/a.js?v=1"), path.join(dist, "assets", "a.js"));
  assert.equal(resolveStaticPath(dist, "/assets/a%20b.css"), path.join(dist, "assets", "a b.css"));
  for (const bad of ["/../x", "/../../etc/passwd", "/%2e%2e/%2e%2e/x", "/..%2f..%2fx", "/..\\..\\x", "/%00", "/%E0%A4%A"]) {
    const resolved = resolveStaticPath(dist, bad);
    assert.ok(resolved === null || resolved.startsWith(dist + path.sep), `${bad} -> ${resolved}`);
  }
});

test("proxied backend CORS headers are stripped", () => {
  assert.deepEqual(
    withoutCorsHeaders({ "content-type": "image/png", "access-control-allow-origin": "*", "Access-Control-Allow-Headers": "*" }),
    { "content-type": "image/png" },
  );
});

// ── Integration: real serve.cjs ─────────────────────────────────────────────
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer().once("error", reject).listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function request(port, { method = "GET", rawPath = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    // http.request sends `path` verbatim (no ../ normalisation), like a raw socket client.
    const req = http.request({ host: "127.0.0.1", port, method, path: rawPath, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

let server;
let port;
let output = "";

test.before(async () => {
  port = await freePort();
  server = spawn(process.execPath, [path.join(root, "scripts/server/serve.cjs")], {
    cwd: root,
    env: { ...process.env, PORT: String(port), UAIS_HOST: "", UAIS_ALLOWED_ORIGINS: "", UAIS_ALLOWED_HOSTS: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => { output += d; });
  server.stderr.on("data", (d) => { output += d; });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const res = await request(port, { rawPath: "/api/health" });
      if (res.status === 200) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`serve.cjs did not become healthy:\n${output}`);
});

test.after(() => {
  if (server && server.exitCode === null) server.kill("SIGKILL");
});

test("server: raw ../ paths cannot read files outside app/dist", async () => {
  const marker = `usap-sentinel-${crypto.randomUUID()}`;
  const sentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), "usap-sec-"));
  const sentinel = path.join(sentinelDir, "secret.txt");
  fs.writeFileSync(sentinel, marker);
  try {
    const rel = path.relative(DIST, sentinel).split(path.sep).join("/");
    const deep = "/" + "../".repeat(20) + path.resolve(sentinel).replace(/^[A-Za-z]:/, "").split(path.sep).join("/").replace(/^\//, "");
    const encoded = "/" + rel.split("/").map((seg) => (seg === ".." ? "%2e%2e" : seg)).join("%2f");
    for (const rawPath of ["/" + rel, deep, encoded, "/../../LICENSE", "/..%2f..%2fLICENSE"]) {
      const res = await request(port, { rawPath });
      assert.ok(!res.body.includes(marker), `sentinel leaked via ${rawPath}`);
      assert.ok(!res.body.includes("Permission is hereby granted"), `LICENSE leaked via ${rawPath}`);
    }
  } finally {
    fs.rmSync(sentinelDir, { recursive: true, force: true });
  }
});

test("server: built UI is still served for normal paths", async (t) => {
  if (!fs.existsSync(path.join(DIST, "index.html"))) return t.skip("app/dist not built");
  const index = await request(port, { rawPath: "/" });
  assert.equal(index.status, 200);
  assert.match(index.body, /<div id="root"><\/div>/);
  const spa = await request(port, { rawPath: "/some/client/route?x=1" });
  assert.equal(spa.status, 200);
  assert.equal(spa.body, index.body);
  const asset = index.body.match(/src="(\/assets\/[^"]+\.js)"/)[1];
  const js = await request(port, { rawPath: asset, headers: { origin: `http://127.0.0.1:${port}` } });
  assert.equal(js.status, 200);
  assert.match(js.headers["content-type"], /javascript/);
});

test("server: same-origin and non-browser API calls work without wildcard CORS", async () => {
  const plain = await request(port, { rawPath: "/api/llm/conversations" });
  assert.equal(plain.status, 200);
  const same = await request(port, { rawPath: "/api/llm/conversations", headers: { origin: `http://127.0.0.1:${port}` } });
  assert.equal(same.status, 200);
  assert.equal(same.headers["access-control-allow-origin"], undefined);
  const unknown = await request(port, { rawPath: "/api/does-not-exist" });
  assert.equal(unknown.status, 404);
});

test("server: foreign origins can neither read nor mutate", async () => {
  const id = `usap-sec-${crypto.randomUUID()}`;
  fs.mkdirSync(CHAT_HISTORY, { recursive: true });
  const save = await request(port, {
    method: "POST",
    rawPath: "/api/llm/save-conversation",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ conversation: { id, title: "sec test", messages: [{ role: "user", content: "hi" }] } }),
  });
  assert.equal(save.status, 200, save.body);
  try {
    const evil = { origin: "https://evil.example" };
    const read = await request(port, { rawPath: "/api/llm/conversations", headers: evil });
    assert.equal(read.status, 403);
    assert.ok(!read.body.includes(id));
    assert.equal(read.headers["access-control-allow-origin"], undefined);

    const preflight = await request(port, { method: "OPTIONS", rawPath: "/api/llm/delete-conversation", headers: { ...evil, "access-control-request-method": "POST" } });
    assert.equal(preflight.headers["access-control-allow-origin"], undefined);

    // text/plain "simple" request: a browser sends it without a preflight.
    const del = await request(port, { method: "POST", rawPath: "/api/llm/delete-conversation", headers: { ...evil, "content-type": "text/plain" }, body: JSON.stringify({ id }) });
    assert.equal(del.status, 403);
    const nullOrigin = await request(port, { method: "POST", rawPath: "/api/llm/delete-conversation", headers: { origin: "null", "content-type": "text/plain" }, body: JSON.stringify({ id }) });
    assert.equal(nullOrigin.status, 403);

    const list = await request(port, { rawPath: "/api/llm/conversations" });
    assert.ok(list.body.includes(id), "conversation must survive cross-origin delete attempts");
    for (const p of ["/v1/models", "/sdapi/v1/options", "/tts-outputs/x.wav"]) {
      assert.equal((await request(port, { rawPath: p, headers: evil })).status, 403, p);
    }
  } finally {
    await request(port, { method: "POST", rawPath: "/api/llm/delete-conversation", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
  }
});

test("server: DNS-rebinding Host headers are refused", async () => {
  const res = await request(port, { rawPath: "/api/llm/conversations", headers: { host: `attacker.example:${port}` } });
  assert.equal(res.status, 403);
  const ok = await request(port, { rawPath: "/api/health", headers: { host: `localhost:${port}` } });
  assert.equal(ok.status, 200);
});
