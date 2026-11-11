// serve.cjs — portable static file server + backend process manager
// Serves app/dist/, manages sd-vulkan.exe lifecycle with correct CLI flags
// serve.cjs — portable static file server + backend process manager
// Serves app/dist/, manages sd-vulkan.exe lifecycle with correct CLI flags

const http     = require("http");
const https    = require("https");
const fs       = require("fs");
const net      = require("net");
const os       = require("os");
const path     = require("path");
const { spawn, spawnSync, execSync, exec, execFile } = require("child_process");
const { comprehensiveWebSearch } = require("../search/core");
const { detectModelKindCached } = require("./model-kind.cjs");
const { createRequestPolicy, withoutCorsHeaders, resolveStaticPath, jsonBodyType } = require("./request-policy.cjs");
const { createLanAuth, withoutAuthHeaders, TOKEN_FILE_NAME: LAN_TOKEN_FILE_NAME } = require("./lan-auth.cjs");
// Step 9.6: engines run under a guard process, so they stop with this server even on a crash or SIGKILL.
const supervisor = require("./supervisor.cjs");
const { decideRestart } = require("./restart-policy.cjs");
// Step 9.7: one error model (status by cause, machine-readable code, no stacks, no host paths).
const errors = require("./errors.cjs");
const { ApiError, badRequest, notFound, conflict, notInstalled, errorStatus, errorBody, publicMessage, configurePathRedaction } = errors;
const { publicPaths } = require("./public-paths.cjs");
// Step 9.8: request pipeline (security order + error boundary), router and route modules.
const { createRouter } = require("./http/router.cjs");
const { createPipeline } = require("./http/pipeline.cjs");
const { systemRoutes } = require("./routes/system.cjs");
const { createTtsService } = require("./services/tts-engine.cjs");
const { ttsRoutes } = require("./routes/tts.cjs");
const { createSpeechService } = require("./services/speech-engine.cjs");
const { speechRoutes } = require("./routes/speech.cjs");
const { createWebSearchService } = require("./services/web-search.cjs");
const { createHardwareService } = require("./services/hardware.cjs");
const { searchRoutes } = require("./routes/search.cjs");
const { imageRoutes } = require("./routes/image.cjs");
const { createImageEngine } = require("./services/image-engine.cjs");
const { modelRoutes } = require("./routes/models.cjs");
const { createModelStore } = require("./services/model-store.cjs");
const { createDownloadService } = require("./services/downloads.cjs");

// HTTP keep-alive agent for llama-server (eliminates TCP handshake per request)
const llmHttpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 1,
  keepAliveMsecs: 30000,
});

const HF_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const hfModelCache = new Map();
const hfProjectorCache = new Map();

function readPort(value, fallback) {
  const port = parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

const PORT_FRONTEND = readPort(process.env.PORT || process.env.FRONTEND_PORT, 1420);
const PREFERRED_BACKEND_PORT = readPort(process.env.BACKEND_PORT || process.env.SD_BACKEND_PORT, 8080);
const PREFERRED_LLM_PORT = readPort(process.env.LLM_PORT, 10086);
const PREFERRED_SPEECH_PORT = readPort(process.env.SPEECH_PORT, 10088);
const PREFERRED_TTS_PORT = readPort(process.env.TTS_PORT, 10089);
let PORT_LLM = PREFERRED_LLM_PORT;
const MAX_JSON_BODY_BYTES = 64 * 1024 * 1024;
const SERVER_BUILD = "text-image-v1";
// Program and user-data locations come from one resolver (scripts/server/paths.cjs). The default
// portable layout is byte-identical to the original <root>/app folders.
const { resolveLayout, ensureDataDirs } = require("./paths.cjs");
const LAYOUT  = resolveLayout();
if (LAYOUT.warning) console.warn(`  [paths] ${LAYOUT.warning}`);
const ROOT    = LAYOUT.root;
configurePathRedaction({ root: ROOT });
const DIST    = LAYOUT.dist;
const TOOLS   = LAYOUT.tools;
ensureDataDirs(LAYOUT);
// Outbound requests (downloads, Hugging Face API) may only reach public internet addresses
// (scripts/server/net-guard.cjs). USAP_ALLOW_LAN_DOWNLOADS=1 additionally allows private-LAN hosts
// such as a model mirror on a NAS; loopback and cloud-metadata addresses stay blocked.
const { assertSafeUrl, guardedRequestOptions, followRedirect, privateLanPolicy } = require("./net-guard.cjs");
const DOWNLOAD_POLICY = process.env.USAP_ALLOW_LAN_DOWNLOADS === "1" ? privateLanPolicy({ maxRedirects: 10 }) : { maxRedirects: 10 };
// Downloads are hashed while they stream, checked against scripts/config/download-digests.txt and only
// then moved into place (Step 9.4; scripts/server/downloader.cjs, scripts/server/integrity.cjs).
const downloader = require("./downloader.cjs");
const integrity = require("./integrity.cjs");
function downloadBlockReason(url) {
  try { assertSafeUrl(url, DOWNLOAD_POLICY); return ""; } catch (err) { return err.message; }
}
const osPlatform = process.platform;
const BACKEND_PATHS = {
  cuda: path.join(ROOT, "app", "backend", "win", "cuda", "sd-cuda.exe"),
  vulkan: path.join(ROOT, "app", "backend", "win", "vulkan", "sd-vulkan.exe"),
  cpu: path.join(ROOT, "app", "backend", "win", "cpu", "sd-cpu.exe"),
  mac: path.join(ROOT, "app", "backend", "mac", "sd"),
  linuxCpu: path.join(ROOT, "app", "backend", "linux", "cpu", "sd-server-cpu"),
  linuxVulkan: path.join(ROOT, "app", "backend", "linux", "vulkan", "sd-server-vulkan"),
  linuxRocm: path.join(ROOT, "app", "backend", "linux", "rocm", "sd-server-rocm"),
  linuxCuda: path.join(ROOT, "app", "backend", "linux", "cuda", "sd-server-cuda"),
};
let BACKEND_PATH = "";
// On Intel Macs the image backend is only present if setup verified its x86_64 slices (scripts/setup/setup.sh).
const IS_MAC_INTEL = osPlatform === "darwin" && process.arch !== "arm64";
const MAC_INTEL_IMAGE_MESSAGE = "Image generation is not installed on this Intel Mac: setup could not verify an x86_64 stable-diffusion.cpp build. Run setup again; text chat, transcription and voice still work.";
const backendValidationErrors = {};
if (osPlatform === "win32") {
  let hasNvidia = false;
  try {
    execSync("nvidia-smi", { stdio: "ignore" });
    hasNvidia = true;
  } catch (_) {
    const commonPath = "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe";
    if (fs.existsSync(commonPath)) {
      hasNvidia = true;
    }
  }

  if (hasNvidia && fs.existsSync(BACKEND_PATHS.cuda)) {
    BACKEND_PATH = BACKEND_PATHS.cuda;
  } else if (fs.existsSync(BACKEND_PATHS.cpu)) {
    BACKEND_PATH = BACKEND_PATHS.cpu;
  } else {
    BACKEND_PATH = BACKEND_PATHS.vulkan;
  }
} else if (osPlatform === "darwin") {
  BACKEND_PATH = BACKEND_PATHS.mac;
} else {
  // Linux: default to Vulkan if available, otherwise CPU
  if (fs.existsSync(BACKEND_PATHS.linuxVulkan)) {
    BACKEND_PATH = BACKEND_PATHS.linuxVulkan;
  } else if (fs.existsSync(BACKEND_PATHS.linuxCpu)) {
    BACKEND_PATH = BACKEND_PATHS.linuxCpu;
  } else {
    BACKEND_PATH = BACKEND_PATHS.linuxVulkan;
  }
}
const MODELS = LAYOUT.data.models;
const LLM_MODELS = LAYOUT.data.llmModels;
const CHAT_HISTORY = LAYOUT.data.chatHistory;
const LLM_BACKEND_PATHS = {
  winCuda: path.join(ROOT, "app", "llm-backend", "win", "cuda", "llama-server.exe"),
  winVulkan: path.join(ROOT, "app", "llm-backend", "win", "vulkan", "llama-server.exe"),
  winSycl: path.join(ROOT, "app", "llm-backend", "win", "sycl", "llama-server.exe"),
  winHip: path.join(ROOT, "app", "llm-backend", "win", "hip", "llama-server.exe"),
  winCpu: path.join(ROOT, "app", "llm-backend", "win", "cpu", "llama-server.exe"),
  linuxCuda: path.join(ROOT, "app", "llm-backend", "linux", "cuda", "llama-server"),
  linuxRocm: path.join(ROOT, "app", "llm-backend", "linux", "rocm", "llama-server"),
  linuxVulkan: path.join(ROOT, "app", "llm-backend", "linux", "vulkan", "llama-server"),
  linuxSycl: path.join(ROOT, "app", "llm-backend", "linux", "sycl", "llama-server"),
  linuxCpu: path.join(ROOT, "app", "llm-backend", "linux", "cpu", "llama-server"),
  macArm64: path.join(ROOT, "app", "llm-backend", "mac", "arm64", "llama-server"),
  macX64: path.join(ROOT, "app", "llm-backend", "mac", "x64", "llama-server"),
};
const LLM_CONFIG_DIR = LAYOUT.data.config;
const LLM_MODEL_SETTINGS_PATH = path.join(LLM_CONFIG_DIR, "llm-model-settings.json");
const LLM_BENCHMARK_PATH = path.join(LLM_CONFIG_DIR, "llm-benchmarks.json");
const SPEECH_MODELS = LAYOUT.data.speechModels;
const TRANSCRIPTIONS = LAYOUT.data.transcriptions;
const TTS_MODELS = LAYOUT.data.ttsModels;
const TTS_OUTPUTS = LAYOUT.data.ttsOutputs;
const TTS_CACHE = LAYOUT.data.ttsCache;
const WEB_SEARCH_CACHE = LAYOUT.data.webSearchCache;
const TTS_RUNTIME = path.join(ROOT, "app", "tts-runtime");
const TTS_WORKER = path.join(ROOT, "scripts", "workers", "tts-kokoro-worker.mjs");
const SPEECH_BACKEND_ROOT = path.join(ROOT, "app", "speech-backend");
const SPEECH_BACKEND_PATHS = {
  winVulkanCli: path.join(SPEECH_BACKEND_ROOT, "win", "vulkan", "whisper-cli.exe"),
  winVulkanServer: path.join(SPEECH_BACKEND_ROOT, "win", "vulkan", "whisper-server.exe"),
  winCpuCli: path.join(SPEECH_BACKEND_ROOT, "win", "cpu", "whisper-cli.exe"),
  winCpuServer: path.join(SPEECH_BACKEND_ROOT, "win", "cpu", "whisper-server.exe"),
  winCli: path.join(ROOT, "app", "speech-backend", "win", "whisper-cli.exe"),
  winServer: path.join(ROOT, "app", "speech-backend", "win", "whisper-server.exe"),
  linuxVulkanCli: path.join(SPEECH_BACKEND_ROOT, "linux", "vulkan", "whisper-cli"),
  linuxVulkanServer: path.join(SPEECH_BACKEND_ROOT, "linux", "vulkan", "whisper-server"),
  linuxCpuCli: path.join(SPEECH_BACKEND_ROOT, "linux", "cpu", "whisper-cli"),
  linuxCpuServer: path.join(SPEECH_BACKEND_ROOT, "linux", "cpu", "whisper-server"),
  linuxCli: path.join(ROOT, "app", "speech-backend", "linux", "whisper-cli"),
  linuxServer: path.join(ROOT, "app", "speech-backend", "linux", "whisper-server"),
  macMetalCli: path.join(SPEECH_BACKEND_ROOT, "mac", "metal", "whisper-cli"),
  macMetalServer: path.join(SPEECH_BACKEND_ROOT, "mac", "metal", "whisper-server"),
  macCpuCli: path.join(SPEECH_BACKEND_ROOT, "mac", "cpu", "whisper-cli"),
  macCpuServer: path.join(SPEECH_BACKEND_ROOT, "mac", "cpu", "whisper-server"),
  macCli: path.join(ROOT, "app", "speech-backend", "mac", "whisper-cli"),
  macServer: path.join(ROOT, "app", "speech-backend", "mac", "whisper-server"),
};
const OPENVINO_MODELS = LAYOUT.data.openvinoModels;
const OUTPUTS = LAYOUT.data.outputs;

const OPENVINO_NPU_MODELS = [
  {
    id: "lcm-dreamshaper-v7-fp16",
    name: "LCM DreamShaper v7 FP16",
    repo: "OpenVINO/LCM_Dreamshaper_v7-fp16-ov",
    folder: "LCM_Dreamshaper_v7-fp16-ov",
    approxSize: "2.0 GB",
    resolution: "512x512",
    notes: "OpenVINO LCM image model. Uses CPU text encoder, NPU UNet, and GPU or CPU VAE decoder.",
  },
];

// ── Backend process state ─────────────────────────────────────────────────────
// Image generation (stable-diffusion.cpp, OpenVINO NPU, Core ML) lives in services/image-engine.cjs (Step 9.8g).
// Functions bound later in this file are passed as wrappers, resolved when called.
const imageEngine = createImageEngine({
  BACKEND_PATHS, IS_MAC_INTEL, MAC_INTEL_IMAGE_MESSAGE, MODELS, OUTPUTS, PREFERRED_BACKEND_PORT, ROOT, assertNoOtherActiveRuntime, backendValidationErrors, badRequest, checkPort, conflict, describeLinuxRuntimeLinkerError, findOpenVinoModel: (...args) => findOpenVinoModel(...args), fs, getBackendOptions, getDefaultModel, getModelLoadIssue, getOpenVinoModelInfo: (...args) => getOpenVinoModelInfo(...args), getOpenVinoNpuInfo: (...args) => getOpenVinoNpuInfo(...args), getPreferredVulkanBackendName: (...args) => getPreferredVulkanBackendName(...args), http, json, killLlm, os, osPlatform, path, pollNvidiaVram: (...args) => pollNvidiaVram(...args), readdirVisible: (...args) => readdirVisible(...args), requestJson, safeOutputName, spawn, spawnSync, stripAnsi, supervisor, withoutAuthHeaders, withoutCorsHeaders,
  getBackendPath: () => BACKEND_PATH,
});
const {
  normalizeBackendSettingValue, backendSettingsMatch, findAvailableBackendPort, getCoreMLPythonPath, backendAccepts, proxyImageBackendRequest, killOpenVinoWorker, generateWithOpenVino, killBackend, startBackend, saveGeneratedOutput, listGeneratedOutputs, deleteGeneratedOutputs,
} = imageEngine.fns;

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

function modelName(value) {
  return path.basename(String(value || ""));
}

function getActiveHeavyRuntime() {
  if ((imageEngine.state.backendReady || imageEngine.state.backendProc || imageEngine.state.openvinoReady || imageEngine.state.openvinoProc) && imageEngine.state.currentSettings.model) {
    return { type: "image", label: "Image", model: modelName(imageEngine.state.currentSettings.model) };
  }
  if ((llmReady || llmProc) && llmSettings.model) {
    return { type: "text", label: "Text", model: modelName(llmSettings.model) };
  }
  return null;
}

function assertNoOtherActiveRuntime(targetType, targetModel) {
  if (targetType !== "image" && targetType !== "text") return;

  const runtime = getActiveHeavyRuntime();
  const targetName = modelName(targetModel);
  if (!runtime || (runtime.type === targetType && runtime.model === targetName)) return;

  const err = new Error(`"${runtime.model}" is already loaded as a ${runtime.label} model. Unload it before loading "${targetName}".`);
  err.statusCode = 409;
  err.code = "MODEL_ALREADY_ACTIVE";
  err.activeRuntime = runtime;
  err.targetRuntime = { type: targetType, model: targetName };
  throw err;
}

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

function jsonErrorStatus(err) {
  return errorStatus(err);
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


function appleNpuRuntimeMatches(current, requested) {
  return normalizeBackendSettingValue("model", current.model) === normalizeBackendSettingValue("model", requested.model) &&
    current.backendType === "apple-npu" &&
    requested.backendType === "apple-npu" &&
    normalizeBackendSettingValue("useGpu", current.useGpu) === normalizeBackendSettingValue("useGpu", requested.useGpu) &&
    normalizeBackendSettingValue("width", current.width || 512) === normalizeBackendSettingValue("width", requested.width || 512) &&
    normalizeBackendSettingValue("height", current.height || 512) === normalizeBackendSettingValue("height", requested.height || 512);
}


// Hardware detection, telemetry and memory polling live in services/hardware.cjs (Step 9.8e).
const hardware = createHardwareService({
  os, fs, path, execSync, spawnSync, exec, execFile, osPlatform, LLM_BACKEND_PATHS,
  getBackendProc: () => imageEngine.state.backendProc, getOpenVinoPython, getCoreMLPythonPath,
});
const {
  roundGb, getPhysicalCores, getOptimalThreads, getCpuSample, getCpuUsagePercent, hasVulkanRuntime,
  detectLinuxGpuFromSysfs, isVirtualOrSoftwareGpu, getPreferredVulkanBackendName,
  detectLlamaCudaGpu, detectLlamaVulkanGpu, detectLlamaSyclGpu, getGpuInfo, hasNpuHardware,
  detectNpu, pollNvidiaVram, getNvidiaVram, parseLlamaDeviceMemory, getLlamaTelemetryBackendPath,
  pollLlamaVram, getLlamaVram, pollMacRam, getHardwareSpecs, getTelemetry, getOpenVinoNpuInfo,
  getCoreMLNpuInfo,
} = hardware.fns;

let cachedBackendOptions = null;


// ── GPU Layer Auto-Tuning ─────────────────────────────────────────────────────
// Calculate optimal GPU layer count from free VRAM to prevent OOM
function chooseAutoLayers(modelFilename, freeVramBytes, cacheTypeK = "q8_0", cacheTypeV = "q8_0") {
  let modelSizeGb = 4;
  let layerCount = 32;
  
  try {
    const modelPath = path.join(LLM_MODELS, modelFilename);
    if (fs.existsSync(modelPath)) {
      const stats = fs.statSync(modelPath);
      modelSizeGb = stats.size / (1024 * 1024 * 1024);
    }
  } catch (_) {}
  
  // Estimate layer count from model size (rough heuristic based on common architectures)
  if (modelSizeGb < 2) layerCount = 24;      // Small models (1-2B)
  else if (modelSizeGb < 4) layerCount = 32;   // Medium (3-4B)
  else if (modelSizeGb < 8) layerCount = 40;   // Large (7-8B)
  else if (modelSizeGb < 20) layerCount = 80;    // Very large (13-20B)
  else if (modelSizeGb < 40) layerCount = 100;   // Huge (30-40B)
  else layerCount = 120;                        // Massive (70B+)
  
  // Calculate approximate layer size
  const layerSizeGb = modelSizeGb / layerCount;
  
  // Account for KV cache memory with quantization
  // q8_0 = 0.5x, q4_0 = 0.25x of f16
  const kvCacheMultiplier = (cacheTypeK === "q4_0" || cacheTypeV === "q4_0") ? 0.25 :
                            (cacheTypeK === "q8_0" || cacheTypeV === "q8_0") ? 0.5 : 1.0;
  
  // Leave 15% VRAM headroom for KV cache + overhead + OS
  const usableVram = freeVramBytes * 0.85;
  const maxLayers = Math.floor(usableVram / (layerSizeGb * 1024 * 1024 * 1024));
  
  // Cap at total layers, return -1 if fits fully
  if (maxLayers >= layerCount) return -1;  // All layers fit
  return Math.max(0, maxLayers);
}

function getGgufModelSizeGb(modelFilename) {
  try {
    const modelPath = path.join(LLM_MODELS, modelFilename);
    if (fs.existsSync(modelPath)) {
      return fs.statSync(modelPath).size / (1024 * 1024 * 1024);
    }
  } catch (_) {}
  return 4;
}

function getStableSyclGpuLayers(modelFilename, requestedLayers) {
  if (process.env.LOCALAI_LLM_ALLOW_FULL_SYCL === "1") return requestedLayers;
  if (requestedLayers !== -1) return requestedLayers;

  const syclGpu = detectLlamaSyclGpu();
  const vramGb = syclGpu?.free_vram_gb || syclGpu?.vram_gb || 0;
  const modelSizeGb = getGgufModelSizeGb(modelFilename);
  if (vramGb > 0 && vramGb <= 8.5 && modelSizeGb >= 2.5) {
    return 0;
  }
  if (vramGb > 0 && vramGb <= 12 && modelSizeGb >= 5) {
    return 0;
  }
  return requestedLayers;
}


// Start background VRAM polling (runs every 5 seconds, only active when backend is idle)
// Start the hardware polling timers at the same point of start-up as before (Step 9.8e).
hardware.start();


function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
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


function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / (1024 ** idx)).toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

const RETRYABLE_FILE_CODES = new Set(["EACCES", "EBUSY", "EMFILE", "ENFILE", "EPERM"]);

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function withFileRetrySync(operation, attempts = 8) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return operation();
    } catch (err) {
      lastError = err;
      if (!RETRYABLE_FILE_CODES.has(err?.code) || attempt === attempts - 1) throw err;
      sleepSync(Math.min(1000, 100 * (2 ** attempt)));
    }
  }
  throw lastError;
}

function describeStorageError(err, targetPath) {
  const target = path.basename(targetPath || "the destination file");
  if (err?.code === "ENOSPC" || err?.code === "EFBIG") {
    const detail = err?.message ? ` ${err.message}` : "";
    return `Cannot write ${target}: the destination has insufficient usable space or its filesystem cannot store a file this large.${detail} Large models require an NTFS, exFAT, APFS, or ext4 drive; FAT32 files are limited to 4 GB.`;
  }
  if (RETRYABLE_FILE_CODES.has(err?.code)) {
    return `Cannot access ${target} after several retries. Close programs scanning or using the file, allow this app through antivirus/ransomware protection, and retry.`;
  }
  return err?.message || String(err);
}

function ensureStorageCapacity(targetDir, requiredBytes) {
  const bytes = Number(requiredBytes) || 0;
  if (bytes <= 0 || typeof fs.statfsSync !== "function") return;
  try {
    const stats = fs.statfsSync(targetDir);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    if (Number.isFinite(availableBytes) && availableBytes > 0 && bytes > availableBytes) {
      const err = new Error(`Only ${formatBytes(availableBytes)} is available, but ${formatBytes(bytes)} is required.`);
      err.code = "ENOSPC";
      throw err;
    }
  } catch (err) {
    if (err?.code === "ENOSPC") throw err;
  }
}

function replaceFileWithRetry(tempPath, destPath) {
  // Atomic: the previous file stays in place until the new one is fully in position (Step 9.4).
  withFileRetrySync(() => integrity.atomicReplaceFile(tempPath, destPath));
}

function getPathInfo(label, targetPath, type = "file") {
  const exists = fs.existsSync(targetPath);
  return {
    label,
    path: targetPath,
    type,
    exists,
    ok: exists,
  };
}

function isDirWritable(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    const testFile = path.join(dirPath, `.uncensored-ai-studio-write-test-${Date.now()}.tmp`);
    fs.writeFileSync(testFile, "ok", "utf8");
    fs.unlinkSync(testFile);
    return true;
  } catch (_) {
    return false;
  }
}

function getDirInfo(label, targetPath) {
  const exists = fs.existsSync(targetPath);
  const writable = exists ? isDirWritable(targetPath) : false;
  return {
    label,
    path: targetPath,
    type: "directory",
    exists,
    writable,
    ok: exists && writable,
  };
}

function getPathSize(targetPath) {
  try {
    if (!fs.existsSync(targetPath)) return 0;
    const stat = fs.statSync(targetPath);
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    return fs.readdirSync(targetPath).reduce((sum, name) => sum + getPathSize(path.join(targetPath, name)), 0);
  } catch (_) {
    return 0;
  }
}

function getOpenVinoPythonCandidates() {
  const candidates = [];
  if (process.env.OPENVINO_PYTHON) candidates.push(process.env.OPENVINO_PYTHON);
  if (osPlatform === "win32") {
    candidates.push(path.join(ROOT, "app", "tools", "python-win", "python.exe"));
  } else {
    candidates.push(path.join(ROOT, "app", "tools", "openvino-venv-linux", "bin", "python"));
    candidates.push(path.join(ROOT, "app", "tools", "openvino-venv", "bin", "python")); // legacy fallback
  }
  return [...new Set(candidates)];
}

function getOpenVinoPython() {
  for (const candidate of getOpenVinoPythonCandidates()) {
    try {
      const result = spawnSync(candidate, [
        "-c",
        "import openvino, openvino_genai, PIL; print(openvino.__version__)",
      ], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
      if (result.status === 0) return candidate;
    } catch (_) {}
  }
  return null;
}


// Model folders (listing, linked models, imports) live in services/model-store.cjs (Step 9.8f).
const modelStore = createModelStore({
  LLM_MODELS, MODELS, OPENVINO_MODELS, OPENVINO_NPU_MODELS, SPEECH_MODELS, badRequest, describeStorageError,
  detectModelKindCached, ensureStorageCapacity, formatBytes, fs, getPathSize, path, replaceFileWithRetry, withFileRetrySync,
});
const {
  getOpenVinoModelInfo, findOpenVinoModel, readdirVisible, describeLinkedModel, modelFolderFor, detectedKindFor, getLlmModels, isModelFile, getModelInfo, streamModelUpload,
} = modelStore.fns;


function pathInside(childPath, parentPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function checkPort(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once("error", () => resolve({ port, available: false, inUse: true }))
      .once("listening", () => {
        tester.close(() => resolve({ port, available: true, inUse: false }));
      })
      .listen(port, "127.0.0.1");
  });
}

async function waitForPortAvailable(port, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await checkPort(port);
    if (status.available) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
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

async function findAvailableSpeechPort() {
  const preferred = await checkPort(PREFERRED_SPEECH_PORT);
  if (preferred.available) return PREFERRED_SPEECH_PORT;

  for (let port = 28161; port <= 28190; port += 1) {
    const candidate = await checkPort(port);
    if (candidate.available) {
      console.log(`  [speech] Preferred port ${PREFERRED_SPEECH_PORT} is busy; using ${port} instead.`);
      return port;
    }
  }

  throw new Error(`No free speech port found. Tried ${PREFERRED_SPEECH_PORT} and 28161-28190.`);
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


function findExistingFile(candidates) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || "";
}

// Uploads arrive as 16 kHz mono WAV (the browser converts other formats), about 115 MB
// per hour, so 1 GB allows roughly 9 hours of audio.
function readBinaryBody(req, limitBytes = 1024 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > limitBytes) {
        reject(new Error(`Audio file is too large. Limit is ${Math.round(limitBytes / (1024 * 1024))} MB.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function isWaveBuffer(buffer) {
  return buffer?.length > 44 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WAVE";
}

// Text-to-speech (Kokoro) lives in services/tts-engine.cjs (Step 9.8b).
const tts = createTtsService({
  paths: { ROOT, TTS_MODELS, TTS_OUTPUTS, TTS_CACHE, TTS_RUNTIME, TTS_WORKER },
  preferredPort: PREFERRED_TTS_PORT,
  fs, path, supervisor,
  errors: { badRequest, notFound, notInstalled },
  helpers: { formatBytes, getPathSize, isWaveBuffer, pathInside, readdirVisible, safeOutputName },
});

// Speech recognition (whisper.cpp) lives in services/speech-engine.cjs (Step 9.8c).
const speech = createSpeechService({
  paths: { ROOT, SPEECH_MODELS, SPEECH_BACKEND_ROOT, SPEECH_BACKEND_PATHS, TRANSCRIPTIONS },
  osPlatform, fs, path, supervisor,
  errors: { badRequest, notFound, notInstalled },
  helpers: { describeLinkedModel, detectedKindFor, findAvailableSpeechPort, findExistingFile, formatBytes, getPathSize, isWaveBuffer, pathInside, readdirVisible, safeOutputName },
  preferredPort: PREFERRED_SPEECH_PORT,
});

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

function waitForChildExit(proc, timeoutMs) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      resolve(true);
      return;
    }
    let done = false;
    const finish = (exited) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      proc.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    proc.once("exit", onExit);
  });
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

function getSetupPaths() {
  const appDir = path.join(ROOT, "app");
  if (osPlatform === "win32") {
    return {
      node: path.join(appDir, "tools", "node-win", "node.exe"),
      npm: path.join(appDir, "tools", "node-win", "npm.cmd"),
      distIndex: path.join(DIST, "index.html"),
      cudaBackend: BACKEND_PATHS.cuda,
      vulkanBackend: BACKEND_PATHS.vulkan,
      cpuBackend: BACKEND_PATHS.cpu,
      models: MODELS,
      outputs: OUTPUTS,
      chatHistory: CHAT_HISTORY,
      transcriptions: TRANSCRIPTIONS,
      ttsOutputs: TTS_OUTPUTS,
    };
  } else if (osPlatform === "darwin") {
    return {
      node: path.join(appDir, "tools", "node-mac", "bin", "node"),
      npm: path.join(appDir, "tools", "node-mac", "bin", "npm"),
      distIndex: path.join(DIST, "index.html"),
      macBackend: BACKEND_PATHS.mac,
      models: MODELS,
      outputs: OUTPUTS,
      chatHistory: CHAT_HISTORY,
      transcriptions: TRANSCRIPTIONS,
      ttsOutputs: TTS_OUTPUTS,
    };
  } else {
    // Linux / WSL
    return {
      node: path.join(appDir, "tools", "node-linux", "bin", "node"),
      npm: path.join(appDir, "tools", "node-linux", "bin", "npm"),
      distIndex: path.join(DIST, "index.html"),
      linuxCpuBackend: BACKEND_PATHS.linuxCpu,
      linuxVulkanBackend: BACKEND_PATHS.linuxVulkan,
      linuxRocmBackend: BACKEND_PATHS.linuxRocm,
      models: MODELS,
      outputs: OUTPUTS,
      chatHistory: CHAT_HISTORY,
      transcriptions: TRANSCRIPTIONS,
      ttsOutputs: TTS_OUTPUTS,
    };
  }
}

async function getHealth() {
  const paths = getSetupPaths();
  const checks = [
    getPathInfo("Portable Node.js", paths.node),
    getPathInfo("Portable npm", paths.npm),
    getPathInfo("Frontend build", paths.distIndex),
    getDirInfo("Models folder", paths.models),
    getDirInfo("Outputs folder", paths.outputs),
    getDirInfo("Chat history folder", paths.chatHistory),
    getDirInfo("Transcriptions folder", paths.transcriptions),
    getDirInfo("TTS outputs folder", paths.ttsOutputs),
  ];

  if (osPlatform === "win32") {
    checks.push(getPathInfo("CUDA backend", paths.cudaBackend));
    checks.push(getPathInfo("Vulkan backend", paths.vulkanBackend));
    checks.push(getPathInfo("CPU backend", paths.cpuBackend));
  } else if (osPlatform === "darwin") {
    checks.push(getPathInfo("Mac backend", paths.macBackend));
  } else {
    checks.push(getPathInfo("Linux CPU backend", paths.linuxCpuBackend));
    checks.push(getPathInfo("Linux Vulkan backend", paths.linuxVulkanBackend));
    checks.push(getPathInfo("Linux ROCm backend", paths.linuxRocmBackend));
  }

  let backendInstalled = false;
  if (osPlatform === "win32") {
    backendInstalled = checks.find((check) => check.label === "CUDA backend")?.exists ||
      checks.find((check) => check.label === "Vulkan backend")?.exists ||
      checks.find((check) => check.label === "CPU backend")?.exists;
  } else if (osPlatform === "darwin") {
    backendInstalled = checks.find((check) => check.label === "Mac backend")?.exists;
  } else {
    backendInstalled =
      checks.find((check) => check.label === "Linux CPU backend")?.exists ||
      checks.find((check) => check.label === "Linux CPU backend")?.exists ||
      checks.find((check) => check.label === "Linux Vulkan backend")?.exists ||
      checks.find((check) => check.label === "Linux ROCm backend")?.exists;
  }

  const criticalOk = checks
    .filter((check) => !["CUDA backend", "Vulkan backend", "CPU backend", "Linux CPU backend", "Linux Vulkan backend", "Linux ROCm backend", "Mac backend"].includes(check.label))
    .every((check) => check.ok) && backendInstalled;

  const ports = {
    frontend: { ...(await checkPort(PORT_FRONTEND)), expectedInUse: true },
    backend: { ...(await checkPort(imageEngine.state.PORT_BACKEND)), expectedInUse: imageEngine.state.backendProc !== null || imageEngine.state.openvinoProc !== null },
  };
  ports.frontend.ok = !ports.frontend.available;
  ports.backend.preferred = PREFERRED_BACKEND_PORT;
  ports.backend.selected = imageEngine.state.PORT_BACKEND;
  ports.backend.ok = true;

  const issues = checks
    .filter((check) => !check.ok && !["CUDA backend", "Vulkan backend", "CPU backend", "Linux CPU backend", "Linux Vulkan backend", "Linux ROCm backend", "Mac backend"].includes(check.label))
    .map((check) => `${check.label} is missing or not writable.`);
  if (!backendInstalled) {
    issues.push(`No ${osPlatform === "win32" ? "Windows" : osPlatform === "darwin" ? "macOS" : "Linux"} backend binary is installed.`);
  }
  return {
    ok: criticalOk && ports.backend.ok,
    build: SERVER_BUILD,
    root: ROOT,
    platform: osPlatform,
    checks,
    ports,
    backend: {
      ready: imageEngine.state.backendReady || imageEngine.state.openvinoReady,
      running: imageEngine.state.backendProc !== null || imageEngine.state.openvinoProc !== null,
      error: imageEngine.state.backendError,
      settings: imageEngine.state.currentSettings,
      options: getBackendOptions(),
    },
    models: {
      count: fs.existsSync(MODELS) ? readdirVisible(MODELS).filter(isModelFile).length : 0,
      totalBytes: getPathSize(MODELS),
      totalSize: formatBytes(getPathSize(MODELS)),
    },
    outputs: {
      count: fs.existsSync(OUTPUTS) ? readdirVisible(OUTPUTS).filter((file) => file.toLowerCase().endsWith(".json")).length : 0,
      totalBytes: getPathSize(OUTPUTS),
      totalSize: formatBytes(getPathSize(OUTPUTS)),
    },
    chat: {
      count: fs.existsSync(CHAT_HISTORY) ? readdirVisible(CHAT_HISTORY).filter((file) => file.toLowerCase().endsWith(".json")).length : 0,
      totalBytes: getPathSize(CHAT_HISTORY),
      totalSize: formatBytes(getPathSize(CHAT_HISTORY)),
    },
    speech: {
      transcriptions: fs.existsSync(TRANSCRIPTIONS) ? readdirVisible(TRANSCRIPTIONS).filter((file) => file.toLowerCase().endsWith(".json")).length : 0,
      totalBytes: getPathSize(TRANSCRIPTIONS),
      totalSize: formatBytes(getPathSize(TRANSCRIPTIONS)),
    },
    tts: {
      models: fs.existsSync(TTS_MODELS) ? readdirVisible(TTS_MODELS).filter((file) => file.toLowerCase().endsWith(".json")).length : 0,
      outputs: fs.existsSync(TTS_OUTPUTS) ? readdirVisible(TTS_OUTPUTS).filter((file) => file.toLowerCase().endsWith(".json")).length : 0,
      runtimeInstalled: tts.getTtsRuntimeStatus().installed,
      totalBytes: getPathSize(TTS_MODELS) + getPathSize(TTS_OUTPUTS) + getPathSize(TTS_CACHE),
      totalSize: formatBytes(getPathSize(TTS_MODELS) + getPathSize(TTS_OUTPUTS) + getPathSize(TTS_CACHE)),
    },
    issues,
  };
}

function addCleanupCandidate(candidates, id, targetPath, reason, options = {}) {
  if (!fs.existsSync(targetPath)) return;
  if (!options.allowUserData && (
    pathInside(targetPath, MODELS) ||
    pathInside(targetPath, OUTPUTS) ||
    pathInside(targetPath, CHAT_HISTORY) ||
    pathInside(targetPath, TRANSCRIPTIONS) ||
    pathInside(targetPath, TTS_MODELS) ||
    pathInside(targetPath, TTS_OUTPUTS)
  )) return;
  const sizeBytes = getPathSize(targetPath);
  candidates.push({
    id,
    path: targetPath,
    name: path.basename(targetPath),
    reason,
    sizeBytes,
    size: formatBytes(sizeBytes),
  });
}

function getCleanupCandidates() {
  const candidates = [];
  const toolsDir = path.join(ROOT, "app", "tools");
  const frontendDir = path.join(ROOT, "app", "frontend");
  addCleanupCandidate(candidates, "scratch-invalid", path.join(ROOT, "scratch_invalid.txt"), "Scratch/debug file.");
  addCleanupCandidate(candidates, "vite-cache", path.join(frontendDir, "node_modules", ".vite"), "Vite dependency cache; it can be regenerated.");

  if (fs.existsSync(toolsDir)) {
    for (const item of fs.readdirSync(toolsDir)) {
      const itemPath = path.join(toolsDir, item);
      if (item.toLowerCase().endsWith(".zip")) {
        addCleanupCandidate(candidates, `setup-zip-${item}`, itemPath, "Setup download archive.");
      } else if (/^sd-.+-temp$/i.test(item)) {
        addCleanupCandidate(candidates, `setup-temp-${item}`, itemPath, "Temporary backend extraction folder.");
      }
    }
  }

  if (fs.existsSync(MODELS)) {
    for (const item of readdirVisible(MODELS)) {
      if (item.toLowerCase().endsWith(".part") || item.toLowerCase().endsWith(".tmp")) {
        addCleanupCandidate(candidates, `partial-model-${item}`, path.join(MODELS, item), "Incomplete model download/import file.", { allowUserData: true });
      }
    }
  }

  return candidates.sort((a, b) => b.sizeBytes - a.sizeBytes);
}

function cleanupSelected(ids = []) {
  const allowed = new Map(getCleanupCandidates().map((candidate) => [candidate.id, candidate]));
  const deleted = [];
  for (const id of ids) {
    const candidate = allowed.get(id);
    if (!candidate) continue;
    if (!fs.existsSync(candidate.path)) continue;
    const stat = fs.statSync(candidate.path);
    if (stat.isDirectory()) {
      fs.rmSync(candidate.path, { recursive: true, force: true });
    } else {
      fs.unlinkSync(candidate.path);
    }
    deleted.push(candidate);
  }
  return deleted;
}

function hasNvidiaGpu() {
  const info = getGpuInfo().name.toLowerCase();
  if (info.includes("nvidia")) return true;
  try {
    execSync("nvidia-smi", { stdio: "ignore" });
    return true;
  } catch (_) {
    return false;
  }
}

function hasAmdGpu() {
  const info = getGpuInfo().name.toLowerCase();
  return info.includes("amd") || info.includes("advanced micro devices") || info.includes("radeon");
}

// Detect whether we are running inside WSL2 (Windows Subsystem for Linux).
// WSL2's GPU paravirtualization (GPU-PV) only exposes a D3D12/DirectX interface
// to Linux. Vulkan hardware passthrough is only supported for NVIDIA (via CUDA).
// Intel Arc and AMD GPUs in WSL2 fall back to llvmpipe (CPU software rendering).
function isRunningInWSL() {
  if (osPlatform !== "linux") return false;
  try {
    const procVersion = fs.readFileSync("/proc/version", "utf8").toLowerCase();
    return procVersion.includes("microsoft") || procVersion.includes("wsl");
  } catch (_) {
    return false;
  }
}

function getVulkanUnavailableReason() {
  if (osPlatform === "win32" && !hasVulkanRuntime()) {
    return "The Vulkan runtime (vulkan-1.dll) is missing. Install or update your GPU vendor driver with Vulkan support, then run setup again so the Vulkan backend folder is repaired.";
  }
  const vulkanPath = osPlatform === "win32" ? BACKEND_PATHS.vulkan : BACKEND_PATHS.linuxVulkan;
  if (backendValidationErrors[vulkanPath]) {
    return backendValidationErrors[vulkanPath];
  }
  if (osPlatform === "linux" && isRunningInWSL()) {
    const gpuName = getGpuInfo().name;
    const lowerGpu = gpuName.toLowerCase();
    if (lowerGpu.includes("intel") || lowerGpu.includes("arc")) {
      return `Vulkan GPU is not available in WSL2 for Intel ${gpuName}. WSL2's GPU paravirtualization only exposes a DirectX interface — Intel Arc Vulkan requires running natively on Windows.`;
    }
    return "Vulkan GPU is not available in WSL2. WSL2's GPU paravirtualization does not support hardware Vulkan for this GPU. Run natively on Windows or Linux for GPU acceleration.";
  }
  return "Installed, but this binary did not register a Vulkan backend on this machine.";
}


function getBackendOptions() {
  if (cachedBackendOptions) return cachedBackendOptions;

  const cudaInstalled = (osPlatform === "win32" && fs.existsSync(BACKEND_PATHS.cuda)) ||
                        (osPlatform === "linux" && fs.existsSync(BACKEND_PATHS.linuxCuda));
  const cudaAvailable = cudaInstalled && hasNvidiaGpu() && backendAccepts(
    osPlatform === "win32" ? BACKEND_PATHS.cuda : BACKEND_PATHS.linuxCuda,
    "cuda"
  );
  const vulkanInstalled = (osPlatform === "win32" && fs.existsSync(BACKEND_PATHS.vulkan)) ||
                          (osPlatform === "linux" && fs.existsSync(BACKEND_PATHS.linuxVulkan));
  const vulkanRuntimeAvailable = osPlatform !== "win32" || hasVulkanRuntime();
  const vulkanAvailable = vulkanInstalled && vulkanRuntimeAvailable && backendAccepts(
    osPlatform === "win32" ? BACKEND_PATHS.vulkan : BACKEND_PATHS.linuxVulkan,
    "vulkan"
  );
  const rocmInstalled = osPlatform === "linux" && fs.existsSync(BACKEND_PATHS.linuxRocm);
  const rocmAvailable = rocmInstalled && hasAmdGpu() && backendAccepts(BACKEND_PATHS.linuxRocm, "rocm");
  const metalInstalled = osPlatform === "darwin" && fs.existsSync(BACKEND_PATHS.mac);
  // The macOS sd build always contains ggml's CPU backend ("--backend cpu"). It is the fallback
  // where Metal lacks ops the model needs (e.g. 'NORM' on paravirtual GPUs) and the default on
  // Intel Macs. Like Metal, it is not probed: a cold first exec on macOS can exceed the 5 s probe.
  const macCpuAvailable = metalInstalled;
  const cpuInstalled = (osPlatform === "linux" && fs.existsSync(BACKEND_PATHS.linuxCpu)) ||
                        (osPlatform === "win32" && fs.existsSync(BACKEND_PATHS.cpu)) ||
                        macCpuAvailable;
  const metalAvailable = metalInstalled;
  const coremlNpu = getCoreMLNpuInfo();
  const openvinoNpu = getOpenVinoNpuInfo();
  const openvinoModels = getOpenVinoModelInfo();
  const openvinoNpuAvailable = openvinoNpu.supported && openvinoModels.some((model) => model.installed);

  const options = [];
  if (cpuInstalled) options.push({ id: "cpu", label: "CPU", available: true });
  if (metalAvailable) options.push({ id: "metal", label: "Metal GPU", available: true });
  if (coremlNpu.supported && coremlNpu.ready) options.push({ id: "apple-npu", label: "Apple Neural Engine (NPU)", available: true });
  if (vulkanAvailable) options.push({ id: "vulkan", label: "Vulkan GPU", available: true });
  if (rocmAvailable) options.push({ id: "rocm", label: "ROCm GPU (AMD)", available: true });
  if (cudaAvailable) options.push({ id: "cuda", label: "CUDA GPU", available: true });
  if (openvinoNpuAvailable) options.push({ id: "openvino-npu", label: "NPU (OpenVINO)", available: true });

  const unavailable = [];
  if (vulkanInstalled && !vulkanAvailable) {
    unavailable.push({ id: "vulkan", label: "Vulkan GPU", reason: getVulkanUnavailableReason() });
  }
  if (cudaInstalled && !cudaAvailable) {
    const cudaPath = osPlatform === "win32" ? BACKEND_PATHS.cuda : BACKEND_PATHS.linuxCuda;
    unavailable.push({ id: "cuda", label: "CUDA GPU", reason: backendValidationErrors[cudaPath] || "Installed, but CUDA backend validation failed." });
  }
  if (rocmInstalled && !rocmAvailable) {
    unavailable.push({ id: "rocm", label: "ROCm GPU (AMD)", reason: "Installed, but ROCm backend validation failed." });
  }
  if (metalInstalled && !metalAvailable) {
    unavailable.push({ id: "metal", label: "Metal GPU", reason: "Installed, but Metal backend validation failed." });
  }
  if (IS_MAC_INTEL && !metalInstalled) {
    unavailable.push({ id: "metal", label: "Metal GPU", reason: MAC_INTEL_IMAGE_MESSAGE });
  }
  if (coremlNpu.supported && !coremlNpu.ready) {
    unavailable.push({ id: "apple-npu", label: "Apple Neural Engine (NPU)", reason: coremlNpu.reason });
  }
  if (!cpuInstalled && (osPlatform === "win32" || osPlatform === "linux")) {
    unavailable.push({
      id: "cpu",
      label: "CPU",
      reason: osPlatform === "win32"
        ? "Windows CPU backend is not installed. Run scripts/setup/setup.ps1 to install app/backend/win/cpu."
        : "Linux CPU backend is not installed. Run setup again to install app/backend/linux/cpu.",
    });
  }
  if (openvinoNpu.supported && !openvinoNpuAvailable) {
    unavailable.push({ id: "openvino-npu", label: "NPU (OpenVINO)", reason: "Runtime is ready, but no OpenVINO NPU model is downloaded." });
  } else if (!openvinoNpu.supported && hasNpuHardware() && (osPlatform === "win32" || osPlatform === "linux")) {
    unavailable.push({ id: "openvino-npu", label: "NPU (OpenVINO)", reason: openvinoNpu.reason });
  }

  let defaultBackend = "cpu";
  if (coremlNpu.supported && coremlNpu.ready) {
    defaultBackend = "apple-npu";
  } else if (metalAvailable && !(IS_MAC_INTEL && macCpuAvailable)) {
    // Intel Macs default to CPU: Metal image generation is unverified on Intel/AMD Mac GPUs.
    defaultBackend = "metal";
  } else if (cudaAvailable) {
    const gpuName = String(getGpuInfo().name).toLowerCase();
    const isGtxCard = gpuName.includes("gtx");
    if (isGtxCard && vulkanAvailable) {
      defaultBackend = "vulkan"; // Default to Vulkan for GTX cards because of lack of Tensor Cores
    } else {
      defaultBackend = "cuda";
    }
  } else if (rocmAvailable) {
    defaultBackend = "rocm";
  } else if (vulkanAvailable) {
    defaultBackend = "vulkan";
  }

  cachedBackendOptions = {
    options,
    unavailable,
    cudaAvailable,
    vulkanAvailable,
    rocmAvailable,
    metalAvailable,
    openvinoNpuAvailable,
    openvinoNpu,
    openvinoModels,
    coremlNpu,
    defaultBackendType: defaultBackend,
  };
  return cachedBackendOptions;
}


function stripAnsi(value) {
  return String(value || "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\[[A-Z]/g, "");
}


function requestJson(url, payload = null, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = payload ? Buffer.from(JSON.stringify(payload), "utf8") : null;
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: data ? "POST" : "GET",
      headers: data ? {
        "Content-Type": "application/json",
        "Content-Length": data.length,
      } : {},
      timeout: timeoutMs,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          const jsonBody = JSON.parse(body || "{}");
          if (res.statusCode < 200 || res.statusCode >= 300 || jsonBody.ok === false) {
            reject(new Error(jsonBody.error || `HTTP ${res.statusCode}`));
            return;
          }
          resolve(jsonBody);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    if (data) req.write(data);
    req.end();
  });
}


function requestHttpsJson(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    try { assertSafeUrl(url, DOWNLOAD_POLICY); } catch (err) { reject(err); return; }
    const req = https.get(url, {
      ...guardedRequestOptions(DOWNLOAD_POLICY),
      headers: {
        "Accept": "application/json",
        "User-Agent": "Uncensored-AI-Studio/1.0",
      },
      timeout: timeoutMs,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body || "null");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(parsed?.error || `Hugging Face returned HTTP ${res.statusCode}`));
            return;
          }
          resolve(parsed);
        } catch (err) {
          reject(new Error(`Hugging Face returned invalid JSON: ${err.message}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Hugging Face request timed out")));
  });
}

function getModelParameterBillions(value) {
  const text = String(value || "");
  const matches = [...text.matchAll(/(?:^|[-_/ ])(\d+(?:\.\d+)?)\s*b(?:[-_/ ]|$)/gi)];
  if (matches.length === 0) return null;
  return Math.min(...matches.map((match) => Number(match[1])).filter(Number.isFinite));
}

function selectGgufFile(siblings = [], tier = "low") {
  const files = siblings
    .map((item) => typeof item === "string" ? item : item?.rfilename)
    .filter((name) => name && /\.gguf$/i.test(name))
    .filter((name) => !/(?:^|\/)(?:mmproj|mtp)(?:[-_/]|$)|-\d{5}-of-\d{5}\.gguf$/i.test(name));
  const preferences = tier === "high"
    ? [/q6_k\.gguf$/i, /q5_k_m\.gguf$/i, /q4_k_m\.gguf$/i, /q8_0\.gguf$/i]
    : [/q4_k_m\.gguf$/i, /q4_k_s\.gguf$/i, /q4_0\.gguf$/i, /q3_k_m\.gguf$/i, /iq4_xs\.gguf$/i];
  for (const pattern of preferences) {
    const match = files.find((name) => pattern.test(name));
    if (match) return match;
  }
  return files[0] || "";
}

function selectMmprojFile(siblings = [], modelFilename = "") {
  const files = siblings
    .map((item) => typeof item === "string" ? item : item?.rfilename)
    .filter((name) => name && /\.gguf$/i.test(name))
    .filter((name) => /(?:^|[-_/])mmproj(?:[-_.\/]|$)|mmproj/i.test(name));
  if (files.length === 0) return "";

  const modelBase = path.basename(modelFilename).toLowerCase();
  const modelStem = modelBase.replace(/\.gguf$/i, "").replace(/\.(q\d(?:_k_[ms])?|iq\d_[a-z0-9]+|bf16|f16|f32)$/i, "");
  const scored = files.map((name) => {
    const lower = name.toLowerCase();
    let score = 0;
    if (/bf16/i.test(lower)) score += 6;
    if (/f16/i.test(lower)) score += 5;
    if (/mmproj-model-f16/i.test(lower)) score += 4;
    if (modelStem && lower.includes(modelStem)) score += 10;
    return { name, score };
  });
  scored.sort((a, b) => b.score - a.score || a.name.length - b.name.length);
  return scored[0]?.name || "";
}

function parseHuggingFaceResolveUrl(fileUrl) {
  try {
    const parsed = new URL(fileUrl);
    if (!/^(?:www\.)?huggingface\.co$/i.test(parsed.hostname)) return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    const resolveIndex = parts.findIndex((part) => part === "resolve" || part === "blob");
    if (resolveIndex < 2 || resolveIndex + 2 >= parts.length) return null;
    const repoId = `${decodeURIComponent(parts[0])}/${decodeURIComponent(parts[1])}`;
    const revision = decodeURIComponent(parts[resolveIndex + 1] || "main");
    const repositoryFilename = parts.slice(resolveIndex + 2).map(decodeURIComponent).join("/");
    return { repoId, revision, repositoryFilename };
  } catch (_) {
    return null;
  }
}

async function resolveHuggingFaceProjector(fileUrl, localModelFilename = "") {
  const parsed = parseHuggingFaceResolveUrl(fileUrl);
  if (!parsed) return null;

  const cacheKey = `${parsed.repoId}|${parsed.revision}|${parsed.repositoryFilename}`;
  const cached = hfProjectorCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < HF_MODEL_CACHE_TTL_MS) return cached.projector;

  try {
    const treeUrl = `https://huggingface.co/api/models/${parsed.repoId}/tree/${encodeURIComponent(parsed.revision)}?recursive=true`;
    const tree = await requestHttpsJson(treeUrl);
    const projectorRepositoryFilename = selectMmprojFile(tree, parsed.repositoryFilename || localModelFilename);
    const projector = projectorRepositoryFilename
      ? {
          url: `https://huggingface.co/${parsed.repoId}/resolve/${encodeURIComponent(parsed.revision)}/${projectorRepositoryFilename.split("/").map(encodeURIComponent).join("/")}`,
          filename: `${parsed.repoId.replace(/\//g, "--")}--${path.basename(projectorRepositoryFilename)}`,
          repositoryFilename: projectorRepositoryFilename,
        }
      : null;
    hfProjectorCache.set(cacheKey, { createdAt: Date.now(), projector });
    return projector;
  } catch (err) {
    console.warn(`  [download] Could not resolve vision projector for ${parsed.repoId}: ${err.message || err}`);
    hfProjectorCache.set(cacheKey, { createdAt: Date.now(), projector: null });
    return null;
  }
}

function classifyHuggingFaceModel(model, filename) {
  const searchable = `${model.id || ""} ${filename || ""} ${(model.tags || []).join(" ")}`.toLowerCase();
  const parameters = getModelParameterBillions(searchable);
  return {
    potato: parameters !== null && parameters <= 3,
    vision: /(?:vision|llava|multimodal|(?:^|[-_/ ])vl(?:[-_/ ]|$)|moondream)/i.test(searchable),
    uncensored: /uncensored|abliterated|heretic/i.test(searchable),
    parameters,
  };
}

function getTextModelFit(sizeBytes, specs = getHardwareSpecs()) {
  if (!sizeBytes) {
    return { recommended: false, mode: "unknown", label: "", reason: "File size is unavailable, so compatibility cannot be estimated." };
  }

  const ramBytes = Math.max(0, Number(specs.ram_total_gb) || 0) * (1024 ** 3);
  const vramBytes = Math.max(0, Number(specs.gpu_vram_gb) || 0) * (1024 ** 3);
  const isAppleSilicon = osPlatform === "darwin" && /apple/i.test(String(specs.cpu_name || ""));
  const systemReserve = Math.max(4 * (1024 ** 3), ramBytes * 0.3);
  const usableRam = Math.max(0, ramBytes - systemReserve);
  const runtimeNeed = (sizeBytes * 1.25) + (1.5 * (1024 ** 3));
  const fastGpuFit = vramBytes >= runtimeNeed;
  const cpuOrOffloadFit = usableRam >= runtimeNeed;
  const unifiedMemoryFit = isAppleSilicon && usableRam >= runtimeNeed;
  const hybridFit = !fastGpuFit && vramBytes > 0 && cpuOrOffloadFit;
  const recommended = fastGpuFit || cpuOrOffloadFit || unifiedMemoryFit;

  if (recommended) {
    const mode = fastGpuFit
      ? "GPU memory"
      : isAppleSilicon
        ? "unified memory"
        : hybridFit
          ? "combined GPU and system memory"
          : "system RAM";
    return {
      recommended: true,
      mode: fastGpuFit ? "gpu" : isAppleSilicon ? "unified" : hybridFit ? "hybrid" : "ram",
      label: fastGpuFit ? "GPU Fit" : isAppleSilicon ? "Fits Unified Memory" : hybridFit ? "GPU + RAM Fit" : "Fits in RAM",
      reason: `${formatBytes(sizeBytes)} weights fit the estimated ${mode} budget with runtime headroom.`,
    };
  }

  return {
    recommended: false,
    mode: "too-large",
    label: "",
    reason: `${formatBytes(sizeBytes)} weights need about ${formatBytes(runtimeNeed)} including runtime headroom; this computer has about ${formatBytes(usableRam)} usable RAM and ${formatBytes(vramBytes)} VRAM.`,
  };
}

async function addHuggingFaceFileSize(model) {
  try {
    const detail = await requestHttpsJson(`https://huggingface.co/api/models/${model.id}?blobs=true`);
    const file = (detail.siblings || []).find((item) => item?.rfilename === model.repositoryFilename);
    const sizeBytes = Number(file?.size || file?.lfs?.size || 0);
    const fit = getTextModelFit(sizeBytes);
    return {
      ...model,
      sizeBytes,
      size: sizeBytes > 0 ? formatBytes(sizeBytes) : "Unknown",
      approxSize: sizeBytes > 0 ? formatBytes(sizeBytes) : model.approxSize,
      recommendedFit: fit.recommended,
      fitMode: fit.mode,
      fitLabel: fit.label,
      fitReason: fit.reason,
    };
  } catch (_) {
    return {
      ...model,
      sizeBytes: 0,
      size: "Unknown",
      recommendedFit: false,
      fitMode: "unknown",
      fitLabel: "",
      fitReason: "File size is unavailable, so compatibility cannot be estimated.",
    };
  }
}

async function searchHuggingFaceModels(query, filters) {
  const specs = getHardwareSpecs();
  const tier = specs.gpu_vram_gb >= 10 || specs.ram_total_gb >= 32
    ? "high"
    : specs.gpu_vram_gb >= 5 || specs.ram_total_gb >= 16 ? "mid" : "low";
  const defaultSearch = tier === "low" ? "1B instruct" : tier === "mid" ? "7B instruct" : "8B instruct";
  let searchTerms = "";
  if (query.trim()) {
    searchTerms = [
      query.trim(),
      filters.includes("vision") ? "vision" : "",
      filters.includes("uncensored") ? "uncensored" : "",
    ].filter(Boolean).join(" ");
  } else {
    if (filters.includes("vision") && filters.includes("uncensored")) {
      searchTerms = "vision uncensored gguf";
    } else if (filters.includes("vision")) {
      searchTerms = "vision gguf";
    } else if (filters.includes("uncensored")) {
      searchTerms = "uncensored gguf";
    } else {
      searchTerms = defaultSearch;
    }
  }
  const cacheKey = `${tier}|${searchTerms}|${filters.sort().join(",")}`;
  const cached = hfModelCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < HF_MODEL_CACHE_TTL_MS) return cached.models;

  const params = new URLSearchParams({
    filter: "gguf",
    search: searchTerms,
    sort: "downloads",
    direction: "-1",
    limit: "50",
    full: "true",
  });
  const results = await requestHttpsJson(`https://huggingface.co/api/models?${params.toString()}`);
  const models = [];

  for (const model of Array.isArray(results) ? results : []) {
    if (model.private || model.gated || model.disabled) continue;
    const filename = selectGgufFile(model.siblings, tier);
    if (!filename) continue;
    const projectorFilename = selectMmprojFile(model.siblings, filename);
    const traits = classifyHuggingFaceModel(model, filename);
    if (filters.includes("vision") && !traits.vision) continue;
    if (filters.includes("uncensored") && !traits.uncensored) continue;

    const isLikelyChatModel = /instruct|chat|assistant|coder|uncensored|abliterated|vision|llava|\bvl\b/i.test(`${model.id} ${filename}`);
    if (!query.trim() && !isLikelyChatModel) continue;
    const normalizedQuery = query.trim().toLowerCase().replace(/[-_/]+/g, " ").replace(/\s+/g, " ");
    const normalizedModelName = `${model.id} ${filename}`.toLowerCase().replace(/[-_/]+/g, " ").replace(/\s+/g, " ");
    const queryWords = normalizedQuery.split(" ").filter(Boolean);
    const exactPhraseMatch = normalizedQuery && normalizedModelName.includes(normalizedQuery);
    const matchedQueryWords = queryWords.filter((word) => normalizedModelName.includes(word)).length;
    const score = Number(model.downloads || 0)
      + (traits.parameters && traits.parameters <= 3 && tier === "low" ? 10000000 : 0)
      + (traits.parameters && tier === "mid" && traits.parameters >= 4 && traits.parameters <= 9 ? 10000000 : 0)
      + (traits.parameters && tier === "high" && traits.parameters >= 7 && traits.parameters <= 14 ? 10000000 : 0)
      + (exactPhraseMatch ? 100000000 : 0)
      + (matchedQueryWords * 5000000);
    models.push({
      id: model.id,
      name: String(model.id || "").split("/").pop().replace(/[-_]+/g, " "),
      filename: `${model.id.replace(/\//g, "--")}--${path.basename(filename)}`,
      repositoryFilename: filename,
      format: "GGUF",
      approxSize: traits.parameters ? `~${traits.parameters}B parameters` : "Size shown before download",
      resolution: "N/A",
      notes: `Community GGUF from ${String(model.id || "").split("/")[0]}. ${Number(model.downloads || 0).toLocaleString()} Hugging Face downloads.`,
      url: `https://huggingface.co/${model.id}/resolve/main/${filename.split("/").map(encodeURIComponent).join("/")}`,
      projectorUrl: projectorFilename ? `https://huggingface.co/${model.id}/resolve/main/${projectorFilename.split("/").map(encodeURIComponent).join("/")}` : "",
      projectorFilename: projectorFilename ? `${model.id.replace(/\//g, "--")}--${path.basename(projectorFilename)}` : "",
      pageUrl: `https://huggingface.co/${model.id}`,
      downloads: Number(model.downloads || 0),
      likes: Number(model.likes || 0),
      tags: Object.entries(traits).filter(([key, value]) => key !== "parameters" && value).map(([key]) => key),
      score,
    });
  }

  const ranked = models.sort((a, b) => b.score - a.score);
  hfModelCache.set(cacheKey, { createdAt: Date.now(), models: ranked });
  return ranked;
}


function getDefaultModel() {
  try {
    const files = readdirVisible(MODELS).filter(isModelFile);
    return files.length ? path.join(MODELS, files[0]) : null;
  } catch (_) { return null; }
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

function isVisionModelFilename(filename = "") {
  const lower = String(filename || "").toLowerCase();
  return lower.includes("llava") ||
    lower.includes("vision") ||
    lower.includes("qwen2vl") ||
    lower.includes("qwen2-vl") ||
    lower.includes("qwen2.5-vl") ||
    lower.includes("qwen3-vl") ||
    lower.includes("qwen3.5-4b-vision") ||
    lower.includes("gemma-4") ||
    lower.includes("gemma4") ||
    lower.includes("-e2b-") ||
    lower.includes("e2b-it") ||
    lower.includes("paligemma") ||
    lower.includes("minicpm-v") ||
    lower.includes("internvl") ||
    lower.includes("phi-3-vision") ||
    lower.includes("phi3-vision") ||
    lower.includes("smolvlm") ||
    lower.includes("moondream") ||
    lower === "ggml-model-q4_k.gguf";
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


// ── Model Downloader ─────────────────────────────────────────────────────────
// Downloads (models, OpenVINO models, the Windows image engine) live in services/downloads.cjs (Step 9.8f).
function invalidateBackendOptions() { cachedBackendOptions = null; }
const downloads = createDownloadService({
  DOWNLOAD_POLICY, LLM_MODELS, MODELS, OPENVINO_MODELS, OPENVINO_NPU_MODELS, ROOT, SPEECH_MODELS, TOOLS, TTS_MODELS,
  downloadBlockReason, downloader, fs, getOpenVinoNpuInfo, getPathSize, integrity, osPlatform, path, spawn, spawnSync,
  invalidateBackendOptions,
});
const {
  startOpenVinoModelDownload, IMAGE_BACKEND_DOWNLOADS, startImageBackendDownload, getModelDownloadUrlIssue, startModelDownload, cancelModelDownload,
} = downloads.fns;


// ── Verified downloads (Step 9.4) ───────────────────────────────────────────


// ── Generation State (Real-time progress parser) ─────────────────────────────


// ── MIME types ────────────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html", ".js": "application/javascript", ".mjs": "application/javascript",
  ".css":  "text/css",  ".png": "image/png",
  ".jpg":  "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".ico":  "image/x-icon", ".json": "application/json", ".wav": "audio/wav", ".txt": "text/plain",
  ".woff2":"font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
};


function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / (1024 ** idx)).toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function getModelLoadIssue(modelPath) {
  const filename = path.basename(modelPath || "");
  const lower = filename.toLowerCase();
  const ext = path.extname(lower);
  if (!modelPath || !fs.existsSync(modelPath)) {
    return `Model file not found: ${filename || "unknown model"}`;
  }

  const size = getPathSize(modelPath);
  if (size < 128 * 1024 * 1024) {
    return `${filename} is too small to be a complete image model (${formatBytes(size)}). Delete it and download/import it again.`;
  }

  if (ext === ".gguf") {
    const knownDiffusionOnlyGguf =
      lower === "stable-diffusion-xl-base-1.0-q4_0.gguf" ||
      lower.includes("stable-diffusion-xl-base-1.0");
    const requiresSeparateComponents =
      knownDiffusionOnlyGguf ||
      lower.includes("z_image") ||
      lower.includes("z-image") ||
      lower.includes("zimage") ||
      lower.includes("qwen") ||
      lower.includes("hidream") ||
      lower.includes("hunyuan") ||
      lower.includes("wan") ||
      lower.includes("flux");

    if (requiresSeparateComponents) {
      if (knownDiffusionOnlyGguf) {
        return `${filename} is not supported as a one-click model in this app. This SDXL GGUF is a diffusion-only component and needs matching VAE/text encoder files instead of being loaded with --model. Use one of the recommended Safetensors SDXL/SD 1.5 checkpoints, or import a complete single-file GGUF checkpoint.`;
      }
      return `${filename} looks like a multi-file diffusion GGUF. This app currently loads single-file SD 1.5/SDXL checkpoints directly. Models like Z-Image, Qwen, Flux, HiDream, Hunyuan, and Wan usually need extra files such as VAE/text encoders and must be launched with --diffusion-model instead of --model.`;
    }
  }

  return null;
}


function describeLinuxRuntimeLinkerError(rawError) {
  const raw = String(rawError || "").trim();
  const lower = raw.toLowerCase();
  if (osPlatform !== "linux") return null;
  if (!lower.includes("glibc") && !lower.includes("libstdc++") && !lower.includes("libc.so.6")) return null;

  const needsGlibc = raw.match(/GLIBC_([0-9.]+)/)?.[1];
  const needsGlibcxx = raw.match(/GLIBCXX_([0-9.]+)/)?.[1];
  const requirements = [];
  if (needsGlibc) requirements.push(`glibc ${needsGlibc}+`);
  if (needsGlibcxx) requirements.push(`GLIBCXX_${needsGlibcxx}+`);
  const requirementText = requirements.length ? requirements.join(" and ") : "newer glibc/libstdc++ runtime libraries";

  return `${raw}\n\nThe selected model is not the problem. The Linux backend binary cannot start because this OS is missing ${requirementText}. The bundled Linux backends are built for Ubuntu 24.04-era systems. Use Ubuntu 24.04+, Fedora 40+, another glibc 2.38+ distro, or build stable-diffusion.cpp from source on this machine.`;
}


function readBody(req, { emptyOnly = false } = {}) {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    req.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > MAX_JSON_BODY_BYTES) {
        reject(new Error(`Request body is too large. Limit is ${Math.round(MAX_JSON_BODY_BYTES / (1024 * 1024))} MB.`));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end",  () => {
      if (emptyOnly && data.trim()) return reject(Object.assign(new Error(JSON_TYPE_ERROR), { status: 415 }));
      try { resolve(JSON.parse(data || "{}")); } catch(e) { reject(new Error("Invalid JSON request body")); }
    });
    req.on("error", reject);
  });
}

// S-9: a JSON route only accepts a JSON body (Content-Type application/json or */*+json). A request
// with no body and no Content-Type (e.g. POST /api/llm/stop) is still accepted as {}.
const JSON_TYPE_ERROR = "Request body must be JSON (Content-Type: application/json).";
async function readJsonBody(req, res) {
  const type = jsonBodyType(req);
  if (type === "other") {
    req.resume();
    json(res, 415, { ok: false, error: JSON_TYPE_ERROR, code: "UNSUPPORTED_MEDIA_TYPE" });
    return null;
  }
  let body;
  try {
    body = await readBody(req, { emptyOnly: type === "missing" });
  } catch (err) {
    const status = err.status || (err.message.includes("too large") ? 413 : 400);
    const code = status === 415 ? "UNSUPPORTED_MEDIA_TYPE" : status === 413 ? "BODY_TOO_LARGE" : "INVALID_JSON";
    json(res, status, { ok: false, error: err.message, code });
    return null;
  }
  // Every JSON route expects an object. `null`, numbers, strings and arrays used to slip through as
  // a falsy/odd body, leaving the request unanswered or failing later with a 500.
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    json(res, 400, { ok: false, error: "Request body must be a JSON object.", code: "INVALID_REQUEST" });
    return null;
  }
  return body;
}

function safeOutputName(value) {
  return String(value || "")
    .replace(/[^a-z0-9._-]/gi, "_")
    .replace(/_+/g, "_")
    .slice(0, 120);
}

function sanitizeChatMessageForStorage(message) {
  if (!message || typeof message !== "object") return null;
  const role = String(message.role || "").trim();
  if (!["system", "user", "assistant"].includes(role)) return null;
  let content = message.content;
  if (Array.isArray(content)) {
    content = content.map((item) => {
      if (!item || typeof item !== "object") return item;
      if (item.type === "image_url") {
        return { type: "text", text: "[Attached image omitted from saved chat history]" };
      }
      return item;
    });
  } else if (typeof content !== "string") {
    content = content === undefined || content === null ? "" : String(content);
  }
  return {
    ...message,
    role,
    content,
  };
}

function sanitizeChatConversationForStorage(conversation = {}) {
  const now = Date.now();
  const id = safeOutputName(conversation.id || `chat_${now}`) || `chat_${now}`;
  const messages = Array.isArray(conversation.messages)
    ? conversation.messages.map(sanitizeChatMessageForStorage).filter(Boolean)
    : [];
  const timestamp = Number(conversation.timestamp) || now;
  return {
    id,
    title: String(conversation.title || "Chat Session").slice(0, 160),
    model: String(conversation.model || ""),
    messages,
    timestamp,
    createdAt: conversation.createdAt || new Date(timestamp).toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function getChatConversationPath(id) {
  const safeId = safeOutputName(id);
  if (!safeId) throw badRequest("INVALID_REQUEST", "A chat id is required.");
  const filePath = path.join(CHAT_HISTORY, `${safeId}.json`);
  if (!pathInside(filePath, CHAT_HISTORY)) {
    throw new Error("Invalid chat id.");
  }
  return filePath;
}

function saveChatConversation(conversation = {}) {
  const saved = sanitizeChatConversationForStorage(conversation);
  const filePath = getChatConversationPath(saved.id);
  fs.writeFileSync(filePath, JSON.stringify(saved, null, 2), "utf8");
  return saved;
}

function listChatConversations() {
  try {
    return readdirVisible(CHAT_HISTORY)
      .filter((file) => file.toLowerCase().endsWith(".json"))
      .map((file) => {
        try {
          const filePath = path.join(CHAT_HISTORY, file);
          if (!pathInside(filePath, CHAT_HISTORY)) return null;
          const conversation = JSON.parse(fs.readFileSync(filePath, "utf8"));
          const stat = fs.statSync(filePath);
          return {
            ...conversation,
            filename: file,
            modifiedAt: stat.mtime.toISOString(),
            sizeBytes: stat.size,
            size: formatBytes(stat.size),
          };
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
  } catch (_) {
    return [];
  }
}

function deleteChatConversation(id) {
  const filePath = getChatConversationPath(id);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}


function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(body);
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const LISTEN_HOST = process.env.UAIS_HOST || "127.0.0.1";
const requestPolicy = createRequestPolicy({ listenHost: LISTEN_HOST });
// Step 9.5: sign-in whenever the server is reachable beyond this machine (scripts/server/lan-auth.cjs).
const lanAuth = createLanAuth({
  tokenFile: path.join(LAYOUT.data.config, LAN_TOKEN_FILE_NAME),
  listenHost: LISTEN_HOST,
  log: (msg) => console.warn("  " + msg),
});
if (lanAuth.mode.warning) console.warn(`  [auth] ${lanAuth.mode.warning}`);
try {
  lanAuth.ensureToken();
} catch (err) {
  // Fail closed: without a token file every remote request is refused.
  console.error(`  [auth] Could not create the access token file (${err.code || err.message}). Remote access is refused.`);
}

// One troubleshooting snapshot (GET /api/diagnostics). No secrets.
async function getDiagnostics() {
  return {
    generatedAt: new Date().toISOString(),
    health: await getHealth(),
    cleanupCandidates: getCleanupCandidates(),
    download: downloads.getState(),
    generation: imageEngine.state.generationState,
    llm: {
      ready: llmReady,
      running: llmProc !== null,
      error: llmError,
      settings: llmSettings,
      port: PORT_LLM,
    },
    speech: {
      ready: speech.isReady(),
      error: speech.getError(),
      settings: speech.getSettings(),
      backend: speech.getSpeechBackend(),
      transcription: speech.getTranscriptionState(),
    },
    hardware: getHardwareSpecs(),
    telemetry: getTelemetry(),
    engines: { llm: llmLifecycleSnapshot(), processes: supervisor.snapshot() }, // additive (Step 9.6)
  };
}

// Routes moved into modules (Step 9.8). They run after the pipeline's security checks and
// before the routes below that haven't moved yet.
// Text of a chat message (string or multi-part content). Moved to module scope for the web-search
// service; it was declared inside the legacy request handler.
function getMessageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") return item;
      if (typeof item?.text === "string") return item.text;
      if (typeof item?.content === "string") return item.content;
      return "";
    }).join("\n");
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
  }
  return "";
}

// Web search and retrieval for chat lives in services/web-search.cjs (Step 9.8d).
const webSearch = createWebSearchService({
  search: comprehensiveWebSearch,
  cacheDir: WEB_SEARCH_CACHE,
  publicCachePath: errors.redactPaths(WEB_SEARCH_CACHE).replace(/\\/g, "/"),
  completeChat: (payload, timeoutMs) => requestJson(`http://127.0.0.1:${PORT_LLM}/v1/chat/completions`, { model: llmSettings.model || "local-model", ...payload }, timeoutMs),
  isLlmReady: () => llmReady,
  getMessageText,
});

const router = createRouter();
// Status responses carry shortened paths for every client (issue #52); internal callers keep absolute ones.
router.use(systemRoutes({ json, getHealth: async () => publicPaths(await getHealth()), getDiagnostics: async () => publicPaths(await getDiagnostics()), getCleanupCandidates, getHardwareSpecs, getBackendOptions: () => publicPaths(getBackendOptions()), getTelemetry }));
router.use(ttsRoutes({ tts, json, readJsonBody, jsonErrorStatus, errorStatus, errorBody, streamModelUpload, pathInside, fs, path, MIME, TTS_MODELS, TTS_OUTPUTS }));
router.use(speechRoutes({ speech, SPEECH_MODELS, TRANSCRIPTIONS, downloadBlockReason, getDownloadState: () => downloads.getState(), errorBody, errorStatus, fs, json, jsonErrorStatus, path, pathInside, readBinaryBody, readJsonBody, startModelDownload, streamModelUpload }));
router.use(searchRoutes({ webSearch, json, readJsonBody, errorStatus, errorBody }));
router.use(imageRoutes({
  state: imageEngine.routeState, MIME, MODELS, OUTPUTS, PREFERRED_BACKEND_PORT, SERVER_BUILD, appleNpuRuntimeMatches, assertNoOtherActiveRuntime,
  backendSettingsMatch, deleteGeneratedOutputs, errorBody, errorStatus, findAvailableBackendPort, fs, generateWithOpenVino,
  getCoreMLPythonPath, getDefaultModel, json, jsonErrorStatus, killBackend, killOpenVinoWorker, listGeneratedOutputs, path,
  proxyImageBackendRequest, readJsonBody, saveGeneratedOutput, startBackend,
}));
router.use(modelRoutes({
  IMAGE_BACKEND_DOWNLOADS, LLM_MODELS, MODELS, OPENVINO_MODELS, SPEECH_MODELS, addHuggingFaceFileSize, cancelModelDownload,
  describeLinkedModel, detectModelKindCached, downloadBlockReason, errorBody, errorStatus, execFile, findOpenVinoModel, fs,
  getBackendProc: () => imageEngine.state.backendProc, getCurrentSettings: () => imageEngine.state.currentSettings, getDownloadProgress: downloads.getDownloadProgress,
  getDownloadState: downloads.getState, getLlmModels, getLlmProc: () => llmProc, getLlmSettings: () => llmSettings,
  getModelDownloadUrlIssue, getModelInfo, getOpenVinoModelInfo, getOpenVinoNpuInfo, invalidateBackendOptions, isModelFile, json,
  killLlm, modelFolderFor, os, path, pathInside, publicMessage, readJsonBody, readdirVisible, resolveHuggingFaceProjector,
  searchHuggingFaceModels, speech, startImageBackendDownload, startModelDownload, startOpenVinoModelDownload, streamModelUpload,
}));

// Routes not yet moved into modules, then static files. Only reached through the pipeline.
async function legacyRoutes(req, res) {
  // ── Management API ────────────────────────────────────────────────────────
  // POST /api/cleanup
  if (req.url === "/api/cleanup" && req.method === "POST") {
    try {
      const body = await readJsonBody(req, res);
      if (!body) return;
      const deleted = cleanupSelected(Array.isArray(body.ids) ? body.ids : []);
      return json(res, 200, { ok: true, deleted });
    } catch (err) {
      console.error("  [api] Cleanup failed:", err);
      return json(res, errorStatus(err), errorBody(err));
    }
  }


  if (req.url === "/api/llm/status" && req.method === "GET") {
    const backend = getLlmBackend();
    const probe = getLlmBackendProbe();
    return json(res, 200, publicPaths({
      ready: llmReady,
      running: llmProc !== null,
      port: PORT_LLM,
      preferredPort: PREFERRED_LLM_PORT,
      error: llmError,
      settings: llmSettings,
      backendInstalled: Boolean(backend),
      backendMode: backend?.mode || "",
      backendPath: backend?.path || "",
      selectedBackend: probe.selected,
      availableBackends: probe.available,
      engine: llmLifecycleSnapshot(), // additive (Step 9.6)
    }));
  }

  if (req.url.startsWith("/api/llm/backends") && req.method === "GET") {
    const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    return json(res, 200, publicPaths({ ok: true, ...getLlmBackendProbe(parsed.searchParams.get("refresh") === "1") }));
  }

  if (req.url === "/api/llm/stats" && req.method === "GET") {
    return json(res, 200, publicPaths(getLlmRuntimeStats()));
  }

  if (req.url === "/api/llm/model-settings" && req.method === "GET") {
    return json(res, 200, { ok: true, ...getPersistedLlmModelSettings() });
  }

  if (req.url === "/api/llm/model-settings" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const filename = path.basename(String(body.model || ""));
    if (!filename) return json(res, 400, { ok: false, error: "model is required" });
    const updated = updateLlmModelSettings(filename, {
      preferredBackend: body.preferredBackend ? String(body.preferredBackend).toLowerCase() : undefined,
    });
    return json(res, 200, { ok: true, model: filename, settings: updated });
  }

  if (req.url === "/api/llm/conversations" && req.method === "GET") {
    return json(res, 200, { ok: true, conversations: listChatConversations() });
  }

  if (req.url === "/api/llm/save-conversation" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      const conversation = saveChatConversation(body.conversation || body);
      return json(res, 200, { ok: true, conversation });
    } catch (err) {
      console.error("  [api] Failed to save chat conversation:", err);
      return json(res, errorStatus(err), errorBody(err));
    }
  }

  if (req.url === "/api/llm/delete-conversation" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      const deleted = deleteChatConversation(body.id);
      return json(res, 200, { ok: true, deleted });
    } catch (err) {
      console.error("  [api] Failed to delete chat conversation:", err);
      return json(res, errorStatus(err), errorBody(err));
    }
  }


  if (req.url === "/api/llm/start" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      await runExclusiveLlmOperation(() => startLlm(body));
      return json(res, 200, { ok: true, ready: llmReady, port: PORT_LLM, settings: llmSettings });
    } catch (err) {
      llmError = err.message || String(err);
      if (err.code !== "MODEL_ALREADY_ACTIVE") {
        await runExclusiveLlmOperation(() => killLlm());
      }
      return json(res, jsonErrorStatus(err), errorBody(err, { error: llmError, code: err.code || "", activeRuntime: err.activeRuntime || null }));
    }
  }

  if (req.url === "/api/llm/stop" && req.method === "POST") {
    await stopLlmNow(); // cancels a start in progress immediately
    await runExclusiveLlmOperation(() => killLlm());
    return json(res, 200, { ok: true });
  }

  if (req.url === "/api/llm/benchmark" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      const result = await runExclusiveLlmOperation(() => benchmarkLlmModel(body));
      return json(res, 200, result);
    } catch (err) {
      return json(res, errorStatus(err), errorBody(err));
    }
  }


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
  const currentCtx = llmSettings.contextSize || 4096;
  const contextLadder = [32768, 24576, 16384, 12288, 8192, 4096, 2048, 1024, 512];
  const nextLimit = contextLadder.find(limit => limit < currentCtx);
  if (!nextLimit) {
    throw new Error("Cannot lower context size any further.");
  }
  console.log(`  [llm] Retrying with lower context limit: ${nextLimit} (was ${currentCtx})`);
  
  const originalModel = llmSettings.model;
  const newSettings = {
    model: originalModel,
    threads: llmSettings.threads,
    contextSize: nextLimit,
    gpuLayers: llmSettings.gpuLayers,
    enableThinking: llmSettings.enableThinking,
  };
  
  await runExclusiveLlmOperation(() => startLlm(newSettings));
}

async function doLlmChat(req, res, body, retryCount = 0) {
  try {
    const isStream = body.stream === true;
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    const webAugmentation = await webSearch.augmentMessagesWithWebSearch(rawMessages, body);
    const requestData = JSON.stringify({
      model: llmSettings.model || "local-model",
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
        port: PORT_LLM,
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
            json(res, clientRes.statusCode || 500, { ok: false, error: message });
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
        const result = await requestJson(`http://127.0.0.1:${PORT_LLM}/v1/chat/completions`, JSON.parse(requestData), 300000);
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
        throw err;
      }
    }
  } catch (err) {
    return json(res, errorStatus(err), errorBody(err));
  }
}

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

// ── llmfit Integration ──────────────────────────────────────────────────────────
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

  if (req.url === "/api/llm/chat" && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    if (!llmReady) {
      const state = llmEngineState();
      if (state === "restarting") return json(res, 409, { ok: false, error: "The text engine stopped unexpectedly and is restarting. Try again in a moment.", code: "ENGINE_RESTARTING" });
      if (state === "crashed") return json(res, 409, { ok: false, error: llmError || "The text engine stopped unexpectedly.", code: "ENGINE_CRASHED" });
      if (state === "starting") return json(res, 409, { ok: false, error: "The text model is still loading. Try again in a moment.", code: "ENGINE_STARTING" });
      return json(res, 409, { ok: false, error: "Load a text model before sending a message.", code: "ENGINE_NOT_READY" });
    }
    await doLlmChat(req, res, body);
    return;
  }

  // GET /api/llm/recommend — llmfit recommendations
  if (req.url.startsWith("/api/llm/recommend") && req.method === "GET") {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const useCase = url.searchParams.get("useCase") || "chat";
    const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit")) || 10));
    const recommendations = await getLlmfitRecommendations(useCase, limit);
    return json(res, 200, { ok: true, recommendations, source: recommendations ? "llmfit" : "fallback" });
  }


  if (req.url.startsWith("/api/")) {
    return json(res, 404, { ok: false, error: "Unknown API endpoint" });
  }

  // ── Static frontend files ─────────────────────────────────────────────────
  let filePath = resolveStaticPath(DIST, req.url);
  if (!filePath) {
    res.writeHead(404); res.end("Not found"); return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST, "index.html");
  }

  const ext  = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || "application/octet-stream";

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  });
}

// Every request: Host → Origin → CORS → preflight → sign-in → module routes → legacy routes,
// inside one error boundary (scripts/server/http/pipeline.cjs).
const server = http.createServer(createPipeline({ requestPolicy, lanAuth, router, fallback: legacyRoutes, json, errors }));

server.timeout = 0; // Disable socket timeout for large model uploads/downloads

// Local-only by default (no sign-in). UAIS_HOST=0.0.0.0 shares it on your network; sign-in is then
// required for every other device (see docs/security/LAN_ACCESS.md).
server.listen(PORT_FRONTEND, LISTEN_HOST, () => {
  console.log("");
  console.log("  ============================================================");
  console.log("   UNCENSORED AI STUDIO      |  Running");
  console.log("   Server Build: " + SERVER_BUILD);
  console.log("   Frontend : http://localhost:" + PORT_FRONTEND);
  console.log("   Image API: http://127.0.0.1:" + imageEngine.state.PORT_BACKEND);
  console.log("   Text API : starts on http://127.0.0.1:" + PREFERRED_LLM_PORT);
  console.log("   Speech   : managed locally, API on frontend port");
  console.log("   TTS      : Kokoro ONNX managed locally, API on frontend port");
  if (lanAuth.mode.required) {
    // The token itself is never printed; only where to find it.
    console.log("   Sign-in  : required" + (lanAuth.mode.loopbackExempt ? " for other devices (this computer is exempt)" : " for every request"));
    console.log("   Token    : " + lanAuth.tokenFile);
  }
  console.log("  ============================================================");
  console.log("");

  // Do not auto-start backend; wait for selection from the Web UI
  console.log("  [backend] Ready. Waiting for model load request from the webapp...");
});

// Last line of defence for exits that skip the handlers below (uncaught errors, process.exit):
// ask every engine to stop now. Hard kills of this server are covered by the engine guards.
process.on("exit", () => supervisor.stopAllSync());

// Graceful shutdown
process.on("SIGINT",  async () => { await killBackend(); await killOpenVinoWorker(); await killLlm(); await speech.stopSpeech(); await tts.stopTts(); process.exit(0); });
process.on("SIGTERM", async () => { await killBackend(); await killOpenVinoWorker(); await killLlm(); await speech.stopSpeech(); await tts.stopTts(); process.exit(0); });
