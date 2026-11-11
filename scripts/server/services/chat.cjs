// services/chat.cjs — chat requests to the text engine (Step 9.8h).
//
// Moved unchanged from serve.cjs: the keep-alive connection to llama-server, POST /api/llm/chat request
// building (sampling settings, web-search results added by services/web-search.cjs), streaming (SSE passed
// through as the engine sends it, with a `web_sources` event first when there are sources), non-streaming
// JSON, the one-time retry with a smaller context after an out-of-memory error, and aborting the engine
// request when the client disconnects. Only free variables changed: they come from `deps`, and the engine
// state (PORT_LLM, llmSettings) is read through `state` (getters only; state.X was X).
//
// Prompt order is unchanged: the client's messages are passed on as sent; web results, when requested,
// are one extra "user" message after the leading system messages (see docs/security/WEB_CONTENT_TRUST.md).
"use strict";

const REQUIRED = ["state","errorBody","errorStatus","http","json","redactPaths","requestJson","runExclusiveLlmOperation","startLlm","webSearch"];

function createChatService(deps) {
  for (const name of REQUIRED) {
    if (deps[name] === undefined || deps[name] === null) throw new Error(`chat: missing dependency ${name}`);
  }
  const { state, errorBody, errorStatus, http, json, redactPaths, requestJson, runExclusiveLlmOperation, startLlm, webSearch } = deps;

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
    
    await runExclusiveLlmOperation(() => startLlm(newSettings));
  }

  async function doLlmChat(req, res, body, retryCount = 0) {
    try {
      const isStream = body.stream === true;
      const rawMessages = Array.isArray(body.messages) ? body.messages : [];
      const webAugmentation = await webSearch.augmentMessagesWithWebSearch(rawMessages, body);
      const requestData = JSON.stringify({
        model: state.llmSettings.model || "local-model",
        messages: webAugmentation.messages,
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
        const clientReq = http.request({
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
          if (clientRes.statusCode < 200 || clientRes.statusCode >= 300) {
            let errorBody = "";
            clientRes.setEncoding("utf8");
            clientRes.on("data", (chunk) => { errorBody += chunk; });
            clientRes.on("end", async () => {
              let message = `Text backend returned HTTP ${clientRes.statusCode}`;
              try {
                message = JSON.parse(errorBody || "{}").error?.message || message;
              } catch (_) {}
              
              if (isOomError(message) && retryCount === 0) {
                try {
                  await retryLowerContext();
                  return doLlmChat(req, res, body, retryCount + 1);
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
          clientRes.on("data", (chunk) => res.write(chunk));
          clientRes.on("end", () => res.end());
          clientRes.on("error", (err) => res.destroy(err));
        });

        clientReq.on("error", async (err) => {
          console.error("LLM stream request error:", err);
          if (isOomError(err.message) && retryCount === 0) {
            try {
              await retryLowerContext();
              return doLlmChat(req, res, body, retryCount + 1);
            } catch (retryErr) {
              console.error("Failed OOM recovery retry:", retryErr);
            }
          }
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          } else {
            res.end();
          }
        });

        clientReq.write(requestData);
        clientReq.end();
        res.on("close", () => {
          if (!res.writableEnded && !clientReq.destroyed) clientReq.destroy();
        });
        return;
      } else {
        try {
          const result = await requestJson(`http://127.0.0.1:${state.PORT_LLM}/v1/chat/completions`, JSON.parse(requestData), 300000);
          if (webAugmentation.webSources.length) {
            result.web_sources = webAugmentation.webSources;
          }
          return json(res, 200, result);
        } catch (err) {
          if (isOomError(err.message) && retryCount === 0) {
            try {
              await retryLowerContext();
              return doLlmChat(req, res, body, retryCount + 1);
            } catch (retryErr) {
              console.error("Failed OOM recovery retry:", retryErr);
            }
          }
          // #67: an engine error answers like the streaming path: the engine's status and message.
          if (err.upstreamStatus) return json(res, err.upstreamStatus, { ok: false, error: redactPaths(err.message) });
          throw err;
        }
      }
    } catch (err) {
      return json(res, errorStatus(err), errorBody(err));
    }
  }

  // Step 9.9b: counted for GET /api/resources only. `active` is chat requests the studio is answering; `waiting`
  // is streaming requests queued for the one shared connection to the engine (maxSockets 1). Non-streaming
  // requests use their own connection, so they never wait there. Nothing here changes how requests run.
  let activeChats = 0;
  function trackedDoLlmChat(req, res, body) {
    activeChats += 1;
    let counted = true;
    const done = () => { if (counted) { counted = false; activeChats -= 1; } };
    res.once("close", done);
    res.once("finish", done);
    return doLlmChat(req, res, body);
  }
  const chatStats = () => ({
    active: activeChats,
    waiting: Object.values(llmHttpAgent.requests || {}).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0),
  });
  return { doLlmChat: trackedDoLlmChat, isOomError, retryLowerContext, chatStats };
}

module.exports = { createChatService };
