// router.cjs — a small, explicit router for the studio API (Step 9.8).
//
// It reproduces the matching rules of the original if-chain in serve.cjs exactly, so routes can
// move into modules without any behaviour change:
//   * "exact" routes match when req.url (including any query string) equals the path, like the
//     original `req.url === "/api/x"`. A query string therefore does not match an exact route.
//   * "prefix" routes match when req.url starts with the path, like `req.url.startsWith(...)`.
//   * Routes are tried in registration order; the first match handles the request.
// There is no pattern syntax, no middleware stack and no implicit behaviour.
"use strict";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function createRouter() {
  const routes = [];

  function add(method, match, path, handler) {
    if (!METHODS.has(method)) throw new Error(`router: unsupported method ${method}`);
    if (match !== "exact" && match !== "prefix") throw new Error(`router: unknown match type ${match}`);
    if (typeof path !== "string" || !path.startsWith("/")) throw new Error(`router: path must start with "/": ${path}`);
    if (typeof handler !== "function") throw new Error(`router: handler for ${method} ${path} is not a function`);
    if (routes.some((r) => r.method === method && r.match === match && r.path === path)) {
      throw new Error(`router: duplicate route ${method} ${path}`);
    }
    routes.push({ method, match, path, handler });
  }

  /** Register a module: `register({ get, post, prefix })` calls inside `mod(api)`. */
  const api = {
    get: (path, handler) => add("GET", "exact", path, handler),
    post: (path, handler) => add("POST", "exact", path, handler),
    getPrefix: (path, handler) => add("GET", "prefix", path, handler),
    postPrefix: (path, handler) => add("POST", "prefix", path, handler),
  };

  function find(req) {
    const url = String(req.url || "");
    return routes.find((r) => r.method === req.method && (r.match === "exact" ? url === r.path : url.startsWith(r.path))) || null;
  }

  /** Run the first matching route. Resolves true when a route handled the request. */
  async function dispatch(req, res) {
    const route = find(req);
    if (!route) return false;
    await route.handler(req, res);
    return true;
  }

  return { ...api, use: (mod) => mod(api), dispatch, find, routes: () => routes.map(({ method, match, path }) => ({ method, match, path })) };
}

module.exports = { createRouter };
