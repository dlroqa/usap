"use strict";
// Startup stale-file report, R1 (report only; Step 9.9 completion scope). It counts temporary files that a server
// stopped hard (Windows TerminateProcess, a crash, SIGKILL, power loss) may have left behind, and reports the counts in
// /api/diagnostics. **It never deletes, moves, renames, writes or creates anything**: this module only opens
// directories for reading and lstat()s entries (a test checks that no write or delete function appears in it).
//
// Off by default. On: USAP_STALE_FILE_REPORT=report, or "staleFileReport": "report" in app/config/scheduler.json.
// USAP_SCHEDULER=off also turns it off (provisional, until the owner decides whether the rollback switch covers it).
//
// What is counted (names only matched, never trusted as ownership; nothing here is ever removed):
//   * legacy whisper temporaries beside the user's transcripts: <data>/transcriptions/.speech-<ISO stamp>-<name>.wav,
//     …-out.txt, …-out.json (the transcription path used while the transcription queue is off, today's default);
//   * transcription-queue uploads in the old flat layout: <data>/cache/speech-uploads/<16 hex>-<n>-<16 hex>.wav,
//     .out.txt, .out.json (written by the queue, off by default).
// No ownership is claimed for any of them: there is no instance registry in R1, so the report cannot tell a file of
// another running copy from an abandoned one, and says so. Age is reported in buckets only, never used as a verdict.
//
// Safety: a directory is read only if it is a plain directory (not a link or junction) whose real path is inside the
// real path of the data folder; entries are lstat()ed and only regular files are counted (links, junctions and
// directories are counted as skipped, never followed). Bounded: at most 10 000 entries and 500 ms per directory. It
// runs once after the server listens, asynchronously; any error is counted by code. No file name or path is reported.
const fsDefault = require("fs");
const pathDefault = require("path");

const LEGACY = /^\.speech-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[A-Za-z0-9._-]{1,120}?(?:\.wav|-out\.txt|-out\.json)$/;
const QUEUE_OLD = /^[0-9a-f]{16}-\d{1,12}-[0-9a-f]{16}(?:\.wav|\.out\.txt|\.out\.json)$/;
const MAX_ENTRIES = 10000;
const MAX_MS = 500;
const AGE_BUCKETS = [["under1h", 3600e3], ["under24h", 86400e3], ["under7d", 7 * 86400e3], ["older", Infinity]];

function staleFileReportSetting({ env = process.env, configDir, schedulerMode, fs = fsDefault, path = pathDefault } = {}) {
  let cfg = {};
  if (configDir) { try { cfg = JSON.parse(fs.readFileSync(path.join(configDir, "scheduler.json"), "utf8")) || {}; } catch (_) { cfg = {}; } }
  if (!cfg || typeof cfg !== "object") cfg = {};
  const ignored = [];
  const word = (v, source, name) => {
    if (v === undefined || v === null || v === "") return null;
    const s = typeof v === "string" ? v.trim().toLowerCase() : null;
    if (s === "report" || s === "off") return s;
    ignored.push({ name, source, reason: "allowed: report, off" });
    return null;
  };
  const requested = word(env.USAP_STALE_FILE_REPORT, "environment", "USAP_STALE_FILE_REPORT") || word(cfg.staleFileReport, "scheduler.json", "staleFileReport") || "off";
  let mode = requested;
  let forcedOffBy = null;
  if (schedulerMode === "off" && requested !== "off") { mode = "off"; forcedOffBy = "scheduler-off"; }
  return { mode, requested, forcedOffBy, ignored };
}

function inside(realRoot, real, path) {
  const rel = path.relative(realRoot, real);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Count matching entries of one directory. Never throws; never writes. */
async function scanDir({ dir, realRoot, pattern, fs, path, now, clock }) {
  const r = { state: "scanned", scanned: 0, matched: 0, matchedBytes: 0, skippedNotFile: 0, truncated: false, errors: {}, age: Object.fromEntries(AGE_BUCKETS.map(([k]) => [k, 0])), durationMs: 0 };
  const t0 = clock();
  const err = (e) => { const c = (e && e.code) || "ERROR"; r.errors[c] = (r.errors[c] || 0) + 1; };
  let st;
  try { st = fs.lstatSync(dir); } catch (e) { r.state = e && e.code === "ENOENT" ? "absent" : "unreadable"; if (r.state === "unreadable") err(e); return r; }
  if (st.isSymbolicLink() || !st.isDirectory()) { r.state = "not-a-plain-folder"; return r; }
  let real;
  try { real = fs.realpathSync(dir); } catch (e) { r.state = "unreadable"; err(e); return r; }
  if (!inside(realRoot, real, path)) { r.state = "outside-data-folder"; return r; }
  let handle;
  try { handle = await fs.promises.opendir(real); } catch (e) { r.state = "unreadable"; err(e); return r; }
  try {
    for await (const ent of handle) {
      if (r.scanned >= MAX_ENTRIES || clock() - t0 > MAX_MS) { r.truncated = true; break; }
      r.scanned += 1;
      if (!pattern.test(ent.name)) continue;
      let e;
      try { e = fs.lstatSync(path.join(real, ent.name)); } catch (x) { err(x); continue; }
      if (!e.isFile() || e.isSymbolicLink()) { r.skippedNotFile += 1; continue; }
      r.matched += 1;
      r.matchedBytes += e.size;
      const age = Math.max(0, now() - e.mtimeMs);
      for (const [k, lim] of AGE_BUCKETS) { if (age < lim) { r.age[k] += 1; break; } }
    }
  } catch (e) { err(e); } finally { try { await handle.close(); } catch (_) { /* already closed by the loop */ } }
  r.durationMs = Math.round(clock() - t0);
  return r;
}

/**
 * @param {object} o
 * @param {string} o.dataRoot       the data folder (paths.cjs LAYOUT.dataRoot)
 * @param {string} o.transcriptions the transcripts folder (LAYOUT.data.transcriptions)
 */
function createStaleFileReport({ setting, dataRoot, transcriptions, fs = fsDefault, path = pathDefault, now = Date.now, clock = () => Number(process.hrtime.bigint() / 1000000n) }) {
  let last = null;
  let running = null;
  async function run() {
    if (setting.mode !== "report") return null;
    if (running) return running;
    running = (async () => {
      const startedAt = now();
      let realRoot = null;
      try { realRoot = fs.realpathSync(dataRoot); } catch (_) { realRoot = null; }
      const out = { mode: "report", lastRunAt: new Date(startedAt).toISOString(), ownership: "not determined (no instance registry in R1; files of another running copy cannot be told apart)", removed: 0 };
      if (!realRoot) { out.state = "data-folder-unreadable"; last = out; return out; }
      out.legacyTranscriptionTemporaries = await scanDir({ dir: transcriptions, realRoot, pattern: LEGACY, fs, path, now, clock });
      out.oldFormatQueueUploads = await scanDir({ dir: path.join(dataRoot, "cache", "speech-uploads"), realRoot, pattern: QUEUE_OLD, fs, path, now, clock });
      out.durationMs = Math.max(0, now() - startedAt);
      last = out;
      return out;
    })();
    try { return await running; } finally { running = null; }
  }
  return { run, snapshot: () => (setting.mode === "report" ? (last || { mode: "report", state: "pending" }) : null) };
}

module.exports = { staleFileReportSetting, createStaleFileReport, LEGACY, QUEUE_OLD, MAX_ENTRIES, MAX_MS };
