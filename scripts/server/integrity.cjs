// Download integrity (Step 9.4).
//
// Two different guarantees, kept apart on purpose:
//   * transfer integrity: the bytes on disk are the bytes the source sent (size + SHA-256 match what the
//     source itself reports). This catches truncation and corruption, but a checksum served by the same
//     host as the file proves nothing about who published it.
//   * pinned digest: the SHA-256 matches a value recorded in this repository at review time
//     (scripts/config/download-digests.txt). A file that was swapped after review, or by anyone between
//     the publisher and this machine, is refused. Where the publisher signs its checksums (Node.js), the
//     signature was checked when the digest was pinned; see docs/security/DOWNLOAD_INTEGRITY.md.
//
// Files are streamed to a temporary path, hashed while they arrive, and only moved into place after
// every check passes. Replacing an existing file or engine directory never deletes the old copy first.
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MANIFEST_PATH = path.join(__dirname, "..", "config", "download-digests.txt");
const HEX64 = /^[0-9a-f]{64}$/;

class IntegrityError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = "IntegrityError";
    this.code = "USAP_INTEGRITY";
    this.reason = reason; // "digest" | "size" | "truncated" | "manifest" | "arch" | "replace"
  }
}

// ── Manifest ────────────────────────────────────────────────────────────────
// One entry per line: "<sha256> <size-in-bytes> <url> [trust]". '#' starts a comment.
// trust: "signed" (publisher-signed checksum list, signature checked at pin time) or "pinned"
// (digest recorded at review time; the default).
function parseManifest(text) {
  const entries = new Map();
  String(text || "").split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) return;
    const [sha256, size, url, trust = "pinned", ...extra] = line.split(/\s+/);
    const where = `download-digests.txt line ${i + 1}`;
    if (extra.length) throw new IntegrityError(`${where}: too many fields`, "manifest");
    if (!HEX64.test(sha256 || "")) throw new IntegrityError(`${where}: not a lowercase SHA-256`, "manifest");
    if (!/^[1-9]\d*$/.test(size || "")) throw new IntegrityError(`${where}: size must be a positive integer`, "manifest");
    if (!/^https:\/\//.test(url || "")) throw new IntegrityError(`${where}: URL must be https`, "manifest");
    if (!["pinned", "signed"].includes(trust)) throw new IntegrityError(`${where}: unknown trust "${trust}"`, "manifest");
    if (entries.has(url)) throw new IntegrityError(`${where}: duplicate URL`, "manifest");
    entries.set(url, { sha256, size: Number(size), url, trust });
  });
  return entries;
}

let manifestCache = null;
function loadManifest(file = MANIFEST_PATH) {
  if (file === MANIFEST_PATH && manifestCache) return manifestCache;
  const entries = parseManifest(fs.readFileSync(file, "utf8"));
  if (file === MANIFEST_PATH) manifestCache = entries;
  return entries;
}

/** The pinned entry for exactly this URL, or null. The URL the user asked for, before redirects. */
function pinnedFor(url, manifest) {
  try { return (manifest || loadManifest()).get(String(url)) || null; } catch (err) {
    // A broken manifest must not silently downgrade every download to "unverified".
    throw err instanceof IntegrityError ? err : new IntegrityError(`Could not read the download digest list: ${err.message}`, "manifest");
  }
}

// ── Hashing ─────────────────────────────────────────────────────────────────
function createHasher() {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  return {
    update(chunk) { hash.update(chunk); bytes += chunk.length; },
    get bytes() { return bytes; },
    digest() { return hash.digest("hex"); },
  };
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = createHasher();
    fs.createReadStream(file).on("data", (c) => h.update(c)).on("error", reject).on("end", () => resolve({ sha256: h.digest(), bytes: h.bytes }));
  });
}

/**
 * SHA-256 the source itself reports for a response (Hugging Face sends the LFS object id as
 * X-Linked-Etag on resolve URLs). Transfer integrity only: it comes from the same source as the file.
 */
function sourceReportedSha256(headers = {}) {
  for (const name of ["x-linked-etag", "x-amz-meta-sha256", "x-goog-meta-sha256"]) {
    const v = String(headers[name] || "").replace(/^W\//, "").replace(/"/g, "").trim().toLowerCase();
    if (HEX64.test(v)) return v;
  }
  return null;
}

/**
 * Decide whether a finished transfer may be activated.
 * Returns { ok, status, message } where status is:
 *   "verified"        matches a pinned (or publisher-signed) digest from this repository
 *   "source-checksum" matches the checksum the download source reported (transfer integrity only)
 *   "unverified"      no expected digest available; only the local checksum is known
 */
function evaluateDownload({ sha256, bytes, pinned = null, sourceSha256 = null, expectedBytes = 0, label = "the file" }) {
  if (pinned) {
    if (bytes !== pinned.size) {
      return { ok: false, reason: "size", status: "rejected", message: `${label} is ${bytes} bytes, but the pinned size is ${pinned.size}. The download was discarded.` };
    }
    if (sha256 !== pinned.sha256) {
      return { ok: false, reason: "digest", status: "rejected", message: `${label} does not match its pinned SHA-256 digest. The download was discarded; it may have been corrupted or replaced.` };
    }
    return { ok: true, status: "verified", trust: pinned.trust, message: `SHA-256 matches the ${pinned.trust === "signed" ? "publisher-signed" : "pinned"} digest.` };
  }
  if (expectedBytes > 0 && bytes !== expectedBytes) {
    return { ok: false, reason: "truncated", status: "rejected", message: `${label} is incomplete: received ${bytes} of ${expectedBytes} bytes.` };
  }
  if (sourceSha256) {
    if (sha256 !== sourceSha256) {
      return { ok: false, reason: "digest", status: "rejected", message: `${label} does not match the checksum reported by the download source. The download was discarded.` };
    }
    return { ok: true, status: "source-checksum", message: "SHA-256 matches the checksum reported by the download source (transfer integrity; publisher not authenticated)." };
  }
  return { ok: true, status: "unverified", message: "No trusted digest is known for this file; its SHA-256 was recorded but the publisher is not authenticated." };
}

// ── Atomic activation ───────────────────────────────────────────────────────
// rename() over an existing file is atomic on POSIX and uses MoveFileEx(REPLACE_EXISTING) on Windows,
// so the old file is never deleted first. If the direct rename is refused (some Windows/FAT cases), the
// old file is moved aside, the new one moved in, and the old one restored if that fails.
function atomicReplaceFile(tempPath, destPath, { rename = fs.renameSync } = {}) {
  try {
    rename(tempPath, destPath);
    return;
  } catch (err) {
    if (!fs.existsSync(destPath) || !["EPERM", "EEXIST", "EACCES", "EBUSY"].includes(err && err.code)) throw err;
  }
  const backup = `${destPath}.previous-${process.pid}-${Date.now()}`;
  rename(destPath, backup);
  try {
    rename(tempPath, destPath);
  } catch (err) {
    try { rename(backup, destPath); } catch (_) { /* keep the backup on disk; report the original error */ }
    throw new IntegrityError(`Could not activate the new file; the previous version was kept (${err.message}).`, "replace");
  }
  try { fs.rmSync(backup, { force: true }); } catch (_) {}
}

/** Swap a fully prepared staging directory into place, keeping the previous directory on failure. */
function atomicReplaceDir(stagingDir, destDir, { rename = fs.renameSync } = {}) {
  const hadPrevious = fs.existsSync(destDir);
  const backup = `${destDir}.previous-${process.pid}-${Date.now()}`;
  if (hadPrevious) rename(destDir, backup); // fails (e.g. EBUSY: engine running) before anything changes
  try {
    rename(stagingDir, destDir);
  } catch (err) {
    if (hadPrevious) { try { rename(backup, destDir); } catch (_) {} }
    throw new IntegrityError(`Could not activate the new files; the previous version was kept (${err.message}).`, "replace");
  }
  if (hadPrevious) { try { fs.rmSync(backup, { recursive: true, force: true }); } catch (_) {} }
}

// ── Native binary architecture ──────────────────────────────────────────────
const ELF_MACHINES = { 0x03: "x86", 0x3e: "x64", 0xb7: "arm64", 0x28: "arm" };
const MACHO_CPUS = { 0x01000007: "x64", 0x0100000c: "arm64", 0x00000007: "x86", 0x0000000c: "arm" };
const PE_MACHINES = { 0x8664: "x64", 0xaa64: "arm64", 0x014c: "x86", 0x01c4: "arm" };

/** Identify the executable format and CPU architectures of a file (reads the first 4 KiB). */
function inspectBinary(file) {
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(4096);
  let n;
  try { n = fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
  const b = buf.subarray(0, n);
  if (n >= 20 && b.readUInt32BE(0) === 0x7f454c46) {
    const le = b[5] === 1;
    const m = le ? b.readUInt16LE(18) : b.readUInt16BE(18);
    return { format: "elf", arches: [ELF_MACHINES[m] || `elf-machine-0x${m.toString(16)}`] };
  }
  if (n >= 8 && b.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = b.readUInt32LE(4);
    return { format: "macho", arches: [MACHO_CPUS[cpu] || `macho-cpu-0x${cpu.toString(16)}`] };
  }
  if (n >= 8 && b.readUInt32BE(0) === 0xcafebabe) {
    const count = b.readUInt32BE(4);
    if (count > 0 && count < 16 && n >= 8 + count * 20) { // Java class files share this magic with a large "count"
      const arches = [];
      for (let i = 0; i < count; i++) { const cpu = b.readUInt32BE(8 + i * 20); arches.push(MACHO_CPUS[cpu] || `macho-cpu-0x${cpu.toString(16)}`); }
      return { format: "macho-universal", arches };
    }
  }
  if (n >= 64 && b[0] === 0x4d && b[1] === 0x5a) {
    const off = b.readUInt32LE(0x3c);
    if (off + 6 <= n && b.readUInt32BE(off) === 0x50450000) {
      const m = b.readUInt16LE(off + 4);
      return { format: "pe", arches: [PE_MACHINES[m] || `pe-machine-0x${m.toString(16)}`] };
    }
  }
  return { format: "unknown", arches: [] };
}

const EXPECTED_FORMAT = { linux: ["elf"], darwin: ["macho", "macho-universal"], win32: ["pe"] };

/**
 * Throws IntegrityError unless the binary is built for platform and one of the accepted CPU
 * architectures (default: exactly `arch`, i.e. no emulation such as Rosetta).
 */
function assertNativeBinary(file, { platform = process.platform, arch = process.arch, accept = [arch] } = {}) {
  const info = inspectBinary(file);
  const formats = EXPECTED_FORMAT[platform] || [];
  if (!formats.includes(info.format)) {
    throw new IntegrityError(`${path.basename(file)} is not a ${platform} executable (found ${info.format}).`, "arch");
  }
  if (!info.arches.some((a) => accept.includes(a))) {
    throw new IntegrityError(`${path.basename(file)} is built for ${info.arches.join("+") || "an unknown CPU"}, not ${accept.join(" or ")}.`, "arch");
  }
  return info;
}

module.exports = {
  MANIFEST_PATH,
  IntegrityError,
  parseManifest,
  loadManifest,
  pinnedFor,
  createHasher,
  hashFile,
  sourceReportedSha256,
  evaluateDownload,
  atomicReplaceFile,
  atomicReplaceDir,
  inspectBinary,
  assertNativeBinary,
};
