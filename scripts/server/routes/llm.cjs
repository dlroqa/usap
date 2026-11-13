// routes/llm.cjs — text engine, chat and conversation HTTP routes (Step 9.8h). Moved unchanged from
// serve.cjs; the engine is services/llm-engine.cjs, chat is services/chat.cjs and saved conversations are
// services/conversations.cjs. Reached only through the request pipeline (Host, Origin, sign-in, error
// boundary). Engine state is read through `state` (state.X was X); only llmError is set, as before.
//
//   GET  /api/llm/status, /api/llm/backends (prefix), /api/llm/stats, /api/llm/model-settings,
//        /api/llm/conversations, /api/llm/recommend (prefix)
//   POST /api/llm/model-settings, /api/llm/save-conversation, /api/llm/delete-conversation, /api/llm/start,
//        /api/llm/stop, /api/llm/benchmark, /api/llm/chat
"use strict";

const REQUIRED = ["state","PREFERRED_LLM_PORT","benchmarkLlmModel","deleteChatConversation","doLlmChat","errorBody","errorStatus","getLlmBackend","getLlmBackendProbe","getLlmRuntimeStats","getLlmfitRecommendations","getPersistedLlmModelSettings","json","jsonErrorStatus","killLlm","listChatConversations","llmEngineState","llmLifecycleSnapshot","path","publicPaths","readJsonBody","runExclusiveLlmOperation","saveChatConversation","startLlm","stopLlmNow","updateLlmModelSettings"];

function llmRoutes(deps) {
  for (const name of REQUIRED) {
    if (deps[name] === undefined || deps[name] === null) throw new Error(`routes/llm: missing dependency ${name}`);
  }
  // Optional (Step 9.9d): the warn-only memory check's latest text result. Without it, responses are unchanged.
  const memoryCheck = typeof deps.memoryCheck === "function" ? deps.memoryCheck : () => null;
  // Additive field: only a result produced by this start, so a start that failed before loading never carries an
  // older one.
  const withMemoryCheck = (body, before) => { let after = null; try { after = memoryCheck(); } catch (_) { after = null; } return after && after !== before ? { ...body, memoryCheck: after } : body; };
  const { state, PREFERRED_LLM_PORT, benchmarkLlmModel, deleteChatConversation, doLlmChat, errorBody, errorStatus, getLlmBackend, getLlmBackendProbe, getLlmRuntimeStats, getLlmfitRecommendations, getPersistedLlmModelSettings, json, jsonErrorStatus, killLlm, listChatConversations, llmEngineState, llmLifecycleSnapshot, path, publicPaths, readJsonBody, runExclusiveLlmOperation, saveChatConversation, startLlm, stopLlmNow, updateLlmModelSettings } = deps;
  return (r) => {
    r.get("/api/llm/status", async (req, res) => {
    const backend = getLlmBackend();
    const probe = getLlmBackendProbe();
    return json(res, 200, publicPaths({
      ready: state.llmReady,
      running: state.llmProc !== null,
      port: state.PORT_LLM,
      preferredPort: PREFERRED_LLM_PORT,
      error: state.llmError,
      settings: state.llmSettings,
      backendInstalled: Boolean(backend),
      backendMode: backend?.mode || "",
      backendPath: backend?.path || "",
      selectedBackend: probe.selected,
      availableBackends: probe.available,
      engine: llmLifecycleSnapshot(), // additive (Step 9.6)
    }));
    });

    r.getPrefix("/api/llm/backends", async (req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    return json(res, 200, publicPaths({ ok: true, ...getLlmBackendProbe(parsed.searchParams.get("refresh") === "1") }));
    });

    r.get("/api/llm/stats", async (req, res) => {
    return json(res, 200, publicPaths(getLlmRuntimeStats()));
    });

    r.get("/api/llm/model-settings", async (req, res) => {
    return json(res, 200, { ok: true, ...getPersistedLlmModelSettings() });
    });

    r.post("/api/llm/model-settings", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const filename = path.basename(String(body.model || ""));
    if (!filename) return json(res, 400, { ok: false, error: "model is required" });
    const updated = updateLlmModelSettings(filename, {
      preferredBackend: body.preferredBackend ? String(body.preferredBackend).toLowerCase() : undefined,
    });
    return json(res, 200, { ok: true, model: filename, settings: updated });
    });

    r.get("/api/llm/conversations", async (req, res) => {
    return json(res, 200, { ok: true, conversations: listChatConversations() });
    });

    r.post("/api/llm/save-conversation", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      const conversation = saveChatConversation(body.conversation || body);
      return json(res, 200, { ok: true, conversation });
    } catch (err) {
      console.error("  [api] Failed to save chat conversation:", err);
      return json(res, errorStatus(err), errorBody(err));
    }
    });

    r.post("/api/llm/delete-conversation", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      const deleted = deleteChatConversation(body.id);
      return json(res, 200, { ok: true, deleted });
    } catch (err) {
      console.error("  [api] Failed to delete chat conversation:", err);
      return json(res, errorStatus(err), errorBody(err));
    }
    });

    r.post("/api/llm/start", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    let memoryBefore = null;
    try { memoryBefore = memoryCheck(); } catch (_) { memoryBefore = null; }
    try {
      await runExclusiveLlmOperation(() => startLlm(body));
      return json(res, 200, withMemoryCheck({ ok: true, ready: state.llmReady, port: state.PORT_LLM, settings: state.llmSettings }, memoryBefore));
    } catch (err) {
      state.llmError = err.message || String(err);
      if (err.code !== "MODEL_ALREADY_ACTIVE") {
        await runExclusiveLlmOperation(() => killLlm());
      }
      return json(res, jsonErrorStatus(err), withMemoryCheck(errorBody(err, { error: state.llmError, code: err.code || "", activeRuntime: err.activeRuntime || null }), memoryBefore));
    }
    });

    r.post("/api/llm/stop", async (req, res) => {
    await stopLlmNow(); // cancels a start in progress immediately
    await runExclusiveLlmOperation(() => killLlm());
    return json(res, 200, { ok: true });
    });

    r.post("/api/llm/benchmark", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      const result = await runExclusiveLlmOperation(() => benchmarkLlmModel(body));
      return json(res, 200, result);
    } catch (err) {
      return json(res, errorStatus(err), errorBody(err));
    }
    });

    r.post("/api/llm/chat", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    if (!state.llmReady) {
      const state = llmEngineState();
      if (state === "restarting") return json(res, 409, { ok: false, error: "The text engine stopped unexpectedly and is restarting. Try again in a moment.", code: "ENGINE_RESTARTING" });
      if (state === "crashed") return json(res, 409, { ok: false, error: state.llmError || "The text engine stopped unexpectedly.", code: "ENGINE_CRASHED" });
      if (state === "starting") return json(res, 409, { ok: false, error: "The text model is still loading. Try again in a moment.", code: "ENGINE_STARTING" });
      return json(res, 409, { ok: false, error: "Load a text model before sending a message.", code: "ENGINE_NOT_READY" });
    }
    await doLlmChat(req, res, body);
    return;
    });

  // GET /api/llm/recommend — llmfit recommendations
    r.getPrefix("/api/llm/recommend", async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const useCase = url.searchParams.get("useCase") || "chat";
    const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit")) || 10));
    const recommendations = await getLlmfitRecommendations(useCase, limit);
    return json(res, 200, { ok: true, recommendations, source: recommendations ? "llmfit" : "fallback" });
    });
  };
}

module.exports = { llmRoutes };
