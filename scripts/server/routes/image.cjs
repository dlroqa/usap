// routes/image.cjs — image generation HTTP routes (Step 9.8g). Moved unchanged from serve.cjs; the engine,
// its state and saved outputs come from services/image-engine.cjs. Reached only through the request pipeline
// (Host, Origin, sign-in, error boundary). Engine state is read and set through `state` (state.X was X).
//
//   GET/POST /v1/*, /sdapi/* (prefix; proxied to the image engine)
//   GET  /api/backend-status, /api/generation-progress, /api/outputs, /api/output-file (prefix)
//   POST /api/restart-backend, /api/stop-backend, /api/openvino-generate, /api/save-output, /api/delete-outputs
"use strict";

const REQUIRED = ["state","MIME","MODELS","OUTPUTS","PREFERRED_BACKEND_PORT","SERVER_BUILD","appleNpuRuntimeMatches","assertNoOtherActiveRuntime","backendSettingsMatch","deleteGeneratedOutputs","errorBody","errorStatus","findAvailableBackendPort","fs","generateWithOpenVino","getCoreMLPythonPath","getDefaultModel","json","jsonErrorStatus","killBackend","killOpenVinoWorker","listGeneratedOutputs","path","proxyImageBackendRequest","readJsonBody","saveGeneratedOutput","startBackend"];

function imageRoutes(deps) {
  for (const name of REQUIRED) {
    if (deps[name] === undefined || deps[name] === null) throw new Error(`routes/image: missing dependency ${name}`);
  }
  // Optional (Step 9.9d): the warn-only memory check's latest image result. Without it, responses are unchanged.
  const memoryCheck = typeof deps.memoryCheck === "function" ? deps.memoryCheck : () => null;
  const withMemoryCheck = (body, before) => { let after = null; try { after = memoryCheck(); } catch (_) { after = null; } return after && after !== before ? { ...body, memoryCheck: after } : body; };
  const { state, MIME, MODELS, OUTPUTS, PREFERRED_BACKEND_PORT, SERVER_BUILD, appleNpuRuntimeMatches, assertNoOtherActiveRuntime, backendSettingsMatch, deleteGeneratedOutputs, errorBody, errorStatus, findAvailableBackendPort, fs, generateWithOpenVino, getCoreMLPythonPath, getDefaultModel, json, jsonErrorStatus, killBackend, killOpenVinoWorker, listGeneratedOutputs, path, proxyImageBackendRequest, readJsonBody, saveGeneratedOutput, startBackend } = deps;
  return (r) => {
    // Original condition: (req.url.startsWith("/v1/") || req.url.startsWith("/sdapi/")) && GET or POST
    const proxyRoute = async (req, res) => {
    return proxyImageBackendRequest(req, res);
    };
    r.getPrefix("/v1/", proxyRoute);
    r.postPrefix("/v1/", proxyRoute);
    r.getPrefix("/sdapi/", proxyRoute);
    r.postPrefix("/sdapi/", proxyRoute);

  // GET /api/backend-status
    r.get("/api/backend-status", async (req, res) => {
    return json(res, 200, {
      ready: state.backendReady || state.openvinoReady,
      running: state.backendProc !== null || state.openvinoProc !== null,
      port: state.PORT_BACKEND,
      preferredPort: PREFERRED_BACKEND_PORT,
      error: state.backendError,
      loading: state.backendLoadState,
      unloading: state.backendUnloadState,
      settings: state.currentSettings,
      build: SERVER_BUILD,
    });
    });

  // POST /api/restart-backend — restart with new settings
    r.post("/api/restart-backend", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    console.log("  [api] Restart backend request:", body);
    const newSettings = {};
    if (body.model)    newSettings.model    = body.backend_type === "openvino-npu" ? String(body.model) : path.join(MODELS, body.model);
    if (body.steps)    newSettings.steps    = parseInt(body.steps);
    if (body.cfgScale) newSettings.cfgScale = parseFloat(body.cfgScale);
    if (body.sampler)  newSettings.sampler  = body.sampler;
    if (body.threads)  newSettings.threads  = parseInt(body.threads);
    if (body.width)    newSettings.width    = parseInt(body.width);
    if (body.height)   newSettings.height   = parseInt(body.height);
    if (typeof body.use_gpu === "boolean") newSettings.useGpu = body.use_gpu;
    if (body.backend_type) {
      newSettings.backendType = String(body.backend_type);
      newSettings.useGpu = body.backend_type !== "cpu";
    }
    if (typeof body.vae_tiling === "boolean") newSettings.vaeTiling = body.vae_tiling;
    if (typeof body.vae_on_cpu === "boolean") newSettings.vaeOnCpu = body.vae_on_cpu;
    if (typeof body.flash_attn === "boolean") newSettings.flashAttn = body.flash_attn;
    let memoryBefore = null;
    try { memoryBefore = memoryCheck(); } catch (_) { memoryBefore = null; }
    try {
      const targetModel = newSettings.model || state.currentSettings.model || getDefaultModel();
      assertNoOtherActiveRuntime("image", targetModel);
      const requestedSettings = { ...state.currentSettings, ...newSettings, model: targetModel };
      const imageBackendReady = (state.backendReady && state.backendProc) || (state.openvinoReady && state.openvinoProc);
      if (imageBackendReady && backendSettingsMatch(state.currentSettings, requestedSettings)) {
        return json(res, 200, { ok: true, message: "Backend already running with requested settings.", settings: state.currentSettings, port: state.PORT_BACKEND });
      }
      if (state.generationState.active) {
        return json(res, 409, {
          ok: false,
          error: "Image generation is in progress. Wait for it to finish or cancel it before changing backend settings.",
        });
      }
      if (state.backendReady && state.backendProc && appleNpuRuntimeMatches(state.currentSettings, requestedSettings)) {
        state.currentSettings = requestedSettings;
        return json(res, 200, { ok: true, message: "Apple NPU backend already running; updated generation defaults.", settings: state.currentSettings, port: state.PORT_BACKEND });
      }
      await killBackend();
      await new Promise(r => setTimeout(r, 500));
      if (newSettings.backendType === "openvino-npu") {
        startBackend(newSettings).catch((err) => {
          state.backendError = err.message || String(err);
          state.backendLoadState = {
            ...state.backendLoadState,
            active: false,
            phase: "OpenVINO NPU model load failed",
          };
          console.error("  [openvino-npu] Startup failed:", state.backendError);
        });
        return json(res, 200, { ok: true, message: "OpenVINO NPU backend starting...", settings: state.currentSettings, port: state.PORT_BACKEND });
      }
      if (newSettings.backendType === "apple-npu") {
        const backendPort = await findAvailableBackendPort();
        state.PORT_BACKEND = backendPort;
        newSettings.backendPort = backendPort;
        state.currentSettings = { ...state.currentSettings, ...newSettings };
        state.backendLoadState = {
          active: true,
          phase: "Starting Apple NPU backend...",
          progress: 1,
          current: 0,
          total: 0,
          speed: "",
          model: path.basename(newSettings.model || targetModel),
          backendMode: "Apple NPU",
          backendBinary: path.basename(getCoreMLPythonPath()),
          device: "",
        };
        startBackend(newSettings).catch((err) => {
          state.backendError = err.message || String(err);
          state.backendLoadState = {
            ...state.backendLoadState,
            active: false,
            phase: "Apple NPU model load failed",
          };
          console.error("  [coreml-npu] Startup failed:", state.backendError);
        });
        return json(res, 200, { ok: true, message: "Apple NPU backend starting...", settings: { ...state.currentSettings, ...newSettings }, port: backendPort });
      }
      await startBackend(newSettings);
      return json(res, 200, withMemoryCheck({ ok: true, message: "Backend restarting...", settings: state.currentSettings, port: state.PORT_BACKEND }, memoryBefore));
    } catch (err) {
      state.backendError = err.message || String(err);
      return json(res, jsonErrorStatus(err), withMemoryCheck(errorBody(err, { error: state.backendError, code: err.code || "", activeRuntime: err.activeRuntime || null, port: state.PORT_BACKEND }), memoryBefore));
    }
    });

  // POST /api/stop-backend
    r.post("/api/stop-backend", async (req, res) => {
    await killBackend();
    await killOpenVinoWorker();
    return json(res, 200, { ok: true });
    });

  // GET /api/generation-progress
    r.get("/api/generation-progress", async (req, res) => {
    return json(res, 200, {
      ...state.generationState,
      backendMode: state.generationState.backendMode || state.currentSettings.backendMode || "",
      backendDevice: state.generationState.backendDevice || state.currentSettings.backendDevice || "",
    });
    });

    r.post("/api/openvino-generate", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      return json(res, 200, await generateWithOpenVino(body));
    } catch (err) {
      return json(res, errorStatus(err), errorBody(err));
    }
    });

  // GET /api/outputs
    r.get("/api/outputs", async (req, res) => {
    return json(res, 200, { outputs: listGeneratedOutputs() });
    });

  // GET /api/output-file?filename=...
    r.getPrefix("/api/output-file", async (req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const filename = path.basename(parsed.searchParams.get("filename") || "");
    const filePath = path.join(OUTPUTS, filename);
    if (!filename || !fs.existsSync(filePath)) {
      return json(res, 404, { error: "Output file not found" });
    }
    const ext = path.extname(filePath).toLowerCase();
    fs.readFile(filePath, (err, data) => {
      if (err) return json(res, errorStatus(err), errorBody(err));
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      res.end(data);
    });
    return;
    });

  // POST /api/save-output
    r.post("/api/save-output", async (req, res) => {
    try {
      const body = await readJsonBody(req, res);
      if (!body) return;
      const saved = saveGeneratedOutput(body.image, body.metadata || {});
      return json(res, 200, { ok: true, output: { ...saved, url: `/api/output-file?filename=${encodeURIComponent(saved.image)}` } });
    } catch (err) {
      console.error("  [api] Failed to save output:", err);
      return json(res, errorStatus(err), errorBody(err));
    }
    });

  // POST /api/delete-outputs
    r.post("/api/delete-outputs", async (req, res) => {
    try {
      const body = await readJsonBody(req, res);
      if (!body) return;
      const deleted = deleteGeneratedOutputs(body.outputs || []);
      return json(res, 200, { ok: true, deleted });
    } catch (err) {
      console.error("  [api] Failed to delete outputs:", err);
      return json(res, errorStatus(err), errorBody(err));
    }
    });
  };
}

module.exports = { imageRoutes };
