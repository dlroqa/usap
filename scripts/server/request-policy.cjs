// request-policy.cjs — origin / host / static-path policy for serve.cjs.
//
// The studio UI is served same-origin by serve.cjs and has no login, so any web
// page the user visits must not be able to drive or read the local API.
//   * Requests that carry a foreign Origin are refused (403). Same-origin
//     browser requests and non-browser clients (no Origin header) are unaffected.
//   * When bound to loopback, the Host header must be a loopback name, which
//     blocks DNS-rebinding attacks.
//   * Static files are confined to the dist directory.
// Extra trusted origins/hosts can be added with UAIS_ALLOWED_ORIGINS /
// UAIS_ALLOWED_HOSTS (comma-separated); only those origins receive CORS headers.

const path = require("path");

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
// The Vite dev server (app/frontend/vite.config.js, strictPort 1420) proxies /api here.
const DEV_ORIGINS = ["http://localhost:1420", "http://127.0.0.1:1420"];
const CORS_HEADER_RE = /^access-control-/i;

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch (_) {
    return null;
  }
}

function hostnameOf(hostHeader) {
  if (!hostHeader) return "";
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch (_) {
    return "";
  }
}

function isLoopbackBind(listenHost) {
  const host = String(listenHost || "").toLowerCase();
  return LOOPBACK_HOSTNAMES.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host);
}

function createRequestPolicy({ listenHost = "127.0.0.1", env = process.env } = {}) {
  const extraOrigins = new Set(parseList(env.UAIS_ALLOWED_ORIGINS).map(normalizeOrigin).filter(Boolean));
  const trustedOrigins = new Set([...DEV_ORIGINS, ...extraOrigins]);
  const extraHosts = new Set(parseList(env.UAIS_ALLOWED_HOSTS).map((h) => h.toLowerCase()));
  const enforceHost = isLoopbackBind(listenHost);

  function isAllowedHost(req) {
    if (!enforceHost) return true;
    const hostname = hostnameOf(req.headers.host);
    return LOOPBACK_HOSTNAMES.has(hostname) || extraHosts.has(hostname);
  }

  // Returns true when the request has no Origin (non-browser / same-origin GET)
  // or an Origin that is the server itself or explicitly trusted.
  function isAllowedOrigin(req) {
    const raw = req.headers.origin;
    if (raw === undefined) return true;
    const origin = normalizeOrigin(raw); // "null" and non-http(s) schemes -> null
    if (!origin) return false;
    if (new URL(origin).host === String(req.headers.host || "").toLowerCase()) return true;
    return trustedOrigins.has(origin);
  }

  // CORS response headers are only ever sent to explicitly configured origins.
  function corsHeadersFor(req) {
    const origin = normalizeOrigin(req.headers.origin || "");
    if (!origin || !extraOrigins.has(origin)) return null;
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST",
      Vary: "Origin",
    };
  }

  return { isAllowedHost, isAllowedOrigin, corsHeadersFor };
}

function withoutCorsHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (!CORS_HEADER_RE.test(key)) out[key] = value;
  }
  return out;
}

// Resolve a request URL to a file inside distDir, or null if it would escape it.
function resolveStaticPath(distDir, requestUrl) {
  let urlPath = String(requestUrl || "/").split("?")[0].split("#")[0];
  try {
    urlPath = decodeURIComponent(urlPath);
  } catch (_) {
    return null;
  }
  if (urlPath.includes("\0")) return null;
  const root = path.resolve(distDir);
  const filePath = path.resolve(root, "." + path.sep + (urlPath === "/" ? "index.html" : urlPath));
  const relative = path.relative(root, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return filePath;
}

module.exports = {
  createRequestPolicy,
  withoutCorsHeaders,
  resolveStaticPath,
  isLoopbackBind,
};
