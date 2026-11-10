// errors.cjs — one error model for the studio API (Step 9.7).
//
// Every JSON error response keeps the existing shape: { ok: false, error: "<message>" }, plus any
// fields a route already sent. It adds a machine-readable `code` (when known) and an optional
// `hint`. Status codes follow the cause:
//   400 the request is malformed or invalid      404 the named model/file/item doesn't exist
//   409 the current state doesn't allow it        503 a required engine/runtime isn't installed
//   500 something failed inside the server (or an engine), not the caller's fault
// Messages never include stack traces, and absolute paths inside the studio folder or the user's
// home folder are shortened (a LAN client must not learn the host's user name or layout).
"use strict";

const os = require("os");
const path = require("path");

class ApiError extends Error {
  /**
   * @param {number} statusCode
   * @param {string} code      e.g. "INVALID_REQUEST"
   * @param {string} message   user-facing; becomes the response's `error`
   * @param {{hint?: string, extra?: object}} [opts]
   */
  constructor(statusCode, code, message, { hint, extra } = {}) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    if (hint) this.hint = hint;
    if (extra) this.extra = extra;
  }
}

const badRequest = (code, message, opts) => new ApiError(400, code, message, opts);
const notFound = (code, message, opts) => new ApiError(404, code, message, opts);
const conflict = (code, message, opts) => new ApiError(409, code, message, opts);
const notInstalled = (message, opts) => new ApiError(503, "ENGINE_NOT_INSTALLED", message, opts);

// Node's own argument errors: a request field of the wrong type reached a Node API (e.g. a JSON
// array where a filename string was expected). That is the caller's input, not a server fault.
const WRONG_TYPE_CODES = new Set(["ERR_INVALID_ARG_TYPE", "ERR_INVALID_ARG_VALUE"]);
const WRONG_TYPE_MESSAGE = "A request field has the wrong type or value.";

// Status for any thrown value: an explicit statusCode wins; known codes map; otherwise 500.
function errorStatus(err) {
  const explicit = Number(err && err.statusCode);
  if (explicit >= 400 && explicit <= 599) return explicit;
  if (err && err.code === "MODEL_ALREADY_ACTIVE") return 409;
  if (err && WRONG_TYPE_CODES.has(err.code)) return 400;
  return 500;
}

let roots = [];
/** Paths to shorten in messages: the studio root (→ relative) and the home folder (→ "~"). */
function configurePathRedaction({ root, home = os.homedir() } = {}) {
  roots = [];
  if (root) roots.push([path.resolve(root), ""]);
  if (home) roots.push([path.resolve(home), "~"]);
  // Longest first, so the studio root wins over a home folder that contains it.
  roots.sort((a, b) => b[0].length - a[0].length);
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function redactPaths(message) {
  let out = String(message);
  for (const [abs, replacement] of roots) {
    for (const variant of new Set([abs, abs.replace(/\\/g, "/")])) {
      const re = new RegExp(`${escapeRe(variant)}(?=[\\\\/]|\\b|$)[\\\\/]?`, "gi");
      out = out.replace(re, replacement ? `${replacement}/` : "");
    }
  }
  return out;
}

// The user-facing text for an error: its own message (first 2000 characters), never a stack.
function publicMessage(err, fallback = "Something went wrong in the local server.") {
  if (err && WRONG_TYPE_CODES.has(err.code)) return WRONG_TYPE_MESSAGE; // Node's text names internals
  const raw = err && typeof err === "object" ? err.message : err;
  const text = String(raw || "").trim();
  return text ? redactPaths(text).slice(0, 2000) : fallback;
}

/**
 * Body for an error response. `fields` are a route's existing extra fields (kept for
 * compatibility); `error`, `code` and `hint` are filled from the error unless given.
 */
function errorBody(err, fields = {}) {
  const body = { ok: false, ...fields };
  body.error = redactPaths(fields.error !== undefined && fields.error !== null ? fields.error : publicMessage(err));
  const code = fields.code || (err && WRONG_TYPE_CODES.has(err.code) ? "INVALID_REQUEST"
    : err && err.code && /^[A-Z][A-Z0-9_]+$/.test(String(err.code)) ? err.code : "");
  if (code || "code" in fields) body.code = code || "";
  else if (errorStatus(err) >= 500) body.code = "INTERNAL_ERROR";
  if (err && err.hint && !body.hint) body.hint = err.hint;
  if (err && err.extra) Object.assign(body, err.extra);
  return body;
}

module.exports = {
  ApiError, badRequest, notFound, conflict, notInstalled,
  errorStatus, errorBody, publicMessage, redactPaths, configurePathRedaction,
};
