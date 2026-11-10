// Step 9.5 (threats S-7, S-9): sign-in for network-exposed servers and JSON content types.
// Everything runs against local servers in temp folders; no network access beyond this machine.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const auth = require("../server/lan-auth.cjs");
const { jsonBodyType } = require("../server/request-policy.cjs");
const { makeRoot, startServer, stopServer } = require("./api-contract/harness.cjs");

const IS_WIN = process.platform === "win32";

function tmpTokenFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usap-auth-"));
  return { dir, file: path.join(dir, "config", auth.TOKEN_FILE_NAME) };
}

function send(host, port, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body !== undefined) h["Content-Length"] = Buffer.byteLength(body);
    const req = http.request({ host, port, method, path: urlPath, headers: h, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        if (/json/.test(res.headers["content-type"] || "")) { try { json = JSON.parse(text); } catch (_) { /* not json */ } }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`timeout ${method} ${urlPath}`)));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const cookieOf = (r) => String((r.headers["set-cookie"] || [])[0] || "").split(";")[0];
const jsonBody = (o) => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });

// A minimal server: the auth gate in front of a route that answers "through".
async function gateServer({ listenHost = "127.0.0.1", bind = "127.0.0.1", env = { UAIS_AUTH: "on" }, clock } = {}) {
  const t = tmpTokenFile();
  const now = clock ? () => clock.t : Date.now;
  const logs = [];
  const lan = auth.createLanAuth({ tokenFile: t.file, listenHost, env, now, log: (m) => logs.push(m) });
  lan.ensureToken();
  const server = http.createServer(async (req, res) => {
    if (await lan.handle(req, res)) return;
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("through");
  });
  await new Promise((r) => server.listen(0, bind, r));
  const port = server.address().port;
  return {
    lan, port, logs, file: t.file, token: () => auth.readTokenFile(t.file),
    get: (p, o) => send("127.0.0.1", port, "GET", p, o),
    post: (p, o) => send("127.0.0.1", port, "POST", p, o),
    close: () => { server.close(); fs.rmSync(t.dir, { recursive: true, force: true }); },
  };
}

test("mode: loopback default is unchanged; any exposed bind requires sign-in and cannot be switched off", () => {
  const m = (listenHost, env = {}) => auth.resolveAuthMode({ listenHost, env });
  assert.deepEqual([m("127.0.0.1").required, m("localhost").required, m("::1").required], [false, false, false]);
  for (const host of ["0.0.0.0", "::", "192.168.1.20"]) {
    assert.equal(m(host).required, true, host);
    assert.equal(m(host).loopbackExempt, true, host);
  }
  const forced = m("127.0.0.1", { UAIS_AUTH: "on" });
  assert.deepEqual([forced.required, forced.loopbackExempt], [true, false]);
  for (const value of ["off", "0", "false", "none"]) {
    const r = m("0.0.0.0", { UAIS_AUTH: value });
    assert.equal(r.required, true, `UAIS_AUTH=${value} must not disable sign-in on an exposed bind`);
    assert.match(r.warning, /stays required/);
  }
});

test("S-9: JSON routes classify the declared body type", () => {
  const t = (ct) => jsonBodyType({ headers: ct === undefined ? {} : { "content-type": ct } });
  assert.equal(t(undefined), "missing");
  assert.equal(t("application/json"), "json");
  assert.equal(t("Application/JSON; charset=utf-8"), "json");
  assert.equal(t("application/merge-patch+json"), "json");
  for (const ct of ["text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonp"]) {
    assert.equal(t(ct), "other", ct);
  }
});

test("tokens: 256-bit random, owner-only file, malformed files are ignored", () => {
  const a = auth.generateToken();
  assert.match(a, auth.TOKEN_RE);
  assert.notEqual(a, auth.generateToken());
  const t = tmpTokenFile();
  auth.rotateToken(t.file);
  assert.match(auth.readTokenFile(t.file), auth.TOKEN_RE);
  if (!IS_WIN) assert.equal(fs.statSync(t.file).mode & 0o777, 0o600);
  fs.writeFileSync(t.file, "not-a-token\n");
  assert.equal(auth.readTokenFile(t.file), null);
  auth.revokeToken(t.file);
  assert.equal(fs.existsSync(t.file), false);
  fs.rmSync(t.dir, { recursive: true, force: true });
});

test("tokens: the file is readable by this user only (POSIX mode 0600; Windows: this account, SYSTEM and Administrators only)", () => {
  const t = tmpTokenFile();
  try {
    assert.equal(auth.rotateToken(t.file), null, "protection applied without a warning");
    if (IS_WIN) {
      const { execFileSync } = require("node:child_process");
      const acl = execFileSync("icacls", [t.file], { encoding: "utf8" });
      const entries = acl.split(/\r?\n/).map((l) => l.replace(t.file, "").trim()).filter((l) => /:\(/.test(l));
      // Only this account, plus SYSTEM and Administrators (which Windows keeps for admin-created
      // files and which can read every file anyway). No inherited entries, no Users/Everyone.
      const me = os.userInfo().username.toLowerCase();
      assert.ok(entries.length >= 1, acl);
      for (const e of entries) {
        const who = e.split(":(")[0].toLowerCase();
        assert.ok(who === "nt authority\\system" || who === "builtin\\administrators" || who.endsWith(`\\${me}`) || who === me, `unexpected ACL entry: ${e}`);
      }
      assert.ok(entries.some((e) => e.split(":(")[0].toLowerCase().endsWith(me)), "this account has access");
      assert.doesNotMatch(acl, /\(I\)/, "no inherited entries");
      assert.doesNotMatch(acl, /Everyone|BUILTIN\\Users|Authenticated Users/i, acl);
    } else {
      assert.equal(fs.statSync(t.file).mode & 0o777, 0o600);
      fs.chmodSync(t.file, 0o644); // a copied or older file is re-protected
      assert.equal(auth.protectTokenFile(t.file), null);
      assert.equal(fs.statSync(t.file).mode & 0o777, 0o600);
    }
    // Leftover temp files would hold a copy of the token.
    assert.deepEqual(fs.readdirSync(path.dirname(t.file)), [auth.TOKEN_FILE_NAME]);
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test("gate: requests without a valid credential are refused without leaking anything", async () => {
  const s = await gateServer();
  try {
    const token = s.token();
    let r = await s.get("/api/health");
    assert.equal(r.status, 401);
    assert.equal(r.json.code, "auth_required");
    assert.equal(r.headers["cache-control"], "no-store");
    assert.ok(!r.text.includes(token));
    // Browser navigation gets the sign-in page, with a strict CSP and no token in it.
    r = await s.get("/", { headers: { Accept: "text/html,application/xhtml+xml" } });
    assert.equal(r.status, 401);
    assert.match(r.headers["content-type"], /text\/html/);
    assert.match(r.headers["content-security-policy"], /default-src 'none'/);
    assert.match(r.headers["content-security-policy"], /frame-ancestors 'none'/);
    assert.match(r.text, /<form method="post" action="\/api\/auth\/login">/);
    assert.match(r.text, /<label for="token">/);
    assert.doesNotMatch(r.text, /<script/i);
    assert.ok(!r.text.includes(token));
    // Static assets, engine proxy routes and writes are refused too.
    for (const p of ["/assets/index.js", "/v1/models", "/sdapi/v1/txt2img"]) assert.equal((await s.get(p)).status, 401, p);
    assert.equal((await s.post("/api/cleanup", jsonBody({ ids: [] }))).status, 401);
    // A token in the query string is never accepted.
    assert.equal((await s.get(`/api/health?token=${token}`)).status, 401);
    assert.equal((await s.get(`/api/health?access_token=${token}`)).status, 401);
    // Wrong or malformed bearer tokens.
    for (const h of ["Bearer usap_" + "A".repeat(43), "Bearer nope", `Basic ${Buffer.from("u:" + token).toString("base64")}`, token]) {
      assert.equal((await s.get("/api/health", { headers: { Authorization: h } })).status, 401, h.slice(0, 12));
    }
    // A forged session cookie.
    assert.equal((await s.get("/api/health", { headers: { Cookie: `${auth.COOKIE_NAME}=${"B".repeat(43)}` } })).status, 401);
    assert.equal((await s.get("/api/auth/status")).json.authenticated, false);
  } finally { s.close(); }
});

test("gate: bearer token and browser sign-in (JSON and form) grant access; the cookie is HttpOnly and SameSite=Strict", async () => {
  const s = await gateServer();
  try {
    const token = s.token();
    let r = await s.get("/api/health", { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 200);
    assert.equal(r.text, "through");

    r = await s.post("/api/auth/login", jsonBody({ token }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    const setCookie = r.headers["set-cookie"][0];
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\//);
    assert.ok(!setCookie.includes(token), "the cookie is a session id, not the token");
    const cookie = cookieOf(r);
    assert.equal((await s.get("/api/health", { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await s.get("/api/auth/status", { headers: { Cookie: cookie } })).json.authenticated, true);

    r = await s.post("/api/auth/login", { headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `token=${encodeURIComponent(token)}` });
    assert.equal(r.status, 303);
    assert.equal(r.headers.location, "/");
    assert.equal((await s.get("/", { headers: { Cookie: cookieOf(r) } })).status, 200);

    // A failed form sign-in shows the page again with an error, never the submitted value.
    r = await s.post("/api/auth/login", { headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "token=usap_wrong<script>" });
    assert.equal(r.status, 401);
    assert.match(r.text, /role="alert"/);
    assert.ok(!r.text.includes("usap_wrong"));

    // Request validation on the sign-in route.
    assert.equal((await s.post("/api/auth/login", { headers: { "Content-Type": "text/plain" }, body: token })).status, 415);
    assert.equal((await s.post("/api/auth/login", jsonBody({ token: "x".repeat(5000) }))).status, 413);
    assert.equal((await s.get("/api/auth/login")).status, 405);

    // Sign-out ends that session only.
    r = await s.post("/api/auth/logout", { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    assert.match(r.headers["set-cookie"][0], /Max-Age=0/);
    assert.equal((await s.get("/api/health", { headers: { Cookie: cookie } })).status, 401);
    assert.equal((await s.get("/api/health", { headers: { Authorization: `Bearer ${token}` } })).status, 200);
    assert.deepEqual(s.logs, [], "nothing about credentials is logged");
  } finally { s.close(); }
});

test("gate: failed attempts are rate limited per client, then the window expires", async () => {
  const clock = { t: Date.now() };
  const s = await gateServer({ clock });
  try {
    const token = s.token();
    for (let i = 0; i < auth.MAX_FAILURES; i++) {
      assert.equal((await s.post("/api/auth/login", jsonBody({ token: "usap_" + "x".repeat(43) }))).status, 401, `attempt ${i + 1}`);
    }
    let r = await s.post("/api/auth/login", jsonBody({ token }));
    assert.equal(r.status, 429, "even the right token is refused while locked out");
    assert.ok(Number(r.headers["retry-after"]) > 0);
    r = await s.get("/api/health", { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 429);
    assert.equal(r.json.code, "auth_rate_limited");
    clock.t += 15 * 60 * 1000 + 1;
    assert.equal((await s.post("/api/auth/login", jsonBody({ token }))).status, 200);
  } finally { s.close(); }
});

test("gate: sign-in always issues a new server-generated session id (no session fixation)", async () => {
  const s = await gateServer();
  try {
    const planted = `${auth.COOKIE_NAME}=${"C".repeat(43)}`;
    const r = await s.post("/api/auth/login", { headers: { "Content-Type": "application/json", Cookie: planted }, body: JSON.stringify({ token: s.token() }) });
    assert.equal(r.status, 200);
    const issued = cookieOf(r);
    assert.notEqual(issued, planted);
    assert.equal((await s.get("/api/health", { headers: { Cookie: planted } })).status, 401, "a planted id never becomes valid");
    assert.equal((await s.get("/api/health", { headers: { Cookie: issued } })).status, 200);
    const again = cookieOf(await s.post("/api/auth/login", { headers: { "Content-Type": "application/json", Cookie: issued }, body: JSON.stringify({ token: s.token() }) }));
    assert.notEqual(again, issued, "signing in again issues a fresh id");
  } finally { s.close(); }
});

test("gate: spoofed forwarding headers neither bypass throttling nor earn the local exemption", async () => {
  const s = await gateServer();
  try {
    for (let i = 0; i < auth.MAX_FAILURES; i++) {
      await s.post("/api/auth/login", { headers: { "Content-Type": "application/json", "X-Forwarded-For": `203.0.113.${i}`, "X-Real-IP": `198.51.100.${i}`, Forwarded: `for=192.0.2.${i}` }, body: JSON.stringify({ token: "usap_" + "x".repeat(43) }) });
    }
    const r = await s.post("/api/auth/login", { headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.200" }, body: JSON.stringify({ token: s.token() }) });
    assert.equal(r.status, 429, "the limiter keys on the socket address only");
  } finally { s.close(); }
  const a = await gateServer({ listenHost: "0.0.0.0", env: {} });
  try {
    assert.equal((await a.get("/api/health")).status, 200, "a direct local request is exempt");
    for (const [h, v] of [["X-Forwarded-For", "192.168.1.50"], ["Forwarded", "for=192.168.1.50"], ["X-Real-IP", "192.168.1.50"], ["Via", "1.1 proxy"], ["X-Forwarded-Host", "studio.lan"]]) {
      assert.equal((await a.get("/api/health", { headers: { [h]: v } })).status, 401, `${h}: a proxied request must sign in`);
    }
  } finally { a.close(); }
});

test("gate: sessions expire after 12 hours", async () => {
  const clock = { t: Date.now() };
  const s = await gateServer({ clock });
  try {
    const cookie = cookieOf(await s.post("/api/auth/login", jsonBody({ token: s.token() })));
    clock.t += 11 * 60 * 60 * 1000;
    assert.equal((await s.get("/api/health", { headers: { Cookie: cookie } })).status, 200);
    clock.t += 60 * 60 * 1000 + 1;
    assert.equal((await s.get("/api/health", { headers: { Cookie: cookie } })).status, 401);
  } finally { s.close(); }
});

test("gate: rotating the token signs everyone out; revoking it refuses all access until a new one exists", async () => {
  const s = await gateServer();
  try {
    const oldToken = s.token();
    const oldCookie = cookieOf(await s.post("/api/auth/login", jsonBody({ token: oldToken })));
    assert.equal((await s.get("/api/health", { headers: { Cookie: oldCookie } })).status, 200);

    auth.rotateToken(s.file);
    const newToken = s.token();
    assert.notEqual(newToken, oldToken);
    assert.equal((await s.get("/api/health", { headers: { Cookie: oldCookie } })).status, 401, "old session revoked");
    assert.equal((await s.get("/api/health", { headers: { Authorization: `Bearer ${oldToken}` } })).status, 401, "old token revoked");
    assert.equal((await s.post("/api/auth/login", jsonBody({ token: oldToken }))).status, 401);
    const newCookie = cookieOf(await s.post("/api/auth/login", jsonBody({ token: newToken })));
    assert.equal((await s.get("/api/health", { headers: { Cookie: newCookie } })).status, 200);

    auth.revokeToken(s.file);
    assert.equal((await s.get("/api/health", { headers: { Cookie: newCookie } })).status, 401, "sessions end on revoke");
    assert.equal((await s.get("/api/health", { headers: { Authorization: `Bearer ${newToken}` } })).status, 401);
    assert.equal((await s.post("/api/auth/login", jsonBody({ token: newToken }))).status, 401);
    assert.equal(s.logs.length, 1);
    assert.match(s.logs[0], /No valid access token/);
    assert.ok(!s.logs[0].includes(newToken));

    auth.rotateToken(s.file);
    assert.equal((await s.get("/api/health", { headers: { Authorization: `Bearer ${s.token()}` } })).status, 200);
  } finally { s.close(); }
});

test("gate (auto mode): this computer is exempt only with a loopback Host, so DNS rebinding still needs sign-in", async () => {
  const s = await gateServer({ listenHost: "0.0.0.0", env: {} });
  try {
    assert.equal((await s.get("/api/health")).status, 200, "Host 127.0.0.1 from loopback");
    assert.equal((await s.get("/api/health", { headers: { Host: `localhost:${s.port}` } })).status, 200);
    assert.equal((await s.get("/api/health", { headers: { Host: `rebind.example:${s.port}` } })).status, 401);
    assert.equal((await s.get("/api/health", { headers: { Host: `192.168.1.20:${s.port}` } })).status, 401);
  } finally { s.close(); }
});

test("gate (auto mode): a request from another address on the network must sign in", async (t) => {
  const lanIp = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
  if (!lanIp) {
    if (process.env.CI) assert.fail("CI runner has no non-loopback IPv4 interface");
    t.skip("this machine has no non-loopback IPv4 interface");
    return;
  }
  const s = await gateServer({ listenHost: "0.0.0.0", bind: "0.0.0.0", env: {} });
  try {
    const r = await send(lanIp.address, s.port, "GET", "/api/health");
    assert.equal(r.status, 401);
    const ok = await send(lanIp.address, s.port, "GET", "/api/health", { headers: { Authorization: `Bearer ${s.token()}` } });
    assert.equal(ok.status, 200);
  } finally { s.close(); }
});

// ── The real server ──────────────────────────────────────────────────────────
test("serve.cjs: default loopback mode is unchanged (no sign-in); JSON routes require a JSON content type", async () => {
  const root = makeRoot();
  let srv;
  try {
    srv = await startServer(root);
    const get = (p, o) => send("127.0.0.1", srv.port, "GET", p, o);
    const post = (p, o) => send("127.0.0.1", srv.port, "POST", p, o);
    assert.equal((await get("/api/health")).status, 200);
    assert.deepEqual((await get("/api/auth/status")).json, { ok: true, required: false, authenticated: true });
    assert.equal((await post("/api/auth/login", jsonBody({ token: "x" }))).status, 404);
    assert.equal(fs.existsSync(path.join(root, "app", "config", auth.TOKEN_FILE_NAME)), false, "no token file in loopback mode");
    assert.doesNotMatch(srv.log(), /Sign-in/);
    // S-9
    assert.equal((await post("/api/cleanup", jsonBody({ ids: [] }))).status, 200);
    let r = await post("/api/cleanup", { headers: { "Content-Type": "text/plain" }, body: '{"ids":[]}' });
    assert.equal(r.status, 415);
    assert.match(r.json.error, /application\/json/);
    assert.equal((await post("/api/cleanup", { body: '{"ids":[]}' })).status, 415, "untyped body");
    assert.equal((await post("/api/cleanup", { headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "ids=1" })).status, 415);
    assert.equal((await post("/api/cleanup")).status, 200, "a POST with no body and no type is still accepted");
  } finally { stopServer(srv); fs.rmSync(root, { recursive: true, force: true }); }
});

test("serve.cjs: with sign-in required, every route is protected, credentials never reach logs or engines", async () => {
  const root = makeRoot();
  const seen = [];
  const engine = http.createServer((req, res) => { seen.push(req.headers); res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); });
  await new Promise((r) => engine.listen(0, "127.0.0.1", r));
  const enginePort = String(engine.address().port);
  let srv;
  try {
    srv = await startServer(root, { UAIS_AUTH: "on", BACKEND_PORT: enginePort, SD_BACKEND_PORT: enginePort }, { readyPath: "/api/auth/status" });
    const get = (p, o) => send("127.0.0.1", srv.port, "GET", p, o);
    const post = (p, o) => send("127.0.0.1", srv.port, "POST", p, o);
    const tokenFile = path.join(root, "app", "config", auth.TOKEN_FILE_NAME);
    const token = auth.readTokenFile(tokenFile);
    assert.match(token, auth.TOKEN_RE, "a token is created at startup");
    if (!IS_WIN) assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);

    assert.deepEqual((await get("/api/auth/status")).json, { ok: true, required: true, authenticated: false });
    for (const p of ["/api/health", "/api/diagnostics", "/api/settings", "/api/llm/models", "/api/speech/models", "/api/download-progress", "/v1/models"]) {
      assert.equal((await get(p)).status, 401, p);
    }
    for (const [p, b] of [["/api/cleanup", { ids: [] }], ["/api/llm/stop", {}], ["/api/download-model", { url: "https://example.com/x.gguf" }], ["/api/settings", {}]]) {
      assert.equal((await post(p, jsonBody(b))).status, 401, p);
    }
    assert.equal((await get("/", { headers: { Accept: "text/html" } })).status, 401);
    assert.equal(seen.length, 0, "nothing reached the engine unauthenticated");

    assert.equal((await get("/api/health", { headers: { Authorization: `Bearer ${token}` } })).status, 200);
    const login = await post("/api/auth/login", jsonBody({ token }));
    assert.equal(login.status, 200);
    const cookie = cookieOf(login);
    assert.equal((await get("/api/health", { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await post("/api/cleanup", { headers: { Cookie: cookie, "Content-Type": "application/json" }, body: '{"ids":[]}' })).status, 200);

    // CSRF: a valid session cookie doesn't help a request from another website.
    const evil = await post("/api/cleanup", { headers: { Cookie: cookie, "Content-Type": "application/json", Origin: "http://evil.example" }, body: '{"ids":[]}' });
    assert.equal(evil.status, 403);
    const same = await post("/api/cleanup", { headers: { Cookie: cookie, "Content-Type": "application/json", Origin: `http://127.0.0.1:${srv.port}` }, body: '{"ids":[]}' });
    assert.equal(same.status, 200);
    // The token file is never served as a static file, even to a signed-in client.
    for (const p of ["/../config/lan-access-token", "/%2e%2e/config/lan-access-token", "/..%2fconfig%2flan-access-token", "/config/lan-access-token", "/app/config/lan-access-token"]) {
      const r = await get(p, { headers: { Cookie: cookie } });
      assert.ok(!r.text.includes(token), `${p} must not return the token (status ${r.status})`);
    }

    // The image-engine proxy forwards the request without USAP's credentials.
    const r = await get("/v1/models", { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].cookie, undefined);
    assert.equal(seen[0].authorization, undefined);
    await get("/v1/models", { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(seen[1].authorization, undefined);

    const log = srv.log();
    assert.match(log, /Sign-in\s+: required for every request/);
    assert.ok(log.includes(tokenFile), "the log says where the token is");
    assert.ok(!log.includes(token), "the token is never logged");
    assert.ok(!log.includes(cookie.split("=")[1]), "the session id is never logged");
  } finally { stopServer(srv); engine.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("CLI: status, show, rotate and revoke manage the token file without printing it unless asked", () => {
  const { spawnSync } = require("node:child_process");
  const t = tmpTokenFile();
  const cli = (cmd) => spawnSync(process.execPath, [path.join(__dirname, "..", "server", "lan-auth.cjs"), cmd],
    { encoding: "utf8", env: { ...process.env, USAP_AUTH_TOKEN_FILE: t.file } });
  try {
    assert.match(cli("status").stdout, /No access token/);
    assert.equal(cli("show").status, 1);
    const rot = cli("rotate");
    assert.equal(rot.status, 0);
    const token = auth.readTokenFile(t.file);
    assert.match(token, auth.TOKEN_RE);
    assert.ok(!rot.stdout.includes(token), "rotate does not print the token");
    assert.equal(cli("show").stdout.trim(), token);
    assert.match(cli("status").stdout, /An access token exists/);
    assert.equal(cli("revoke").status, 0);
    assert.equal(fs.existsSync(t.file), false);
    assert.equal(cli("bogus").status, 2);
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});
