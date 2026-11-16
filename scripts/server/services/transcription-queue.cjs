// services/transcription-queue.cjs — bounded Whisper transcription queue (Step 9.9f-3,
// docs/roadmap/STEP9_9F_WHISPER_QUEUE.md). Off by default; when off it is not created and POST /api/speech/transcribe
// is the handler from before (the whole body read into memory, an unbounded chain).
//
// When on:
//   * admission happens at arrival, before any body byte is read, in this order: 413 (declared size over 1 GiB),
//     429 (1 running + `limit` waiting/uploading), 507 (storage reservation refused), then a FIFO position assigned
//     synchronously (services/job-queue.cjs, unchanged);
//   * the raw WAV body streams to a private file in <data root>/cache/speech-uploads with native backpressure, so
//     memory per upload is bounded and independent of its size; the byte count, not Content-Length, is enforced;
//   * one in-process ledger books every byte an upload may still write or a file still holds (uploading, waiting, and
//     the running job's file until whisper-cli exits); a reservation also needs free disk space minus a margin;
//   * an upload ends on 30 s without data or 240 s in total (408 UPLOAD_TIMEOUT); a job waits at most 10 minutes
//     (503 QUEUE_TIMEOUT); a job runs only once its upload is complete and verified;
//   * a client that leaves while uploading or waiting never reaches whisper-cli; a running transcription is not
//     cancelled (as today): it keeps its turn and its file until the worker exits;
//   * every file, reservation and turn is released exactly once, whatever ends the job.
"use strict";

const crypto = require("node:crypto");
const fsDefault = require("node:fs");
const pathDefault = require("node:path");
const { jobQueueSetting, createJobQueue } = require("./job-queue.cjs");

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const MAX_UPLOAD_BYTES = 1 * GiB;      // today's per-request ceiling (readBinaryBody); not raisable
const RESERVE_STEP_BYTES = 64 * MiB;   // reservation growth for uploads without Content-Length
const MARGIN_MAX_BYTES = 256 * MiB;    // free-space safety margin: 256 MiB or 2 % of the volume, the smaller
const DEFAULT_WAIT_MS = 10 * 60 * 1000;
const WAV_ONLY = "Speech transcription currently accepts WAV audio only."; // today's message, unchanged

const RANGES = {
  limit: { name: "transcriptionQueueLimit", env: "USAP_TRANSCRIPTION_QUEUE_LIMIT", min: 1, max: 16, def: 4 },
  budgetBytes: { name: "transcriptionQueueStorageBudgetBytes", env: "USAP_TRANSCRIPTION_QUEUE_STORAGE_BUDGET_BYTES", min: 64 * MiB, max: 64 * GiB, def: 2 * GiB },
  uploadIdleMs: { name: "transcriptionQueueUploadIdleMs", env: "USAP_TRANSCRIPTION_QUEUE_UPLOAD_IDLE_MS", min: 5000, max: 120000, def: 30000 },
  uploadMaxMs: { name: "transcriptionQueueUploadMaxMs", env: "USAP_TRANSCRIPTION_QUEUE_UPLOAD_MAX_MS", min: 30000, max: 290000, def: 240000 },
};

/**
 * The setting: `USAP_TRANSCRIPTION_QUEUE` (environment, wins) or scheduler.json `transcriptionQueue`, on | off, default
 * off; USAP_SCHEDULER=off forces it off. The longest wait as for the voice queue (1 s to 1 h). The numbers in RANGES:
 * environment, then scheduler.json, then the default; a value outside its range is ignored and reported, never clamped.
 */
function transcriptionQueueSetting({ env = process.env, configDir, schedulerMode, fs = fsDefault, path = pathDefault } = {}) {
  let cfg = {};
  if (configDir) {
    try { cfg = JSON.parse(fs.readFileSync(path.join(configDir, "scheduler.json"), "utf8")) || {}; } catch (_) { cfg = {}; }
  }
  if (!cfg || typeof cfg !== "object") cfg = {};
  const ignored = [];
  const num = (key) => {
    const r = RANGES[key];
    for (const [v, source, n] of [[env[r.env], "environment", r.env], [cfg[r.name], "scheduler.json", r.name]]) {
      if (v === undefined || v === null || v === "") continue;
      const x = Number(v);
      if (Number.isInteger(x) && x >= r.min && x <= r.max) return x;
      ignored.push({ name: n, source, reason: `allowed: integer ${r.min}-${r.max}` });
    }
    return r.def;
  };
  const limit = num("limit");
  const base = jobQueueSetting({ env, configDir, schedulerMode, name: "transcriptionQueue", envName: "USAP_TRANSCRIPTION_QUEUE",
    waitName: "transcriptionQueueMaxWaitMs", waitEnvName: "USAP_TRANSCRIPTION_QUEUE_MAX_WAIT_MS", defaultWaitMs: DEFAULT_WAIT_MS, limit });
  return Object.freeze({
    mode: base.mode, requested: base.requested, forcedOffBy: base.forcedOffBy, limit, maxWaitMs: base.maxWaitMs,
    budgetBytes: num("budgetBytes"), uploadIdleMs: num("uploadIdleMs"), uploadMaxMs: num("uploadMaxMs"),
    ignored: Object.freeze([...base.ignored, ...ignored].map((x) => Object.freeze(x))),
  });
}

/**
 * Storage ledger. `reserve`/`grow` check and book in one synchronous step (one server process: nothing can interleave),
 * so the sum of reservations never exceeds the budget, nor the free space minus the margin. `release` is idempotent.
 */
function createStorageLedger({ budgetBytes, dir, statfs = (d) => fsDefault.statfsSync(d) }) {
  let reserved = 0;
  const freeBytes = () => {
    try {
      const st = statfs(dir);
      const avail = Number(st.bavail) * Number(st.bsize);
      const size = Number(st.blocks) * Number(st.bsize);
      if (!Number.isFinite(avail) || avail < 0) return null;
      const margin = Number.isFinite(size) && size > 0 ? Math.min(MARGIN_MAX_BYTES, Math.floor(size * 0.02)) : MARGIN_MAX_BYTES;
      return Math.max(0, avail - margin);
    } catch (_) {
      return null; // no statfs on this volume: only the budget applies; ENOSPC while writing still ends the upload (507)
    }
  };
  // Free space already counts bytes written by uploads in progress, so subtract only what is reserved but not written.
  let written = 0;
  const check = (bytes) => {
    if (reserved + bytes > budgetBytes) return "budget";
    const free = freeBytes();
    if (free !== null && free - (reserved - written) < bytes) return "disk";
    return null;
  };
  function reserve(bytes) {
    const why = check(bytes);
    if (why) return { ok: false, reason: why };
    reserved += bytes;
    const r = { size: bytes, written: 0, released: false };
    return { ok: true, reservation: r };
  }
  function grow(r, bytes) {
    if (r.released) return false;
    if (check(bytes)) return false;
    reserved += bytes; r.size += bytes;
    return true;
  }
  function wrote(r, bytes) { if (!r.released) { r.written += bytes; written += bytes; } }
  function release(r) {
    if (!r || r.released) return false;
    r.released = true;
    reserved -= r.size; written -= r.written;
    return true;
  }
  return { reserve, grow, wrote, release, reservedBytes: () => reserved, budgetBytes };
}

/** The dedicated upload folder: created on first use with mode 0700; refused if it is a link or outside the data root. */
function prepareUploadDir({ dataRoot, fs = fsDefault, path = pathDefault }) {
  const dir = path.join(dataRoot, "cache", "speech-uploads");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("the speech upload folder is not a plain folder");
  const real = fs.realpathSync(dir);
  const realRoot = fs.realpathSync(dataRoot);
  const rel = path.relative(realRoot, real);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("the speech upload folder is outside the data folder");
  return dir;
}

/**
 * @param {object} o
 * @param {object} o.setting      transcriptionQueueSetting(...)
 * @param {string} o.dir          prepareUploadDir(...)
 * @param {object} o.speech       the speech service (runExclusiveSpeechOperation, transcribeWavFile, getSettings, setError, getError)
 * @param {Function} o.json       json(res, status, body)
 */
function createTranscriptionQueue({ setting, dir, speech, json, fs = fsDefault, path = pathDefault, statfs, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, log = console, maxUploadBytes = MAX_UPLOAD_BYTES }) {
  // `maxUploadBytes` is not a setting: the server always uses 1 GiB. Tests pass a small value to reach the limit.
  const queue = createJobQueue({ engineLabel: "speech engine", limit: setting.limit, maxWaitMs: setting.maxWaitMs, now, setTimer, clearTimer });
  const ledger = createStorageLedger({ budgetBytes: setting.budgetBytes, dir, statfs });
  const instanceId = crypto.randomBytes(8).toString("hex");
  let seq = 0;
  const live = new Set(); // jobs with a file or a reservation (for shutdown and reporting)
  const counts = { tooLarge: 0, insufficientStorage: 0, uploadTimedOut: 0, notWav: 0, uploadFailed: 0, disconnected: 0, transcribed: 0, failed: 0 };
  const O_NOFOLLOW = fs.constants && fs.constants.O_NOFOLLOW ? fs.constants.O_NOFOLLOW : 0;

  // One account per request, opened at arrival and shared by the upload and by any discarding after a refusal: every
  // body byte received counts against one ceiling (the per-upload limit), one absolute deadline runs from arrival
  // (the whole-upload time), and inactivity is measured from the last byte actually received. A refusal never opens a
  // new budget. The counting listener is attached first and never removed, so bytes that arrive between a refusal and
  // its answer are counted too (and dropped: nothing keeps them).
  function openAccount(req) {
    const t = now();
    const acct = { startedAt: t, lastDataAt: t, bytes: 0 };
    req.on("data", (c) => { acct.bytes += c.length; acct.lastDataAt = now(); });
    return acct;
  }

  // Answer before the body was read in full. The whole answer is sent at once (status, headers and a body of known
  // length, so the client can read it immediately). Node closes the connection when a response ends, and closing while
  // request data is still arriving resets it, which can make a client that is still sending lose the answer (seen on
  // Windows). So while the request's own budgets allow, the rest of the body is read and discarded and the response
  // ends after it; when a budget is spent (bytes over the ceiling, the absolute deadline, or no data for the inactivity
  // time), or the declared size can never fit the ceiling, the connection is closed at once after the answer is
  // written. Bounded resource use comes first: a client still sending at that point may see a reset instead.
  function answerEarly(req, res, status, body, retryAfterSeconds, acct, declared) {
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    if (retryAfterSeconds) res.setHeader("Retry-After", String(retryAfterSeconds));
    if (req.complete) { json(res, status, body); return; }
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), Connection: "close" });
    res.write(text);
    let idle = null;
    let total = null;
    let settled = false;
    const done = (cut) => {
      if (settled) return;
      settled = true;
      if (total) clearTimer(total);
      if (idle) clearTimer(idle);
      req.removeListener("data", onDiscard); req.removeListener("end", onEnd); req.removeListener("close", onEnd);
      try { res.end(); } catch (_) { /* gone */ }
      if (cut) { try { req.destroy(); } catch (_) { /* gone */ } }
    };
    function onDiscard() { if (acct.bytes > maxUploadBytes) return done(true); armIdle(); }
    function onEnd() { done(false); }
    const armIdle = () => {
      if (idle) clearTimer(idle);
      const left = acct.lastDataAt + setting.uploadIdleMs - now();
      if (left <= 0) return done(true);
      idle = setTimer(() => done(true), left);
      if (idle && idle.unref) idle.unref();
    };
    // Already over: nothing left to wait for, or a body that can't complete within the ceiling.
    const totalLeft = acct.startedAt + setting.uploadMaxMs - now();
    if (req.destroyed || req.readableEnded || acct.bytes > maxUploadBytes || totalLeft <= 0
      || (declared !== null && declared > maxUploadBytes)) return done(true);
    // Our own pause (write backpressure) is not the client's silence: inactivity counts from here in that case.
    if (req.isPaused()) acct.lastDataAt = now();
    total = setTimer(() => done(true), totalLeft);
    if (total && total.unref) total.unref();
    req.on("data", onDiscard);
    req.on("end", onEnd);
    req.on("close", onEnd);
    armIdle();
    if (!settled) req.resume();
  }

  async function handle(req, res, options) {
    const declaredRaw = req.headers["content-length"];
    const declared = declaredRaw === undefined ? null : Number(declaredRaw);
    const acct = openAccount(req);
    // 1. Size, before anything is read or reserved.
    if (declared !== null && declared > maxUploadBytes) {
      counts.tooLarge += 1;
      return answerEarly(req, res, 413, { ok: false, code: "UPLOAD_TOO_LARGE", error: `Audio file is too large. Limit is ${Math.round(maxUploadBytes / MiB)} MB.` }, undefined, acct, declared);
    }
    // 2. Capacity. The queue answers 429 itself (and counts it) when running + waiting is at its limit.
    const st = queue.stats();
    if (st.running + st.waiting >= 1 + st.limit) {
      const r = await queue.admit(() => {});
      return answerEarly(req, res, r.status, { ok: false, code: r.code, error: r.error }, r.retryAfterSeconds, acct, declared);
    }
    // 3. Storage, booked atomically (no await between here and the admission below).
    const first = declared !== null ? Math.max(declared, 1) : Math.min(RESERVE_STEP_BYTES, maxUploadBytes);
    const booked = ledger.reserve(first);
    if (!booked.ok) {
      counts.insufficientStorage += 1;
      return answerEarly(req, res, 507, { ok: false, code: "INSUFFICIENT_STORAGE",
        error: booked.reason === "budget"
          ? "Not enough room for this upload now: other transcriptions hold the temporary storage. Try again later."
          : "Not enough free disk space to receive this audio file." }, booked.reason === "budget" ? 30 : undefined, acct, declared);
    }
    // 4. Admission: the FIFO position is taken here, synchronously.
    const job = { id: ++seq, reservation: booked.reservation, file: null, outBase: null, fd: null, out: null, bytes: 0, header: Buffer.alloc(0),
      uploadDone: false, uploadError: null, running: false, settled: false, withdraw: null, timers: [] };
    live.add(job);
    const turnP = queue.admit((cb) => { job.withdraw = cb; });
    return runJob(req, res, options, job, declared, turnP, acct);
  }

  // Delete the job's files and release its reservation, once. The file is deleted only after its write stream has
  // closed its descriptor (Windows can't delete an open file); the reservation is released with the deletion.
  function cleanup(job, { sync = false } = {}) {
    if (job.settled && !sync) return;
    job.settled = true;
    for (const t of job.timers) clearTimer(t);
    const removeFiles = () => {
      for (const f of [job.file, job.outBase && `${job.outBase}.txt`, job.outBase && `${job.outBase}.json`]) {
        if (!f) continue;
        try { fs.unlinkSync(f); } catch (err) { if (err && err.code !== "ENOENT") log.warn(`  [speech-queue] could not delete a temporary file (${err.code})`); }
      }
      ledger.release(job.reservation);
      live.delete(job);
    };
    const out = job.out;
    if (sync || !out || out.closed || (out.destroyed && out.fd === null)) { if (out && !out.destroyed) { try { out.destroy(); } catch (_) { /* closed */ } } removeFiles(); return; }
    out.once("close", removeFiles);
    try { out.destroy(); } catch (_) { removeFiles(); }
  }

  function runJob(req, res, options, job, declared, turnP, acct) {
    return new Promise((resolveJob) => {
      let release = null;
      let clientGone = false;
      const respond = (status, body, retryAfterSeconds) => {
        if (clientGone || res.headersSent || res.writableEnded || res.destroyed) return;
        if (!job.uploadDone) return answerEarly(req, res, status, body, retryAfterSeconds, acct, declared);
        if (retryAfterSeconds) res.setHeader("Retry-After", String(retryAfterSeconds));
        json(res, status, body);
      };
      const finish = () => { cleanup(job); if (release) release(); resolveJob(); };

      // ── Upload: stream to the private file, with backpressure, limits and deadlines ──
      let uploadSettle;
      const uploadP = new Promise((r) => { uploadSettle = r; });
      const failUpload = (code, extra = {}) => {
        if (job.uploadDone || job.uploadError) return;
        job.uploadError = { code, ...extra };
        req.removeListener("data", onData); req.removeListener("end", onEnd);
        if (job.out) { try { job.out.destroy(); } catch (_) { /* closed */ } }
        uploadSettle(false);
      };
      const idle = () => {
        const t = setTimer(() => failUpload("UPLOAD_TIMEOUT", { phase: "idle" }), setting.uploadIdleMs);
        job.timers.push(t);
        return t;
      };
      let idleTimer = idle();
      // The absolute deadline runs from arrival (the request's account), the same one any later discarding obeys.
      job.timers.push(setTimer(() => failUpload("UPLOAD_TIMEOUT", { phase: "total" }), Math.max(0, acct.startedAt + setting.uploadMaxMs - now())));

      const name = `${instanceId}-${job.id}-${crypto.randomBytes(8).toString("hex")}`;
      try {
        const file = path.join(dir, `${name}.wav`);
        job.fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
        job.file = file;
        job.outBase = path.join(dir, `${name}.out`);
        job.out = fs.createWriteStream(null, { fd: job.fd, autoClose: true });
      } catch (err) {
        failUpload(err && err.code === "ENOSPC" ? "INSUFFICIENT_STORAGE" : "UPLOAD_WRITE_FAILED", { errCode: err && err.code });
      }
      if (job.out) {
        job.out.on("error", (err) => failUpload(err && err.code === "ENOSPC" ? "INSUFFICIENT_STORAGE" : "UPLOAD_WRITE_FAILED", { errCode: err && err.code }));
        job.out.on("drain", () => { if (!job.uploadDone && !job.uploadError) req.resume(); });
      }
      function onData(chunk) {
        if (job.uploadDone || job.uploadError) return;
        clearTimer(idleTimer); idleTimer = idle();
        job.bytes = acct.bytes; // every body byte of this request so far (counted by its account)
        if (job.bytes > maxUploadBytes || (declared !== null && job.bytes > declared)) return failUpload("UPLOAD_TOO_LARGE");
        if (job.header.length < 12) {
          job.header = Buffer.concat([job.header, chunk.subarray(0, 12 - job.header.length)]);
          if (job.header.length >= 12 && !(job.header.toString("ascii", 0, 4) === "RIFF" && job.header.toString("ascii", 8, 12) === "WAVE")) return failUpload("NOT_WAV");
        }
        while (job.bytes > job.reservation.size) {
          if (!ledger.grow(job.reservation, RESERVE_STEP_BYTES)) return failUpload("INSUFFICIENT_STORAGE");
        }
        ledger.wrote(job.reservation, chunk.length);
        if (!job.out.write(chunk)) req.pause();
      }
      function onEnd() {
        if (job.uploadDone || job.uploadError) return;
        const complete = req.complete && (declared === null || job.bytes === declared);
        if (!complete) return failUpload("CLIENT_GONE");
        if (job.bytes <= 44 || job.header.length < 12) return failUpload("NOT_WAV"); // today's check: header plus data
        job.out.end(() => {
          if (job.uploadError) return;
          job.uploadDone = true;
          for (const t of job.timers) clearTimer(t);
          job.timers = [];
          uploadSettle(true);
        });
      }
      if (job.out && !job.uploadError) {
        req.on("data", onData);
        req.on("end", onEnd);
        req.on("aborted", () => failUpload("CLIENT_GONE"));
      }
      res.once("close", () => {
        if (res.writableEnded) return;
        clientGone = true;
        failUpload("CLIENT_GONE");
        if (job.withdraw && !release) job.withdraw(); // still waiting: leave the queue at once
      });

      // An upload that fails while the job is still waiting leaves the queue at once (its turn is never granted).
      uploadP.then((ok) => { if (!ok && !release && job.withdraw) job.withdraw(); });

      const answerUploadError = () => {
        const e = job.uploadError;
        if (!e || e.code === "CLIENT_GONE") { counts.disconnected += 1; return; }
        if (e.code === "UPLOAD_TOO_LARGE") { counts.tooLarge += 1; return respond(413, { ok: false, code: e.code, error: `Audio file is too large. Limit is ${Math.round(maxUploadBytes / MiB)} MB.` }); }
        if (e.code === "UPLOAD_TIMEOUT") {
          counts.uploadTimedOut += 1;
          return respond(408, { ok: false, code: e.code, phase: e.phase, error: e.phase === "idle"
            ? `The audio upload stopped: no data for ${Math.round(setting.uploadIdleMs / 1000)} s.`
            : `The audio upload took longer than ${Math.round(setting.uploadMaxMs / 1000)} s.` });
        }
        if (e.code === "NOT_WAV") { counts.notWav += 1; speech.setError(WAV_ONLY); return respond(500, { ok: false, error: WAV_ONLY }); }
        if (e.code === "INSUFFICIENT_STORAGE") { counts.insufficientStorage += 1; return respond(507, { ok: false, code: e.code, error: "Not enough free disk space to receive this audio file." }); }
        counts.uploadFailed += 1;
        return respond(500, { ok: false, code: "UPLOAD_WRITE_FAILED", error: "The audio file could not be saved for transcription." });
      };

      turnP.then(async (turn) => {
        if (!turn.ok) {
          // Not run: queue timeout, refused by /api/speech/stop, or withdrawn (client gone / upload failed).
          failUpload("CLIENT_GONE");
          if (turn.code === "CLIENT_GONE") { if (job.uploadError && job.uploadError.code !== "CLIENT_GONE") answerUploadError(); else if (clientGone) counts.disconnected += 1; return finish(); }
          respond(turn.status, { ok: false, code: turn.code, error: turn.error }, turn.retryAfterSeconds);
          return finish();
        }
        release = turn.release;
        // Our turn. Run only once the upload is complete and verified (bounded by the upload deadlines).
        const ok = await uploadP;
        if (!ok) { answerUploadError(); return finish(); }
        if (clientGone) { counts.disconnected += 1; return finish(); }
        job.running = true;
        try {
          const result = await speech.runExclusiveSpeechOperation(() => speech.transcribeWavFile(job.file, job.outBase, options));
          counts.transcribed += 1;
          if (!clientGone) respond(200, { ok: true, transcription: result });
        } catch (err) {
          counts.failed += 1;
          speech.setError(err.message || String(err));
          if (!clientGone) respond(err.message && err.message.includes("too large") ? 413 : 500, { ok: false, error: speech.getError() });
        } finally {
          finish(); // the worker has exited (the promise settles on its exit): file, reservation and turn go now
        }
      });
    });
  }

  return {
    handle,
    refuseWaiting: (result) => queue.refuseWaiting(result),
    stats: () => ({ ...queue.stats(), uploading: [...live].filter((j) => !j.uploadDone && !j.uploadError && !j.settled).length }),
    storage: () => ({ budgetBytes: ledger.budgetBytes, reservedBytes: ledger.reservedBytes() }),
    counts: () => ({ ...queue.counts(), ...counts }),
    maxWaitMs: setting.maxWaitMs,
    /** At process exit: delete this instance's files (synchronous). */
    cleanupSync() { for (const job of [...live]) cleanup(job, { sync: true }); },
    instanceId,
  };
}

module.exports = { transcriptionQueueSetting, createStorageLedger, prepareUploadDir, createTranscriptionQueue, MAX_UPLOAD_BYTES, RESERVE_STEP_BYTES };
