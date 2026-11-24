"use strict";
// D6 (image-queue-validate.cjs): which post-GC sample belongs to the request the validator just made. Pure function,
// unit-tested in scripts/tests/memprobe-gc.test.cjs. A sample is accepted only if all of these hold:
//   - it is the probe's retained post-GC sample `lastGc` (a GC actually ran), or the GC-marked record itself with
//     gcAvailable (the probe ran the GC in that tick);
//   - its id is exactly this request's id (ids carry a per-run nonce and a sequence number: no other cycle or run matches);
//   - its pid is the studio being measured (a sample from another server process never counts);
//   - it was taken at or after this request was made (no sample from before the trigger can be accepted).
// Anything else is "not yet": the caller keeps waiting within its unchanged bound, and a missing sample stays missing.
function matchGcSample(p, { id, pid, requestedAt }) {
  if (!p || typeof p !== "object" || !id) return null;
  const ok = (g) => g && g.id === id && g.pid === pid && Number.isFinite(g.t) && g.t >= requestedAt;
  if (p.lastGc && ok(p.lastGc)) return { ...p.lastGc, gcId: p.lastGc.id };
  if (p.gcId === id && p.gcAvailable === true && ok({ id: p.gcId, pid: p.pid, t: p.t })) return p;
  return null;
}

// Request ids the probe accepts; anything else is removed unanswered (the validator then records a missing sample).
const GC_ID = /^[A-Za-z0-9._-]{1,128}$/;
// Writes the GC request atomically: a temporary file in the same folder (same filesystem), then a rename, so the probe
// never reads a half-written request. On Windows a rename onto a file another process has open for a moment (the
// probe reading it) can fail with EPERM/EBUSY/EACCES; that is retried a bounded number of times (default 20 x 25 ms),
// then the temporary file is removed and the error is raised (the D6 check then fails; nothing is skipped).
const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function writeTrigger(file, id, { fs = require("fs"), retries = 20, waitMs = 25 } = {}) {
  if (!GC_ID.test(String(id))) throw new Error("invalid GC request id");
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, id);
  for (let attempt = 0; ; attempt += 1) {
    try { fs.renameSync(tmp, file); return attempt; } catch (err) {
      if (!RETRY_CODES.has(err && err.code) || attempt >= retries) {
        try { fs.unlinkSync(tmp); } catch (_) { /* already gone */ }
        throw err;
      }
      sleepSync(waitMs);
    }
  }
}

module.exports = { matchGcSample, writeTrigger, GC_ID };
