"use strict";
// Startup stale-file report, R1 (services/stale-file-report.cjs): counts only, never deletes. Unit tests against real
// temporary data folders (every file's content, size and mtime compared before and after), the negative controls of
// the private design that apply to a report-only stage, and the real server (off by default; report; rollback).
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { staleFileReportSetting, createStaleFileReport, MAX_ENTRIES } = require("../server/services/stale-file-report.cjs");
const { makeRoot, startServer, stopServerAndWait, removeTestRoot, request } = require("./api-contract/harness.cjs");

const IS_WIN = process.platform === "win32";
const HOUR = 3600e3;
const MODULE = path.join(__dirname, "..", "server", "services", "stale-file-report.cjs");

function tempData() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "usap-stale-"));
  const data = path.join(base, "app");
  fs.mkdirSync(path.join(data, "transcriptions"), { recursive: true });
  return { base, data, tx: path.join(data, "transcriptions"), up: path.join(data, "cache", "speech-uploads"), rm: () => fs.rmSync(base, { recursive: true, force: true }) };
}
function put(file, body = "x", ageMs = 0) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  if (ageMs) { const t = (Date.now() - ageMs) / 1000; fs.utimesSync(file, t, t); }
}
// Every entry under dir: relative path -> { kind, size, mtimeMs, sha256 } (links recorded, never followed).
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name); const st = fs.lstatSync(p); const rel = path.relative(dir, p);
      if (st.isSymbolicLink()) out[rel] = { kind: "link", target: fs.readlinkSync(p) };
      else if (st.isDirectory()) { out[rel] = { kind: "dir" }; walk(p); }
      else out[rel] = { kind: "file", size: st.size, mtimeMs: st.mtimeMs, sha256: crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") };
    }
  };
  walk(dir);
  return out;
}
const report = (d, opts = {}) => createStaleFileReport({ setting: { mode: "report" }, dataRoot: d.data, transcriptions: d.tx, ...opts });
const STAMP = "2026-11-20T15-35-46-120Z";

test("setting: off by default; report from the environment or scheduler.json; invalid values ignored; USAP_SCHEDULER=off turns it off", () => {
  assert.equal(staleFileReportSetting({ env: {} }).mode, "off");
  assert.equal(staleFileReportSetting({ env: { USAP_STALE_FILE_REPORT: "report" } }).mode, "report");
  const bad = staleFileReportSetting({ env: { USAP_STALE_FILE_REPORT: "on" } });
  assert.equal(bad.mode, "off", "'on' (deletion) is not a value of R1"); assert.equal(bad.ignored.length, 1);
  assert.equal(staleFileReportSetting({ env: { USAP_STALE_FILE_REPORT: "delete" } }).mode, "off");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "usap-stale-cfg-"));
  try {
    fs.writeFileSync(path.join(d, "scheduler.json"), JSON.stringify({ staleFileReport: "report" }));
    assert.equal(staleFileReportSetting({ env: {}, configDir: d }).mode, "report");
    assert.equal(staleFileReportSetting({ env: { USAP_STALE_FILE_REPORT: "off" }, configDir: d }).mode, "off", "the environment wins");
    const rb = staleFileReportSetting({ env: {}, configDir: d, schedulerMode: "off" });
    assert.equal(rb.mode, "off"); assert.equal(rb.forcedOffBy, "scheduler-off");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("C14: the module contains no function that deletes, moves, writes or creates files", () => {
  const src = fs.readFileSync(MODULE, "utf8").replace(/\/\/.*$/gm, "");
  const banned = /\b(unlink|rm|rmdir|rename|writeFile|appendFile|mkdir|mkdtemp|copyFile|cp|truncate|ftruncate|symlink|link|chmod|chown|utimes|lutimes|open|createWriteStream)(Sync)?\s*\(/g;
  const found = src.match(banned) || [];
  assert.deepEqual(found, [], `stale-file-report.cjs must not call ${found.join(", ")}`);
  assert.ok(/opendir\(/.test(src) && /lstatSync\(/.test(src), "it reads with opendir and lstat (the check sees calls)");
});

test("C10/C11/C12/C14: legacy temporaries of any age and old-format queue uploads are counted; transcripts, documents, models and near-miss names are not; nothing changes", async () => {
  const d = tempData();
  try {
    put(path.join(d.tx, `.speech-${STAMP}-jfk.wav`), "w", 1000);                    // 1 s old
    put(path.join(d.tx, `.speech-${STAMP}-jfk-out.txt`), "t", 25 * HOUR);           // 25 h
    put(path.join(d.tx, `.speech-${STAMP}-meeting.notes-out.json`), "j", 365 * 24 * HOUR); // 1 year
    // genuine user data and near misses (C10, C11)
    put(path.join(d.tx, "transcript-2026-11-20T15-35-46-120Z-jfk.wav.json"), "{}", 400 * 24 * HOUR);
    put(path.join(d.tx, "transcript-2026-11-20T15-35-46-120Z-jfk.txt"), "hello", 400 * 24 * HOUR);
    put(path.join(d.tx, `speech-${STAMP}-jfk.wav`), "no leading dot");
    put(path.join(d.tx, ".speech-2026-11-20-jfk.wav"), "malformed stamp");
    put(path.join(d.tx, `.speech-${STAMP}-jfk-out.md`), "other extension");
    put(path.join(d.tx, `.speech-${STAMP}-jfk.wav.bak`), "suffix");
    put(path.join(d.data, "documents", "report.pdf"), "pdf");
    put(path.join(d.data, "models", `.speech-${STAMP}-model.wav`), "legacy name outside transcriptions");
    put(path.join(d.data, "models", "sd.gguf"), "model");
    put(path.join(d.up, "0123456789abcdef-7-fedcba9876543210.wav"), "q", 2 * HOUR);
    put(path.join(d.up, "0123456789abcdef-7-fedcba9876543210.out.txt"), "q");
    put(path.join(d.up, "0123456789abcdef0123456789abcdef-1-x.wav"), "new or foreign format");
    const before = snapshot(d.base);
    const r = await report(d).run();
    assert.deepEqual(snapshot(d.base), before, "report-only: every entry unchanged (content, size, mtime)");
    const l = r.legacyTranscriptionTemporaries, q = r.oldFormatQueueUploads;
    assert.equal(r.removed, 0);
    assert.equal(l.state, "scanned"); assert.equal(l.matched, 3); assert.equal(l.matchedBytes, 3);
    assert.deepEqual(l.age, { under1h: 1, under24h: 0, under7d: 1, older: 1 });
    assert.equal(q.matched, 2);
    assert.match(r.ownership, /not determined/);
    const text = JSON.stringify(r);
    for (const leak of ["jfk", "meeting", "report.pdf", d.base, "0123456789abcdef"]) assert.ok(!text.includes(leak), `the report names no file or path (${leak})`);
  } finally { d.rm(); }
});

test("an absent folder is reported as absent and is NOT created", async () => {
  const d = tempData();
  try {
    const r = await report(d).run();
    assert.equal(r.oldFormatQueueUploads.state, "absent");
    assert.equal(fs.existsSync(path.join(d.data, "cache")), false, "the scan created nothing");
  } finally { d.rm(); }
});

test("C7: a link inside the folder is skipped, never followed; its target is intact", async (t) => {
  const d = tempData();
  const outside = path.join(d.base, "outside.wav");
  try {
    put(outside, "user data outside");
    try { fs.symlinkSync(outside, path.join(d.tx, `.speech-${STAMP}-link.wav`), "file"); }
    catch (e) { if (IS_WIN && e.code === "EPERM") { t.skip("file symlinks need a privilege on this Windows runner (junctions are covered below)"); return; } throw e; }
    const before = snapshot(d.base);
    const r = await report(d).run();
    assert.equal(r.legacyTranscriptionTemporaries.matched, 0);
    assert.equal(r.legacyTranscriptionTemporaries.skippedNotFile, 1);
    assert.deepEqual(snapshot(d.base), before);
    assert.equal(fs.readFileSync(outside, "utf8"), "user data outside");
  } finally { d.rm(); }
});

test("C8/C11: a scanned folder that is a link or junction to elsewhere is not read", async () => {
  const d = tempData();
  const elsewhere = path.join(d.base, "elsewhere");
  try {
    put(path.join(elsewhere, `.speech-${STAMP}-x.wav`), "user");
    fs.rmSync(d.tx, { recursive: true });
    fs.symlinkSync(elsewhere, d.tx, IS_WIN ? "junction" : "dir"); // a junction needs no privilege on Windows
    const before = snapshot(d.base);
    const r = await report(d).run();
    assert.equal(r.legacyTranscriptionTemporaries.state, "not-a-plain-folder");
    assert.equal(r.legacyTranscriptionTemporaries.matched, 0);
    assert.deepEqual(snapshot(d.base), before);
  } finally { d.rm(); }
});

test("C5 (paths): a folder outside the data folder is not read", async () => {
  const d = tempData();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "usap-stale-other-"));
  try {
    put(path.join(other, `.speech-${STAMP}-x.wav`), "user");
    const r = await createStaleFileReport({ setting: { mode: "report" }, dataRoot: d.data, transcriptions: other }).run();
    assert.equal(r.legacyTranscriptionTemporaries.state, "outside-data-folder");
    assert.equal(r.legacyTranscriptionTemporaries.matched, 0);
  } finally { d.rm(); fs.rmSync(other, { recursive: true, force: true }); }
});

test("C17: the scan stops at the entry cap and reports truncated", async () => {
  const d = tempData();
  try {
    for (let i = 0; i < MAX_ENTRIES + 50; i += 1) fs.writeFileSync(path.join(d.tx, `.speech-${STAMP}-f${i}.wav`), "");
    const r = await report(d, { clock: () => 0 }).run(); // the time cap has its own test; here only the entry cap applies
    assert.equal(r.legacyTranscriptionTemporaries.truncated, true);
    assert.equal(r.legacyTranscriptionTemporaries.scanned, MAX_ENTRIES);
    assert.equal(fs.readdirSync(d.tx).length, MAX_ENTRIES + 50, "nothing removed");
  } finally { d.rm(); }
});

test("the scan stops at the time cap and reports truncated", async () => {
  const d = tempData();
  try {
    for (let i = 0; i < 20; i += 1) put(path.join(d.tx, `.speech-${STAMP}-f${i}.wav`));
    let t = 0;
    const r = await report(d, { clock: () => (t += 100) }).run(); // every read of the clock advances 100 ms
    assert.equal(r.legacyTranscriptionTemporaries.truncated, true);
    assert.ok(r.legacyTranscriptionTemporaries.scanned < 20);
  } finally { d.rm(); }
});

test("C19 (failure): errors are counted by code, the run never throws, nothing changes", async () => {
  const d = tempData();
  try {
    put(path.join(d.tx, `.speech-${STAMP}-a.wav`)); put(path.join(d.tx, `.speech-${STAMP}-b.wav`));
    const flaky = { ...fs, lstatSync: (p, ...a) => { if (String(p).endsWith("-b.wav")) { const e = new Error("busy"); e.code = "EBUSY"; throw e; } return fs.lstatSync(p, ...a); } };
    const before = snapshot(d.base);
    const r = await report(d, { fs: flaky }).run();
    assert.equal(r.legacyTranscriptionTemporaries.matched, 1);
    assert.deepEqual(r.legacyTranscriptionTemporaries.errors, { EBUSY: 1 });
    assert.deepEqual(snapshot(d.base), before);
    const broken = { ...fs, realpathSync: () => { const e = new Error("x"); e.code = "EACCES"; throw e; } };
    const r2 = await report(d, { fs: broken }).run();
    assert.equal(r2.state, "data-folder-unreadable");
  } finally { d.rm(); }
});

test("C15: off reads nothing", async () => {
  const d = tempData();
  try {
    put(path.join(d.tx, `.speech-${STAMP}-a.wav`));
    let calls = 0;
    const spy = new Proxy(fs, { get: (o, k) => (typeof o[k] === "function" ? (...a) => { calls += 1; return o[k](...a); } : o[k]) });
    const r = createStaleFileReport({ setting: { mode: "off" }, dataRoot: d.data, transcriptions: d.tx, fs: spy });
    assert.equal(await r.run(), null);
    assert.equal(r.snapshot(), null);
    assert.equal(calls, 0, "no file-system call when off");
  } finally { d.rm(); }
});

test("C1/C2 (R1 scope): a file being written by a live process is only counted, never touched", async () => {
  const d = tempData();
  const f = path.join(d.tx, `.speech-${STAMP}-live.wav`);
  const fd = fs.openSync(f, "w"); // held open, as an upload in progress would be
  try {
    fs.writeSync(fd, "partial");
    const r = await report(d).run();
    assert.equal(r.legacyTranscriptionTemporaries.matched, 1);
    fs.writeSync(fd, "-more");
    fs.closeSync(fd);
    assert.equal(fs.readFileSync(f, "utf8"), "partial-more", "the writer's file is intact");
  } finally { try { fs.closeSync(fd); } catch (_) { /* closed */ } d.rm(); }
});

// ── the real server ──────────────────────────────────────────────────────────────────────────────────────────────
async function withServer(env, fn) {
  const root = makeRoot();
  const tx = path.join(root, "app", "transcriptions");
  put(path.join(tx, `.speech-${STAMP}-left.wav`), "left behind", 48 * HOUR);
  put(path.join(tx, "transcript-2026-11-20T15-35-46-120Z-user.wav.json"), "{}");
  const before = snapshot(path.join(root, "app"));
  const srv = await startServer(root, env);
  try { await fn(srv, () => snapshot(path.join(root, "app")), before); } finally { await stopServerAndWait(srv); removeTestRoot(root); }
}
const diag = async (srv) => (await request(srv.port, "GET", "/api/diagnostics")).json;
const strip = (s) => Object.fromEntries(Object.entries(s).filter(([k]) => !/^(config|cache|logs)/.test(k))); // the server's own folders

test("server: off by default — /api/diagnostics unchanged (no staleFiles), files untouched, nothing logged", async () => {
  await withServer({ USAP_STALE_FILE_REPORT: "" }, async (srv, now, before) => {
    const d = await diag(srv);
    assert.equal("staleFiles" in d, false);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!/\[stale-files\]/.test(srv.log()), "no report line when off");
    const after = strip(now());
    for (const [k, v] of Object.entries(strip(before))) assert.deepEqual(after[k], v, `${k} unchanged`);
  });
});

test("server: report — counts after listening, nothing removed, renamed or created, no names in the answer", async () => {
  await withServer({ USAP_STALE_FILE_REPORT: "report" }, async (srv, now, before) => {
    let s = null;
    for (let i = 0; i < 100 && !(s && s.lastRunAt); i += 1) { s = (await diag(srv)).staleFiles; if (!s || !s.lastRunAt) await new Promise((r) => setTimeout(r, 100)); }
    assert.ok(s && s.lastRunAt, "the report ran");
    assert.equal(s.mode, "report"); assert.equal(s.removed, 0);
    assert.equal(s.legacyTranscriptionTemporaries.matched, 1);
    assert.equal(s.legacyTranscriptionTemporaries.age.under7d, 1);
    assert.equal(s.oldFormatQueueUploads.state, "absent");
    assert.ok(!JSON.stringify(s).includes("left"), "no file name in the answer");
    const after = strip(now());
    for (const [k, v] of Object.entries(strip(before))) assert.deepEqual(after[k], v, `${k} unchanged`);
    assert.equal(fs.existsSync(path.join(srv.root, "app", "cache", "speech-uploads")), false, "the upload folder was not created");
    assert.match(srv.log(), /\[stale-files\] report only \(nothing removed\): 1 legacy transcription temporaries, 0 old-format queue uploads/);
    assert.ok(!/left\.wav/.test(srv.log()), "no file name in the log");
  });
});

test("server: USAP_SCHEDULER=off turns the report off (provisional) and says so", async () => {
  await withServer({ USAP_STALE_FILE_REPORT: "report", USAP_SCHEDULER: "off" }, async (srv) => {
    assert.equal("staleFiles" in (await diag(srv)), false);
    assert.match(srv.log(), /\[stale-files\] report "report" is off because USAP_SCHEDULER=off/);
  });
});

test("concurrent change: entries removed, replaced by a link or a folder between listing and lstat are never followed or counted as files", async () => {
  const d = tempData();
  try {
    for (const n of ["gone", "tolink", "todir", "kept"]) put(path.join(d.tx, `.speech-${STAMP}-${n}.wav`), n);
    const outside = path.join(d.base, "outside.wav"); put(outside, "user data");
    const first = new Set();
    // The first lstat of each entry happens after the listing: change the entry right before it, as another process could.
    const racing = { ...fs, lstatSync: (p, ...a) => {
      const b = path.basename(String(p));
      if (!first.has(b)) {
        first.add(b);
        if (b.includes("-gone.")) fs.rmSync(p);
        if (b.includes("-tolink.")) { fs.rmSync(p); try { fs.symlinkSync(outside, p, "file"); } catch (_) { fs.writeFileSync(p + ".x", ""); } }
        if (b.includes("-todir.")) { fs.rmSync(p); fs.mkdirSync(p); }
      }
      return fs.lstatSync(p, ...a);
    } };
    const r = await report(d, { fs: racing }).run();
    const l = r.legacyTranscriptionTemporaries;
    assert.equal(l.matched, 1 + (fs.lstatSync(path.join(d.tx, `.speech-${STAMP}-tolink.wav`), { throwIfNoEntry: false })?.isFile() ? 1 : 0), "only regular files are counted");
    assert.ok(l.errors.ENOENT >= 1, "the vanished entry is counted as an error, not thrown");
    assert.ok(l.skippedNotFile >= 1, "the folder (and the link, where created) is skipped");
    assert.equal(fs.readFileSync(outside, "utf8"), "user data", "a link's target is never touched");
    assert.equal(r.removed, 0);
  } finally { d.rm(); }
});

test("unusual structures: a folder with a legacy name, very long and non-ASCII names, and nested folders are handled within the bounds", async () => {
  const d = tempData();
  try {
    fs.mkdirSync(path.join(d.tx, `.speech-${STAMP}-dir.wav`));                              // a folder, not a file
    put(path.join(d.tx, `.speech-${STAMP}-dir.wav`, `.speech-${STAMP}-inner.wav`));          // never recursed into
    put(path.join(d.tx, `.speech-${STAMP}-${"a".repeat(120)}.wav`));                           // longest allowed base
    put(path.join(d.tx, `.speech-${STAMP}-${"a".repeat(121)}.wav`));                           // one longer: not matched
    put(path.join(d.tx, `.speech-${STAMP}-ünïcode.wav`));                                       // outside the name charset
    const before = snapshot(d.base);
    const r = await report(d).run();
    const l = r.legacyTranscriptionTemporaries;
    assert.equal(l.matched, 1, "only the regular file with an allowed name");
    assert.equal(l.skippedNotFile, 1, "the folder with a legacy name is skipped, not entered");
    assert.equal(l.scanned, 4, "only the top level is listed");
    assert.deepEqual(snapshot(d.base), before);
  } finally { d.rm(); }
});

test("server: with the report on, /api/diagnostics stays behind the existing Host and Origin checks", async () => {
  await withServer({ USAP_STALE_FILE_REPORT: "report" }, async (srv) => {
    const foreignOrigin = await request(srv.port, "GET", "/api/diagnostics", { headers: { Origin: "http://evil.example" } });
    assert.equal(foreignOrigin.status, 403);
    assert.ok(!/staleFiles/.test(foreignOrigin.text || JSON.stringify(foreignOrigin.json || {})), "nothing from the report in a refusal");
    const foreignHost = await request(srv.port, "GET", "/api/diagnostics", { headers: { Host: `rebind.example:${srv.port}` } });
    assert.ok(foreignHost.status === 403 || foreignHost.status === 421 || foreignHost.status === 400, `non-loopback Host refused (${foreignHost.status})`);
    assert.ok(!/staleFiles/.test(foreignHost.text || JSON.stringify(foreignHost.json || {})));
  });
});
