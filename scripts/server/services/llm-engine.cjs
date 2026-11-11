// services/llm-engine.cjs — the text engine (Step 9.8h).
//
// Moved unchanged from serve.cjs: llama.cpp backend detection and probes, model settings and benchmarks,
// starting (backends, load profiles, context and layer choices), readiness, stopping and the Step 9.6
// supervision (bounded automatic restart through restart-policy.cjs, no restart after running out of memory
// or after an intentional stop), and the llmfit recommendation lookup. The code below is the original
// code; only its free variables now come from `deps`. No HTTP routes here (see routes/llm.cjs), no chat
// requests (services/chat.cjs) and no conversation files (services/conversations.cjs).
//
// `state` gives read access to the engine state for serve.cjs, chat and diagnostics. Only the routes may
// set llmError, which POST /api/llm/start set before the move (`routeState`).
"use strict";

const { describeSpawnError, isLaunchFailure } = require("../spawn-error.cjs");

const REQUIRED = ["ApiError","LLM_BACKEND_PATHS","LLM_BENCHMARK_PATH","LLM_MODELS","LLM_MODEL_SETTINGS_PATH","PREFERRED_LLM_PORT","assertNoOtherActiveRuntime","badRequest","checkPort","decideRestart","fs","getGpuInfo","getStableSyclGpuLayers","http","isVisionModelFilename","killBackend","killOpenVinoWorker","notFound","notInstalled","os","osPlatform","path","pathInside","readJsonFile","readdirVisible","requestJson","spawnSync","supervisor","waitForChildExit","waitForPortAvailable","writeJsonFile"];

function createLlmEngine(deps) {
  for (const name of REQUIRED) {
    if (deps[name] === undefined || deps[name] === null) throw new Error(`llm-engine: missing dependency ${name}`);
  }
  const { ApiError, LLM_BACKEND_PATHS, LLM_BENCHMARK_PATH, LLM_MODELS, LLM_MODEL_SETTINGS_PATH, PREFERRED_LLM_PORT, assertNoOtherActiveRuntime, badRequest, checkPort, decideRestart, fs, getGpuInfo, getStableSyclGpuLayers, http, isVisionModelFilename, killBackend, killOpenVinoWorker, notFound, notInstalled, os, osPlatform, path, pathInside, readJsonFile, readdirVisible, requestJson, spawnSync, supervisor, waitForChildExit, waitForPortAvailable, writeJsonFile } = deps;

  let PORT_LLM = PREFERRED_LLM_PORT;

  let llmProc = null;

  let llmProcSeq = 0;

  let llmReady = false;

  let llmError = null;

  // Step 9.6 lifecycle: start cancellation, crash detection and bounded automatic restarts.
  let llmStartToken = 0;       // bumped by a stop request: an in-progress start gives up

  let llmStarting = false;

  let llmLastStartRequest = null;

  let llmLastExit = null;      // { code, signal, at, unexpected }

  let llmCrash = null;         // set when the engine stopped unexpectedly and is not being restarted

  let llmRestartTimer = null;

  let llmRestartAttempts = []; // timestamps of automatic restarts in the current window

  let llmRestarting = false;

  const LLM_RESTART_LIMIT = 3;

  const LLM_RESTART_WINDOW_MS = 10 * 60 * 1000;

  const LLM_AUTO_RESTART = process.env.USAP_ENGINE_AUTO_RESTART !== "0";

  const LLM_READY_TIMEOUT_MS = Number(process.env.USAP_LLM_READY_TIMEOUT_MS) || 0; // 0: built-in limits

  let llmOperationQueue = Promise.resolve();

  function llmEngineState() {
    if (llmStarting) return llmRestarting ? "restarting" : "starting";
    if (llmReady && llmProc) return "ready";
    if (llmRestartTimer) return "restarting";
    if (llmCrash) return "crashed";
    return "stopped";
  }

  // Additive diagnostics; no secrets, no paths beyond the model name.
  function llmLifecycleSnapshot() {
    const now = Date.now();
    return {
      state: llmEngineState(),
      autoRestart: LLM_AUTO_RESTART,
      restartsInWindow: llmRestartAttempts.filter((t) => now - t < LLM_RESTART_WINDOW_MS).length,
      restartLimit: LLM_RESTART_LIMIT,
      lastExit: llmLastExit,
      crash: llmCrash,
      supervised: Boolean(llmProc && llmProc.supervised),
    };
  }

  function engineStartCancelledError() {
    return Object.assign(new Error("Loading the text model was stopped."), { code: "ENGINE_START_CANCELLED", statusCode: 409 });
  }

  let llmSettings = {
    model: null,
    threads: Math.max(1, Math.min(16, os.cpus().length || 4)),
    contextSize: 4096,
    gpuLayers: -1,
    backendMode: "",
    backendBinary: "",
    supportsVision: false,
    visionMode: "none",
    visionStatus: "Projector not loaded",
    flashAttn: true,
    cacheTypeK: "q8_0",
    cacheTypeV: "q8_0",
    mlock: false,
    mmap: true,
    cachePrompt: true,
    defragThold: 0.1,
    batchSize: 512,
    ubatchSize: 512,
    performanceProfile: "balanced",
  };

  function runExclusiveLlmOperation(operation) {
    const run = llmOperationQueue.catch(() => {}).then(operation);
    llmOperationQueue = run.catch(() => {});
    return run;
  }

  function getPersistedLlmModelSettings() {
    return readJsonFile(LLM_MODEL_SETTINGS_PATH, { models: {} });
  }

  function savePersistedLlmModelSettings(settings) {
    writeJsonFile(LLM_MODEL_SETTINGS_PATH, settings && typeof settings === "object" ? settings : { models: {} });
  }

  function getLlmModelSettings(filename) {
    const safeFilename = path.basename(String(filename || ""));
    if (!safeFilename) return {};
    const settings = getPersistedLlmModelSettings();
    return settings.models?.[safeFilename] || {};
  }

  function updateLlmModelSettings(filename, patch) {
    const safeFilename = path.basename(String(filename || ""));
    if (!safeFilename) return {};
    const allSettings = getPersistedLlmModelSettings();
    if (!allSettings.models || typeof allSettings.models !== "object") allSettings.models = {};
    const previous = allSettings.models[safeFilename] || {};
    const next = {
      ...previous,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    allSettings.models[safeFilename] = next;
    savePersistedLlmModelSettings(allSettings);
    return next;
  }

  function getPersistedLlmBenchmarks() {
    return readJsonFile(LLM_BENCHMARK_PATH, { results: [] });
  }

  function savePersistedLlmBenchmarks(benchmarks) {
    writeJsonFile(LLM_BENCHMARK_PATH, benchmarks && typeof benchmarks === "object" ? benchmarks : { results: [] });
  }

  function recordLlmBenchmark(result) {
    const benchmarks = getPersistedLlmBenchmarks();
    const results = Array.isArray(benchmarks.results) ? benchmarks.results : [];
    results.unshift({
      ...result,
      createdAt: new Date().toISOString(),
    });
    benchmarks.results = results.slice(0, 100);
    savePersistedLlmBenchmarks(benchmarks);
    return benchmarks.results[0];
  }

  function parseLlamaDeviceList(output) {
    const devices = [];
    const devicePattern = /(CUDA|Vulkan|SYCL|HIP|ROCm)\d*\s*:\s*(.+?)\s+\(([\d.]+)\s+MiB(?:,\s*([\d.]+)\s+MiB free)?\)/gi;
    let match;
    while ((match = devicePattern.exec(output || "")) !== null) {
      const totalMiB = Number(match[3]);
      const freeMiB = match[4] ? Number(match[4]) : NaN;
      if (!Number.isFinite(totalMiB) || totalMiB <= 0) continue;
      devices.push({
        type: match[1],
        name: match[2].trim(),
        vram_gb: Math.round((totalMiB / 1024) * 100) / 100,
        free_vram_gb: Number.isFinite(freeMiB) ? Math.round((freeMiB / 1024) * 100) / 100 : null,
      });
    }
    return devices.sort((a, b) => b.vram_gb - a.vram_gb);
  }

  async function findAvailableLlmPort() {
    const preferred = await checkPort(PREFERRED_LLM_PORT);
    if (preferred.available) return PREFERRED_LLM_PORT;

    for (let port = 28121; port <= 28160; port += 1) {
      const candidate = await checkPort(port);
      if (candidate.available) {
        console.log(`  [llm] Preferred port ${PREFERRED_LLM_PORT} is busy; using ${port} instead.`);
        return port;
      }
    }

    throw new Error(`No free LLM port found. Tried ${PREFERRED_LLM_PORT} and 28121-28160.`);
  }

  function getLlmBackend() {
    return getLlmBackendCandidates()[0] || null;
  }

  let cachedLlmBackendProbe = null;

  let cachedLlmBackendProbeAt = 0;

  function resolveSystemLlamaServer() {
    const configured = process.env.LOCALAI_LLM_SYSTEM_SERVER || process.env.LLAMA_SERVER_PATH || "";
    if (configured && fs.existsSync(configured)) return configured;
    return "";
  }

  function describeLlmProbeFailure(result, output) {
    const text = String(output || "").trim().slice(-600);
    if (text) return text;
    if (result.error) return result.error.message || String(result.error);
    const code = result.status;
    if (code === null || code === undefined) return "Backend did not start (timed out or was killed).";
    // 0xC0000135 = STATUS_DLL_NOT_FOUND: modular llama.cpp builds need every bundled DLL next to llama-server.exe.
    if (osPlatform === "win32" && (code >>> 0) === 0xC0000135) {
      return "A required DLL is missing next to llama-server.exe (exit 0xC0000135). Re-run setup to reinstall the llama.cpp backend, and install the Visual C++ Redistributable and, for CUDA, a current NVIDIA driver.";
    }
    if (code !== 0) return `Backend exited with code ${osPlatform === "win32" ? "0x" + (code >>> 0).toString(16).toUpperCase() : code} without listing any devices.`;
    return "Backend reported no usable devices.";
  }

  function probeLlmBackend(backend) {
    if (!backend?.path || !fs.existsSync(backend.path)) {
      return {
        ...backend,
        installed: false,
        detected: false,
        devices: [],
        error: "Backend binary not installed.",
      };
    }

    try {
      const result = spawnSync(backend.path, ["--list-devices"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      });
      const output = `${result.stdout || ""}\n${result.stderr || ""}`;
      const devices = parseLlamaDeviceList(output);
      const detected = backend.key === "cpu" || backend.key === "metal" || backend.key === "system" || devices.length > 0;
      return {
        ...backend,
        installed: true,
        detected,
        devices,
        device: devices[0] || null,
        error: !detected ? describeLlmProbeFailure(result, output) : "",
      };
    } catch (err) {
      return {
        ...backend,
        installed: true,
        detected: backend.key === "cpu",
        devices: [],
        device: null,
        error: err.message || String(err),
      };
    }
  }

  function getAllLlmBackendCandidates() {
    const systemPath = resolveSystemLlamaServer();
    const candidates = [];
    const add = (key, backendPath, mode, portable = true) => {
      if (!backendPath) return;
      if (candidates.some((item) => item.path === backendPath)) return;
      candidates.push({ key, path: backendPath, mode, portable });
    };

    if (systemPath) add("system", systemPath, "System llama.cpp", false);
    if (osPlatform === "win32") {
      add("cuda", LLM_BACKEND_PATHS.winCuda, "Auto (CUDA/CPU)");
      add("hip", LLM_BACKEND_PATHS.winHip, "Auto (HIP/CPU)");
      add("vulkan", LLM_BACKEND_PATHS.winVulkan, "Auto (Vulkan/CPU)");
      add("sycl", LLM_BACKEND_PATHS.winSycl, "Auto (SYCL/CPU)");
      add("cpu", LLM_BACKEND_PATHS.winCpu, "CPU");
    } else if (osPlatform === "darwin") {
      add("metal", process.arch === "arm64" ? LLM_BACKEND_PATHS.macArm64 : LLM_BACKEND_PATHS.macX64, process.arch === "arm64" ? "Metal GPU" : "CPU");
    } else {
      add("cuda", LLM_BACKEND_PATHS.linuxCuda, "Auto (CUDA/CPU)");
      add("rocm", LLM_BACKEND_PATHS.linuxRocm, "Auto (ROCm/CPU)");
      add("sycl", LLM_BACKEND_PATHS.linuxSycl, "Auto (SYCL/CPU)");
      add("vulkan", LLM_BACKEND_PATHS.linuxVulkan, "Auto (Vulkan/CPU)");
      add("cpu", LLM_BACKEND_PATHS.linuxCpu, "CPU");
    }
    return candidates;
  }

  function getLlmBackendProbe(force = false) {
    const now = Date.now();
    if (!force && cachedLlmBackendProbe && now - cachedLlmBackendProbeAt < 60000) return cachedLlmBackendProbe;

    const probed = getAllLlmBackendCandidates().map(probeLlmBackend);
    const priority = osPlatform === "win32"
      ? { system: -1, cuda: 0, hip: 1, vulkan: 2, sycl: 3, metal: 4, cpu: 9 }
      : osPlatform === "darwin"
        ? { system: -1, metal: 0, cpu: 9 }
        : { system: -1, cuda: 0, rocm: 1, sycl: 2, cpu: 3, vulkan: 4 };

    const available = probed
      .filter((item) => item.installed && item.detected)
      .sort((a, b) => {
        if (osPlatform !== "linux") {
          if (a.key === "cpu" && b.key !== "cpu") return 1;
          if (b.key === "cpu" && a.key !== "cpu") return -1;
        }
        return (priority[a.key] ?? 8) - (priority[b.key] ?? 8);
      });

    cachedLlmBackendProbe = {
      generatedAt: new Date().toISOString(),
      candidates: probed,
      available,
      selected: available[0] || null,
    };
    cachedLlmBackendProbeAt = now;
    return cachedLlmBackendProbe;
  }

  function getLlmBackendCandidates() {
    const includeUndetectedGpu = process.env.LOCALAI_LLM_TRY_UNDETECTED_GPU === "1";
    const probe = getLlmBackendProbe();
    if (includeUndetectedGpu) {
      return probe.candidates.filter((item) => item.installed);
    }
    return probe.available;
  }

  function pingLlmReady(expectedModel = "") {
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${PORT_LLM}/v1/models`, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 500) {
            resolve(false);
            return;
          }
          if (!expectedModel) {
            resolve(true);
            return;
          }
          try {
            const parsed = JSON.parse(body || "{}");
            const servedIds = Array.isArray(parsed.data)
              ? parsed.data.map((item) => String(item.id || item.model || ""))
              : [];
            const expectedBase = path.basename(expectedModel).toLowerCase();
            resolve(servedIds.some((id) => {
              const lower = id.toLowerCase();
              return lower === expectedBase || lower.includes(expectedBase);
            }));
          } catch (_) {
            resolve(false);
          }
        });
      });
      req.setTimeout(1000, () => {
        req.destroy();
        resolve(false);
      });
      req.on("error", () => resolve(false));
    });
  }

  async function waitForLlmReady(maxAttempts = 240, expectedProc = llmProc, expectedModel = "") {
    if (LLM_READY_TIMEOUT_MS > 0) maxAttempts = Math.max(1, Math.ceil(LLM_READY_TIMEOUT_MS / 500));
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (!expectedProc || llmProc !== expectedProc) throw new Error(llmError || "llama.cpp exited during startup.");
      if (await pingLlmReady(expectedModel)) {
        llmReady = true;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const seconds = Math.round(maxAttempts / 2);
    throw Object.assign(new Error(`llama.cpp did not become ready within ${seconds >= 120 ? `${Math.round(seconds / 60)} minutes` : `${seconds} seconds`}.`), { code: "ENGINE_START_TIMEOUT" });
  }

  async function killLlm() {
    cancelLlmRestart();
    llmReady = false;
    llmSettings.supportsVision = false;
    llmSettings.visionMode = "none";
    llmSettings.visionStatus = "Projector not loaded";
    llmSettings.mmproj = null;
    if (!llmProc) {
      await waitForPortAvailable(PORT_LLM, 1500);
      return;
    }

    const proc = llmProc;
    const procPort = PORT_LLM;
    llmProc = null;
    await terminateLlmProc(proc, procPort);
  }

  // Polite stop, then forced, then wait until the port is free again.
  async function terminateLlmProc(proc, procPort) {
    try { proc.kill("SIGTERM"); } catch (_) {}
    const exitedAfterTerm = await waitForChildExit(proc, 2500);
    if (!exitedAfterTerm) {
      try { proc.kill("SIGKILL"); } catch (_) {}
      await waitForChildExit(proc, 2500);
    }

    const released = await waitForPortAvailable(procPort, 5000);
    if (!released) {
      console.warn(`  [llm] Port ${procPort} is still busy after stopping llama.cpp.`);
    }
  }

  function cancelLlmRestart() {
    if (llmRestartTimer) { clearTimeout(llmRestartTimer); llmRestartTimer = null; }
  }

  // Stop requested by the user: end any start in progress right away instead of waiting for it.
  async function stopLlmNow() {
    llmStartToken += 1;
    cancelLlmRestart();
    llmCrash = null;
    if (llmStarting && llmProc) {
      const proc = llmProc;
      const procPort = PORT_LLM;
      llmProc = null;
      llmReady = false;
      await terminateLlmProc(proc, procPort);
    }
  }

  function describeExit(code, signal) {
    return signal ? `signal ${signal}` : `exit code ${code}`;
  }

  // The engine stopped on its own after it was ready: restart it a bounded number of times, with
  // backoff (1 s, 2 s, 4 s), using the settings of the last successful start.
  // Bytes the last model needs to load again (the GGUF plus its vision projector, if any).
  function llmModelBytes() {
    let total = 0;
    for (const name of [llmLastStartRequest && llmLastStartRequest.model, llmSettings.mmproj]) {
      if (!name) continue;
      try { total += fs.statSync(path.join(LLM_MODELS, path.basename(String(name)))).size; } catch (_) { /* gone */ }
    }
    return total;
  }

  function handleUnexpectedLlmExit(code, signal, stderrTail = "") {
    const now = Date.now();
    llmLastExit = { code, signal: signal || null, at: new Date(now).toISOString(), unexpected: true };
    llmRestartAttempts = llmRestartAttempts.filter((t) => now - t < LLM_RESTART_WINDOW_MS);
    const what = `llama.cpp stopped unexpectedly (${describeExit(code, signal)})`;
    const decision = llmLastStartRequest
      ? decideRestart({
        autoRestart: LLM_AUTO_RESTART, attempts: llmRestartAttempts, now, limit: LLM_RESTART_LIMIT,
        windowMs: LLM_RESTART_WINDOW_MS, code, stderrTail, modelBytes: llmModelBytes(), freeBytes: os.freemem(),
      })
      : { restart: false, reason: "no-settings", message: "There are no settings to restart it with." };
    if (!decision.restart) {
      llmCrash = { code, signal: signal || null, at: llmLastExit.at, restarts: llmRestartAttempts.length, reason: decision.reason };
      llmError = `${what}. ${decision.message} Load the model again to retry.${llmError ? `\n${llmError}` : ""}`.slice(0, 1600);
      console.warn(`  [llm] ${what}; not restarting (${decision.reason}).`);
      return;
    }
    const delay = decision.delayMs;
    const token = llmStartToken;
    console.warn(`  [llm] ${what}; restarting in ${delay / 1000} s.`);
    llmRestartTimer = setTimeout(async () => {
      llmRestartTimer = null;
      if (token !== llmStartToken || !llmLastStartRequest) return;
      llmRestartAttempts.push(Date.now());
      try {
        await runExclusiveLlmOperation(() => startLlm(llmLastStartRequest, { restart: true }));
        console.log(`  [llm] Restarted after an unexpected stop (restart ${llmRestartAttempts.length} of ${LLM_RESTART_LIMIT}).`);
      } catch (err) {
        if (err.code === "ENGINE_START_CANCELLED") return;
        llmCrash = { code, signal: signal || null, at: llmLastExit.at, restarts: llmRestartAttempts.length, reason: "restart-failed" };
        llmError = `${what}, and restarting it failed: ${err.message || err}`.slice(0, 1600);
        await runExclusiveLlmOperation(() => killLlm());
      }
    }, delay);
  }

  function chooseAutoContext(modelFilename, isGpu) {
    let modelSizeGb = 4;
    try {
      const modelPath = path.join(LLM_MODELS, modelFilename);
      if (fs.existsSync(modelPath)) {
        const stats = fs.statSync(modelPath);
        modelSizeGb = stats.size / (1024 * 1024 * 1024);
      }
    } catch (_) {}

    const lowerFilename = String(modelFilename || "").toLowerCase();
    const isVisionModel = isVisionModelFilename(lowerFilename);
    let projectorSizeGb = 0;
    if (isVisionModel) {
      try {
        const files = readdirVisible(LLM_MODELS);
        const projector = files.find((file) => {
          const lower = file.toLowerCase();
          return lower.endsWith(".gguf") && lower.includes("mmproj");
        });
        if (projector) {
          projectorSizeGb = fs.statSync(path.join(LLM_MODELS, projector)).size / (1024 * 1024 * 1024);
        }
      } catch (_) {}
    }

    const systemRamGb = os.totalmem() / (1024 * 1024 * 1024);
    let vramGb = 0;
    try {
      const gpu = getGpuInfo();
      if (gpu && gpu.vram_gb) {
        vramGb = gpu.vram_gb;
      }
    } catch (_) {}

    let availableGb = 0;
    let bufferGb = 2.0;

    if (isGpu && vramGb > 0) {
      availableGb = vramGb;
      bufferGb = 1.5;
    } else {
      availableGb = systemRamGb;
      bufferGb = 2.5;
    }

    if (isGpu && vramGb > 0) {
      const gpuBudgetGb = Math.max(0.5, vramGb - modelSizeGb - projectorSizeGb - bufferGb);
      const maxFastContext = vramGb < 10 ? 8192 : vramGb < 16 ? 16384 : 32768;
      if (isVisionModel) {
        return Math.min(maxFastContext, gpuBudgetGb >= 2.5 ? 8192 : 4096);
      }
      if (gpuBudgetGb < 1.5) return 4096;
      if (gpuBudgetGb < 3.0) return Math.min(maxFastContext, 8192);
      return Math.min(maxFastContext, 16384);
    }

    const usableGb = Math.max(0.5, availableGb - modelSizeGb - projectorSizeGb - bufferGb);

    let kvPer4096Gb = 0.55;
    if (modelSizeGb >= 5.5) {
      kvPer4096Gb = 1.05;
    } else if (modelSizeGb >= 4.0) {
      kvPer4096Gb = 0.85;
    }

    const estimatedMaxCtx = (usableGb / kvPer4096Gb) * 4096;
    const contextLadder = [32768, 24576, 16384, 12288, 8192, 4096, 2048];
    
    for (const limit of contextLadder) {
      if (limit <= estimatedMaxCtx) {
        return limit;
      }
    }
    return 2048;
  }

  function buildLlmLoadProfiles(settings = {}, backend = {}) {
    const requestedContext = Number(settings.contextSize);
    const safeContext = requestedContext && requestedContext > 0
      ? Math.max(512, Math.min(4096, requestedContext))
      : 4096;
    const isCpu = backend.key === "cpu" || backend.mode === "CPU";
    const profiles = [
      { name: "requested", gpuLayers: isCpu ? 0 : undefined },
      {
        name: "safe",
        contextSize: safeContext,
        gpuLayers: isCpu ? 0 : 0,
        flashAttn: false,
        cacheTypeK: "q4_0",
        cacheTypeV: "q4_0",
        batchSize: 256,
        ubatchSize: 256,
        enableThinking: false,
      },
    ];
    return profiles;
  }

  // Architectures that GGUF files can declare but llama.cpp has never implemented.
  // Updating the backend cannot fix these, so fail early with a clear message.
  const LLAMA_CPP_UNSUPPORTED_ARCHITECTURES = {
    mllama: "Llama 3.2 Vision (mllama) is not supported by llama.cpp, so no backend update can load it. Use a llama.cpp-supported vision model instead (for example Qwen2.5-VL, Gemma 3, or Llava) together with its mmproj file.",
  };

  function readGgufArchitecture(modelPath) {
    let fd = null;
    try {
      fd = fs.openSync(modelPath, "r");
      const buf = Buffer.alloc(64 * 1024);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      if (bytes < 24 || buf.toString("latin1", 0, 4) !== "GGUF") return "";
      let kvCount = Number(buf.readBigUInt64LE(16));
      let offset = 24;
      const readString = () => {
        const len = Number(buf.readBigUInt64LE(offset));
        offset += 8;
        if (len > 4096 || offset + len > bytes) throw new Error("metadata exceeds header window");
        const value = buf.toString("utf8", offset, offset + len);
        offset += len;
        return value;
      };
      // GGUF value type sizes for fixed-width scalar types; 8 = string.
      const scalarSize = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
      while (kvCount-- > 0) {
        const key = readString();
        const type = buf.readUInt32LE(offset);
        offset += 4;
        if (type === 8) {
          const value = readString();
          if (key === "general.architecture") return value;
        } else if (scalarSize[type]) {
          offset += scalarSize[type];
        } else {
          return ""; // arrays and unknown types: give up, let llama.cpp report it
        }
      }
    } catch (_) {
      // Unreadable header: let llama.cpp produce its own error.
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
    }
    return "";
  }

  async function startLlm(settings = {}, { restart = false } = {}) {
    const token = llmStartToken;
    if (!restart) cancelLlmRestart();
    llmStarting = true;
    llmRestarting = restart;
    try {
      await startLlmAttempts(settings, token);
      const { __loadProfile, ...request } = settings;
      llmLastStartRequest = request;
      llmCrash = null;
      if (!restart) llmRestartAttempts = [];
    } finally {
      llmStarting = false;
      llmRestarting = false;
    }
  }

  async function startLlmAttempts(settings, token) {
    const filename = path.basename(String(settings.model || ""));
    const modelPath = path.join(LLM_MODELS, filename);
    if (!filename) throw badRequest("MODEL_REQUIRED", "Select a downloaded GGUF text model first.");
    if (!pathInside(modelPath, LLM_MODELS) || !fs.existsSync(modelPath)) {
      throw notFound("MODEL_NOT_FOUND", "Select a downloaded GGUF text model first.");
    }
    if (!filename.toLowerCase().endsWith(".gguf")) {
      throw badRequest("MODEL_UNSUPPORTED", "Text generation requires a .gguf model.");
    }

    const architecture = readGgufArchitecture(modelPath).toLowerCase();
    if (LLAMA_CPP_UNSUPPORTED_ARCHITECTURES[architecture]) {
      throw badRequest("MODEL_UNSUPPORTED", `${filename}: ${LLAMA_CPP_UNSUPPORTED_ARCHITECTURES[architecture]}`);
    }

    const candidates = getLlmBackendCandidates();
    if (candidates.length === 0) {
      throw notInstalled("llama.cpp is not installed. Run the platform setup script to install the text backend.");
    }
    const persistedSettings = getLlmModelSettings(filename);
    const preferredBackend = String(settings.preferredBackend || persistedSettings.preferredBackend || "").toLowerCase();
    const sortedCandidates = preferredBackend
      ? [...candidates].sort((a, b) => {
          if (a.key === preferredBackend && b.key !== preferredBackend) return -1;
          if (b.key === preferredBackend && a.key !== preferredBackend) return 1;
          return 0;
        })
      : candidates;

    const failures = [];
    for (const backend of sortedCandidates) {
      for (const profile of buildLlmLoadProfiles(settings, backend)) {
        if (token !== llmStartToken) throw engineStartCancelledError();
        try {
          await startLlmWithBackend({ ...settings, __loadProfile: profile }, backend);
          llmSettings.backendFallbacks = failures;
          updateLlmModelSettings(filename, {
            // Only pin the backend when the first choice worked; a CPU fallback after a
            // failed GPU start must not become the permanent preference.
            ...(failures.length === 0 ? { preferredBackend: backend.key } : {}),
            lastBackendMode: llmSettings.backendMode,
            lastBackendBinary: llmSettings.backendBinary,
            lastSettings: {
              threads: llmSettings.threads,
              contextSize: llmSettings.contextSize,
              gpuLayers: llmSettings.gpuLayers,
              cacheTypeK: llmSettings.cacheTypeK,
              cacheTypeV: llmSettings.cacheTypeV,
              batchSize: llmSettings.batchSize,
              ubatchSize: llmSettings.ubatchSize,
              flashAttn: llmSettings.flashAttn,
            },
          });
          return;
        } catch (err) {
          // A stop request during startup ends the whole start; no other backend or profile is tried.
          if (token !== llmStartToken || err.code === "ENGINE_START_CANCELLED") {
            await killLlm();
            throw engineStartCancelledError();
          }
          const message = err.message || String(err);
          failures.push({
            backend: backend.mode,
            binary: path.basename(backend.path),
            profile: profile.name,
            error: message.slice(-500),
          });
          console.warn(`  [llm] Load failed on ${backend.mode} (${profile.name}): ${message}`);
          await killLlm();
        }
      }
    }

    const last = failures[failures.length - 1];
    llmSettings.backendFallbacks = failures;
    throw new ApiError(500, "ENGINE_START_FAILED", `Text model failed on all available llama.cpp backends. Last failure: ${last?.error || "unknown error"}`);
  }

  // Older llama.cpp builds take --mmap/--mlock; newer ones only --load-mode. Read the
  // binary's --help once per path to know which it understands.
  const llamaServerHelpCache = new Map();

  function llamaServerSupportsFlag(binaryPath, flag) {
    if (!llamaServerHelpCache.has(binaryPath)) {
      let help = "";
      try {
        const result = spawnSync(binaryPath, ["--help"], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 10000,
          maxBuffer: 4 * 1024 * 1024,
        });
        help = `${result.stdout || ""}\n${result.stderr || ""}`;
      } catch (_) {}
      llamaServerHelpCache.set(binaryPath, help);
    }
    return llamaServerHelpCache.get(binaryPath).includes(flag);
  }

  async function startLlmWithBackend(settings = {}, backend) {
    const filename = path.basename(String(settings.model || ""));
    const modelPath = path.join(LLM_MODELS, filename);
    if (!filename) throw badRequest("MODEL_REQUIRED", "Select a downloaded GGUF text model first.");
    if (!pathInside(modelPath, LLM_MODELS) || !fs.existsSync(modelPath)) {
      throw notFound("MODEL_NOT_FOUND", "Select a downloaded GGUF text model first.");
    }
    if (!filename.toLowerCase().endsWith(".gguf")) {
      throw badRequest("MODEL_UNSUPPORTED", "Text generation requires a .gguf model.");
    }

    if (!backend) {
      throw notInstalled("llama.cpp is not installed. Run the platform setup script to install the text backend.");
    }

    assertNoOtherActiveRuntime("text", filename);
    await killBackend();
    await killOpenVinoWorker();
    await killLlm();
    PORT_LLM = await findAvailableLlmPort();
    llmError = null;

    const loadProfile = settings.__loadProfile || {};
    let contextSize = Number(loadProfile.contextSize ?? settings.contextSize);
    if (!contextSize || contextSize <= 0) {
      const isGpu = backend.mode.includes("GPU") || backend.mode.includes("CUDA") || backend.mode.includes("Vulkan") || backend.mode.includes("Metal") || backend.mode.startsWith("Auto");
      contextSize = chooseAutoContext(filename, isGpu);
      console.log(`  [llm] Auto-selected context size: ${contextSize} tokens based on memory limits.`);
    } else {
      contextSize = Math.max(512, Math.min(32768, contextSize));
    }

    const isSyclBackend = backend.mode.includes("SYCL") || path.basename(path.dirname(backend.path)).toLowerCase() === "sycl";
    const requestedGpuLayers = Number.isFinite(Number(loadProfile.gpuLayers ?? settings.gpuLayers)) ? Number(loadProfile.gpuLayers ?? settings.gpuLayers) : -1;
    const effectiveGpuLayers = isSyclBackend ? getStableSyclGpuLayers(filename, requestedGpuLayers) : requestedGpuLayers;
    const effectiveFlashAttn = isSyclBackend ? false : (loadProfile.flashAttn ?? (settings.flashAttn !== false));
    const effectiveCacheTypeK = isSyclBackend ? "q4_0" : loadProfile.cacheTypeK || settings.cacheTypeK || llmSettings.cacheTypeK || "q8_0";
    const effectiveCacheTypeV = isSyclBackend ? "q4_0" : loadProfile.cacheTypeV || settings.cacheTypeV || llmSettings.cacheTypeV || "q8_0";
    const effectiveBatchSize = isSyclBackend ? Math.min(256, Number(loadProfile.batchSize ?? settings.batchSize) || llmSettings.batchSize || 512) : Number(loadProfile.batchSize ?? settings.batchSize) || llmSettings.batchSize || 512;
    const effectiveUbatchSize = isSyclBackend ? Math.min(256, Number(loadProfile.ubatchSize ?? settings.ubatchSize) || llmSettings.ubatchSize || 512) : Number(loadProfile.ubatchSize ?? settings.ubatchSize) || llmSettings.ubatchSize || 512;
    const effectiveEnableThinking = isSyclBackend && effectiveGpuLayers === 0 ? false : (loadProfile.enableThinking ?? (settings.enableThinking === true));

    llmSettings = {
      ...llmSettings,
      model: filename,
      threads: Math.max(1, Math.min(64, Number(settings.threads) || llmSettings.threads)),
      contextSize: contextSize,
      gpuLayers: effectiveGpuLayers,
      requestedGpuLayers,
      backendMode: backend.mode,
      backendBinary: path.basename(backend.path),
      loadProfile: loadProfile.name || "requested",
      enableThinking: effectiveEnableThinking,
      supportsThinking: /deepseek|qwen3|gemma-4|gemma4|think|r1|e2b|reasoning/i.test(filename),
      // New performance settings
      flashAttn: effectiveFlashAttn,
      cacheTypeK: effectiveCacheTypeK,
      cacheTypeV: effectiveCacheTypeV,
      mlock: settings.mlock || llmSettings.mlock || false,
      mmap: settings.mmap !== false && llmSettings.mmap !== false,
      cachePrompt: settings.cachePrompt !== false && llmSettings.cachePrompt !== false,
      defragThold: Number(settings.defragThold) || llmSettings.defragThold || 0.1,
      batchSize: Math.max(128, Math.min(2048, effectiveBatchSize)),
      ubatchSize: Math.max(128, Math.min(2048, effectiveUbatchSize)),
      performanceProfile: settings.performanceProfile || llmSettings.performanceProfile || "balanced",
    };

    let mmprojPath = null;
    const lowerFilename = filename.toLowerCase();
    const isMultimodal = isVisionModelFilename(lowerFilename);

    if (isMultimodal) {
      if (settings.mmproj) {
        const customProjPath = path.join(LLM_MODELS, path.basename(settings.mmproj));
        if (fs.existsSync(customProjPath)) {
          mmprojPath = customProjPath;
        }
      }
      if (!mmprojPath) {
        try {
          const files = readdirVisible(LLM_MODELS);
          let bestMatch = null;
          
          // 1. Match by Hugging Face repository prefix (e.g., "unsloth--gemma-4-E2B-it-qat-GGUF--")
          if (filename.includes("--")) {
            const lastIndex = filename.lastIndexOf("--");
            const repoPrefix = filename.substring(0, lastIndex + 2);
            bestMatch = files.find(file => {
              const lower = file.toLowerCase();
              return file.startsWith(repoPrefix) && lower.includes("mmproj") && lower.endsWith(".gguf");
            });
          }
          
          // 2. Match a projector named after this exact model, e.g.
          //    Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf -> mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf
          if (!bestMatch) {
            const baseName = lowerFilename.replace(/\.gguf$/, "").replace(/[-_.](?:i?q\d[\w]*|f16|bf16|f32)$/i, "");
            if (baseName.length >= 6) {
              bestMatch = files.find((file) => {
                const lower = file.toLowerCase();
                return lower.endsWith(".gguf") && lower.includes("mmproj") && lower.includes(baseName);
              });
            }
          }

          // 3. Match by model family keyword (e.g. matching model containing "gemma-4" with projector containing "gemma-4")
          if (!bestMatch) {
            const keywords = ["gemma-4", "gemma4", "llava", "qwen2.5-vl", "qwen3-vl", "qwen2vl", "qwen2-vl", "paligemma", "minicpm", "internvl", "phi-3", "phi3", "smolvlm", "moondream"];
            const matchedKeyword = keywords.find(kw => lowerFilename.includes(kw));
            if (matchedKeyword) {
              bestMatch = files.find(file => {
                const lower = file.toLowerCase();
                return lower.endsWith(".gguf") && lower.includes("mmproj") && lower.includes(matchedKeyword);
              });
            }
          }
          
          // 4. General fallback: only a generically named projector (e.g. mmproj-model-f16.gguf).
          //    A projector named after another model (mmproj-Qwen2.5-VL-...) would make
          //    llama.cpp fail to load this one.
          if (!bestMatch) {
            bestMatch = files.find(file => /^mmproj(?:[-_.]model)?(?:[-_.](?:f16|bf16|f32|q\d\w*))?\.gguf$/i.test(file));
          }
          
          if (bestMatch) {
            mmprojPath = path.join(LLM_MODELS, bestMatch);
          }
        } catch (_) {}
      }
    }

    const args = [
      "--model", modelPath,
      "--host", "127.0.0.1",
      "--port", String(PORT_LLM),
      "-lv", "1",
      "--ctx-size", String(llmSettings.contextSize),
      "--threads", String(llmSettings.threads),
      "--n-gpu-layers", String(llmSettings.gpuLayers),
      "--parallel", "1",
      "--cache-type-k", String(llmSettings.cacheTypeK),   // ✅ KV cache quantization K
      "--cache-type-v", String(llmSettings.cacheTypeV),   // ✅ KV cache quantization V
      "--cache-prompt",                        // ✅ Prompt caching for multi-turn (major UX win)
      "--ctx-checkpoints", "8",                // ✅ Context shifting recovery
      "--poll", "30",                          // ✅ More aggressive polling
      "--metrics",                             // ✅ Metrics endpoint for tuning
      "--batch-size", String(llmSettings.batchSize),       // ✅ Prompt processing batch
      "--ubatch-size", String(llmSettings.ubatchSize),     // ✅ Micro-batch size
    ];
    if (llmSettings.flashAttn) {
      args.push("--flash-attn", "on");
    }
    if (isSyclBackend) {
      args.push("--no-warmup");
    }
    
    // CPU mode: lock memory to prevent OS paging (critical for consistent speed)
    const isGpuMode = backend.mode.includes("GPU") || backend.mode.includes("CUDA") ||
                      backend.mode.includes("HIP") || backend.mode.includes("ROCm") ||
                      backend.mode.includes("Vulkan") || backend.mode.includes("Metal") ||
                      backend.mode.includes("SYCL");
    const lockMemory = !isGpuMode && llmSettings.mlock;
    if (llamaServerSupportsFlag(backend.path, "--load-mode")) {
      // llama.cpp b11000+ replaced --mmap/--mlock with --load-mode and rejects the old flags.
      const loadMode = llmSettings.mmap ? (lockMemory ? "mmap+mlock" : "mmap") : (lockMemory ? "mlock" : "none");
      args.push("--load-mode", loadMode);
    } else {
      if (lockMemory) {
        args.push("--mlock");                    // ✅ Prevent OS swapping on CPU
      }
      // All modes: memory-mapped loading for faster startup
      if (llmSettings.mmap) {
        args.push("--mmap");                     // ✅ Faster model loading
      }
    }
    
    if (llmSettings.enableThinking === false) {
      args.push("--reasoning", "off");           // ✅ Disable reasoning/thinking completely
    } else if (llmSettings.supportsThinking) {
      args.push("--reasoning", "on");            // ✅ Enable reasoning for supported models
    }
    if (llmSettings.enableThinking === true && llmSettings.supportsThinking) {
      args.push("--reasoning-format", "deepseek"); // ✅ Extract thoughts into reasoning_content
    }
    if (mmprojPath) {
      args.push("--mmproj", mmprojPath);
    }
    llmSettings.supportsVision = Boolean(mmprojPath);
    llmSettings.mmproj = mmprojPath ? path.basename(mmprojPath) : null;
    llmSettings.visionMode = mmprojPath ? "mmproj" : "none";
    llmSettings.visionStatus = mmprojPath
      ? `Using projector ${path.basename(mmprojPath)}`
      : (isMultimodal ? "Matching mmproj projector not found" : "Model is text-only");
    const spawnEnv = { ...process.env };
    const backendDir = path.dirname(backend.path);
    
    // Platform library paths
    if (osPlatform === "linux") {
      spawnEnv.LD_LIBRARY_PATH = backendDir + (spawnEnv.LD_LIBRARY_PATH ? `:${spawnEnv.LD_LIBRARY_PATH}` : "");
    } else if (osPlatform === "darwin") {
      spawnEnv.DYLD_LIBRARY_PATH = backendDir + (spawnEnv.DYLD_LIBRARY_PATH ? `:${spawnEnv.DYLD_LIBRARY_PATH}` : "");
    }
    
    // CUDA-specific optimizations
    if (backend.mode.includes("CUDA")) {
      // Multi-GPU: increase command buffer size (reduces CPU stalls)
      spawnEnv.CUDA_SCALE_LAUNCH_QUEUES = spawnEnv.CUDA_SCALE_LAUNCH_QUEUES || "4x";
      
      // Linux: allow swapping to system RAM when VRAM exhausted
      if (osPlatform === "linux") {
        spawnEnv.GGML_CUDA_ENABLE_UNIFIED_MEMORY = spawnEnv.GGML_CUDA_ENABLE_UNIFIED_MEMORY || "1";
      }
    }
    
    // SYCL-specific optimizations (Intel Arc/Graphics)
    if (backend.mode.includes("SYCL")) {
      spawnEnv.ZES_ENABLE_SYSMAN = "1";
    }

    console.log("  [llm] Starting:", backend.path, args.join(" "));
    const proc = supervisor.spawnSupervised(backend.path, args, { stdio: "pipe", env: spawnEnv }, { label: "llm" });
    const procSeq = ++llmProcSeq;
    llmProc = proc;
    proc.stdout.on("data", (data) => {
      if (llmProc !== proc) return;
      process.stdout.write("  [llm] " + data.toString());
    });
    proc.usapStderrTail = "";
    proc.stderr.on("data", (data) => {
      if (llmProc !== proc) return;
      const output = data.toString();
      proc.usapStderrTail = (proc.usapStderrTail + output).slice(-4096); // for out-of-memory detection
      process.stderr.write("  [llm-err] " + output);
      if (/Vulkan\d+\s*:/i.test(output)) llmSettings.backendMode = "Vulkan GPU";
      else if (/CUDA\d+\s*:/i.test(output)) llmSettings.backendMode = "CUDA GPU";
      else if (/(HIP|ROCm)\d*\s*:/i.test(output)) llmSettings.backendMode = "ROCm GPU";
      else if (/SYCL\d+\s*:/i.test(output)) llmSettings.backendMode = "SYCL GPU";
      else if (/Metal/i.test(output) && /GPU|device/i.test(output)) llmSettings.backendMode = "Metal GPU";
      else if (/\-\s+CPU\s+:/i.test(output) && llmSettings.backendMode.startsWith("Auto")) llmSettings.backendMode = "CPU";
      if (/error|failed/i.test(output) && !/no error/i.test(output)) {
        llmError = output.trim().slice(-1200);
        const unknownArch = output.match(/unknown model architecture:\s*'([^']+)'/i);
        if (unknownArch) {
          llmError = `${LLAMA_CPP_UNSUPPORTED_ARCHITECTURES[unknownArch[1].toLowerCase()] || `This llama.cpp build does not support the '${unknownArch[1]}' architecture. Re-run setup to update the backend, or pick a different model.`}\n${llmError}`.slice(-1400);
        }
      }
    });
    // #68: a launch failure (EACCES and the like) is an "error" event, not an exit. Without a listener it
    // stopped the whole server. Now it fails this start like a failed launch: waitForLlmReady sees that the
    // engine is gone and throws llmError, and the next backend or profile is tried.
    proc.on("error", (err) => {
      if (!isLaunchFailure(proc)) { console.warn("  [llm] engine process error:", err.message); return; }
      console.error("  [llm] Could not start", backend.path, "-", err.code || "", err.message);
      if (llmProc !== proc) return;
      llmError = describeSpawnError(err, "text engine (llama.cpp)");
      llmReady = false;
      llmProc = null;
      llmLastExit = { code: null, signal: null, at: new Date().toISOString(), unexpected: false };
    });
    proc.on("exit", (code, signal) => {
      if (llmProc !== proc) {
        console.log("  [llm] stale process exited with code", code);
        return;
      }
      const wasReady = proc.usapReady === true;
      llmReady = false;
      llmProc = null;
      if (code !== 0 && code !== null && !llmError) llmError = `llama.cpp exited with code ${code}`;
      console.log("  [llm] exited with code", code, signal ? `(signal ${signal})` : "", `(process ${procSeq})`);
      if (wasReady) handleUnexpectedLlmExit(code, signal, proc.usapStderrTail);
      else llmLastExit = { code, signal: signal || null, at: new Date().toISOString(), unexpected: false };
    });

    await waitForLlmReady(backend.key === "cpu" ? 720 : 360, proc, filename);
    proc.usapReady = true;
  }

  // Declared inside the request handler in serve.cjs before Step 9.8h.
  function getLlmRuntimeStats() {
    const benchmarks = getPersistedLlmBenchmarks();
    return {
      ok: true,
      ready: llmReady,
      running: llmProc !== null,
      selectedBackend: getLlmBackendProbe().selected,
      settings: llmSettings,
      modelSettings: getPersistedLlmModelSettings(),
      benchmarks: (benchmarks.results || []).slice(0, 20),
    };
  }

  async function benchmarkLlmBackend(model, backend, baseSettings = {}) {
    const prompt = String(baseSettings.prompt || "Reply with one short sentence about local AI performance.");
    const startedAt = Date.now();
    await startLlmWithBackend({
      ...baseSettings,
      model,
      contextSize: Math.min(2048, Number(baseSettings.contextSize) || 2048),
      gpuLayers: Number.isFinite(Number(baseSettings.gpuLayers)) ? Number(baseSettings.gpuLayers) : -1,
      enableThinking: false,
    }, backend);

    const result = await requestJson(`http://127.0.0.1:${PORT_LLM}/v1/chat/completions`, {
      model: llmSettings.model || "local-model",
      messages: [
        { role: "system", content: "You are a concise local benchmark assistant." },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 64,
      stream: false,
    }, 180000);
    const finishedAt = Date.now();
    const timings = result.timings || {};
    return {
      backendKey: backend.key,
      backendMode: llmSettings.backendMode || backend.mode,
      backendBinary: llmSettings.backendBinary || path.basename(backend.path),
      model,
      ok: true,
      total_ms: finishedAt - startedAt,
      prompt_ms: Number(timings.prompt_ms) || null,
      predicted_ms: Number(timings.predicted_ms) || null,
      predicted_n: Number(timings.predicted_n) || null,
      predicted_per_second: Number(timings.predicted_per_second) || null,
      prompt_per_second: Number(timings.prompt_per_second) || null,
    };
  }

  async function benchmarkLlmModel(settings = {}) {
    const filename = path.basename(String(settings.model || llmSettings.model || ""));
    const modelPath = path.join(LLM_MODELS, filename);
    if (!filename) throw badRequest("MODEL_REQUIRED", "Select a downloaded GGUF text model before benchmarking.");
    if (!pathInside(modelPath, LLM_MODELS) || !fs.existsSync(modelPath)) {
      throw notFound("MODEL_NOT_FOUND", "Select a downloaded GGUF text model before benchmarking.");
    }

    const previous = {
      ready: llmReady,
      model: llmSettings.model,
      settings: { ...llmSettings },
    };
    const requestedBackends = Array.isArray(settings.backends)
      ? settings.backends.map((item) => String(item).toLowerCase())
      : [];
    const candidates = getLlmBackendCandidates()
      .filter((backend) => backend.key !== "cpu" || settings.includeCpu !== false)
      .filter((backend) => requestedBackends.length === 0 || requestedBackends.includes(backend.key));

    if (candidates.length === 0) {
      throw new Error("No available text backends were detected for benchmarking.");
    }

    const results = [];
    for (const backend of candidates) {
      try {
        const result = await benchmarkLlmBackend(filename, backend, settings);
        results.push(recordLlmBenchmark(result));
      } catch (err) {
        results.push(recordLlmBenchmark({
          backendKey: backend.key,
          backendMode: backend.mode,
          backendBinary: path.basename(backend.path),
          model: filename,
          ok: false,
          error: (err.message || String(err)).slice(-800),
        }));
        await killLlm();
      }
    }

    const successful = results
      .filter((item) => item.ok && Number(item.predicted_per_second) > 0)
      .sort((a, b) => Number(b.predicted_per_second) - Number(a.predicted_per_second));
    const winner = successful[0] || null;
    if (winner) {
      updateLlmModelSettings(filename, {
        preferredBackend: winner.backendKey,
        benchmarkWinner: {
          backendMode: winner.backendMode,
          predicted_per_second: winner.predicted_per_second,
          createdAt: winner.createdAt,
        },
      });
    }

    if (previous.ready && previous.model && previous.model === filename && winner) {
      try {
        await startLlm({ ...previous.settings, model: filename, preferredBackend: winner.backendKey });
      } catch (err) {
        console.warn("  [llm] Failed to restore text model after benchmark:", err.message || err);
      }
    }

    return { ok: true, model: filename, winner, results };
  }

  const state = Object.freeze({
      get PORT_LLM() { return PORT_LLM; },
      get llmProc() { return llmProc; },
      get llmProcSeq() { return llmProcSeq; },
      get llmReady() { return llmReady; },
      get llmError() { return llmError; },
      get llmStartToken() { return llmStartToken; },
      get llmStarting() { return llmStarting; },
      get llmLastStartRequest() { return llmLastStartRequest; },
      get llmLastExit() { return llmLastExit; },
      get llmCrash() { return llmCrash; },
      get llmRestartTimer() { return llmRestartTimer; },
      get llmRestartAttempts() { return llmRestartAttempts; },
      get llmRestarting() { return llmRestarting; },
      get llmOperationQueue() { return llmOperationQueue; },
      get llmSettings() { return llmSettings; },
      get cachedLlmBackendProbe() { return cachedLlmBackendProbe; },
      get cachedLlmBackendProbeAt() { return cachedLlmBackendProbeAt; },
  });
  return {
    state,
    routeState: Object.freeze({
      get PORT_LLM() { return PORT_LLM; },
      get llmProc() { return llmProc; },
      get llmProcSeq() { return llmProcSeq; },
      get llmReady() { return llmReady; },
      get llmError() { return llmError; },
      get llmStartToken() { return llmStartToken; },
      get llmStarting() { return llmStarting; },
      get llmLastStartRequest() { return llmLastStartRequest; },
      get llmLastExit() { return llmLastExit; },
      get llmCrash() { return llmCrash; },
      get llmRestartTimer() { return llmRestartTimer; },
      get llmRestartAttempts() { return llmRestartAttempts; },
      get llmRestarting() { return llmRestarting; },
      get llmOperationQueue() { return llmOperationQueue; },
      get llmSettings() { return llmSettings; },
      get cachedLlmBackendProbe() { return cachedLlmBackendProbe; },
      get cachedLlmBackendProbeAt() { return cachedLlmBackendProbeAt; },
      set llmError(value) { llmError = value; },
    }),
    fns: { LLM_RESTART_LIMIT, LLM_RESTART_WINDOW_MS, LLM_AUTO_RESTART, LLM_READY_TIMEOUT_MS, llmEngineState, llmLifecycleSnapshot, engineStartCancelledError, runExclusiveLlmOperation, getPersistedLlmModelSettings, savePersistedLlmModelSettings, getLlmModelSettings, updateLlmModelSettings, getPersistedLlmBenchmarks, savePersistedLlmBenchmarks, recordLlmBenchmark, parseLlamaDeviceList, findAvailableLlmPort, getLlmBackend, resolveSystemLlamaServer, describeLlmProbeFailure, probeLlmBackend, getAllLlmBackendCandidates, getLlmBackendProbe, getLlmBackendCandidates, pingLlmReady, waitForLlmReady, killLlm, terminateLlmProc, cancelLlmRestart, stopLlmNow, describeExit, llmModelBytes, handleUnexpectedLlmExit, chooseAutoContext, buildLlmLoadProfiles, LLAMA_CPP_UNSUPPORTED_ARCHITECTURES, readGgufArchitecture, startLlm, startLlmAttempts, llamaServerHelpCache, llamaServerSupportsFlag, startLlmWithBackend, getLlmRuntimeStats, benchmarkLlmBackend, benchmarkLlmModel },
  };
}

const FIT_REQUIRED = ["ROOT","fs","getGpuInfo","os","osPlatform","path","spawnSync"];

// llmfit recommendations. Before Step 9.8h this code was declared inside the request handler, so its
// cache was created again for every request and never reused; callers keep that by creating a new lookup
// per request (see serve.cjs). Making the cache work is a separate change (#69).
function createLlmfitLookup(deps) {
  for (const name of FIT_REQUIRED) {
    if (deps[name] === undefined || deps[name] === null) throw new Error(`llmfit: missing dependency ${name}`);
  }
  const { ROOT, fs, getGpuInfo, os, osPlatform, path, spawnSync } = deps;

  let cachedLlmfitResults = new Map();

  function getHardwareHash() {
    const cpus = os.cpus();
    const gpu = getGpuInfo();
    const ram = os.totalmem();
    return `${cpus.length}-${cpus[0]?.model || 'unknown'}-${gpu.name}-${ram}`;
  }

  async function getLlmfitRecommendations(useCase = "chat", limit = 10) {
    const hardwareHash = getHardwareHash();
    const cacheKey = `${hardwareHash}:${useCase}:${limit}`;
    
    const cached = cachedLlmfitResults.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < 3600000) { // 1 hour cache
      return cached.data;
    }
    
    // Try to find llmfit binary
    const llmfitPaths = [
      path.join(ROOT, "app", "tools", "llmfit", osPlatform === "win32" ? "llmfit.exe" : "llmfit"),
      "llmfit", // PATH
    ];
    
    let llmfitPath = null;
    for (const p of llmfitPaths) {
      try {
        if (fs.existsSync(p)) {
          llmfitPath = p;
          break;
        }
        if (osPlatform !== "win32") {
          const whichResult = spawnSync("which", [p], { stdio: "ignore" });
          if (whichResult.status === 0) {
            llmfitPath = p;
            break;
          }
        }
      } catch (_) {}
    }
    
    if (!llmfitPath) return null; // Fallback to tier table
    
    try {
      const result = spawnSync(llmfitPath, [
        "recommend", "--json", "--limit", String(limit),
        "--use-case", useCase, "--force-runtime", "llamacpp"
      ], {
        encoding: "utf8",
        timeout: 8000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      
      if (result.status !== 0) return null;
      
      const data = JSON.parse(result.stdout);
      cachedLlmfitResults.set(cacheKey, { timestamp: Date.now(), data });
      return data;
    } catch (_) {
      return null;
    }
  }

  return { getLlmfitRecommendations };
}

module.exports = { createLlmEngine, createLlmfitLookup };
