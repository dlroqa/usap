// public-paths.cjs — shorten host paths in status and diagnostics responses (issue #52).
//
// Status routes used to return absolute paths (e.g. /home/<user>/Studio/app/runtime/...). Over LAN
// sharing, any signed-in device could learn the host's user name and folder layout. The interface
// doesn't display these fields, so they are shortened for every client, including localhost:
//   the studio root itself   → "."
//   inside the studio root   → studio-relative ("app/runtime/...")
//   inside the home folder   → "~/..."
//   anything else            → unchanged (system locations such as /usr/bin carry no user data)
// Only the response is changed. The server keeps using absolute paths for file-system work.
// Uses the same roots as error messages (errors.cjs configurePathRedaction).
"use strict";

const { redactPaths } = require("./errors.cjs");

// Response keys whose string values are file-system paths.
const PATH_KEYS = new Set([
  "path", "root", "backendPath", "serverPath", "runtimePath", "workerPath", "cachePath", "pathHint", "python",
]);
// Message keys whose text can contain a path (engine output, probe failures): paths inside are shortened.
const TEXT_KEYS = new Set(["error", "reason", "hint", "message", "detail", "stderrTail", "lastError"]);

function publicPath(value) {
  if (typeof value !== "string" || !value) return value;
  const short = redactPaths(value);
  return short === "" ? "." : short;
}

/**
 * Returns a copy of `value` in which every string under a PATH_KEYS key, at any depth, is shortened,
 * and paths inside TEXT_KEYS messages are shortened in place.
 * Other values are shared, not copied. Field names and types are unchanged.
 */
function publicPaths(value, depth = 0) {
  if (depth > 12 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => publicPaths(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && PATH_KEYS.has(key)) out[key] = publicPath(item);
    else if (typeof item === "string" && TEXT_KEYS.has(key)) out[key] = redactPaths(item);
    else out[key] = publicPaths(item, depth + 1);
  }
  return out;
}

module.exports = { publicPath, publicPaths, PATH_KEYS, TEXT_KEYS };
