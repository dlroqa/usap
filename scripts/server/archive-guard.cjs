// archive-guard.cjs — installing downloaded model archives (Core ML .zip) safely (Step 9.8f).
//
// 1. The archive's central directory is read here, before anything is unpacked. Every entry must be a
//    plain relative path (no absolute or drive paths, no "..", ":", backslashes or control characters),
//    a regular file or a folder (no links or devices), with no duplicate or conflicting names (case-
//    insensitively, as on macOS and Windows). Entry count, entry size, total size and the expansion
//    ratio are limited, and the destination must have room for the unpacked size.
// 2. unzip (an argument list, never a shell) unpacks into a new, uniquely named hidden staging folder
//    next to the destination ("._" names are hidden from the model lists), with a time limit. The
//    unpacked tree is checked again: only regular files and folders, and no more data than declared.
// 3. The top-level items are moved into place as one transaction: an item with the same name is moved
//    aside first and restored if any step fails, so the installed models stay as they were. This keeps
//    the existing behaviour of replacing a model with the same name (see issue #58).
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

class ArchiveError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArchiveError";
  }
}

const GB = 1024 ** 3;
const LIMITS = Object.freeze({
  maxEntries: 20000,
  maxEntryBytes: 32 * GB,
  maxTotalBytes: 64 * GB, // a Core ML model is a few GB
  maxDirectoryBytes: 64 * 1024 * 1024,
  maxRatio: 200, // unpacked:packed, for entries over ratioMinBytes (model weights barely compress)
  ratioMinBytes: 16 * 1024 * 1024,
  unzipTimeoutMs: 60 * 60 * 1000,
  staleStagingMs: 6 * 60 * 60 * 1000,
});
const STAGING_PREFIX = "._usap-unpack-";
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

// The central directory is the archive's own list of entries; unzip extracts from the same list.
function readEntries(zipPath, limits) {
  const fd = fs.openSync(zipPath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const tailLength = Math.min(size, 22 + 65535 + 20);
    const tail = Buffer.alloc(tailLength);
    fs.readSync(fd, tail, 0, tailLength, size - tailLength);
    let eocd = -1;
    for (let i = tailLength - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new ArchiveError("it isn't a zip archive.");
    let count = tail.readUInt16LE(eocd + 10);
    let directorySize = tail.readUInt32LE(eocd + 12);
    let directoryOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      const locator = eocd - 20;
      if (locator < 0 || tail.readUInt32LE(locator) !== 0x07064b50) throw new ArchiveError("its zip64 directory is missing.");
      const record = Buffer.alloc(56);
      fs.readSync(fd, record, 0, 56, Number(tail.readBigUInt64LE(locator + 8)));
      if (record.readUInt32LE(0) !== 0x06064b50) throw new ArchiveError("its zip64 directory is damaged.");
      count = Number(record.readBigUInt64LE(32));
      directorySize = Number(record.readBigUInt64LE(40));
      directoryOffset = Number(record.readBigUInt64LE(48));
    }
    if (count > limits.maxEntries) throw new ArchiveError(`it has more than ${limits.maxEntries} entries.`);
    if (directorySize > limits.maxDirectoryBytes || directoryOffset + directorySize > size) {
      throw new ArchiveError("its directory is damaged.");
    }
    const directory = Buffer.alloc(directorySize);
    fs.readSync(fd, directory, 0, directorySize, directoryOffset);

    const entries = [];
    let at = 0;
    for (let i = 0; i < count; i += 1) {
      if (at + 46 > directory.length || directory.readUInt32LE(at) !== 0x02014b50) throw new ArchiveError("its directory is damaged.");
      const flags = directory.readUInt16LE(at + 8);
      let compressed = directory.readUInt32LE(at + 20);
      let uncompressed = directory.readUInt32LE(at + 24);
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      const external = directory.readUInt32LE(at + 38);
      const end = at + 46 + nameLength + extraLength + commentLength;
      if (end > directory.length) throw new ArchiveError("its directory is damaged.");
      const nameBytes = directory.subarray(at + 46, at + 46 + nameLength);
      const name = nameBytes.toString(flags & 0x800 ? "utf8" : "latin1");
      if (uncompressed === 0xffffffff || compressed === 0xffffffff) {
        // zip64 extra field: the 64-bit sizes present, uncompressed first
        const extra = directory.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
        for (let e = 0; e + 4 <= extra.length;) {
          const id = extra.readUInt16LE(e);
          const length = extra.readUInt16LE(e + 2);
          if (id === 0x0001) {
            let p = e + 4;
            if (uncompressed === 0xffffffff && p + 8 <= e + 4 + length) { uncompressed = Number(extra.readBigUInt64LE(p)); p += 8; }
            if (compressed === 0xffffffff && p + 8 <= e + 4 + length) compressed = Number(extra.readBigUInt64LE(p));
            break;
          }
          e += 4 + length;
        }
        if (uncompressed === 0xffffffff || compressed === 0xffffffff) throw new ArchiveError("its directory is damaged.");
      }
      entries.push({ name, size: uncompressed, compressedSize: compressed, mode: external >>> 16, nameBytes });
      at = end;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

// Why an entry is unsafe, or "" when it is a plain relative file or folder.
function entryIssue(entry, limits) {
  const { name, mode, nameBytes, size, compressedSize } = entry;
  if (!name || name === "/" || name.split("/").every((part) => part === "" || part === ".")) return "it has an entry with no name.";
  if (nameBytes.some((b) => b < 0x20 || b === 0x7f)) return "it has an entry with control characters in its name.";
  if (name.includes("\\")) return "it has an entry with a backslash in its name.";
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return "it has an entry with an absolute path.";
  if (name.includes(":")) return "it has an entry with a colon in its name.";
  if (name.split("/").some((part) => part === "..")) return "it has an entry that points outside its folder.";
  const type = mode & S_IFMT;
  // Archives made on Windows store no type (0); unzip then writes plain files and folders.
  if (type !== 0 && type !== S_IFREG && type !== S_IFDIR) return "it has a link or special file.";
  if (size > limits.maxEntryBytes) return "it has a file larger than the size limit.";
  if (size > limits.ratioMinBytes && size > compressedSize * limits.maxRatio) return "it expands far more than a model file can.";
  return "";
}

// The path an entry unpacks to, compared the way case-insensitive file systems do.
const entryKey = (name) => name.split("/").filter((part) => part && part !== ".").join("/").normalize("NFC").toLowerCase();

function inspectZip(zipPath, limits = LIMITS) {
  const entries = readEntries(zipPath, limits);
  if (entries.length === 0) throw new ArchiveError("it is empty.");
  let total = 0;
  const files = new Set();
  const dirs = new Set();
  for (const entry of entries) {
    const issue = entryIssue(entry, limits);
    if (issue) throw new ArchiveError(issue);
    total += entry.size;
    if (total > limits.maxTotalBytes) throw new ArchiveError("it unpacks to more than the size limit.");
    const key = entryKey(entry.name);
    const isDir = entry.name.endsWith("/") || (entry.mode & S_IFMT) === S_IFDIR;
    if (isDir) {
      if (files.has(key)) throw new ArchiveError("it has a file and a folder with the same name.");
      dirs.add(key);
    } else {
      if (files.has(key)) throw new ArchiveError("it has two entries with the same name.");
      if (dirs.has(key)) throw new ArchiveError("it has a file and a folder with the same name.");
      files.add(key);
    }
  }
  // A file can't also be a parent folder ("a" and "a/b").
  for (const key of files) {
    const parts = key.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      if (files.has(parts.slice(0, i).join("/"))) throw new ArchiveError("it has a file and a folder with the same name.");
    }
  }
  return { entries, totalBytes: total };
}

// After unpacking: only regular files and folders, and no more data than the archive declared.
function assertPlainTree(dir, maxBytes) {
  let total = 0;
  const walk = (current) => {
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      const stats = fs.lstatSync(full);
      if (stats.isDirectory()) walk(full);
      else if (stats.isFile()) {
        total += stats.size;
        if (total > maxBytes) throw new ArchiveError("it unpacked to more data than it declared.");
      } else {
        throw new ArchiveError("it has a link or special file.");
      }
    }
  };
  walk(dir);
  return total;
}

function runUnzip(zipPath, stagingDir, timeoutMs) {
  // An argument list: no shell ever sees the file name (S-8). unzip's default also refuses "../" paths.
  execFileSync("unzip", ["-qq", "-o", zipPath, "-d", stagingDir], { stdio: "ignore", timeout: timeoutMs, killSignal: "SIGKILL" });
}

// Staging folders left by an unpack that was killed part-way (power cut, crash).
function removeStaleStaging(destDir, limits, now) {
  let names = [];
  try { names = fs.readdirSync(destDir); } catch (_) { return; }
  for (const name of names) {
    if (!name.startsWith(STAGING_PREFIX)) continue;
    const full = path.join(destDir, name);
    try {
      const stats = fs.lstatSync(full);
      if (stats.isDirectory() && now - stats.mtimeMs > limits.staleStagingMs) fs.rmSync(full, { recursive: true, force: true });
    } catch (_) { /* best effort */ }
  }
}

// Move every staged item into place, or none: on failure, new items are removed and previous ones restored.
function activate(stagingDir, destDir, items, rename) {
  const stamp = `${process.pid}-${Date.now()}`;
  const done = [];
  try {
    for (const name of items) {
      const to = path.join(destDir, name);
      let backup = null;
      if (fs.existsSync(to) || isLink(to)) {
        backup = path.join(destDir, `${STAGING_PREFIX}previous-${stamp}-${name}`);
        rename(to, backup);
      }
      done.push({ to, backup, placed: false });
      rename(path.join(stagingDir, name), to);
      done[done.length - 1].placed = true;
    }
  } catch (err) {
    for (const step of done.reverse()) {
      try { if (step.placed) fs.rmSync(step.to, { recursive: true, force: true }); } catch (_) { /* keep going */ }
      try { if (step.backup) fs.renameSync(step.backup, step.to); } catch (_) { /* the backup stays on disk */ }
    }
    throw new Error(`The new model couldn't be put in place; the installed one was kept (${err.message}).`);
  }
  for (const step of done) {
    if (step.backup) { try { fs.rmSync(step.backup, { recursive: true, force: true }); } catch (_) { /* best effort */ } }
  }
}
function isLink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; } }

/**
 * Unpacks a model archive into destDir. Throws ArchiveError when the archive is unsafe (nothing is
 * changed); other errors (no unzip on this system, a full disk, a timeout) also leave destDir as it was.
 * @returns {string[]} the top-level names that were installed
 */
function extractZipSafely(zipPath, destDir, opts = {}) {
  const limits = opts.limits || LIMITS;
  const unzip = opts.unzip || runUnzip;
  const rename = opts.rename || fs.renameSync;
  const statfs = opts.statfs || ((dir) => (typeof fs.statfsSync === "function" ? fs.statfsSync(dir) : null));
  const { totalBytes } = inspectZip(zipPath, limits);
  const space = statfs(destDir);
  if (space && Number(space.bavail) * Number(space.bsize) < totalBytes) {
    throw new ArchiveError("there isn't enough free space to unpack it.");
  }
  removeStaleStaging(destDir, limits, opts.now || Date.now());
  const stagingDir = fs.mkdtempSync(path.join(destDir, STAGING_PREFIX)); // new and unique, never reused
  try {
    unzip(zipPath, stagingDir, limits.unzipTimeoutMs);
    assertPlainTree(stagingDir, totalBytes);
    const items = fs.readdirSync(stagingDir);
    if (items.length === 0) throw new ArchiveError("it is empty.");
    activate(stagingDir, destDir, items, rename);
    return items;
  } finally {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
}

module.exports = { ArchiveError, LIMITS, STAGING_PREFIX, inspectZip, assertPlainTree, extractZipSafely };
