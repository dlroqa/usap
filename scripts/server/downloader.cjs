// Verified file download (Step 9.4): one transfer path for model and engine downloads.
//
//   * every request and every redirect hop goes through the outbound guard (net-guard.cjs)
//   * bytes stream to "<dest>.part" and are hashed as they arrive
//   * the result is checked against the pinned digest list, then against the size / checksum the
//     source reports; only a file that passes is renamed into place (integrity.cjs), so an existing
//     file is never replaced by a partial, corrupt or substituted one
//   * transient network failures are retried a bounded number of times, always from byte zero:
//     a partial file is never resumed, because its earlier bytes cannot be trusted across attempts
//   * cancellation (AbortSignal) stops the transfer and removes the partial file
"use strict";
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const { assertSafeUrl, guardedRequestOptions, followRedirect } = require("./net-guard.cjs");
const integrity = require("./integrity.cjs");

const TRANSIENT = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "USAP_INTERRUPTED", "USAP_STALLED"]);

class DownloadError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = "DownloadError";
    this.code = code;
    Object.assign(this, extra);
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener("abort", () => { clearTimeout(t); reject(new DownloadError("Download cancelled", "USAP_CANCELLED")); }, { once: true });
});

/**
 * One attempt: follow redirects, stream the body to tempPath while hashing.
 * Resolves { sha256, bytes, expectedBytes, sourceSha256, finalUrl }.
 */
function transferOnce(url, tempPath, opts, state) {
  const { policy = {}, headers = {}, signal, onProgress, checkResponse, stallMs = 60000 } = opts;
  return new Promise((resolve, reject) => {
    let settled = false;
    let out = null;
    let req = null;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);
      if (err) {
        try { if (req) req.destroy(); } catch (_) {}
        const done = () => { try { fs.rmSync(tempPath, { force: true }); } catch (_) {} reject(err); };
        if (out && !out.closed) { out.once("close", done); out.destroy(); } else done();
      } else resolve(value);
    };
    const onAbort = () => finish(new DownloadError("Download cancelled", "USAP_CANCELLED"));
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const get = (current, hop) => {
      try { assertSafeUrl(current, policy); } catch (err) { return finish(err); }
      const client = current.startsWith("https:") ? https : http;
      req = client.get(current, { ...guardedRequestOptions(policy), headers }, (res) => {
        // Any hop may carry the source's checksum (Hugging Face sends it on the redirecting response).
        state.sourceSha256 = state.sourceSha256 || integrity.sourceReportedSha256(res.headers);
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          let next;
          try { next = followRedirect(current, res.headers.location, hop, policy); } catch (err) { return finish(err); }
          if (opts.onRedirect) opts.onRedirect(next);
          return get(next, hop + 1);
        }
        const problem = checkResponse ? checkResponse(res, current) : (res.statusCode === 200 ? null : `HTTP ${res.statusCode}`);
        if (problem) { res.resume(); return finish(new DownloadError(problem, "USAP_HTTP", { statusCode: res.statusCode })); }

        const expectedBytes = parseInt(res.headers["content-length"], 10) || 0;
        const hasher = integrity.createHasher();
        out = fs.createWriteStream(tempPath);
        out.on("error", (err) => finish(new DownloadError(`Could not write the download: ${err.message}`, "USAP_WRITE", { cause: err })));
        let stalled = false;
        const armStall = () => setTimeout(() => { stalled = true; res.destroy(); }, stallMs);
        let stall = armStall();
        res.on("data", (chunk) => {
          clearTimeout(stall);
          stall = armStall();
          hasher.update(chunk);
          if (onProgress) onProgress({ bytes: hasher.bytes, totalBytes: expectedBytes });
          // Wait for the disk so slow drives (USB sticks) don't buffer the whole file in memory.
          if (!out.write(chunk)) { res.pause(); out.once("drain", () => res.resume()); }
        });
        const cut = (err) => {
          clearTimeout(stall);
          if (stalled) return finish(new DownloadError(`The download stalled (no data for ${Math.round(stallMs / 1000)} s).`, "USAP_STALLED"));
          const code = err && TRANSIENT.has(err.code) ? err.code : "USAP_INTERRUPTED";
          finish(new DownloadError("The connection closed before the download finished.", code, err ? { cause: err } : {}));
        };
        res.on("aborted", () => cut(null));
        res.on("error", cut);
        res.on("end", () => {
          clearTimeout(stall);
          if (settled) return;
          if (expectedBytes > 0 && hasher.bytes < expectedBytes) {
            return finish(new DownloadError(`The connection closed early: received ${hasher.bytes} of ${expectedBytes} bytes.`, "USAP_INTERRUPTED"));
          }
          out.end(() => {
            // fsync so a power cut right after activation cannot leave a renamed but empty file.
            fs.open(tempPath, "r+", (err, fd) => {
              if (err) return finish(new DownloadError(`Could not finalize the download: ${err.message}`, "USAP_WRITE"));
              fs.fsync(fd, () => fs.close(fd, () => {
                let written = -1;
                try { written = fs.statSync(tempPath).size; } catch (_) {}
                if (written !== hasher.bytes) return finish(new DownloadError(`Wrote ${written} of ${hasher.bytes} bytes to disk.`, "USAP_WRITE"));
                finish(null, { sha256: hasher.digest(), bytes: hasher.bytes, expectedBytes, sourceSha256: state.sourceSha256, finalUrl: current });
              }));
            });
          });
        });
      });
      req.on("error", (err) => finish(err instanceof Error && err.name === "BlockedRequestError" ? err
        : new DownloadError(err.message, TRANSIENT.has(err.code) ? err.code : (err.code || "USAP_NETWORK"), { cause: err })));
    };
    get(url, 0);
  });
}

/**
 * Download url to destPath with verification. Resolves
 * { status: "verified"|"source-checksum"|"unverified", sha256, bytes, message, attempts }.
 * Rejects with DownloadError / IntegrityError / BlockedRequestError; destPath is untouched on failure.
 */
async function downloadVerified(url, destPath, opts = {}) {
  const { retries = 2, retryDelayMs = 1000, signal, manifest, label = "the file", onRetry } = opts;
  const tempPath = opts.tempPath || `${destPath}.part`;
  const pinned = integrity.pinnedFor(url, manifest); // throws on a broken manifest: fail closed
  if (opts.requirePinned && !pinned) {
    // Engines and runtimes must match a digest reviewed into this repository; never install them unverified.
    throw new integrity.IntegrityError(`${label} has no pinned SHA-256 digest in download-digests.txt, so it was not downloaded.`, "manifest");
  }
  let lastErr;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try { fs.rmSync(tempPath, { force: true }); } catch (_) {} // never resume a partial file
    const state = {};
    let result;
    try {
      result = await transferOnce(url, tempPath, opts, state);
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof DownloadError && TRANSIENT.has(err.code);
      if (!retryable || attempt > retries || (signal && signal.aborted)) throw err;
      if (onRetry) onRetry({ attempt, error: err });
      await sleep(retryDelayMs * attempt, signal);
      continue;
    }
    const verdict = integrity.evaluateDownload({ ...result, pinned, label });
    if (!verdict.ok) {
      try { fs.rmSync(tempPath, { force: true }); } catch (_) {}
      // Not retried: a mismatch against a pinned digest is not a network glitch.
      throw new integrity.IntegrityError(verdict.message, verdict.reason);
    }
    if (opts.beforeActivate) {
      try { await opts.beforeActivate(tempPath, result); } catch (err) { try { fs.rmSync(tempPath, { force: true }); } catch (_) {} throw err; }
    }
    if (opts.activate !== false) integrity.atomicReplaceFile(tempPath, destPath);
    return { status: verdict.status, trust: verdict.trust || null, message: verdict.message, sha256: result.sha256, bytes: result.bytes, attempts: attempt, finalUrl: result.finalUrl, tempPath };
  }
  throw lastErr;
}

module.exports = { downloadVerified, DownloadError, TRANSIENT };
