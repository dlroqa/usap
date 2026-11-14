// services/chat.cjs — chat requests to the text engine (Step 9.8h).
//
// Moved unchanged from serve.cjs: the keep-alive connection to llama-server, POST /api/llm/chat request
// building (sampling settings, web-search results added by services/web-search.cjs), streaming (SSE passed
// through as the engine sends it, with a `web_sources` event first when there are sources), non-streaming
// JSON, the one-time retry with a smaller context after an out-of-memory error, and aborting the engine
// request when the client disconnects. Only free variables changed: they come from `deps`, and the engine
// state (PORT_LLM, llmSettings) is read through `state` (getters only; state.X was X).
//
// Step 9.9f-1 (services/chat-timeouts.cjs, docs/roadmap/STEP9_9F_TIMEOUTS.md): optional running-request deadlines,
// engine cancellation confirmation and the UNRESPONSIVE gate, only when `deps.chatTimeouts` is given (setting not
// "off"). Without it every path below is exactly the previous one.
//
// Prompt order is unchanged: the client's messages are passed on as sent; web results, when requested,
// are one extra "user" message after the leading system messages (see docs/security/WEB_CONTENT_TRUST.md).
"use strict";

const promptBoundary = require("./prompt-boundary.cjs");
const { prepareAttachments } = require("./attachments.cjs");

/**
 * Call `done(complete)` exactly once when an engine response is over: complete=true after `end`, false when it was
 * cut off first (`aborted`, `error`, or `close` before the body was complete). Listeners are removed afterwards, so
 * late or repeated events do nothing (#90). An engine connection that stays open without any event is not covered:
 * that needs a timeout for a running request (Step 9.9f).
 */
function onEngineResponseSettled(engineRes, done) {
  let settled = false;
  const finish = (complete) => {
    if (settled) return;
    settled = true;
    engineRes.removeListener("end", onEnd);
    engineRes.removeListener("aborted", onCut);
    engineRes.removeListener("close", onClose);
    engineRes.removeListener("error", onCut);
    engineRes.on("error", () => {}); // a late error after settling must not become an uncaught exception
    done(complete);
  };
  const onEnd = () => finish(true);
  const onCut = () => finish(false);
  const onClose = () => finish(engineRes.complete === true);
  engineRes.on("end", onEnd);
  engineRes.on("aborted", onCut);
  engineRes.on("error", onCut);
  engineRes.on("close", onClose);
}

const REQUIRED = ["state","errorBody","errorStatus","http","json","redactPaths","requestJson","runExclusiveLlmOperation","startLlm","webSearch"];

function createChatService(deps) {
  for (const name of REQUIRED) {
    if (deps[name] === undefined || deps[name] === null) throw new Error(`chat: missing dependency ${name}`);
  }
  const { state, errorBody, errorStatus, http, json, redactPaths, requestJson, runExclusiveLlmOperation, startLlm, webSearch } = deps;
  // P3: prompt protections (all off by default); read per request so the setting applies without a restart.
  const promptProtections = typeof deps.promptProtections === "function" ? deps.promptProtections : () => promptBoundary.PROTECTIONS;

  // HTTP keep-alive agent for llama-server (eliminates TCP handshake per request)
  const llmHttpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 1,
    keepAliveMsecs: 30000,
  });

  // Declared inside the request handler in serve.cjs before Step 9.8h.
  function isOomError(msg) {
    if (!msg) return false;
    const lower = String(msg).toLowerCase();
    return lower.includes("out of memory") ||
           lower.includes("failed to allocate") ||
           lower.includes("failed to initialize the context") ||
           lower.includes("oom") ||
           lower.includes("not enough memory") ||
           lower.includes("allocation failed") ||
           lower.includes("failed to create context");
  }

  async function retryLowerContext() {
    const currentCtx = state.llmSettings.contextSize || 4096;
    const contextLadder = [32768, 24576, 16384, 12288, 8192, 4096, 2048, 1024, 512];
    const nextLimit = contextLadder.find(limit => limit < currentCtx);
    if (!nextLimit) {
      throw new Error("Cannot lower context size any further.");
    }
    console.log(`  [llm] Retrying with lower context limit: ${nextLimit} (was ${currentCtx})`);
    
    const originalModel = state.llmSettings.model;
    const newSettings = {
      model: originalModel,
      threads: state.llmSettings.threads,
      contextSize: nextLimit,
      gpuLayers: state.llmSettings.gpuLayers,
      enableThinking: state.llmSettings.enableThinking,
    };
    
    // Step 9.9f-2: the existing out-of-memory recovery path; memory admission assesses it but never refuses it.
    await runExclusiveLlmOperation(() => startLlm(newSettings, { admissionPath: "oom-retry" }));
  }

  // The engine refused the connection: it isn't listening (stopped, or crashed before the server noticed). Answer
  // like the chat route does when it knows the engine is down, instead of a raw 500 that names the engine's port.
  // Step 9.9f-1. `T` exists only when chatTimeouts is "observe" or "on".
  const T = deps.chatTimeouts && deps.chatTimeouts.mode !== "off" ? deps.chatTimeouts : null;
  const ON = Boolean(T && T.mode === "on");
  const newCtx = () => ({ seq: null, inFlight: false, aborted: false, abortTarget: null,
    // The studio stops waiting for this engine request. Its computation is unknown until the guard confirms it.
    abortEngine() {
      if (this.aborted) return;
      this.aborted = true;
      const wasInFlight = this.inFlight;
      this.inFlight = false;
      try { if (this.abortTarget) this.abortTarget(); } catch (_) { /* already gone */ }
      if (ON && wasInFlight) T.noteAbort(this.seq);
    } });
  // One armed deadline at a time (first byte → idle for streams; total for non-streaming). Fake-timer friendly.
  function makeDeadline(onExpire) {
    const { setTimer, clearTimer, now } = T.timers;
    let timer = null;
    let started = false;
    const clear = () => { if (timer) { clearTimer(timer); timer = null; } };
    const arm = (phase, seconds) => {
      clear();
      started = true;
      const at = now();
      timer = setTimer(() => { timer = null; onExpire(phase, now() - at); }, seconds * 1000);
    };
    return { arm, clear, get started() { return started; } };
  }
  // Only SSE comment lines (": …") and blank lines: a transport keep-alive, not inference progress. llama.cpp
  // b11418 sends none; this only keeps a future keep-alive from hiding a stall.
  const keepAliveOnly = (chunk) => /^(?:[ \t]*\r?\n|:[^\n]*\n)*$/.test(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
  const timeoutMessage = (phase, seconds) => phase === "idle"
    ? `The text engine stopped responding (no output for ${seconds} s). The answer is incomplete; the request was stopped.`
    : phase === "total"
      ? `The text engine didn't finish within ${seconds} s. The request was stopped; try a shorter answer, or reload the model if this keeps happening.`
      : `The text engine didn't start answering within ${seconds} s. The request was stopped; try again, or reload the model if this keeps happening.`;

  const ENGINE_GONE = { ok: false, code: "ENGINE_NOT_READY", error: "The text engine isn't running (it stopped or crashed). Load a text model, or wait for it to restart, then try again." };

  // Engine sockets that have already carried a request. Node marks `reusedSocket` only when a request takes an idle
  // socket, not when it waited for the one socket (maxSockets 1) and got it as the previous response ended, so the
  // studio keeps track itself.
  const usedEngineSockets = new WeakSet();
  // A stale kept-alive connection fails at once after it is handed to a request; a request the engine worked on
  // fails later. Only a failure within this window of the attempt getting its connection is retried (a request can
  // wait longer than that for the one connection while another stream runs, so creation time doesn't count).
  const STALE_RETRY_WINDOW_MS = 2000;
  // Connection errors (ECONNRESET, ETIMEDOUT, …) are answered without Node's message, which can name the engine's
  // local address and port.
  const isTransportError = (err) => Boolean(err && !err.upstreamStatus && typeof err.code === "string" && /^E[A-Z]+$/.test(err.code) && (err.syscall || /socket hang up/i.test(err.message || "")));
  const transportBody = (err) => ({ ok: false, code: "ENGINE_CONNECTION_ERROR", error: `The connection to the text engine failed (${err.code}). Try again.` });

  async function doLlmChat(req, res, body, retryCount = 0, ctx = newCtx()) {
    try {
      const isStream = body.stream === true;
      const protections = promptProtections();
      // P4-1: validate `attachments` records (400 INVALID_ATTACHMENTS) before anything else runs. Without records
      // this is the client's own array, unchanged.
      const prepared = prepareAttachments(body, protections.documents);
      const rawMessages = prepared.messages;
      if (prepared.truncated && !res.headersSent) res.setHeader("X-USAP-Attachments-Truncated", "1");
      const webAugmentation = await webSearch.augmentMessagesWithWebSearch(rawMessages, body);
      const requestData = JSON.stringify({
        model: state.llmSettings.model || "local-model",
        // P2: built from typed segments; byte-identical to webAugmentation.messages while no protection is on.
        messages: promptBoundary.engineMessages(rawMessages, webAugmentation, protections, prepared),
        temperature: Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : 0.7,
        max_tokens: Math.max(1, Math.min(4096, Number(body.max_tokens) || Number(body.maxTokens) || 1024)),
        stream: isStream,
        // New sampling parameters
        top_p: Number.isFinite(Number(body.top_p)) ? Number(body.top_p) : 0.95,
        top_k: Number.isFinite(Number(body.top_k)) ? Number(body.top_k) : 40,
        min_p: Number.isFinite(Number(body.min_p)) ? Number(body.min_p) : 0.05,
        repeat_penalty: Number.isFinite(Number(body.repeat_penalty)) ? Number(body.repeat_penalty) : 1.1,
        frequency_penalty: Number.isFinite(Number(body.frequency_penalty)) ? Number(body.frequency_penalty) : 0.0,
        presence_penalty: Number.isFinite(Number(body.presence_penalty)) ? Number(body.presence_penalty) : 0.0,
        seed: Number.isInteger(Number(body.seed)) ? Number(body.seed) : undefined,
        stop: Array.isArray(body.stop) ? body.stop : (body.stop ? [body.stop] : undefined),
      });

      if (isStream) {
        let clientReq;
        let cancelled = false; // the client left: never recover, only clean up
        // 9.9f-1: `final` is set when a timeout settled the request (on); every engine handler is then a no-op.
        const live = { final: false };
        const observed = new Set();
        const dl = T ? makeDeadline((phase, elapsedMs) => {
          if (!ON) {
            if (!observed.has(phase)) { observed.add(phase); T.recordWould(phase, { stream: true, elapsedMs }); }
            return;
          }
          if (live.final || cancelled || res.writableEnded || res.destroyed) return;
          live.final = true;
          const seconds = phase === "idle" ? T.setting.idleSeconds : T.setting.firstByteSeconds;
          T.recordTimeout(phase, { stream: true, elapsedMs, seq: ctx.seq });
          ctx.abortEngine(); // before the answer: a queue release triggered by it must see the abort
          const message = timeoutMessage(phase, seconds);
          if (!res.headersSent) return json(res, 504, { ok: false, code: "ENGINE_TIMEOUT", phase, error: message });
          // WebUI-compatible: a data event with `error` is shown as an error; no [DONE], so it is never a success.
          res.write(`data: ${JSON.stringify({ error: { message, code: "ENGINE_TIMEOUT", phase } })}\n\n`);
          res.end();
        }) : null;
        res.on("close", () => {
          if (res.writableEnded) return;
          cancelled = true;
          if (dl) {
            dl.clear();
            if (!live.final && ctx.inFlight && !ctx.cancelCounted) { ctx.cancelCounted = true; T.recordClientCancel(ctx.seq); }
            if (ON && !live.final) { ctx.abortEngine(); return; }
          }
          if (clientReq && !clientReq.destroyed) clientReq.destroy();
        });
        // One engine request; `fresh` is true for the single retry after a reused connection was closed (below).
        const sendToEngine = (fresh) => {
        let answered = false; // the engine sent a status line (and maybe output): never retry after that
        let acquiredAt = null; // when THIS attempt got its engine connection
        clientReq = http.request({
          hostname: "127.0.0.1",
          port: state.PORT_LLM,
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(requestData),
          },
          agent: llmHttpAgent,  // ✅ HTTP keep-alive: eliminates TCP handshake per turn
        }, (clientRes) => {
          answered = true;
          if (live.final) { clientRes.resume(); return; }
          if (clientRes.statusCode < 200 || clientRes.statusCode >= 300) {
            let errorBody = "";
            clientRes.setEncoding("utf8");
            clientRes.on("data", (chunk) => { errorBody += chunk; });
            // #90: the engine answered with an error status; its body can be cut off (engine crash, reset). Answer the
            // client once either way. Never retried: the engine had already answered.
            onEngineResponseSettled(clientRes, async (complete) => {
              if (live.final) return;
              if (dl) { dl.clear(); ctx.inFlight = false; }
              if (!complete) {
                if (cancelled || res.destroyed || res.writableEnded) return; // the client left: nothing to answer
                if (!res.headersSent) return json(res, 500, transportBody({ code: "ECONNRESET" }));
                return res.end();
              }
              let message = `Text backend returned HTTP ${clientRes.statusCode}`;
              try {
                message = JSON.parse(errorBody || "{}").error?.message || message;
              } catch (_) {}
              
              if (isOomError(message) && retryCount === 0) {
                try {
                  await retryLowerContext();
                  // 9.9f-1: the retry is a new engine attempt with a fresh deadline; retryCount stays <= 1.
                  return doLlmChat(req, res, body, retryCount + 1, ctx);
                } catch (retryErr) {
                  console.error("Failed OOM recovery retry:", retryErr);
                }
              }
              json(res, clientRes.statusCode || 500, { ok: false, error: redactPaths(message) });
            });
            return;
          }
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "X-Content-Type-Options": "nosniff",
          });
          const socket = res.socket || res.connection;
          socket?.setNoDelay?.(true);
          res.flushHeaders?.();
          if (webAugmentation.webSources.length) {
            res.write(`event: web_sources\ndata: ${JSON.stringify({ sources: webAugmentation.webSources })}\n\n`);
          }
          if (!dl) {
            clientRes.on("data", (chunk) => res.write(chunk));
            clientRes.on("end", () => res.end());
            clientRes.on("error", (err) => res.destroy(err));
          } else {
            // 9.9f-1: the first BODY chunk (not the status line) ends the first-byte deadline; every body chunk
            // that isn't only a keep-alive re-arms the idle deadline.
            clientRes.on("data", (chunk) => {
              if (live.final) return;
              if (!keepAliveOnly(chunk)) dl.arm("idle", T.setting.idleSeconds);
              res.write(chunk);
            });
            clientRes.on("end", () => { dl.clear(); ctx.inFlight = false; if (!live.final) res.end(); });
            clientRes.on("error", (err) => { dl.clear(); ctx.inFlight = false; if (!live.final) res.destroy(err); });
          }
        });

        let reused = false;
        clientReq.on("socket", (socket) => {
          acquiredAt = Date.now();
          reused = usedEngineSockets.has(socket);
          usedEngineSockets.add(socket);
        });
        clientReq.on("error", async (err) => {
          // A kept-alive engine connection that llama-server closed just as it was reused (seen when a stream starts
          // right after another one ends): nothing came back, so the engine never answered it. Send it once more on
          // a new connection; the prompt and web results are reused, nothing else runs again. Only when ALL hold:
          // first attempt, the connection had carried an earlier request, a reset/broken pipe within the window,
          // no status line or output from the engine, nothing sent to the client, and the client is still there.
          const stale = !fresh && !cancelled && !answered && (reused || clientReq.reusedSocket)
            && (err.code === "ECONNRESET" || err.code === "EPIPE") && acquiredAt !== null && Date.now() - acquiredAt < STALE_RETRY_WINDOW_MS
            && !res.headersSent && !res.destroyed;
          if (cancelled || live.final) return; // the client cancelled, or a timeout settled it: aborted on purpose
          if (stale) {
            console.log("  [llm] the engine closed a reused connection; sending the request again on a new one");
            return sendToEngine(true);
          }
          console.error("LLM stream request error:", err);
          if (dl) { dl.clear(); ctx.inFlight = false; }
          if (isOomError(err.message) && retryCount === 0) {
            try {
              await retryLowerContext();
              return doLlmChat(req, res, body, retryCount + 1, ctx);
            } catch (retryErr) {
              console.error("Failed OOM recovery retry:", retryErr);
            }
          }
          if (!res.headersSent && err.code === "ECONNREFUSED") return json(res, 409, ENGINE_GONE);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify(isTransportError(err) ? transportBody(err) : { ok: false, error: redactPaths(err.message) }));
          } else {
            res.end();
          }
        });

        if (dl) {
          ctx.seq = state.llmProcSeq;
          ctx.inFlight = true;
          ctx.aborted = false;
          const sent = clientReq;
          ctx.abortTarget = () => { if (!sent.destroyed) sent.destroy(); };
        }
        clientReq.write(requestData);
        clientReq.end();
        // Armed once, at the first write of this attempt: the stale-connection retry doesn't restart it.
        if (dl && !dl.started) dl.arm("first-byte", T.setting.firstByteSeconds);
        };
        sendToEngine(false);
        return;
      } else if (ON) {
        return nonStreamEnforced(req, res, body, retryCount, ctx, requestData, webAugmentation, prepared);
      } else {
        // Observe (9.9f-1): the legacy request, unchanged; a passive timer only records a "would have timed out".
        let pending = true;
        let wouldTimer = null;
        if (T) {
          const t0 = T.timers.now();
          wouldTimer = T.timers.setTimer(() => { wouldTimer = null; if (pending) T.recordWould("total", { stream: false, elapsedMs: T.timers.now() - t0 }); }, T.setting.nonStreamTotalSeconds * 1000);
          res.once("close", () => { if (pending && !res.writableEnded) T.recordClientCancel(null); });
        }
        const settled = () => { pending = false; if (wouldTimer) { T.timers.clearTimer(wouldTimer); wouldTimer = null; } };
        try {
          const call = requestJson(`http://127.0.0.1:${state.PORT_LLM}/v1/chat/completions`, JSON.parse(requestData), 300000);
          const result = await (T ? call.finally(settled) : call);
          if (webAugmentation.webSources.length) {
            result.web_sources = webAugmentation.webSources;
          }
          if (prepared.truncated) result.attachments_truncated = true;
          return json(res, 200, result);
        } catch (err) {
          if (isOomError(err.message) && retryCount === 0) {
            try {
              await retryLowerContext();
              return doLlmChat(req, res, body, retryCount + 1, ctx);
            } catch (retryErr) {
              console.error("Failed OOM recovery retry:", retryErr);
            }
          }
          // #67: an engine error answers like the streaming path: the engine's status and message.
          if (err.upstreamStatus) return json(res, err.upstreamStatus, { ok: false, error: redactPaths(err.message) });
          if (err.code === "ECONNREFUSED") return json(res, 409, ENGINE_GONE);
          // Not retried: a non-streaming request may already have run (e.g. ECONNRESET while the engine was dying).
          if (isTransportError(err)) return json(res, 500, transportBody(err));
          throw err;
        }
      }
    } catch (err) {
      return json(res, errorStatus(err), errorBody(err));
    }
  }

  // 9.9f-1, mode "on": the engine request behind a non-streaming chat, with an abort handle. Parsing and errors
  // are exactly requestJson's (serve.cjs); only the limit differs: a wall-clock total kept by the caller, instead
  // of a socket-inactivity timeout. For llama-server, which sends nothing before the full answer, both expire at
  // the same moment (300 s).
  function engineJson(payload) {
    let req;
    const promise = new Promise((resolve, reject) => {
      const data = Buffer.from(JSON.stringify(payload), "utf8");
      req = http.request({ hostname: "127.0.0.1", port: state.PORT_LLM, path: "/v1/chat/completions", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": data.length } }, (r) => {
        let text = "";
        r.setEncoding("utf8");
        r.on("data", (chunk) => { text += chunk; });
        r.on("end", () => {
          try {
            const jsonBody = JSON.parse(text || "{}");
            if (r.statusCode < 200 || r.statusCode >= 300 || jsonBody.ok === false) {
              const engineError = jsonBody.error;
              const message = typeof engineError === "string" ? engineError
                : (engineError && typeof engineError.message === "string" && engineError.message) || `HTTP ${r.statusCode}`;
              const err = new Error(message);
              if (r.statusCode < 200 || r.statusCode >= 300) err.upstreamStatus = r.statusCode;
              reject(err);
              return;
            }
            resolve(jsonBody);
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on("error", reject);
      req.write(data);
      req.end();
    });
    return { promise, abort: () => { if (req && !req.destroyed) req.destroy(); } };
  }

  async function nonStreamEnforced(req, res, body, retryCount, ctx, requestData, webAugmentation, prepared) {
    const { setTimer, clearTimer, now } = T.timers;
    const seconds = T.setting.nonStreamTotalSeconds;
    const call = engineJson(JSON.parse(requestData));
    ctx.seq = state.llmProcSeq;
    ctx.inFlight = true;
    ctx.aborted = false;
    ctx.abortTarget = call.abort;
    let final = false;
    const t0 = now();
    const timer = setTimer(() => {
      if (final) return;
      final = true;
      T.recordTimeout("total", { stream: false, elapsedMs: now() - t0, seq: ctx.seq });
      ctx.abortEngine();
      if (!res.writableEnded && !res.destroyed) json(res, 504, { ok: false, code: "ENGINE_TIMEOUT", phase: "total", error: timeoutMessage("total", seconds) });
    }, seconds * 1000);
    res.once("close", () => {
      if (final || res.writableEnded) return;
      final = true;
      clearTimer(timer);
      if (!ctx.cancelCounted) { ctx.cancelCounted = true; T.recordClientCancel(ctx.seq); }
      ctx.abortEngine(); // new in "on": a non-streaming request is no longer left running for its client
    });
    let result;
    try {
      result = await call.promise;
    } catch (err) {
      if (final) return undefined; // settled by the timeout or the client's disconnect: answered once already
      final = true;
      clearTimer(timer);
      ctx.inFlight = false;
      if (isOomError(err.message) && retryCount === 0) {
        try {
          await retryLowerContext();
          return doLlmChat(req, res, body, retryCount + 1, ctx);
        } catch (retryErr) {
          console.error("Failed OOM recovery retry:", retryErr);
        }
      }
      if (err.upstreamStatus) return json(res, err.upstreamStatus, { ok: false, error: redactPaths(err.message) });
      if (err.code === "ECONNREFUSED") return json(res, 409, ENGINE_GONE);
      if (isTransportError(err)) return json(res, 500, transportBody(err));
      throw err;
    }
    if (final) return undefined;
    final = true;
    clearTimer(timer);
    ctx.inFlight = false;
    if (webAugmentation.webSources.length) result.web_sources = webAugmentation.webSources;
    if (prepared.truncated) result.attachments_truncated = true;
    return json(res, 200, result);
  }

  // 9.9f-1, mode "on": nothing new is sent to the engine while a cancellation is unconfirmed. Waits at most the
  // confirmation window (CONFIRMING), refuses at once while UNRESPONSIVE. Returns true when the chat may go on.
  async function passGate(res) {
    const r = await T.admit((cb) => res.once("close", () => { if (!res.writableEnded) cb(); }));
    if (r.ok) return true;
    if (r.code === "CLIENT_GONE" || res.destroyed || res.writableEnded) return false;
    res.writeHead(r.status, { "Content-Type": "application/json", "Retry-After": String(r.retryAfterSeconds) });
    res.end(JSON.stringify({ ok: false, error: r.error, code: r.code, retryAfterSeconds: r.retryAfterSeconds }));
    return false;
  }

  // Step 9.9b: counted for GET /api/resources only. `active` is chat requests the studio is answering; `waiting`
  // is streaming requests queued for the one shared connection to the engine (maxSockets 1). Non-streaming
  // requests use their own connection, so they never wait there. Nothing here changes how requests run.
  let activeChats = 0;
  // Step 9.9c: the bounded chat queue (services/chat-queue.cjs), only when deps.chatQueue is given (setting on).
  const chatQueue = deps.chatQueue || null;
  function trackedDoLlmChat(req, res, body) {
    activeChats += 1;
    let counted = true;
    const done = () => { if (counted) { counted = false; activeChats -= 1; } };
    res.once("close", done);
    res.once("finish", done);
    if (!chatQueue) {
      if (!ON) return doLlmChat(req, res, body);
      return passGate(res).then((go) => (go ? doLlmChat(req, res, body, 0, newCtx()) : undefined));
    }
    return queuedDoLlmChat(req, res, body);
  }
  async function queuedDoLlmChat(req, res, body) {
    const ctx = newCtx();
    const turn = await chatQueue.admit((cb) => res.once("close", () => { if (!res.writableEnded) cb(); }));
    if (!turn.ok) {
      if (turn.code === "CLIENT_GONE" || res.destroyed || res.writableEnded) return undefined; // nobody to answer
      res.writeHead(turn.status, { "Content-Type": "application/json", "Retry-After": String(turn.retryAfterSeconds) });
      res.end(JSON.stringify({ ok: false, error: turn.error, code: turn.code, retryAfterSeconds: turn.retryAfterSeconds }));
      return undefined;
    }
    let released = false;
    const releaseNow = () => { if (!released) { released = true; turn.release(); } };
    // 9.9f-1 (on): the slot passes to the cancellation confirmation, not to the next request. A client that left
    // while its engine request ran aborts it here (close fires this listener before doLlmChat's own).
    const release = !ON ? releaseNow : () => {
      if (ctx.inFlight && !res.writableEnded) {
        if (!ctx.cancelCounted) { ctx.cancelCounted = true; T.recordClientCancel(ctx.seq); }
        ctx.abortEngine();
      }
      T.afterConfirmation(releaseNow);
    };
    res.once("close", release);
    res.once("finish", release);
    if (res.destroyed) { release(); return undefined; }
    if (ON && !(await passGate(res))) { release(); return undefined; }
    // The engine may have stopped or crashed while this request waited.
    if (!state.llmReady) {
      json(res, 409, { ok: false, error: "The text engine stopped while this request was waiting. Load a text model, then try again.", code: "ENGINE_NOT_READY" });
      return undefined;
    }
    try { return await doLlmChat(req, res, body, 0, ctx); } finally { if (res.writableEnded || res.destroyed) release(); }
  }
  const chatStats = () => ({
    active: chatQueue ? chatQueue.stats().running : activeChats,
    waiting: chatQueue ? chatQueue.stats().waiting
      : Object.values(llmHttpAgent.requests || {}).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0),
  });
  return { doLlmChat: trackedDoLlmChat, isOomError, retryLowerContext, chatStats };
}

module.exports = { createChatService, onEngineResponseSettled };
