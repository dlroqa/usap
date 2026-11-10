// lan-auth.cjs — sign-in for network-exposed USAP (Step 9.5, threat S-7).
//
// Default (bound to loopback): nothing changes; no sign-in.
// Bound beyond loopback (UAIS_HOST=0.0.0.0 etc.): every request needs a credential, except
// requests from this machine itself (loopback peer AND a loopback Host name), so the local
// workflow is unchanged. UAIS_AUTH=on also requires sign-in for loopback (e.g. behind a reverse
// proxy on the same machine). There is deliberately no setting that turns sign-in off while the
// server is exposed.
//
// Credential: one random access token (256 bits) in <data>/config/lan-access-token (mode 0600).
// It is never logged, never accepted in a URL, and never sent to the browser after sign-in.
//   * Browsers: a server-rendered sign-in page posts the token once; the server answers with a
//     random session id in an HttpOnly, SameSite=Strict cookie. The existing UI is untouched.
//   * Scripts: "Authorization: Bearer <token>".
// Rotating the token (CLI below) signs every session out at once; revoking it (deleting the file)
// refuses all remote access until a new token is created. The running server notices both without
// a restart.
//
// CLI: node scripts/server/lan-auth.cjs status | show | rotate | revoke
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { isLoopbackBind } = require("./request-policy.cjs");

const TOKEN_FILE_NAME = "lan-access-token";
const TOKEN_RE = /^usap_[A-Za-z0-9_-]{43}$/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{43}$/;
const COOKIE_NAME = "usap_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 256;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const MAX_TRACKED_CLIENTS = 10000;
const MAX_LOGIN_BODY_BYTES = 4096;
const LOOPBACK_HOSTNAMES = new Set(["localhost", "[::1]", "::1"]);

// ── Token file ───────────────────────────────────────────────────────────────
function generateToken() {
  return "usap_" + crypto.randomBytes(32).toString("base64url");
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

// Constant-time comparison of two strings of any length.
function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function readTokenFile(file) {
  try {
    const token = fs.readFileSync(file, "utf8").trim();
    return TOKEN_RE.test(token) ? token : null;
  } catch (_) {
    return null;
  }
}

// Write atomically (temp file + rename), readable only by the owner where the OS supports modes.
function writeTokenFile(file, token) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, token + "\n", { mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  try { fs.chmodSync(file, 0o600); } catch (_) { /* Windows: ACLs apply instead */ }
}

function rotateToken(file) {
  writeTokenFile(file, generateToken());
}

function revokeToken(file) {
  fs.rmSync(file, { force: true });
}

// ── Request helpers ──────────────────────────────────────────────────────────
function hostnameOf(hostHeader) {
  if (!hostHeader) return "";
  try { return new URL(`http://${hostHeader}`).hostname.toLowerCase(); } catch (_) { return ""; }
}

function peerAddress(req) {
  const raw = String((req.socket && req.socket.remoteAddress) || "");
  return raw.toLowerCase().startsWith("::ffff:") && net.isIPv4(raw.slice(7)) ? raw.slice(7) : raw;
}

function isLoopbackAddress(ip) {
  return ip === "::1" || (net.isIPv4(ip) && ip.startsWith("127."));
}

function isLoopbackHostname(hostname) {
  return LOOPBACK_HOSTNAMES.has(hostname) || (net.isIPv4(hostname) && hostname.startsWith("127."));
}

// Rate-limit key: the IPv4 address, or the /64 prefix for IPv6 (one host can hold a whole /64).
function clientKey(req) {
  const ip = peerAddress(req);
  if (!net.isIPv6(ip)) return ip;
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(":") + "::/64";
}

function pathOf(url) {
  return String(url || "/").split("?")[0].split("#")[0];
}

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function mediaType(req) {
  return String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
}

function readSmallBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    const chunks = [];
    // Past the limit: stop buffering and reject; the caller answers 413 and closes the connection.
    req.on("data", (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > limit) { over = true; chunks.length = 0; reject(Object.assign(new Error("too large"), { status: 413 })); return; }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!over) resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", reject);
  });
}

// ── Sign-in page (no script; matches the app's Clean Light / Clean Dark themes) ─
const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function signInPage(error = "") {
  const err = error ? `<p class="error" id="token-error" role="alert">${escapeHtml(error)}</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in · Uncensored AI Studio</title>
<style>
  :root { --bg: #f5f5f7; --surface: #ffffff; --text: #1d1d1f; --muted: #5f5f66; --border: #d2d2d7;
          --accent: #1d1d1f; --on-accent: #ffffff; --error: #b3261e; --focus: #0a64d8; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0d0d0d; --surface: #171717; --text: #f4f4f4; --muted: #a3a3a3; --border: #333333;
            --accent: #f4f4f4; --on-accent: #0d0d0d; --error: #ff8a80; --focus: #6ea8ff; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; padding: 16px;
         background: var(--bg); color: var(--text); font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { width: 100%; max-width: 400px; background: var(--surface); border: 1px solid var(--border);
         border-radius: 16px; padding: 32px 24px; }
  h1 { font-size: 1.375rem; font-weight: 600; margin: 0 0 8px; }
  p { margin: 0 0 24px; color: var(--muted); }
  label { display: block; font-weight: 500; margin-bottom: 8px; }
  input { width: 100%; min-height: 44px; padding: 10px 12px; font: inherit; color: var(--text); background: var(--bg);
          border: 1px solid var(--border); border-radius: 10px; }
  input[aria-invalid="true"] { border-color: var(--error); }
  .hint { font-size: 0.875rem; margin: 8px 0 0; }
  .error { color: var(--error); font-size: 0.875rem; font-weight: 500; margin: 8px 0 0; }
  button { width: 100%; min-height: 44px; margin-top: 24px; font: inherit; font-weight: 600; cursor: pointer;
           color: var(--on-accent); background: var(--accent); border: 0; border-radius: 10px; }
  button:hover { opacity: 0.88; }
  input:focus-visible, button:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
  code { font-size: 0.8125rem; word-break: break-all; }
</style>
</head>
<body>
<main>
  <h1>Sign in to Uncensored AI Studio</h1>
  <p>This studio is shared on your network, so it asks for its access token.</p>
  <form method="post" action="/api/auth/login">
    <label for="token">Access token</label>
    <input id="token" name="token" type="password" required autocomplete="current-password" autocapitalize="off"
           spellcheck="false" maxlength="200" aria-describedby="token-hint${error ? " token-error" : ""}"${error ? ' aria-invalid="true" autofocus' : ""}>
    ${err}
    <p class="hint" id="token-hint">On the computer running the studio, open <code>app/config/lan-access-token</code>, or run
      <code>node scripts/server/lan-auth.cjs show</code>.</p>
    <button type="submit">Sign in</button>
  </form>
</main>
</body>
</html>`;
}

// ── Policy ───────────────────────────────────────────────────────────────────
function resolveAuthMode({ listenHost = "127.0.0.1", env = process.env } = {}) {
  const raw = String(env.UAIS_AUTH || "").trim().toLowerCase();
  const exposed = !isLoopbackBind(listenHost);
  if (raw === "on" || raw === "required") return { required: true, loopbackExempt: false, exposed, warning: null };
  const warning = raw && raw !== "auto"
    ? `UAIS_AUTH must be "auto" or "on"; using "auto"${exposed ? " (sign-in stays required while the server is reachable from the network)" : ""}.`
    : null;
  return { required: exposed, loopbackExempt: true, exposed, warning };
}

/**
 * @param {object} o
 * @param {string} o.tokenFile  path of the access-token file
 * @param {string} [o.listenHost]
 * @param {object} [o.env]
 * @param {() => number} [o.now]
 * @param {(msg: string) => void} [o.log]  receives status messages; never a credential
 */
function createLanAuth({ tokenFile, listenHost = "127.0.0.1", env = process.env, now = Date.now, log = () => {} }) {
  const mode = resolveAuthMode({ listenHost, env });
  const sessions = new Map(); // sha256(session id) hex -> { fp, expires }
  const failures = new Map(); // client key -> { count, resetAt }
  let cache = { key: null, token: null, fp: null };
  let missingLogged = false;

  // Re-read the token file only when it changes, so rotation and revocation apply immediately.
  function credential() {
    let st;
    try { st = fs.statSync(tokenFile); } catch (_) { st = null; }
    const key = st ? `${st.ino}:${st.size}:${st.mtimeMs}` : "missing";
    if (key !== cache.key) {
      const token = st ? readTokenFile(tokenFile) : null;
      cache = { key, token, fp: token ? sha256(token).toString("hex") : null };
      if (token) missingLogged = false;
    }
    if (!cache.token && mode.required && !missingLogged) {
      missingLogged = true;
      log("[auth] No valid access token: remote access is refused until one is created (node scripts/server/lan-auth.cjs rotate).");
    }
    return cache.token ? cache : null;
  }

  function ensureToken() {
    if (!mode.required || readTokenFile(tokenFile)) return;
    rotateToken(tokenFile);
  }

  function retryAfter(key) {
    const e = failures.get(key);
    if (!e) return 0;
    if (now() >= e.resetAt) { failures.delete(key); return 0; }
    return e.count >= MAX_FAILURES ? Math.max(1, Math.ceil((e.resetAt - now()) / 1000)) : 0;
  }

  function recordFailure(key) {
    if (!failures.has(key) && failures.size >= MAX_TRACKED_CLIENTS) {
      for (const [k, e] of failures) if (now() >= e.resetAt) failures.delete(k);
      if (failures.size >= MAX_TRACKED_CLIENTS) failures.delete(failures.keys().next().value);
    }
    const e = failures.get(key) || { count: 0, resetAt: now() + FAILURE_WINDOW_MS };
    e.count += 1;
    failures.set(key, e);
  }

  function createSession(fp) {
    for (const [k, s] of sessions) if (s.expires <= now()) sessions.delete(k);
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const id = crypto.randomBytes(32).toString("base64url");
    sessions.set(sha256(id).toString("hex"), { fp, expires: now() + SESSION_TTL_MS });
    return id;
  }

  function sessionCookie(req, id, maxAgeSeconds) {
    const secure = req.socket && req.socket.encrypted ? "; Secure" : "";
    return `${COOKIE_NAME}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
  }

  function isExempt(req) {
    return !mode.required ||
      (mode.loopbackExempt && isLoopbackAddress(peerAddress(req)) && isLoopbackHostname(hostnameOf(req.headers.host)));
  }

  // "ok" | "none" | "invalid" | "limited"
  function authenticate(req) {
    const cred = credential();
    const authz = req.headers.authorization;
    if (authz !== undefined) {
      const key = clientKey(req);
      if (retryAfter(key)) return "limited";
      const m = /^Bearer\s+(\S+)$/i.exec(String(authz));
      if (cred && m && TOKEN_RE.test(m[1]) && safeEqual(m[1], cred.token)) return "ok";
      recordFailure(key);
      return "invalid";
    }
    const sid = cookieValue(req, COOKIE_NAME);
    if (sid && SESSION_ID_RE.test(sid)) {
      const k = sha256(sid).toString("hex");
      const s = sessions.get(k);
      if (s && cred && s.fp === cred.fp && s.expires > now()) return "ok";
      if (s) sessions.delete(k);
    }
    return "none";
  }

  function sendJson(res, status, body, headers = {}) {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  }

  async function login(req, res) {
    const key = clientKey(req);
    const type = mediaType(req);
    const isForm = type === "application/x-www-form-urlencoded";
    const fail = (status, message, extra = {}) => (isForm
      ? (res.writeHead(status, { ...PAGE_HEADERS, ...extra }), res.end(signInPage(message)))
      : sendJson(res, status, { ok: false, error: message }, extra));
    const wait = retryAfter(key);
    if (wait) return fail(429, "Too many failed sign-in attempts. Try again later.", { "Retry-After": String(wait) });
    if (!isForm && type !== "application/json") {
      req.resume();
      return sendJson(res, 415, { ok: false, error: "Send the access token as a form or as JSON." });
    }
    let text;
    try {
      text = await readSmallBody(req, MAX_LOGIN_BODY_BYTES);
    } catch (_) {
      res.on("finish", () => req.socket && req.socket.destroy());
      return fail(413, "Request is too large.", { Connection: "close" });
    }
    let token = "";
    if (isForm) token = new URLSearchParams(text).get("token") || "";
    else { try { const body = JSON.parse(text || "{}"); token = typeof body.token === "string" ? body.token : ""; } catch (_) { token = ""; } }
    token = token.trim();
    const cred = credential();
    if (!cred || !TOKEN_RE.test(token) || !safeEqual(token, cred.token)) {
      recordFailure(key);
      return fail(401, "That access token is not valid.");
    }
    failures.delete(key);
    const cookie = sessionCookie(req, createSession(cred.fp), SESSION_TTL_MS / 1000);
    if (isForm) {
      res.writeHead(303, { Location: "/", "Set-Cookie": cookie, "Cache-Control": "no-store" });
      return res.end();
    }
    return sendJson(res, 200, { ok: true }, { "Set-Cookie": cookie });
  }

  function logout(req, res) {
    req.resume();
    const sid = cookieValue(req, COOKIE_NAME);
    if (sid && SESSION_ID_RE.test(sid)) sessions.delete(sha256(sid).toString("hex"));
    const cookie = sessionCookie(req, "", 0);
    if (mediaType(req) === "application/x-www-form-urlencoded") {
      res.writeHead(303, { Location: "/", "Set-Cookie": cookie, "Cache-Control": "no-store" });
      return res.end();
    }
    return sendJson(res, 200, { ok: true }, { "Set-Cookie": cookie });
  }

  /**
   * Run before any route. Returns true when the request has been answered (an auth route, or a
   * refusal); false when it may continue to the normal routes.
   */
  async function handle(req, res) {
    const p = pathOf(req.url);
    if (p === "/api/auth/status" && req.method === "GET") {
      const authenticated = isExempt(req) || authenticate(req) === "ok";
      sendJson(res, 200, { ok: true, required: mode.required, authenticated });
      return true;
    }
    if (p === "/api/auth/login" || p === "/api/auth/logout") {
      if (req.method !== "POST") { req.resume(); sendJson(res, 405, { ok: false, error: "Use POST." }, { Allow: "POST" }); return true; }
      if (!mode.required) { req.resume(); sendJson(res, 404, { ok: false, error: "Sign-in is not enabled on this server." }); return true; }
      await (p === "/api/auth/login" ? login(req, res) : logout(req, res));
      return true;
    }
    if (isExempt(req)) return false;
    const state = authenticate(req);
    if (state === "ok") return false;
    req.resume();
    if (state === "limited") {
      sendJson(res, 429, { ok: false, error: "Too many failed attempts. Try again later.", code: "auth_rate_limited" },
        { "Retry-After": String(retryAfter(clientKey(req))) });
      return true;
    }
    const isPage = req.method === "GET" && !/^\/(api|v1|sdapi)\//.test(p) &&
      /text\/html/.test(String(req.headers.accept || ""));
    if (isPage) {
      res.writeHead(401, PAGE_HEADERS);
      res.end(signInPage());
      return true;
    }
    sendJson(res, 401, { ok: false, error: "Sign-in required.", code: "auth_required" },
      { "WWW-Authenticate": 'Bearer realm="USAP"' });
    return true;
  }

  return { mode, handle, ensureToken, tokenFile, _sessions: sessions, _failures: failures };
}

// Headers that carry USAP credentials and must not be forwarded to local engines.
function withoutAuthHeaders(headers) {
  const out = { ...headers };
  delete out.authorization;
  delete out.cookie;
  return out;
}

module.exports = {
  createLanAuth,
  resolveAuthMode,
  generateToken,
  readTokenFile,
  rotateToken,
  revokeToken,
  withoutAuthHeaders,
  signInPage,
  TOKEN_FILE_NAME,
  TOKEN_RE,
  COOKIE_NAME,
  MAX_FAILURES,
};

// ── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const { resolveLayout } = require("./paths.cjs");
  const file = process.env.USAP_AUTH_TOKEN_FILE || path.join(resolveLayout().data.config, TOKEN_FILE_NAME);
  const cmd = process.argv[2];
  if (cmd === "status") {
    console.log(readTokenFile(file) ? `An access token exists: ${file}` : `No access token (${file}). Remote access is refused.`);
  } else if (cmd === "show") {
    const token = readTokenFile(file);
    if (!token) { console.error(`No access token at ${file}. Create one with: rotate`); process.exit(1); }
    console.log(token);
  } else if (cmd === "rotate") {
    rotateToken(file);
    console.log(`New access token written to ${file}. Everyone signed in with the old token is signed out.`);
    console.log("Display it with: node scripts/server/lan-auth.cjs show");
  } else if (cmd === "revoke") {
    revokeToken(file);
    console.log("Access token deleted. Remote access is refused (and everyone is signed out) until you run: rotate");
  } else {
    console.error("Usage: node scripts/server/lan-auth.cjs status | show | rotate | revoke");
    process.exit(2);
  }
}
