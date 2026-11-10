// pipeline.cjs — the order every request goes through (Step 9.8). Centralizes the request
// security established in Steps 9.3–9.7 so that no route module can be reached around it:
//
//   1. Host check (DNS rebinding)            403 "Host not allowed"
//   2. Origin check (cross-site requests)     403 "Cross-origin request blocked"
//   3. CORS headers for configured origins only
//   4. CORS preflight (OPTIONS)               204
//   5. Sign-in gate when exposed (LAN)        401 / 429 / sign-in page
//   6. Routes: the module router first, then the remaining legacy handler
//   7. Error boundary: an unexpected error answers 400 (wrongly typed input) or a generic 500;
//      details go to the server log only.
"use strict";

/**
 * @param {object} deps
 * @param {{isAllowedHost: Function, isAllowedOrigin: Function, corsHeadersFor: Function}} deps.requestPolicy
 * @param {{handle: (req, res) => Promise<boolean>}} deps.lanAuth
 * @param {{dispatch: (req, res) => Promise<boolean>}} deps.router
 * @param {(req, res) => Promise<void>} deps.fallback   routes not yet moved into modules, then static files
 * @param {(res, status: number, body: object) => void} deps.json
 * @param {{errorStatus: Function, errorBody: Function}} deps.errors
 * @param {(msg: string, err: unknown) => void} [deps.logError]
 */
function createPipeline({ requestPolicy, lanAuth, router, fallback, json, errors, logError = (m, e) => console.error(m, e) }) {
  for (const [name, dep] of Object.entries({ requestPolicy, lanAuth, router, fallback, json, errors })) {
    if (!dep) throw new Error(`pipeline: missing dependency ${name}`);
  }

  async function handleRequest(req, res) {
    if (!requestPolicy.isAllowedHost(req)) {
      return json(res, 403, { ok: false, error: "Host not allowed" });
    }
    if (!requestPolicy.isAllowedOrigin(req)) {
      return json(res, 403, { ok: false, error: "Cross-origin request blocked" });
    }
    const corsHeaders = requestPolicy.corsHeadersFor(req);
    if (corsHeaders) {
      for (const [key, value] of Object.entries(corsHeaders)) res.setHeader(key, value);
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (await lanAuth.handle(req, res)) return;
    if (await router.dispatch(req, res)) return;
    await fallback(req, res);
  }

  // The http.createServer callback.
  return function onRequest(req, res) {
    handleRequest(req, res).catch((err) => {
      logError(`  [api] Unhandled error in ${req.method} ${String(req.url || "").split("?")[0]}:`, err && err.stack ? err.stack : err);
      if (res.headersSent) { try { res.destroy(); } catch (_) { /* already gone */ } return; }
      const status = errors.errorStatus(err) === 400 ? 400 : 500; // wrongly typed input is the caller's error
      try {
        json(res, status, status === 400 ? errors.errorBody(err) : { ok: false, error: "Something went wrong in the local server.", code: "INTERNAL_ERROR" });
      } catch (_) { /* response already broken */ }
    });
  };
}

module.exports = { createPipeline };
