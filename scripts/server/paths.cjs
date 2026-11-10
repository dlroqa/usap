// Single source of truth for where USAP keeps program files and user data (Step 9.2).
//
// Two layouts:
//   portable (default)  everything under <root>/app, exactly as the original Portable Local Studio
//                       (USB/folder edition). Paths are byte-identical to the pre-9.2 constants.
//   installed           program files stay under <root>/app; user data moves to the per-user OS
//                       location (docs/roadmap/DESKTOP_INSTALLERS.md). PREPARED ONLY: reached
//                       solely through USAP_DATA_MODE=installed, which no launcher or installer sets
//                       yet. It never moves, copies or deletes existing data.
//
// Pure: resolveLayout() only computes paths; ensureDataDirs() creates the user-data folders the
// server has always created at startup.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const APP_NAME = "PortableLocalStudio";
const XDG_NAME = "portable-local-studio";

// User-data folders, relative to the data root. Keys are what the server uses.
const DATA_DIRS = Object.freeze({
  models: ["models"],
  llmModels: ["llm-models"],
  chatHistory: ["chat-history"],
  config: ["config"],
  speechModels: ["speech-models"],
  transcriptions: ["transcriptions"],
  ttsModels: ["tts-models"],
  ttsOutputs: ["tts-outputs"],
  ttsCache: ["tts-cache"],
  webSearchCache: ["cache", "search"],
  openvinoModels: ["openvino-models"],
  outputs: ["outputs"],
});

// Per-user data root for the installed edition. `pathApi` lets tests resolve Windows paths on
// POSIX runners and vice versa.
function installedDataRoot({ platform, env, homedir, pathApi }) {
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || pathApi.join(homedir, "AppData", "Local");
    return pathApi.join(base, APP_NAME);
  }
  if (platform === "darwin") {
    return pathApi.join(homedir, "Library", "Application Support", APP_NAME);
  }
  // Linux and other POSIX: XDG base directory spec; a relative XDG_DATA_HOME is invalid and ignored.
  const xdg = env.XDG_DATA_HOME && pathApi.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : pathApi.join(homedir, ".local", "share");
  return pathApi.join(xdg, XDG_NAME);
}

function resolveMode(env) {
  const raw = String(env.USAP_DATA_MODE || "").trim().toLowerCase();
  if (raw === "installed") return { mode: "installed", warning: null };
  if (raw === "" || raw === "portable") return { mode: "portable", warning: null };
  return { mode: "portable", warning: `Unknown USAP_DATA_MODE "${env.USAP_DATA_MODE}"; using the portable layout.` };
}

/**
 * Compute the layout. Never touches the filesystem.
 * @param {object} [o]
 * @param {string} [o.root]      repository/portable root (default: two levels above this file)
 * @param {object} [o.env]       environment (default: process.env)
 * @param {string} [o.platform]  process.platform value (default: current)
 * @param {string} [o.homedir]   user home (default: os.homedir())
 */
function resolveLayout(o = {}) {
  const platform = o.platform || process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const nativeApi = platform === process.platform ? path : pathApi;
  const root = o.root || path.join(__dirname, "..", "..");
  const env = o.env || process.env;
  const homedir = o.homedir || os.homedir();
  const { mode, warning } = resolveMode(env);

  const appDir = nativeApi.join(root, "app");
  const dataRoot = mode === "installed" ? installedDataRoot({ platform, env, homedir, pathApi: nativeApi }) : appDir;
  const data = {};
  for (const [key, parts] of Object.entries(DATA_DIRS)) data[key] = nativeApi.join(dataRoot, ...parts);

  return Object.freeze({
    mode,
    warning,
    root,
    appDir,
    dist: nativeApi.join(appDir, "dist"),
    tools: nativeApi.join(appDir, "tools"),
    dataRoot,
    data: Object.freeze(data),
  });
}

// Create the user-data folders (the same set the server has always created at startup).
// Creates only missing folders; never removes or moves anything.
function ensureDataDirs(layout, fsApi = fs) {
  for (const dir of Object.values(layout.data)) {
    if (!fsApi.existsSync(dir)) fsApi.mkdirSync(dir, { recursive: true });
  }
}

module.exports = { resolveLayout, ensureDataDirs, installedDataRoot, DATA_DIRS };
