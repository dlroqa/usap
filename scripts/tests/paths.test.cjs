// Step 9.2: data-root resolver. Portable paths must stay byte-identical to the original layout;
// installed-mode paths are prepared (per OS) but never chosen unless explicitly requested.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const REPO = path.resolve(__dirname, "..", "..");
const { resolveLayout, ensureDataDirs, DATA_DIRS } = require(path.join(REPO, "scripts", "server", "paths.cjs"));

// The exact folders the original server used (serve.cjs before 9.2), relative to <root>/app.
const ORIGINAL = {
  models: "models",
  llmModels: "llm-models",
  chatHistory: "chat-history",
  config: "config",
  speechModels: "speech-models",
  transcriptions: "transcriptions",
  ttsModels: "tts-models",
  ttsOutputs: "tts-outputs",
  ttsCache: "tts-cache",
  webSearchCache: path.join("cache", "search"),
  openvinoModels: "openvino-models",
  outputs: "outputs",
};

test("portable (default): every path is byte-identical to the original <root>/app layout", () => {
  const root = path.join(os.tmpdir(), "usap root with spaces", "Portable-Local-Studio");
  const l = resolveLayout({ root, env: {} });
  assert.equal(l.mode, "portable");
  assert.equal(l.warning, null);
  assert.equal(l.root, root);
  assert.equal(l.appDir, path.join(root, "app"));
  assert.equal(l.dist, path.join(root, "app", "dist"));
  assert.equal(l.tools, path.join(root, "app", "tools"));
  assert.equal(l.dataRoot, path.join(root, "app"));
  assert.deepEqual(Object.keys(l.data).sort(), Object.keys(ORIGINAL).sort());
  for (const [k, rel] of Object.entries(ORIGINAL)) assert.equal(l.data[k], path.join(root, "app", rel), k);
});

test("portable: the default root is the repository (two levels above scripts/server)", () => {
  const l = resolveLayout({ env: {} });
  assert.equal(l.root, path.join(REPO, "scripts", "server", "..", ".."));
  assert.equal(path.resolve(l.root), REPO);
  assert.equal(l.data.models, path.join(l.root, "app", "models"));
});

test("portable: unrelated environment variables never change the layout", () => {
  const root = "/media/usb/USAP";
  const env = { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local", XDG_DATA_HOME: "/home/x/.local/share", HOME: "/home/x", APPDATA: "x" };
  const l = resolveLayout({ root, env, platform: process.platform === "win32" ? "linux" : process.platform });
  assert.equal(l.mode, "portable");
  assert.equal(l.dataRoot, path.posix.join(root, "app"));
});

test("portable: USAP_DATA_MODE=portable is explicit portable; an unknown value falls back to portable with a warning", () => {
  assert.equal(resolveLayout({ root: "/r", env: { USAP_DATA_MODE: "portable" } }).mode, "portable");
  const odd = resolveLayout({ root: "/r", env: { USAP_DATA_MODE: "cloud" } });
  assert.equal(odd.mode, "portable");
  assert.match(odd.warning, /Unknown USAP_DATA_MODE/);
  assert.equal(odd.dataRoot, path.join("/r", "app"));
});

test("portable: Windows drive and UNC roots resolve under the same folder", () => {
  for (const root of ["E:\\USAP", "\\\\nas\\share\\USAP"]) {
    const l = resolveLayout({ root, env: {}, platform: "win32" });
    assert.equal(l.data.models, path.win32.join(root, "app", "models"));
    assert.equal(l.data.webSearchCache, path.win32.join(root, "app", "cache", "search"));
  }
});

// ── installed mode (prepared, opt-in only) ──────────────────────────────────
test("installed: Windows uses %LOCALAPPDATA%\\PortableLocalStudio; program files stay with the app", () => {
  const l = resolveLayout({ root: "C:\\Program Files\\USAP", platform: "win32", homedir: "C:\\Users\\ana",
    env: { USAP_DATA_MODE: "installed", LOCALAPPDATA: "C:\\Users\\ana\\AppData\\Local" } });
  assert.equal(l.mode, "installed");
  assert.equal(l.dataRoot, "C:\\Users\\ana\\AppData\\Local\\PortableLocalStudio");
  assert.equal(l.data.models, "C:\\Users\\ana\\AppData\\Local\\PortableLocalStudio\\models");
  assert.equal(l.dist, "C:\\Program Files\\USAP\\app\\dist");
  assert.equal(l.tools, "C:\\Program Files\\USAP\\app\\tools");
});

test("installed: Windows without LOCALAPPDATA falls back to <home>\\AppData\\Local", () => {
  const l = resolveLayout({ root: "C:\\USAP", platform: "win32", homedir: "C:\\Users\\ana", env: { USAP_DATA_MODE: "installed" } });
  assert.equal(l.dataRoot, "C:\\Users\\ana\\AppData\\Local\\PortableLocalStudio");
});

test("installed: macOS uses ~/Library/Application Support/PortableLocalStudio", () => {
  const l = resolveLayout({ root: "/Applications/USAP.app/Contents/Resources", platform: "darwin", homedir: "/Users/ana", env: { USAP_DATA_MODE: "installed" } });
  assert.equal(l.dataRoot, "/Users/ana/Library/Application Support/PortableLocalStudio");
  assert.equal(l.data.chatHistory, "/Users/ana/Library/Application Support/PortableLocalStudio/chat-history");
  assert.equal(l.dist, "/Applications/USAP.app/Contents/Resources/app/dist");
});

test("installed: Linux follows XDG_DATA_HOME, defaulting to ~/.local/share; a relative XDG path is ignored", () => {
  const base = { root: "/opt/usap", platform: "linux", homedir: "/home/ana" };
  assert.equal(resolveLayout({ ...base, env: { USAP_DATA_MODE: "installed" } }).dataRoot, "/home/ana/.local/share/portable-local-studio");
  assert.equal(resolveLayout({ ...base, env: { USAP_DATA_MODE: "installed", XDG_DATA_HOME: "/data/xdg" } }).dataRoot, "/data/xdg/portable-local-studio");
  assert.equal(resolveLayout({ ...base, env: { USAP_DATA_MODE: "Installed ", XDG_DATA_HOME: "relative/dir" } }).dataRoot, "/home/ana/.local/share/portable-local-studio");
});

test("installed: every data folder lives under the data root, and none under the program folder", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    const p = platform === "win32" ? path.win32 : path.posix;
    const root = platform === "win32" ? "C:\\Program Files\\USAP" : "/opt/usap";
    const l = resolveLayout({ root, platform, homedir: platform === "win32" ? "C:\\Users\\a" : "/home/a", env: { USAP_DATA_MODE: "installed" } });
    for (const [k, dir] of Object.entries(l.data)) {
      assert.ok(!p.relative(l.dataRoot, dir).startsWith(".."), `${platform} ${k} outside data root`);
      assert.ok(p.relative(l.appDir, dir).startsWith(".."), `${platform} ${k} must not be under the program folder`);
    }
  }
});

// ── directory creation ──────────────────────────────────────────────────────
test("ensureDataDirs creates exactly the original folders, only when missing, and never removes anything", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usap-paths-"));
  try {
    const l = resolveLayout({ root, env: {} });
    fs.mkdirSync(l.data.models, { recursive: true });
    const keep = path.join(l.data.models, "user-model.safetensors");
    fs.writeFileSync(keep, "user data");
    ensureDataDirs(l);
    ensureDataDirs(l); // idempotent
    for (const rel of Object.values(ORIGINAL)) assert.ok(fs.statSync(path.join(root, "app", rel)).isDirectory(), rel);
    assert.equal(fs.readFileSync(keep, "utf8"), "user data");
    const top = fs.readdirSync(path.join(root, "app")).sort();
    assert.deepEqual(top, ["cache", "chat-history", "config", "llm-models", "models", "openvino-models", "outputs", "speech-models", "transcriptions", "tts-cache", "tts-models", "tts-outputs"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("DATA_DIRS is frozen", () => {
  assert.ok(Object.isFrozen(DATA_DIRS));
});

// ── serve.cjs uses the resolver ─────────────────────────────────────────────
test("serve.cjs takes every user-data folder from the resolver (no hard-coded data paths left)", () => {
  const src = fs.readFileSync(path.join(REPO, "scripts", "server", "serve.cjs"), "utf8");
  assert.match(src, /require\(["']\.\/paths\.cjs["']\)/);
  const leftovers = [];
  for (const rel of Object.values(ORIGINAL)) {
    const parts = rel.split(path.sep).map((p) => `"${p}"`).join(",\\s*");
    if (new RegExp(`path\\.join\\(ROOT,\\s*"app",\\s*${parts}\\s*\\)`).test(src)) leftovers.push(rel);
  }
  assert.deepEqual(leftovers, [], "data folders still built from ROOT in serve.cjs");
});
