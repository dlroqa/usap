// Step 9.8f: downloaded model archives (Core ML .zip) are checked before they are unpacked, unpacked into
// a hidden staging folder and moved into place; unsafe archives are refused and removed.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const guard = require("../server/archive-guard.cjs");
const { createDownloadService } = require("../server/services/downloads.cjs");

const HAS_UNZIP = spawnSync("unzip", ["-v"], { stdio: "ignore" }).status === 0;
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "usap-archive-")); made.push(d); return d; };
test.after(() => { for (const d of made) try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* Windows may hold files briefly */ } });

// A minimal zip writer (stored entries). Each entry: { name, data?, mode?, madeBy? }.
function makeZip(file, entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name, "utf8");
    const data = Buffer.from(e.data || "");
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(((e.madeBy ?? 3) << 8) | 20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(e.size ?? data.length, 24); central.writeUInt16LE(name.length, 28);
    const mode = e.mode ?? (e.name.toString().endsWith("/") ? 0o040755 : 0o100644);
    central.writeUInt32LE(((mode << 16) | (e.name.toString().endsWith("/") ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, cd, end]));
  return file;
}

const SAFE = [
  { name: "model.coreml/" },
  { name: "model.coreml/Unet.mlmodelc/" },
  { name: "model.coreml/Unet.mlmodelc/weights.bin", data: "weights" },
  { name: "model.coreml/vocab.json", data: "{}" },
];

test("archive guard: a normal Core ML archive is accepted", () => {
  const dir = tmp();
  const { entries, totalBytes } = guard.inspectZip(makeZip(path.join(dir, "ok.zip"), SAFE));
  assert.deepEqual(entries.map((e) => e.name), SAFE.map((e) => e.name));
  assert.equal(totalBytes, "weights".length + "{}".length);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("archive guard: unsafe entries are refused before anything is unpacked", () => {
  const dir = tmp();
  const cases = [
    [[{ name: "../escape.bin", data: "x" }], /outside its folder/],
    [[{ name: "model.coreml/../../escape.bin", data: "x" }], /outside its folder/],
    [[{ name: "/etc/escape", data: "x" }], /absolute path/],
    [[{ name: "C:/Windows/escape.dll", data: "x" }], /absolute path/],
    [[{ name: "model.coreml\\..\\escape.bin", data: "x" }], /backslash/],
    [[{ name: Buffer.from("model\nname.bin"), data: "x" }], /control characters/],
    [[{ name: "model.coreml/link", data: "/etc/passwd", mode: 0o120777 }], /link or special file/],
    [[{ name: "model.coreml/fifo", mode: 0o010644 }], /link or special file/],
    [[{ name: "model.coreml/dev", mode: 0o020644 }], /link or special file/],
    [[], /empty/],
    [[{ name: "model.coreml/weights.bin:stream", data: "x" }], /colon/],
    [[{ name: "./", data: "" }], /no name/],
    [[{ name: "model.coreml/a.bin", data: "1" }, { name: "model.coreml/a.bin", data: "2" }], /two entries with the same name/],
    [[{ name: "model.coreml/Weights.bin", data: "1" }, { name: "model.coreml/weights.bin", data: "2" }], /two entries with the same name/],
    [[{ name: "model.coreml/a", data: "1" }, { name: "model.coreml/a/b.bin", data: "2" }], /file and a folder/],
    [[{ name: "model.coreml/a/", mode: 0o040755 }, { name: "model.coreml/A", data: "2" }], /file and a folder/],
  ];
  for (const [entries, expected] of cases) {
    const zip = makeZip(path.join(dir, "bad.zip"), entries);
    assert.throws(() => guard.inspectZip(zip), (err) => err.name === "ArchiveError" && expected.test(err.message), JSON.stringify(entries.map((e) => String(e.name))));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("archive guard: entry-count and size limits, damaged and non-zip files", () => {
  const dir = tmp();
  const zip = makeZip(path.join(dir, "many.zip"), SAFE);
  assert.throws(() => guard.inspectZip(zip, { ...guard.LIMITS, maxEntries: 3 }), /more than 3 entries/);
  const big = makeZip(path.join(dir, "big.zip"), [{ name: "model.coreml/huge.bin", data: "x", size: 0xfffffff0 }]);
  const noRatio = { ...guard.LIMITS, maxRatio: Infinity }; // isolate each limit
  assert.throws(() => guard.inspectZip(big, { ...noRatio, maxTotalBytes: 1024 ** 3 }), /unpacks to more than the size limit/);
  assert.throws(() => guard.inspectZip(big, { ...noRatio, maxEntryBytes: 1024 ** 3 }), /file larger than the size limit/);
  // 1 byte stored, 4 GB declared: far beyond the expansion ratio of any model file
  assert.throws(() => guard.inspectZip(big), /expands far more/);
  fs.writeFileSync(path.join(dir, "not.zip"), "this is a web page");
  assert.throws(() => guard.inspectZip(path.join(dir, "not.zip")), /isn't a zip archive/);
  const damaged = fs.readFileSync(zip);
  damaged.writeUInt32LE(0xdeadbeef, damaged.length - 22 - 46 * 4 - SAFE.reduce((n, e) => n + Buffer.byteLength(e.name), 0)); // first central entry
  fs.writeFileSync(path.join(dir, "damaged.zip"), damaged);
  assert.throws(() => guard.inspectZip(path.join(dir, "damaged.zip")), /damaged/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("archive guard: links created while unpacking are caught before anything is installed", () => {
  const dir = tmp();
  const dest = path.join(dir, "models");
  fs.mkdirSync(dest);
  const zip = makeZip(path.join(dir, "ok.zip"), SAFE);
  // Stand-in for an unzip that produced a link anyway.
  const unzip = (_zip, staging) => {
    fs.mkdirSync(path.join(staging, "model.coreml"));
    fs.symlinkSync(os.homedir(), path.join(staging, "model.coreml", "home"));
  };
  let made = true;
  try { fs.symlinkSync(dir, path.join(dir, "probe")); } catch (_) { made = false; }
  if (!made) return; // no symlinks on this system (Windows without Developer Mode)
  assert.throws(() => guard.extractZipSafely(zip, dest, { unzip }), /link or special file/);
  assert.deepEqual(fs.readdirSync(dest), [], "nothing installed, staging removed");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("archive guard: unpacking replaces the same-named model folder in one step and cleans up", { skip: !HAS_UNZIP && "unzip not installed" }, () => {
  const dir = tmp();
  const dest = path.join(dir, "models");
  fs.mkdirSync(path.join(dest, "model.coreml"), { recursive: true });
  fs.writeFileSync(path.join(dest, "model.coreml", "stale.bin"), "old");
  fs.writeFileSync(path.join(dest, "other.safetensors"), "keep");
  const installed = guard.extractZipSafely(makeZip(path.join(dir, "m.zip"), SAFE), dest);
  assert.deepEqual(installed, ["model.coreml"]);
  assert.equal(fs.readFileSync(path.join(dest, "model.coreml", "Unet.mlmodelc", "weights.bin"), "utf8"), "weights");
  assert.ok(!fs.existsSync(path.join(dest, "model.coreml", "stale.bin")), "the folder is replaced, not merged");
  assert.equal(fs.readFileSync(path.join(dest, "other.safetensors"), "utf8"), "keep");
  assert.deepEqual(fs.readdirSync(dest).sort(), ["model.coreml", "other.safetensors"], "no staging folder left");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("archive guard: a failed unpack leaves the installed model as it was", () => {
  const dir = tmp();
  const dest = path.join(dir, "models");
  fs.mkdirSync(path.join(dest, "model.coreml"), { recursive: true });
  fs.writeFileSync(path.join(dest, "model.coreml", "weights.bin"), "installed");
  const zip = makeZip(path.join(dir, "m.zip"), SAFE);
  assert.throws(() => guard.extractZipSafely(zip, dest, { unzip: () => { throw Object.assign(new Error("unzip: not found"), { code: "ENOENT" }); } }), /not found/);
  assert.equal(fs.readFileSync(path.join(dest, "model.coreml", "weights.bin"), "utf8"), "installed");
  assert.deepEqual(fs.readdirSync(dest), ["model.coreml"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The download service: an unsafe archive is refused, removed and reported; nothing is unpacked.
function serviceWritingZip(entries) {
  const dir = tmp();
  const MODELS = path.join(dir, "models");
  fs.mkdirSync(MODELS);
  const svc = createDownloadService({
    DOWNLOAD_POLICY: {}, LLM_MODELS: path.join(dir, "llm"), MODELS, OPENVINO_MODELS: dir, OPENVINO_NPU_MODELS: [], ROOT: dir,
    SPEECH_MODELS: dir, TOOLS: dir, TTS_MODELS: dir, downloadBlockReason: () => "",
    downloader: { TRANSIENT: new Set(), downloadVerified: async (url, dest) => { makeZip(dest, entries); return { status: "unverified", message: "", sha256: "00", bytes: 1 }; } },
    fs, getOpenVinoNpuInfo: () => ({}), getPathSize: () => 0, integrity: {}, osPlatform: "darwin", path,
    spawn: () => {}, spawnSync: () => ({}), invalidateBackendOptions: () => {},
  });
  return { svc, dir, MODELS };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test("archive guard: the download service refuses and removes an unsafe archive", async () => {
  const { svc, dir, MODELS } = serviceWritingZip([{ name: "../../escape.bin", data: "x" }]);
  svc.fns.startModelDownload("https://huggingface.co/o/r/resolve/main/model.coreml.zip");
  await settle();
  const s = svc.getState();
  assert.equal(s.active, false);
  assert.equal(s.error, "model.coreml.zip can't be installed: it has an entry that points outside its folder.");
  assert.deepEqual(fs.readdirSync(MODELS), [], "the archive is removed and nothing was unpacked");
  assert.ok(!fs.existsSync(path.join(dir, "escape.bin")) && !fs.existsSync(path.join(path.dirname(dir), "escape.bin")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("archive guard: the download service installs a normal archive", { skip: !HAS_UNZIP && "unzip not installed" }, async () => {
  const { svc, dir, MODELS } = serviceWritingZip(SAFE);
  svc.fns.startModelDownload("https://huggingface.co/o/r/resolve/main/model.coreml.zip");
  await settle();
  assert.equal(svc.getState().error, null);
  assert.deepEqual(fs.readdirSync(MODELS), ["model.coreml"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("archive guard: no room to unpack, data beyond the declared size, and a timeout all leave the folder unchanged", () => {
  const dir = tmp();
  const dest = path.join(dir, "models");
  fs.mkdirSync(dest);
  const zip = makeZip(path.join(dir, "m.zip"), SAFE);
  assert.throws(() => guard.extractZipSafely(zip, dest, { statfs: () => ({ bavail: 1, bsize: 4 }) }), /enough free space/);
  const overflow = (_zip, staging) => { fs.mkdirSync(path.join(staging, "model.coreml")); fs.writeFileSync(path.join(staging, "model.coreml", "big.bin"), Buffer.alloc(4096)); };
  assert.throws(() => guard.extractZipSafely(zip, dest, { unzip: overflow }), /more data than it declared/);
  let timeout;
  const slow = (_zip, _staging, ms) => { timeout = ms; throw Object.assign(new Error("spawnSync unzip ETIMEDOUT"), { code: "ETIMEDOUT" }); };
  assert.throws(() => guard.extractZipSafely(zip, dest, { unzip: slow }), /ETIMEDOUT/);
  assert.equal(timeout, guard.LIMITS.unzipTimeoutMs);
  assert.deepEqual(fs.readdirSync(dest), [], "no staging folder left");
});

test("archive guard: installing several items is all or nothing", () => {
  const dir = tmp();
  const dest = path.join(dir, "models");
  fs.mkdirSync(path.join(dest, "a.coreml"), { recursive: true });
  fs.writeFileSync(path.join(dest, "a.coreml", "weights.bin"), "installed a");
  fs.mkdirSync(path.join(dest, "b.coreml"), { recursive: true });
  fs.writeFileSync(path.join(dest, "b.coreml", "weights.bin"), "installed b");
  const zip = makeZip(path.join(dir, "two.zip"), [{ name: "a.coreml/weights.bin", data: "new a" }, { name: "b.coreml/weights.bin", data: "new b" }]);
  const unzip = (_zip, staging) => {
    for (const n of ["a", "b"]) { fs.mkdirSync(path.join(staging, `${n}.coreml`)); fs.writeFileSync(path.join(staging, `${n}.coreml`, "weights.bin"), `new ${n}`); }
  };
  let moves = 0;
  // The fourth rename (putting the new b in place) fails, e.g. because the engine holds the folder.
  const rename = (from, to) => { moves += 1; if (moves === 4) throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" }); fs.renameSync(from, to); };
  assert.throws(() => guard.extractZipSafely(zip, dest, { unzip, rename }), /installed one was kept/);
  assert.equal(fs.readFileSync(path.join(dest, "a.coreml", "weights.bin"), "utf8"), "installed a", "the first item was rolled back");
  assert.equal(fs.readFileSync(path.join(dest, "b.coreml", "weights.bin"), "utf8"), "installed b");
  assert.deepEqual(fs.readdirSync(dest).sort(), ["a.coreml", "b.coreml"], "no backups or staging left");
});

test("archive guard: staging folders are new each time, and ones left by a killed unpack are removed later", () => {
  const dir = tmp();
  const dest = path.join(dir, "models");
  fs.mkdirSync(dest);
  const stale = path.join(dest, `${guard.STAGING_PREFIX}old`);
  const recent = path.join(dest, `${guard.STAGING_PREFIX}busy`);
  fs.mkdirSync(stale);
  fs.mkdirSync(recent);
  const old = Date.now() / 1000 - 7 * 3600;
  fs.utimesSync(stale, old, old);
  const seen = [];
  const unzip = (_zip, staging) => { seen.push(staging); fs.mkdirSync(path.join(staging, "model.coreml")); fs.writeFileSync(path.join(staging, "model.coreml", "w.bin"), "w"); };
  const zip = makeZip(path.join(dir, "m.zip"), [{ name: "model.coreml/w.bin", data: "w" }]);
  guard.extractZipSafely(zip, dest, { unzip });
  guard.extractZipSafely(zip, dest, { unzip });
  assert.notEqual(seen[0], seen[1]);
  for (const s of seen) assert.ok(path.basename(s).startsWith(guard.STAGING_PREFIX) && path.dirname(s) === dest);
  assert.ok(!fs.existsSync(stale), "a staging folder older than 6 hours is removed");
  assert.ok(fs.existsSync(recent), "a recent one may belong to a running unpack and is kept");
});

test("archive guard: unzip is run without a shell, with the file names as separate arguments", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server", "archive-guard.cjs"), "utf8");
  assert.match(src, /execFileSync\("unzip", \["-qq", "-o", zipPath, "-d", stagingDir\]/);
  assert.doesNotMatch(src, /\bexecSync\b|shell:\s*true/);
  const dl = fs.readFileSync(path.join(__dirname, "..", "server", "services", "downloads.cjs"), "utf8");
  assert.doesNotMatch(dl, /\bexecSync\b|shell:\s*true/);
});
