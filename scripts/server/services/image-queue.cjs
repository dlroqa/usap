// services/image-queue.cjs — bounded image-generation queue (Step 9.9f-3, docs/roadmap/STEP9_9F_IMAGE_QUEUE.md).
// Off by default; when off it is not created and the four generation routes are today's proxy, unchanged.
//
// It turns on only together with engineSlot (the slot says which engine owns it, in which phase and epoch; the queue
// has no ownership mechanism of its own). When on, for the four synchronous generation routes the studio forwards
// (POST /sdapi/v1/txt2img, /sdapi/v1/img2img, /v1/images/generations, /v1/images/edits; exact path, query allowed):
//   * admission at arrival, before any body byte is read, in this order: 503 ENGINE_NOT_READY (the image engine does
//     not own the slot as "loaded" and ready), 429 QUEUE_FULL (1 running + `limit` waiting), 413 (declared size over
//     the ceiling), 429 QUEUE_FULL with reason "body-budget" (the aggregate in-memory reservation); then a FIFO place
//     (services/job-queue.cjs, unchanged). Refusals before the body was read close the connection after the answer
//     without reading the body (http/refusal-close.cjs);
//   * the body is held in memory as the received chunks (never parsed, joined or re-encoded), bounded per request by
//     the ceiling (actual bytes counted) and in total by the reservation; an upload ends after `uploadIdleMs` without
//     data or `uploadMaxMs` from arrival (408);
//   * one job is forwarded at a time, only once its body is complete, and only if the engine recorded at admission
//     (slot epoch and process) is still the one that owns the slot and is ready; otherwise 503 ENGINE_NOT_READY;
//   * the running place is released exactly once, and only when the upstream response has ended, the upstream request
//     failed, or the engine process exit was seen. A client that leaves never releases it: the answer is read and
//     discarded and the job shows as abandoned. A running job has no deadline (sd-server can't cancel it, #64);
//   * a waiting job whose client leaves is never forwarded; its body and reservation go at once;
//   * a waiting job gets 503 QUEUE_TIMEOUT after `maxWaitMs`; stop and restart refuse waiting jobs (503
//     ENGINE_NOT_READY); every queue answer keeps { ok: false, error, code } and adds a `detail` beginning
//     "Generation failed:", which the unchanged WebUI shows;
//   * only while the running image backend is sd-server: with the Core ML worker ("apple-npu") requests pass through
//     to today's proxy unchanged and the queue reports itself inactive.
"use strict";

const httpDefault = require("node:http");
const fsDefault = require("node:fs");
const pathDefault = require("node:path");
const { jobQueueSetting, createJobQueue } = require("./job-queue.cjs");
const { closeAfterAnswer } = require("../http/refusal-close.cjs");

const MiB = 1024 * 1024;
const DEFAULT_WAIT_MS = 10 * 60 * 1000;
const MIN_RETRY_AFTER_SECONDS = 30;          // design §7: an estimate from recent job times, at least 30 s
const UPLOAD_MAX_MS = 120 * 1000;            // design §5.2: one absolute upload deadline from arrival
const UPLOAD_IDLE_MS = 30 * 1000;            // design §5.2: idle limit from the last byte received
const QUEUED_ROUTE = /^\/(?:sdapi\/v1\/(?:txt2img|img2img)|v1\/images\/(?:generations|edits))(?:\?|$)/;

const RANGES = {
  limit: { name: "imageQueueLimit", env: "USAP_IMAGE_QUEUE_LIMIT", min: 1, max: 2, def: 2 },
  bodyBytes: { name: "imageQueueBodyBytes", env: "USAP_IMAGE_QUEUE_BODY_BYTES", min: 1 * MiB, max: 64 * MiB, def: 64 * MiB },
  bodyBudgetBytes: { name: "imageQueueBodyBudgetBytes", env: "USAP_IMAGE_QUEUE_BODY_BUDGET_BYTES", min: 1 * MiB, max: 192 * MiB, def: 128 * MiB },
};

/**
 * The setting: `USAP_IMAGE_QUEUE` (environment, wins) or scheduler.json `imageQueue`, on | off, default off.
 * USAP_SCHEDULER=off forces it off (forcedOffBy "scheduler-off"); so does engineSlot not being on (forcedOffBy
 * "engine-slot-off"): the queue relies on the slot for engine ownership. The longest wait: USAP_IMAGE_QUEUE_MAX_WAIT_MS
 * or "imageQueueMaxWaitMs", 1 s to 60 min, default 10 min. The numbers in RANGES: environment, then scheduler.json,
 * then the default; a value outside its range is ignored and reported, never clamped. A budget smaller than the
 * per-request ceiling is ignored too (a chunked request reserves the whole ceiling and could never be admitted).
 */
function imageQueueSetting({ env = process.env, configDir, schedulerMode, engineSlotMode, fs = fsDefault, path = pathDefault } = {}) {
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
  const bodyBytes = num("bodyBytes");
  let bodyBudgetBytes = num("bodyBudgetBytes");
  if (bodyBudgetBytes < bodyBytes) {
    ignored.push({ name: "imageQueueBodyBudgetBytes", source: "combined", reason: "must be at least imageQueueBodyBytes" });
    bodyBudgetBytes = Math.max(RANGES.bodyBudgetBytes.def, bodyBytes);
  }
  const base = jobQueueSetting({ env, configDir, schedulerMode, name: "imageQueue", envName: "USAP_IMAGE_QUEUE",
    waitName: "imageQueueMaxWaitMs", waitEnvName: "USAP_IMAGE_QUEUE_MAX_WAIT_MS", defaultWaitMs: DEFAULT_WAIT_MS, limit });
  let mode = base.mode;
  let forcedOffBy = base.forcedOffBy;
  if (mode === "on" && engineSlotMode !== "on") { mode = "off"; forcedOffBy = "engine-slot-off"; }
  return Object.freeze({
    mode, requested: base.requested, forcedOffBy, limit, maxWaitMs: base.maxWaitMs, bodyBytes, bodyBudgetBytes,
    ignored: Object.freeze([...base.ignored, ...ignored].map((x) => Object.freeze(x))),
  });
}

/** True for the four queued generation routes (POST, exact path, a query string allowed). */
function isQueuedRoute(req) {
  return req.method === "POST" && QUEUED_ROUTE.test(String(req.url || ""));
}

/**
 * @param {object} o
 * @param {object} o.setting              imageQueueSetting(...), mode "on"
 * @param {object} o.engine               { snapshot(): { slotOwner, slotPhase, epoch, proc, ready, port, backend },
 *                                          trackGeneration?(res) } (serve.cjs: engineSlot + image engine state)
 * @param {Function} o.json               json(res, status, body)
 * @param {Function} o.withoutAuthHeaders, o.withoutCorsHeaders   the proxy's own header filters
 */
function createImageQueue({ setting, engine, json, withoutAuthHeaders, withoutCorsHeaders, http = httpDefault, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, log = console, uploadMaxMs = UPLOAD_MAX_MS, uploadIdleMs = UPLOAD_IDLE_MS }) {
  for (const [k, v] of Object.entries({ setting, engine, json, withoutAuthHeaders, withoutCorsHeaders })) if (!v) throw new Error(`image-queue: ${k} required`);
  const queue = createJobQueue({ engineLabel: "image engine", limit: setting.limit, maxWaitMs: setting.maxWaitMs, now, setTimer, clearTimer });
  let seq = 0;
  let reservedBytes = 0;
  const live = new Set();  // jobs holding a reservation (admitted, until their body is forwarded or dropped)
  let running = null;      // the forwarded job: { job, startedAt, abandoned }
  const counts = { notReady: 0, tooLarge: 0, bodyBudget: 0, uploadTimedOut: 0, uploadFailed: 0, leftWhileWaiting: 0,
    leftWhileRunning: 0, refusedAtDispatch: 0, forwarded: 0, completed: 0, upstreamFailed: 0, engineExited: 0, passedThrough: 0 };

  const retryAfter = (s) => Math.max(MIN_RETRY_AFTER_SECONDS, Number(s) || 0);
  const lower = (t) => t.charAt(0).toLowerCase() + t.slice(1);
  const body = (code, error, extra = {}) => ({ ok: false, code, error, detail: `Generation failed: ${lower(error)}`, ...extra });

  function engineState() {
    let s = null;
    try { s = engine.snapshot(); } catch (_) { s = null; }
    if (!s) return { ok: false, inactive: false, s: {} };
    if (s.backend !== "sd-server") return { ok: false, inactive: true, s };
    return { ok: s.slotOwner === "image" && s.slotPhase === "loaded" && s.ready === true && Boolean(s.proc), inactive: false, s };
  }
  const notReadyBody = () => body("ENGINE_NOT_READY", "The image engine is not ready (not loaded, loading, or stopping). Load the model, then try again.");

  // Refuse before the body was read: the answer, then the connection closes without reading the body.
  function refuseEarly(req, res, status, payload, retryAfterSeconds) {
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    closeAfterAnswer(req, res);
    if (retryAfterSeconds) res.setHeader("Retry-After", String(retryAfterSeconds));
    json(res, status, payload);
  }

  function releaseBody(job) {
    if (job.bodyReleased) return false;
    job.bodyReleased = true;
    reservedBytes -= job.reservation;
    job.chunks = null;
    live.delete(job);
    return true;
  }

  function handle(req, res, passThrough) {
    const e = engineState();
    // D5: only sd-server is queued; the Core ML worker keeps today's proxy, unchanged.
    if (e.inactive) { counts.passedThrough += 1; return passThrough(req, res); }
    // 1. Engine not ready (D3): nothing is queued during start-up, loading or unloading.
    if (!e.ok) { counts.notReady += 1; refuseEarly(req, res, 503, notReadyBody(), MIN_RETRY_AFTER_SECONDS); return undefined; }
    // 2. Capacity: the queue answers 429 itself (and counts it) when running + waiting is at its limit.
    const st = queue.stats();
    if (st.running + st.waiting >= 1 + st.limit) {
      return queue.admit(() => {}).then((r) => {
        const s = retryAfter(r.retryAfterSeconds);
        refuseEarly(req, res, 429, body("QUEUE_FULL", `The image queue is full. Try again in about ${s} s.`), s);
      });
    }
    // 3. Declared size over the ceiling: 413 and close at once, nothing read.
    const declaredRaw = req.headers["content-length"];
    const declared = declaredRaw === undefined ? null : Number(declaredRaw);
    if (declared !== null && (!Number.isFinite(declared) || declared > setting.bodyBytes)) {
      counts.tooLarge += 1;
      refuseEarly(req, res, 413, body("BODY_TOO_LARGE", `The request body is too large. The limit is ${Math.round(setting.bodyBytes / MiB)} MB.`));
      return undefined;
    }
    // 4. Aggregate body reservation: the declared length, or the whole ceiling for a chunked body.
    const need = declared !== null ? Math.max(declared, 0) : setting.bodyBytes;
    if (reservedBytes + need > setting.bodyBudgetBytes) {
      counts.bodyBudget += 1;
      refuseEarly(req, res, 429, body("QUEUE_FULL", `The image queue is full: other requests hold its memory. Try again in about ${MIN_RETRY_AFTER_SECONDS} s.`, { reason: "body-budget" }), MIN_RETRY_AFTER_SECONDS);
      return undefined;
    }
    // 5. Admission: the reservation and the FIFO place are taken here, synchronously (no await since step 1).
    reservedBytes += need;
    const job = { id: ++seq, reservation: need, chunks: [], bytes: 0, declared, epoch: e.s.epoch, proc: e.s.proc,
      url: req.url, headers: { ...req.headers }, bodyReleased: false, withdraw: null };
    live.add(job);
    const turnP = queue.admit((cb) => { job.withdraw = cb; });
    return runJob(req, res, job, turnP);
  }

  function runJob(req, res, job, turnP) {
    return new Promise((resolveJob) => {
      let release = null;
      let clientGone = false;
      let upstreamRes = null;
      let uploadDone = false;
      let uploadError = null;
      const timers = [];
      const startedAt = now();
      let lastDataAt = startedAt;

      const finish = () => { releaseBody(job); for (const t of timers) clearTimer(t); if (release) release(); resolveJob(); };
      const answer = (status, payload, retryAfterSeconds) => {
        if (clientGone || res.headersSent || res.writableEnded || res.destroyed) return;
        if (!uploadDone) closeAfterAnswer(req, res); // the body is not complete: answer, then close without reading on
        if (retryAfterSeconds) res.setHeader("Retry-After", String(retryAfterSeconds));
        json(res, status, payload);
      };

      // ── Upload: kept in memory as received chunks, bounded by the ceiling and the deadlines ──
      let uploadSettle;
      const uploadP = new Promise((r) => { uploadSettle = r; });
      const failUpload = (code, extra = {}) => {
        if (uploadDone || uploadError) return;
        uploadError = { code, ...extra };
        req.removeListener("data", onData); req.removeListener("end", onEnd);
        for (const t of timers) clearTimer(t);
        job.chunks = null; // drop what was received; the reservation goes with the job
        uploadSettle(false);
      };
      let idleTimer = null;
      const armIdle = () => {
        if (idleTimer) clearTimer(idleTimer);
        const left = lastDataAt + uploadIdleMs - now();
        idleTimer = setTimer(() => failUpload("UPLOAD_TIMEOUT", { phase: "idle" }), Math.max(0, left));
        timers.push(idleTimer);
      };
      function onData(chunk) {
        if (uploadDone || uploadError) return;
        job.bytes += chunk.length;
        lastDataAt = now();
        if (job.bytes > setting.bodyBytes || (job.declared !== null && job.bytes > job.declared) || job.bytes > job.reservation) return failUpload("TOO_LARGE");
        job.chunks.push(chunk);
        armIdle();
      }
      function onEnd() {
        if (uploadDone || uploadError) return;
        if (!req.complete || (job.declared !== null && job.bytes !== job.declared)) return failUpload("CLIENT_GONE");
        uploadDone = true;
        for (const t of timers) clearTimer(t);
        uploadSettle(true);
      }
      timers.push(setTimer(() => failUpload("UPLOAD_TIMEOUT", { phase: "total" }), Math.max(0, startedAt + uploadMaxMs - now())));
      armIdle();
      req.on("data", onData);
      req.on("end", onEnd);
      req.on("aborted", () => failUpload("CLIENT_GONE"));
      res.once("close", () => {
        if (res.writableEnded) return;
        clientGone = true;
        if (running && running.job === job) {
          // Running: ownership is kept until the engine's answer ends; the answer is read and discarded.
          running.abandoned = true;
          counts.leftWhileRunning += 1;
          if (upstreamRes) { upstreamRes.unpipe(res); upstreamRes.resume(); }
          return;
        }
        failUpload("CLIENT_GONE");
        if (job.withdraw && !release) { job.withdraw(); counts.leftWhileWaiting += 1; } // waiting: leave at once
      });
      // An upload that fails while the job waits leaves the queue at once (its turn is never granted).
      uploadP.then((ok) => { if (!ok && !release && job.withdraw) job.withdraw(); });

      const answerUploadError = () => {
        const e = uploadError;
        if (!e || e.code === "CLIENT_GONE") return;
        if (e.code === "TOO_LARGE") { counts.tooLarge += 1; return answer(413, body("BODY_TOO_LARGE", `The request body is too large. The limit is ${Math.round(setting.bodyBytes / MiB)} MB.`)); }
        if (e.code === "UPLOAD_TIMEOUT") {
          counts.uploadTimedOut += 1;
          return answer(408, body("UPLOAD_TIMEOUT", e.phase === "idle"
            ? `The request body stopped arriving: no data for ${Math.round(uploadIdleMs / 1000)} s.`
            : `The request body took longer than ${Math.round(uploadMaxMs / 1000)} s to arrive.`, { phase: e.phase }));
        }
        counts.uploadFailed += 1;
        return answer(400, body("UPLOAD_FAILED", "The request body could not be received."));
      };

      turnP.then(async (turn) => {
        if (!turn.ok) {
          // Not run: queue timeout, refused by stop/restart/shutdown, or withdrawn (client gone / upload failed).
          if (turn.code === "CLIENT_GONE") { answerUploadError(); return finish(); }
          failUpload("CLIENT_GONE");
          answer(turn.status, body(turn.code, turn.error), retryAfter(turn.retryAfterSeconds));
          return finish();
        }
        release = turn.release;
        // Our turn: forward only once the body is complete (bounded by the upload deadlines).
        const ok = await uploadP;
        if (!ok) { answerUploadError(); return finish(); }
        if (clientGone) return finish(); // left while waiting for its own upload: never forwarded
        // Check at dispatch (D3): the engine recorded at admission still owns the slot and is ready.
        const e = engineState();
        if (!e.ok || e.s.epoch !== job.epoch || e.s.proc !== job.proc) {
          counts.refusedAtDispatch += 1;
          answer(503, notReadyBody(), MIN_RETRY_AFTER_SECONDS);
          return finish();
        }
        await forward(req, res, job, e.s, (r) => { upstreamRes = r; }, () => clientGone);
        return finish();
      });
    });
  }

  // Forward the held body to sd-server. Resolves exactly once, when the running place may be released: the upstream
  // response ended, the upstream request or response failed, or the engine process exit was seen.
  function forward(req, res, job, s, setUpstream, isClientGone) {
    return new Promise((resolveOwn) => {
      counts.forwarded += 1;
      running = { job, startedAt: now(), abandoned: isClientGone() };
      const proc = s.proc;
      let owned = true;
      let up = null;
      const onExit = () => { counts.engineExited += 1; try { if (up) up.destroy(); } catch (_) { /* gone */ } own(); };
      function own() {
        if (!owned) return;
        owned = false;
        try { proc.removeListener("exit", onExit); } catch (_) { /* gone */ }
        releaseBody(job); // normally already released after writing
        running = null;
        resolveOwn();
      }
      if (typeof engine.trackGeneration === "function") engine.trackGeneration(req, res); // 9.9e count, as the proxy
      const headers = withoutAuthHeaders(job.headers); // USAP credentials stay in USAP (as the proxy)
      delete headers.host;
      headers.host = `127.0.0.1:${s.port}`;
      up = http.request({ hostname: "127.0.0.1", port: s.port, path: job.url, method: "POST", headers, timeout: 0 }, (upRes) => {
        setUpstream(upRes);
        if (!isClientGone() && !res.headersSent && !res.destroyed) {
          res.writeHead(upRes.statusCode || 502, { ...withoutCorsHeaders(upRes.headers) });
          upRes.pipe(res);
        } else {
          upRes.resume(); // the client left: read and discard (counted by Node only; nothing is kept)
        }
        upRes.on("end", () => { counts.completed += 1; own(); });
        upRes.on("error", () => { counts.upstreamFailed += 1; own(); });
        upRes.on("close", () => { if (!upRes.complete) { counts.upstreamFailed += 1; own(); } });
      });
      up.on("error", (err) => {
        counts.upstreamFailed += 1;
        if (!isClientGone() && !res.headersSent && !res.destroyed) json(res, 502, { ok: false, error: `Image backend is not reachable: ${err.message}` });
        own();
      });
      if (proc.exitCode !== null || proc.signalCode !== null) { onExit(); return; }
      proc.once("exit", onExit);
      // Write the held chunks with backpressure, then drop them and the reservation.
      const chunks = job.chunks || [];
      let i = 0;
      const writeMore = () => {
        while (i < chunks.length) {
          if (!owned) return;
          const ok = up.write(chunks[i]);
          i += 1;
          if (!ok) { up.once("drain", writeMore); return; }
        }
        if (!owned) return;
        up.end();
        releaseBody(job);
      };
      writeMore();
    });
  }

  return {
    isQueuedRoute,
    handle,
    /** Stop, restart, shutdown: refuse every waiting job (the running one is not touched). */
    refuseWaiting(reason = "stopping") {
      return queue.refuseWaiting({ status: 503, code: "ENGINE_NOT_READY", retryAfterSeconds: MIN_RETRY_AFTER_SECONDS,
        error: reason === "shutdown" ? "The server is stopping." : "The image engine is being stopped or restarted. Load the model, then try again." });
    },
    /** True while a forwarded job is unsettled (restart answers 409 then). */
    forwardedUnsettled: () => running !== null,
    stats() {
      const st = queue.stats();
      const e = engineState();
      return { running: st.running, waiting: st.waiting, limit: st.limit, known: true, abandoned: Boolean(running && running.abandoned),
        runningSeconds: running ? Math.max(0, Math.round((now() - running.startedAt) / 1000)) : 0, inactive: e.inactive ? "backend" : null };
    },
    memory: () => ({ bodyBytes: setting.bodyBytes, budgetBytes: setting.bodyBudgetBytes, reservedBytes, heldJobs: live.size }),
    counts: () => ({ ...queue.counts(), ...counts }),
    maxWaitMs: setting.maxWaitMs,
  };
}

module.exports = { imageQueueSetting, createImageQueue, isQueuedRoute, MIN_RETRY_AFTER_SECONDS, UPLOAD_MAX_MS, UPLOAD_IDLE_MS };
