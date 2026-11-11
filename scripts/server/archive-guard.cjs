// archive-guard.cjs — installing downloaded model archives (Core ML .zip) safely (Step 9.8f).
//
// 1. The archive's central directory is read here, before anything is unpacked. Every entry must be a
//    plain relative path (no absolute or drive paths, no "..", no backslashes or control characters),
//    a regular file or a folder (no links or devices), and the archive must stay within the entry and
//    size limits.
// 2. unzip unpacks into a hidden staging folder next to the destination ("._" names are hidden from the
//    model lists). The unpacked tree is checked again: only regular files and folders.
// 3. Each top-level item is moved into place in one step (integrity.cjs), replacing an item with the same
//    name, as re-downloading a model did before. If anything fails, the installed models stay as they were.
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const integrity = require("./integrity.cjs");

class ArchiveError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArchiveError";
  }
}

const LIMITS = Object.freeze({
  maxEntries: 20000,
  maxTotalBytes: 64 * 1024 ** 3, // a Core ML model is a few GB
  maxDirectoryBytes: 64 * 1024 * 1024,
});
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

// The central directory is the archive's own list of entries; unzip extracts from the same list.
function readEntries(zipPath, limits = LIMITS) {
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
    let total = 0;
    let at = 0;
    for (let i = 0; i < count; i += 1) {
      if (at + 46 > directory.length || directory.readUInt32LE(at) !== 0x02014b50) throw new ArchiveError("its directory is damaged.");
      const flags = directory.readUInt16LE(at + 8);
      let uncompressed = directory.readUInt32LE(at + 24);
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      const external = directory.readUInt32LE(at + 38);
      const end = at + 46 + nameLength + extraLength + commentLength;
      if (end > directory.length) throw new ArchiveError("its directory is damaged.");
      const nameBytes = directory.subarray(at + 46, at + 46 + nameLength);
      const name = nameBytes.toString(flags & 0x800 ? "utf8" : "latin1");
      if (uncompressed === 0xffffffff) {
        // zip64 extra field: the 64-bit uncompressed size comes first
        const extra = directory.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
        for (let e = 0; e + 4 <= extra.length;) {
          const id = extra.readUInt16LE(e);
          const length = extra.readUInt16LE(e + 2);
          if (id === 0x0001 && length >= 8 && e + 12 <= extra.length) { uncompressed = Number(extra.readBigUInt64LE(e + 4)); break; }
          e += 4 + length;
        }
      }
      entries.push({ name, size: uncompressed, mode: external >>> 16, nameBytes });
      total += uncompressed;
      if (total > limits.maxTotalBytes) throw new ArchiveError("it unpacks to more than the size limit.");
      at = end;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

// Why an entry is unsafe, or "" when it is a plain relative file or folder.
function entryIssue(entry) {
  const { name, mode, nameBytes } = entry;
  if (!name || name === "/") return "it has an entry with no name.";
  if (nameBytes.some((b) => b < 0x20 || b === 0x7f)) return "it has an entry with control characters in its name.";
  if (name.includes("\\")) return "it has an entry with a backslash in its name.";
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return "it has an entry with an absolute path.";
  if (name.split("/").some((part) => part === "..")) return "it has an entry that points outside its folder.";
  const type = mode & S_IFMT;
  // Archives made on Windows store no type (0); unzip then writes plain files and folders.
  if (type !== 0 && type !== S_IFREG && type !== S_IFDIR) return "it has a link or special file.";
  return "";
}

function inspectZip(zipPath, limits = LIMITS) {
  const entries = readEntries(zipPath, limits);
  if (entries.length === 0) throw new ArchiveError("it is empty.");
  for (const entry of entries) {
    const issue = entryIssue(entry);
    if (issue) throw new ArchiveError(issue);
  }
  return entries;
}

// After unpacking: only regular files and folders, and no more data than the limit.
function assertPlainTree(dir, limits = LIMITS) {
  let total = 0;
  const walk = (current) => {
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      const stats = fs.lstatSync(full);
      if (stats.isDirectory()) walk(full);
      else if (stats.isFile()) {
        total += stats.size;
        if (total > limits.maxTotalBytes) throw new ArchiveError("it unpacks to more than the size limit.");
      } else {
        throw new ArchiveError("it has a link or special file.");
      }
    }
  };
  walk(dir);
}

function runUnzip(zipPath, stagingDir) {
  // An argument list: the path is never interpreted by a shell (S-8). unzip's default refuses "../" paths too.
  execFileSync("unzip", ["-qq", "-o", zipPath, "-d", stagingDir], { stdio: "ignore" });
}

/**
 * Unpacks a model archive into destDir. Throws ArchiveError when the archive is unsafe (nothing is
 * changed); other errors (no unzip on this system, a full disk) also leave destDir as it was.
 * @returns {string[]} the top-level names that were installed
 */
function extractZipSafely(zipPath, destDir, { unzip = runUnzip, limits = LIMITS } = {}) {
  inspectZip(zipPath, limits);
  const stagingDir = path.join(destDir, `._usap-unpack-${process.pid}-${Date.now()}`);
  fs.mkdirSync(stagingDir, { recursive: true });
  try {
    unzip(zipPath, stagingDir);
    assertPlainTree(stagingDir, limits);
    const items = fs.readdirSync(stagingDir);
    if (items.length === 0) throw new ArchiveError("it is empty.");
    for (const name of items) {
      const from = path.join(stagingDir, name);
      const to = path.join(destDir, name);
      if (fs.lstatSync(from).isDirectory()) integrity.atomicReplaceDir(from, to);
      else integrity.atomicReplaceFile(from, to);
    }
    return items;
  } finally {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
}

module.exports = { ArchiveError, LIMITS, inspectZip, assertPlainTree, extractZipSafely };
