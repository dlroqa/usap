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

// Writes the GC request atomically (a temporary file, then rename), so the probe never reads a half-written request.
function writeTrigger(file, id) {
  const fs = require("fs");
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, id);
  fs.renameSync(tmp, file);
}

module.exports = { matchGcSample, writeTrigger };
