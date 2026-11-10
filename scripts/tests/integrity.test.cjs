// Step 9.4: download integrity regression tests. Deterministic and offline: temporary directories,
// synthetic binaries, and local HTTP servers on 127.0.0.1. Never touches real models or app data.
"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const REPO = path.resolve(__dirname, "..", "..");
const integrity = require(path.join(REPO, "scripts", "server", "integrity.cjs"));
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "usap-integrity-"));

// ── Manifest ────────────────────────────────────────────────────────────────
test("manifest: the shipped digest list parses, uses https, and pins every hard-coded engine and runtime URL", () => {
  const manifest = integrity.loadManifest();
  assert.ok(manifest.size >= 20, `only ${manifest.size} entries`);
  for (const e of manifest.values()) assert.match(e.url, /^https:\/\//);
  const sources = ["scripts/server/serve.cjs", "scripts/setup/setup.ps1"].map((f) => fs.readFileSync(path.join(REPO, f), "utf8")).join("\n");
  const literal = [...new Set(sources.match(/https:\/\/(?:github\.com\/[^"'`\s$]+\/releases\/download|nodejs\.org\/dist)\/[^"'`\s$]+/g) || [])];
  assert.ok(literal.length >= 4, "found the hard-coded download URLs");
  for (const url of literal) assert.ok(manifest.has(url), `not pinned: ${url}`);
});

test("manifest: malformed lines are rejected instead of silently ignored", () => {
  const good = `${"a".repeat(64)} 10 https://example.com/x`;
  assert.equal(integrity.parseManifest(`# c\n${good}\n`).size, 1);
  for (const bad of [
    `${"A".repeat(64)} 10 https://example.com/x`, // uppercase
    `${"a".repeat(63)} 10 https://example.com/x`,
    `${"a".repeat(64)} 0 https://example.com/x`,
    `${"a".repeat(64)} 10 http://example.com/x`, // not https
    `${"a".repeat(64)} 10 https://example.com/x maybe`,
    `${good}\n${good}`, // duplicate
  ]) assert.throws(() => integrity.parseManifest(bad), integrity.IntegrityError, bad);
});

// ── Verification decisions ──────────────────────────────────────────────────
const data = Buffer.from("model bytes for the integrity test");
const pinned = { sha256: sha(data), size: data.length, trust: "pinned" };

test("verify: a correct pinned digest is 'verified'", () => {
  const r = integrity.evaluateDownload({ sha256: sha(data), bytes: data.length, pinned });
  assert.equal(r.ok, true);
  assert.equal(r.status, "verified");
});

test("verify: a digest mismatch is rejected even when the size is right", () => {
  const evil = Buffer.from(data); evil[0] ^= 1;
  const r = integrity.evaluateDownload({ sha256: sha(evil), bytes: evil.length, pinned });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "digest");
});

test("verify: a truncated file is rejected by the pinned size and by Content-Length", () => {
  const short = data.subarray(0, 10);
  assert.equal(integrity.evaluateDownload({ sha256: sha(short), bytes: short.length, pinned }).reason, "size");
  assert.equal(integrity.evaluateDownload({ sha256: sha(short), bytes: short.length, expectedBytes: data.length }).reason, "truncated");
});

test("verify: a source-reported checksum is transfer integrity only, never 'verified'", () => {
  const ok = integrity.evaluateDownload({ sha256: sha(data), bytes: data.length, sourceSha256: sha(data) });
  assert.equal(ok.status, "source-checksum");
  assert.match(ok.message, /not authenticated/);
  const bad = integrity.evaluateDownload({ sha256: sha(data), bytes: data.length, sourceSha256: "0".repeat(64) });
  assert.equal(bad.ok, false);
  // A pinned digest wins over whatever the source claims.
  const evil = Buffer.from("replaced");
  assert.equal(integrity.evaluateDownload({ sha256: sha(evil), bytes: evil.length, pinned, sourceSha256: sha(evil) }).ok, false);
});

test("verify: without any expected digest the file is 'unverified', not authenticated", () => {
  const r = integrity.evaluateDownload({ sha256: sha(data), bytes: data.length });
  assert.equal(r.ok, true);
  assert.equal(r.status, "unverified");
});

test("verify: only well-formed SHA-256 source headers are trusted for transfer checks", () => {
  assert.equal(integrity.sourceReportedSha256({ "x-linked-etag": `"${"ab".repeat(32)}"` }), "ab".repeat(32));
  assert.equal(integrity.sourceReportedSha256({ "x-linked-etag": '"d41d8cd98f00b204e9800998ecf8427e"' }), null); // MD5-style etag
  assert.equal(integrity.sourceReportedSha256({}), null);
});

test("hash: streaming hash of a file equals the one-shot hash", async () => {
  const dir = tmp();
  const f = path.join(dir, "x.bin");
  const big = crypto.randomBytes(3 * 1024 * 1024 + 7);
  fs.writeFileSync(f, big);
  assert.deepEqual(await integrity.hashFile(f), { sha256: sha(big), bytes: big.length });
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Atomic activation and rollback ──────────────────────────────────────────
test("replace: a new file replaces the old one in a single rename; no window without a file", () => {
  const dir = tmp();
  const dest = path.join(dir, "model.gguf");
  fs.writeFileSync(dest, "old");
  fs.writeFileSync(`${dest}.part`, "new");
  const calls = [];
  integrity.atomicReplaceFile(`${dest}.part`, dest, { rename: (a, b) => { calls.push([a, b]); fs.renameSync(a, b); } });
  assert.equal(fs.readFileSync(dest, "utf8"), "new");
  assert.deepEqual(calls, [[`${dest}.part`, dest]]);
  assert.equal(fs.existsSync(`${dest}.part`), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("replace: when activation fails, the last-known-good file is restored", () => {
  const dir = tmp();
  const dest = path.join(dir, "engine.exe");
  fs.writeFileSync(dest, "last-known-good");
  fs.writeFileSync(`${dest}.part`, "new");
  let n = 0;
  const rename = (a, b) => {
    n++;
    if (n === 1) throw Object.assign(new Error("EPERM: file in use"), { code: "EPERM" }); // direct replace refused
    if (n === 3) throw Object.assign(new Error("EIO: device error"), { code: "EIO" }); // moving the new file in fails
    fs.renameSync(a, b);
  };
  assert.throws(() => integrity.atomicReplaceFile(`${dest}.part`, dest, { rename }), /previous version was kept/);
  assert.equal(fs.readFileSync(dest, "utf8"), "last-known-good");
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes(".previous-")), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("replace: an engine directory is swapped whole, and kept intact when the swap fails", () => {
  const dir = tmp();
  const dest = path.join(dir, "cpu");
  const staging = path.join(dir, "cpu.staging");
  fs.mkdirSync(dest); fs.writeFileSync(path.join(dest, "sd.exe"), "old"); fs.writeFileSync(path.join(dest, "keep.dll"), "old");
  fs.mkdirSync(staging); fs.writeFileSync(path.join(staging, "sd.exe"), "new");
  // Swap fails while moving the staged copy in: the old directory must come back unchanged.
  let n = 0;
  const failing = (a, b) => { if (++n === 2) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); fs.renameSync(a, b); };
  assert.throws(() => integrity.atomicReplaceDir(staging, dest, { rename: failing }), /previous version was kept/);
  assert.equal(fs.readFileSync(path.join(dest, "sd.exe"), "utf8"), "old");
  assert.equal(fs.existsSync(path.join(dest, "keep.dll")), true);
  // Engine running (directory locked): refused before anything changes.
  assert.throws(() => integrity.atomicReplaceDir(staging, dest, { rename: () => { throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); } }));
  assert.equal(fs.readFileSync(path.join(dest, "sd.exe"), "utf8"), "old");
  // Success: whole directory replaced, nothing stale left behind.
  integrity.atomicReplaceDir(staging, dest);
  assert.deepEqual(fs.readdirSync(dest), ["sd.exe"]);
  assert.equal(fs.readFileSync(path.join(dest, "sd.exe"), "utf8"), "new");
  assert.deepEqual(fs.readdirSync(dir), ["cpu"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Native binary architecture ──────────────────────────────────────────────
function elf(machine) { const b = Buffer.alloc(64); b.writeUInt32BE(0x7f454c46, 0); b[4] = 2; b[5] = 1; b.writeUInt16LE(machine, 18); return b; }
function macho(cpu) { const b = Buffer.alloc(32); b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(cpu, 4); return b; }
function fat(cpus) { const b = Buffer.alloc(8 + cpus.length * 20); b.writeUInt32BE(0xcafebabe, 0); b.writeUInt32BE(cpus.length, 4); cpus.forEach((c, i) => b.writeUInt32BE(c, 8 + i * 20)); return b; }
function pe(machine) { const b = Buffer.alloc(256); b[0] = 0x4d; b[1] = 0x5a; b.writeUInt32LE(0x80, 0x3c); b.writeUInt32BE(0x50450000, 0x80); b.writeUInt16LE(machine, 0x84); return b; }

test("binaries: ELF, Mach-O (thin and universal) and PE architectures are recognised per platform", () => {
  const dir = tmp();
  const write = (name, buf) => { const f = path.join(dir, name); fs.writeFileSync(f, buf); return f; };
  const cases = [
    [elf(0x3e), "linux", "x64", true], [elf(0xb7), "linux", "x64", false], [elf(0xb7), "linux", "arm64", true],
    [macho(0x0100000c), "darwin", "arm64", true], [macho(0x0100000c), "darwin", "x64", false], // no Rosetta assumption
    [fat([0x01000007, 0x0100000c]), "darwin", "x64", true], [fat([0x0100000c]), "darwin", "x64", false],
    [pe(0x8664), "win32", "x64", true], [pe(0x014c), "win32", "x64", false], [pe(0xaa64), "win32", "x64", false],
    [elf(0x3e), "win32", "x64", false], [pe(0x8664), "linux", "x64", false],
    [Buffer.from("#!/bin/sh\necho not a binary\n"), "linux", "x64", false],
    [Buffer.from("<html>Not Found</html>"), "win32", "x64", false],
  ];
  cases.forEach(([buf, platform, arch, ok], i) => {
    const f = write(`b${i}`, buf);
    if (ok) integrity.assertNativeBinary(f, { platform, arch });
    else assert.throws(() => integrity.assertNativeBinary(f, { platform, arch }), integrity.IntegrityError, `case ${i}`);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("binaries: the Node.js running this test is recognised as native", () => {
  const info = integrity.assertNativeBinary(process.execPath);
  assert.ok(info.arches.includes(process.arch));
});
