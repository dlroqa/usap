// services/image-engine.cjs — image generation (Step 9.8g).
//
// Moved unchanged from serve.cjs: the stable-diffusion.cpp engine (backend choice, start, readiness, load
// progress, stop), the OpenVINO NPU worker, the Core ML backend, the /v1 and /sdapi proxy to the engine,
// generation progress, and saved outputs. The code below is the original code; only its free variables now
// come from `deps`, and BACKEND_PATH (set by start-up detection in serve.cjs) is read through
// getBackendPath(). No HTTP routes here (see routes/image.cjs).
//
// `state` gives read access to the engine state for serve.cjs (health, diagnostics, hardware). Only the
// routes may set the four values they set before the move (`routeState`).
"use strict";

const { describeSpawnError, isLaunchFailure } = require("../spawn-error.cjs");

const REQUIRED = ["BACKEND_PATHS","IS_MAC_INTEL","MAC_INTEL_IMAGE_MESSAGE","MODELS","OUTPUTS","PREFERRED_BACKEND_PORT","ROOT","assertNoOtherActiveRuntime","backendValidationErrors","badRequest","checkPort","conflict","describeLinuxRuntimeLinkerError","findOpenVinoModel","fs","getBackendOptions","getBackendPath","getDefaultModel","getModelLoadIssue","getOpenVinoModelInfo","getOpenVinoNpuInfo","getPreferredVulkanBackendName","http","json","killLlm","os","osPlatform","path","pollNvidiaVram","readdirVisible","requestJson","safeOutputName","spawn","spawnSync","stripAnsi","supervisor","withoutAuthHeaders","withoutCorsHeaders"];

function createImageEngine(deps) {
  for (const name of REQUIRED) {
    if (deps[name] === undefined || deps[name] === null) throw new Error(`image-engine: missing dependency ${name}`);
  }
  const { BACKEND_PATHS, IS_MAC_INTEL, MAC_INTEL_IMAGE_MESSAGE, MODELS, OUTPUTS, PREFERRED_BACKEND_PORT, ROOT, assertNoOtherActiveRuntime, backendValidationErrors, badRequest, checkPort, conflict, describeLinuxRuntimeLinkerError, findOpenVinoModel, fs, getBackendOptions, getBackendPath, getDefaultModel, getModelLoadIssue, getOpenVinoModelInfo, getOpenVinoNpuInfo, getPreferredVulkanBackendName, http, json, killLlm, os, osPlatform, path, pollNvidiaVram, readdirVisible, requestJson, safeOutputName, spawn, spawnSync, stripAnsi, supervisor, withoutAuthHeaders, withoutCorsHeaders } = deps;

  let PORT_BACKEND = PREFERRED_BACKEND_PORT;

  const backendSupportsFlags = {};

  let backendProc  = null;

  let backendProcSeq = 0;

  let backendReady = false;

  let backendError = null;

  let openvinoProc = null;

  let openvinoReady = false;

  let openvinoError = null;

  let openvinoPort = null;

  let openvinoModel = null;

  let openvinoWidth = null;

  let openvinoHeight = null;

  let backendLoadState = {
    active: false,
    phase: "",
    progress: 0,
    current: 0,
    total: 0,
    speed: "",
    model: "",
    backendMode: "",
    backendBinary: "",
    device: "",
  };

  let backendUnloadState = {
    active: false,
    phase: "",
    progress: 0,
  };

  let currentSettings = {
    model:    null,
    steps:    20,
    cfgScale: 7.0,
    sampler:  "euler_a",
    threads:  8,
    useGpu:   true,
    backendType: "auto",
    vaeTiling: true,
    vaeOnCpu:  false,
    flashAttn: true,
    width: 512,
    height: 512,
  };

  const BACKEND_RESTART_SETTING_KEYS = [
    "model",
    "steps",
    "cfgScale",
    "sampler",
    "threads",
    "useGpu",
    "backendType",
    "vaeTiling",
    "vaeOnCpu",
    "flashAttn",
    "width",
    "height",
  ];

  function normalizeBackendSettingValue(key, value) {
    if (value === undefined || value === null) return value;
    if (key === "model") return path.resolve(String(value));
    if (["steps", "threads", "width", "height"].includes(key)) return parseInt(value);
    if (key === "cfgScale") return Math.round(parseFloat(value) * 1000) / 1000;
    if (["useGpu", "vaeTiling", "vaeOnCpu", "flashAttn"].includes(key)) return Boolean(value);
    return String(value);
  }

  function backendSettingsMatch(current, requested) {
    return BACKEND_RESTART_SETTING_KEYS.every((key) => (
      normalizeBackendSettingValue(key, current[key]) === normalizeBackendSettingValue(key, requested[key])
    ));
  }

  function setBackendLoadStage(phase, progress, extra = {}) {
    if (backendReady) return;
    backendLoadState = {
      ...backendLoadState,
      active: true,
      phase,
      progress: Math.max(backendLoadState.progress || 0, Math.min(99, progress)),
      ...extra,
    };
  }

  function updateCoreMLLoadProgress(output) {
    if (currentSettings.backendType !== "apple-npu" || backendReady) return;
    const cleanOutput = stripAnsi(output);

    if (cleanOutput.includes("Loading PyTorch reference configuration")) {
      setBackendLoadStage("Loading PyTorch reference configuration...", 8);
    }

    const pipelineMatch = cleanOutput.match(/Loading pipeline components.*?(\d+)%/);
    if (pipelineMatch) {
      const componentProgress = Math.max(0, Math.min(100, Number(pipelineMatch[1]) || 0));
      setBackendLoadStage("Loading pipeline components...", 10 + Math.round(componentProgress * 0.25));
    }

    if (cleanOutput.includes("Loading Core ML models from")) {
      setBackendLoadStage("Loading Core ML model bundle...", 40);
    }
    if (cleanOutput.includes("Loading text_encoder")) {
      setBackendLoadStage("Loading text encoder...", 48);
    }
    if (cleanOutput.includes("Loading unet")) {
      setBackendLoadStage("Loading UNet neural engine model...", 62);
    }
    if (cleanOutput.includes("Loading vae_decoder")) {
      setBackendLoadStage("Loading VAE decoder...", 78);
    }
    if (cleanOutput.includes("Loading safety_checker")) {
      setBackendLoadStage("Loading safety checker...", 88);
    }
    if (cleanOutput.includes("Initializing Core ML pipe")) {
      setBackendLoadStage("Initializing Core ML pipeline...", 94);
    }
    if (cleanOutput.includes("Stable Diffusion configured")) {
      setBackendLoadStage("Configuring image resolution...", 97);
    }
    if (cleanOutput.includes("Core ML models loaded successfully")) {
      setBackendLoadStage("Core ML models loaded successfully.", 99);
    }
  }

  async function findAvailableBackendPort() {
    const preferred = await checkPort(PREFERRED_BACKEND_PORT);
    if (preferred.available) return PREFERRED_BACKEND_PORT;

    for (let port = 28088; port <= 28120; port += 1) {
      const candidate = await checkPort(port);
      if (candidate.available) {
        console.log(`  [backend] Preferred port ${PREFERRED_BACKEND_PORT} is busy; using ${port} instead.`);
        return port;
      }
    }

    throw new Error(`No free backend port found. Tried ${PREFERRED_BACKEND_PORT} and 28088-28120.`);
  }

  let cachedCoreMLPythonPath = null;

  let cachedCoreMLAvailable = null;

  function getCoreMLPythonPath() {
    if (cachedCoreMLAvailable !== null) {
      return cachedCoreMLPythonPath;
    }

    if (osPlatform !== "darwin") {
      cachedCoreMLAvailable = false;
      cachedCoreMLPythonPath = null;
      return null;
    }

    // 1. Check environment variable COREML_PYTHON
    if (process.env.COREML_PYTHON && fs.existsSync(process.env.COREML_PYTHON)) {
      cachedCoreMLPythonPath = process.env.COREML_PYTHON;
      cachedCoreMLAvailable = true;
      return cachedCoreMLPythonPath;
    }

    // 2. Check local/in-project venvs
    const localPaths = [
      path.join(ROOT, "app", "backend", "mac", "coreml_venv", "bin", "python"),
      path.join(ROOT, "app", "backend", "mac", "venv", "bin", "python"),
      path.join(ROOT, "venv", "bin", "python"),
    ];

    for (const p of localPaths) {
      if (fs.existsSync(p)) {
        cachedCoreMLPythonPath = p;
        cachedCoreMLAvailable = true;
        return p;
      }
    }

    // 3. Check dynamically in home directory (as fallback to user's setup)
    const homeDir = os.homedir();
    const homePaths = [
      path.join(homeDir, "workspace", "coreml_conversion", "venv", "bin", "python"),
      path.join(homeDir, "ml-stable-diffusion", "venv", "bin", "python"),
    ];

    for (const p of homePaths) {
      if (fs.existsSync(p)) {
        cachedCoreMLPythonPath = p;
        cachedCoreMLAvailable = true;
        return p;
      }
    }

    // 4. Fallback: Probe system python3 if it has required imports
    try {
      const probeResult = spawnSync("python3", [
        "-c",
        "import torch, python_coreml_stable_diffusion, diffusers, transformers"
      ], { timeout: 2000 });
      
      if (probeResult.status === 0) {
        // Find absolute path of python3
        const whichResult = spawnSync("which", ["python3"], { encoding: "utf8" });
        const python3Path = whichResult.stdout ? whichResult.stdout.trim() : "python3";
        cachedCoreMLPythonPath = python3Path;
        cachedCoreMLAvailable = true;
        return python3Path;
      }
    } catch (err) {
      // python3 not in path or crashed
    }

    cachedCoreMLAvailable = false;
    cachedCoreMLPythonPath = null;
    return null;
  }

  function backendAccepts(binaryPath, backendName) {
    if (!binaryPath || !fs.existsSync(binaryPath)) return false;
    try {
      delete backendValidationErrors[binaryPath];
      const cliBackendName = backendName === "cuda"
        ? "cuda0"
        : backendName === "vulkan"
          ? getPreferredVulkanBackendName()
          : backendName === "rocm"
            ? "rocm0"
            : backendName;
      let probeArgs = [
        "--backend", cliBackendName,
        "--params-backend", cliBackendName,
        "--model", path.join(MODELS, "__backend_probe_missing__.safetensors"),
        "--listen-port", "18082",
      ];
      if (cliBackendName === "metal") {
        probeArgs = [
          "--model", path.join(MODELS, "__backend_probe_missing__.safetensors"),
          "--listen-port", "18082",
        ];
      }
      const spawnEnv = { ...process.env };
      if (osPlatform === "linux") {
        const dir = path.dirname(binaryPath);
        const existing = spawnEnv.LD_LIBRARY_PATH || "";
        spawnEnv.LD_LIBRARY_PATH = dir + (existing ? ":" + existing : "");
      } else if (osPlatform === "darwin") {
        const dir = path.dirname(binaryPath);
        const existing = spawnEnv.DYLD_LIBRARY_PATH || "";
        spawnEnv.DYLD_LIBRARY_PATH = dir + (existing ? ":" + existing : "");
      }
      let result = spawnSync(binaryPath, probeArgs, { env: spawnEnv, encoding: "utf8", timeout: 5000 });
      let output = `${result.stdout || ""}\n${result.stderr || ""}`;
      const unsignedExitCode = Number(result.status) >>> 0;
      if (osPlatform === "win32" && unsignedExitCode === 0xC0000135) {
        backendValidationErrors[binaryPath] = "Windows could not start this backend because a required DLL is missing (0xC0000135). Run scripts/setup/setup.ps1 to install the Microsoft Visual C++ runtime and repair the backend.";
        return false;
      }
      if (osPlatform === "win32" && unsignedExitCode === 0xC000001D) {
        backendValidationErrors[binaryPath] = "This Windows backend used a CPU instruction that this processor does not support (0xC000001D). Run scripts/setup/setup.ps1 to replace it with the runtime-dispatched backend build.";
        return false;
      }

      let supportsFlags = true;
      // Some binaries do not support --backend. If we see "unknown argument",
      // retry without backend flags so we can still verify the binary launches.
      if (output.includes("unknown argument") && output.includes("--backend")) {
        supportsFlags = false;
        const fallbackArgs = [
          "--model", path.join(MODELS, "__backend_probe_missing__.safetensors"),
          "--listen-port", "18082",
        ];
        result = spawnSync(binaryPath, fallbackArgs, { env: spawnEnv, encoding: "utf8", timeout: 5000 });
        output = `${result.stdout || ""}\n${result.stderr || ""}`;
      }

      const lower = output.toLowerCase();
      // Keep the real reason so the UI can show it instead of a generic "did not register".
      const reject = (reason) => {
        const detail = output.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" | ").slice(0, 400);
        backendValidationErrors[binaryPath] = detail ? `${reason} Backend output: ${detail}` : reason;
        return false;
      };
      if (lower.includes("backend config failed") || output.includes(`backend '${backendName}' was not found`) || output.includes(`backend '${cliBackendName}' was not found`)) {
        return reject(backendName === "vulkan" && osPlatform === "linux"
          ? "The backend started but found no Vulkan GPU. Check that `vulkaninfo --summary` lists your GPU (not only llvmpipe). Older Radeon HD 7000/8000 (GCN 1.0/1.1) cards need the amdgpu kernel driver for Mesa Vulkan: boot with radeon.si_support=0 amdgpu.si_support=1 (or radeon.cik_support=0 amdgpu.cik_support=1)."
          : `The backend started but could not use the ${backendName} device.`);
      }
      // Reject binaries that fail at the dynamic linker / glibc level.
      if (lower.includes("glibc") || lower.includes("libc.so") || lower.includes("libstdc++") || lower.includes("cannot open shared object")) {
        return reject(osPlatform === "linux"
          ? "This prebuilt backend cannot run on this Linux system (it needs glibc 2.38+ / a newer libstdc++, e.g. Ubuntu 24.04, or a missing shared library). Build it locally with scripts/build/build_from_source.sh."
          : "This backend is missing a required system library.");
      }
      // A healthy binary prints project-specific log lines when it tries to load the model.
      const isOk = lower.includes("stable-diffusion.cpp") || lower.includes("loading model");
      if (isOk) {
        backendSupportsFlags[binaryPath] = supportsFlags;
        return true;
      }
      return reject(result.error
        ? `The backend could not be started: ${result.error.message}.`
        : `The backend exited (code ${result.status}) without starting.`);
    } catch (_) {
      return false;
    }
  }

  function selectBackendPath(useGpu, backendType = "auto", modelPath = "") {
    const resolvedType = resolveBackendType(useGpu, backendType, modelPath);
    if (osPlatform === "win32") {
      if (resolvedType === "cuda" && fs.existsSync(BACKEND_PATHS.cuda)) return BACKEND_PATHS.cuda;
      if (resolvedType === "cpu" && fs.existsSync(BACKEND_PATHS.cpu)) return BACKEND_PATHS.cpu;
      if (resolvedType === "vulkan" && fs.existsSync(BACKEND_PATHS.vulkan)) return BACKEND_PATHS.vulkan;
      if (fs.existsSync(BACKEND_PATHS.cuda)) return BACKEND_PATHS.cuda;
      if (fs.existsSync(BACKEND_PATHS.cpu)) return BACKEND_PATHS.cpu;
      if (fs.existsSync(BACKEND_PATHS.vulkan)) return BACKEND_PATHS.vulkan;
      return getBackendPath();
    }
    if (osPlatform === "linux") {
      let finalType = resolvedType;
      if (finalType === "cuda") {
        if (fs.existsSync(BACKEND_PATHS.linuxCuda)) {
          return BACKEND_PATHS.linuxCuda;
        }
        finalType = "vulkan";
      }
      if (finalType === "rocm" && fs.existsSync(BACKEND_PATHS.linuxRocm)) return BACKEND_PATHS.linuxRocm;
      if (resolvedType === "vulkan" && fs.existsSync(BACKEND_PATHS.linuxVulkan)) return BACKEND_PATHS.linuxVulkan;
      if (resolvedType === "cpu" && fs.existsSync(BACKEND_PATHS.linuxCpu)) return BACKEND_PATHS.linuxCpu;
      if (fs.existsSync(BACKEND_PATHS.linuxVulkan)) return BACKEND_PATHS.linuxVulkan;
      if (fs.existsSync(BACKEND_PATHS.linuxCpu)) return BACKEND_PATHS.linuxCpu;
      return getBackendPath();
    }
    if (osPlatform === "darwin") {
      if (resolvedType === "apple-npu") return getCoreMLPythonPath();
      if (fs.existsSync(BACKEND_PATHS.mac)) return BACKEND_PATHS.mac;
      return getBackendPath();
    }
    // generic fallback
    if (fs.existsSync(BACKEND_PATHS.mac)) return BACKEND_PATHS.mac;
    return getBackendPath();
  }

  function resolveBackendType(useGpu, backendType = "auto", modelPath = "") {
    const options = getBackendOptions();
    let requestedType = useGpu === false ? "cpu" : backendType === "auto" ? options.defaultBackendType : backendType;

    if (modelPath && osPlatform === "darwin") {
      const lower = modelPath.toLowerCase();
      const isDir = fs.existsSync(modelPath) && fs.statSync(modelPath).isDirectory();
      if (lower.endsWith(".safetensors") || lower.endsWith(".gguf")) {
        if (requestedType === "apple-npu") requestedType = "metal";
      } else if (lower.endsWith(".coreml") || lower.endsWith(".mlpackage") || lower.endsWith(".mlmodelc") || isDir) {
        if (requestedType === "metal") requestedType = "apple-npu";
      }
    }

    const available = new Set(options.options.map(option => option.id));
    return available.has(requestedType) ? requestedType : options.defaultBackendType;
  }

  function getBackendMode(backendPath, useGpu, backendType = "auto") {
    if (useGpu === false || backendType === "cpu") return "CPU";
    const name = path.basename(backendPath || "").toLowerCase();
    if (name.includes("cuda")) return "CUDA GPU";
    if (name.includes("rocm")) return "ROCm GPU";
    if (name.includes("vulkan")) return "Vulkan GPU";
    if (backendType === "apple-npu") return "Apple NPU";
    if (osPlatform === "darwin" || backendType === "metal") return "Metal GPU";
    return "GPU";
  }

  function markBackendReady() {
    if (backendReady) return;
    backendReady = true;
    backendLoadState = {
      ...backendLoadState,
      active: false,
      phase: "Model ready",
      progress: 100,
    };
    console.log("  [backend] READY on port", PORT_BACKEND);

    // Force a single VRAM poll after the model settles in memory
    setTimeout(() => pollNvidiaVram(true), 1500);
  }

  function pingBackendReady() {
    return new Promise(resolve => {
      const req = http.get(`http://127.0.0.1:${PORT_BACKEND}/v1/models`, res => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 500);
      });
      req.setTimeout(1000, () => {
        req.destroy();
        resolve(false);
      });
      req.on("error", () => resolve(false));
    });
  }

  function proxyImageBackendRequest(req, res) {
    const headers = withoutAuthHeaders(req.headers); // USAP credentials stay in USAP
    delete headers.host;
    headers.host = `127.0.0.1:${PORT_BACKEND}`;

    const proxyReq = http.request({
      hostname: "127.0.0.1",
      port: PORT_BACKEND,
      path: req.url,
      method: req.method,
      headers,
      // CPU generation and VAE decoding can legitimately take well over five
      // minutes on low-memory systems. Let the browser/user control cancellation.
      timeout: 0,
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, {
        ...withoutCorsHeaders(proxyRes.headers),
      });
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (err) => {
      json(res, 502, { ok: false, error: `Image backend is not reachable: ${err.message}` });
    });
    proxyReq.on("timeout", () => {
      proxyReq.destroy(new Error("Image backend request timed out"));
    });

    req.pipe(proxyReq);
  }

  async function killOpenVinoWorker() {
    if (!openvinoProc) {
      openvinoReady = false;
      return;
    }
    console.log("  [openvino-npu] Stopping worker...");
    try { openvinoProc.kill("SIGTERM"); } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 800));
    try { openvinoProc.kill("SIGKILL"); } catch (_) {}
    openvinoProc = null;
    openvinoReady = false;
  }

  function getOpenVinoResolution(settings = {}) {
    const width = Number(settings.width) || 512;
    const height = Number(settings.height) || 512;
    const supported = (width === 512 && height === 512) || (width === 1024 && height === 1024);
    if (!supported) {
      throw new Error("OpenVINO NPU supports 512x512 generation or 1024x1024 HD upscale.");
    }
    return { width, height };
  }

  async function startOpenVinoWorker(settings = {}) {
    const npuInfo = getOpenVinoNpuInfo();
    if (!npuInfo.supported) throw new Error(npuInfo.reason || "OpenVINO NPU is not available.");
    const requestedModel = settings.model ? findOpenVinoModel(settings.model) : null;
    if (settings.model && !requestedModel) {
      throw new Error("OpenVINO NPU requires a downloaded OpenVINO model. Standard .safetensors/.ckpt weights must use Vulkan, CUDA, or CPU.");
    }
    const model = requestedModel || getOpenVinoModelInfo().find((item) => item.installed);
    if (!model || !model.installed) {
      throw new Error("OpenVINO NPU model is not downloaded. Download an OpenVINO NPU model from Model Manager first.");
    }
    const { width, height } = getOpenVinoResolution(settings);
    if (openvinoProc &&
        openvinoReady &&
        openvinoModel === model.id) {
      currentSettings = { ...currentSettings, ...settings, model: model.id, width, height };
      return;
    }

    await killBackend();
    await killOpenVinoWorker();
    openvinoError = null;
    openvinoReady = false;
    openvinoModel = model.id;
    openvinoWidth = 512;
    openvinoHeight = 512;
    openvinoPort = await findAvailableBackendPort();
    PORT_BACKEND = openvinoPort;

    currentSettings = { ...currentSettings, ...settings };
    currentSettings.backendType = "openvino-npu";
    currentSettings.useGpu = true;
    currentSettings.backendMode = "NPU (OpenVINO)";
    currentSettings.backendBinary = "openvino_npu_worker.py";
    currentSettings.backendDevice = npuInfo.npu?.name || "Intel AI Boost";
    currentSettings.model = model.id;
    currentSettings.width = width;
    currentSettings.height = height;

    backendError = null;
    backendLoadState = {
      active: true,
      phase: "Compiling OpenVINO NPU pipeline (512x512)...",
      progress: 5,
      current: 0,
      total: 0,
      speed: "",
      model: model.name,
      backendMode: "NPU (OpenVINO)",
      backendBinary: "openvino_npu_worker.py",
      device: currentSettings.backendDevice,
    };

    const workerPath = path.join(ROOT, "scripts", "workers", "openvino_npu_worker.py");
    const cacheDir = path.join(ROOT, "app", "tools", "openvino-cache", "512x512");
    console.log(`  [openvino-npu] Starting 512x512 worker on port ${openvinoPort}`);
    openvinoProc = spawn(npuInfo.python, [
      workerPath,
      "--model-dir", model.path,
      "--port", String(openvinoPort),
      "--width", "512",
      "--height", "512",
      "--cache-dir", cacheDir,
    ], { stdio: "pipe" });

    let openvinoStdoutBuffer = "";
    openvinoProc.stdout.on("data", (data) => {
      const text = data.toString();
      process.stdout.write("  " + text);
      openvinoStdoutBuffer += text;
      const lines = openvinoStdoutBuffer.split(/\r?\n/);
      openvinoStdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (line.includes("READY")) {
          openvinoReady = true;
          backendReady = true;
          backendLoadState = { ...backendLoadState, active: false, phase: "OpenVINO NPU model ready", progress: 100 };
        }
        const progressMatch = line.match(/PROGRESS\s+(\d+)\/(\d+)\s+(.+)$/);
        if (progressMatch) {
          generationState.active = true;
          generationState.step = Number(progressMatch[1]);
          generationState.steps = Number(progressMatch[2]);
          generationState.speed = progressMatch[3].trim();
          generationState.decoding = false;
        } else if (line.includes("DECODING") && generationState.active) {
          generationState.step = generationState.steps;
          generationState.decoding = true;
          generationState.speed = "";
        }
      }
    });
    openvinoProc.stderr.on("data", (data) => {
      const text = data.toString();
      process.stderr.write("  " + text);
      const cleanText = stripAnsi(text).trim();
      if (cleanText && (cleanText.includes("ERROR") || cleanText.includes("Traceback") || cleanText.includes("Exception"))) {
        openvinoError = cleanText;
        backendError = openvinoError;
      }
    });
    openvinoProc.on("exit", (code) => {
      console.log("  [openvino-npu] worker exited with code", code);
      openvinoProc = null;
      openvinoReady = false;
      backendReady = false;
      if (code !== 0 && code !== null && !backendError) backendError = `OpenVINO NPU worker exited with code ${code}`;
      backendLoadState.active = false;
    });

    const startedAt = Date.now();
    while (Date.now() - startedAt < 360000) {
      if (openvinoReady) return;
      if (backendError) throw new Error(backendError);
      if (!openvinoProc) throw new Error("OpenVINO NPU worker exited during startup.");
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      backendLoadState.progress = Math.min(95, 5 + Math.round(elapsed / 2));
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await killOpenVinoWorker();
    throw new Error("OpenVINO NPU 512x512 compile timed out after 6 minutes.");
  }

  async function generateWithOpenVino(body) {
    if (!openvinoReady || !openvinoPort) throw conflict("ENGINE_NOT_READY", "OpenVINO NPU worker is not ready. Load an OpenVINO NPU model first.");
    const steps = Math.max(1, Math.min(8, Number(body.steps) || 4));
    generationState = { active: true, step: 0, steps, speed: "", decoding: false };
    try {
      const result = await requestJson(`http://127.0.0.1:${openvinoPort}/generate`, {
        prompt: body.prompt,
        negative_prompt: body.negative_prompt || "",
        width: Number(body.width) || currentSettings.width || 512,
        height: Number(body.height) || currentSettings.height || 512,
        steps,
        cfg_scale: Number(body.cfg_scale) || 1.0,
        seed: body.seed,
      }, 300000);
      resetGenerationState();
      return result;
    } catch (err) {
      resetGenerationState();
      throw err;
    }
  }

  function startBackendReadyPoll() {
    let attempts = 0;
    const isNpu = currentSettings.backendType === "apple-npu" || currentSettings.backendType === "openvino-npu";
    const maxAttempts = isNpu ? 1200 : 240;
    const interval = setInterval(async () => {
      attempts += 1;
      if (!backendProc || backendReady || attempts > maxAttempts) {
        clearInterval(interval);
        return;
      }
      if (await pingBackendReady()) {
        markBackendReady();
        clearInterval(interval);
      }
    }, 500);
  }

  function startCoreMLLoadHeartbeat(proc) {
    if (currentSettings.backendType !== "apple-npu") return null;
    const startedAt = Date.now();
    const interval = setInterval(() => {
      if (backendProc !== proc || backendReady || !backendLoadState.active) {
        clearInterval(interval);
        return;
      }
      const elapsedSec = (Date.now() - startedAt) / 1000;
      const targetProgress = Math.min(96, Math.round(8 + 88 * (1 - Math.exp(-elapsedSec / 55))));
      if (targetProgress > (backendLoadState.progress || 0)) {
        backendLoadState = {
          ...backendLoadState,
          active: true,
          phase: backendLoadState.phase || "Loading Core ML model...",
          progress: targetProgress,
        };
      }
    }, 1000);
    return interval;
  }

  function killBackend() {
    return new Promise(resolve => {
      resetGenerationState();
      const proc = backendProc;
      if (!proc) {
        backendUnloadState = { active: false, phase: "", progress: 0 };
        resolve();
        return;
      }
      backendUnloadState = { active: true, phase: "Stopping backend process...", progress: 10 };
      backendReady = false;
      try { proc.kill("SIGTERM"); } catch (_) {}
      backendUnloadState = { active: true, phase: "Waiting for process exit...", progress: 50 };
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch (_) {}
        if (backendProc === proc) backendProc = null;
        backendUnloadState = { active: false, phase: "Backend unloaded", progress: 100 };
        resolve();
      }, 2000);
    });
  }

  async function startBackend(settings = {}) {
    const requestedSettings = { ...currentSettings, ...settings };
    if (!requestedSettings.model) requestedSettings.model = getDefaultModel();
    assertNoOtherActiveRuntime("image", requestedSettings.model);

    await killLlm();
    if (settings.backendType === "openvino-npu") {
      await startOpenVinoWorker(settings);
      return;
    }
    await killOpenVinoWorker();
    backendError = null;
    currentSettings = requestedSettings;
    if (!currentSettings.model) {
      console.log("  [backend] No model found in app/models/ — backend not started");
      return;
    }

    const modelLoadIssue = getModelLoadIssue(currentSettings.model);
    if (modelLoadIssue) {
      backendError = modelLoadIssue;
      backendLoadState = {
        active: false,
        phase: "Model load blocked",
        progress: 0,
        current: 0,
        total: 0,
        speed: "",
        model: path.basename(currentSettings.model),
        backendMode: "",
        backendBinary: "",
        device: "",
      };
      throw new Error(modelLoadIssue);
    }

    PORT_BACKEND = Number(settings.backendPort) > 0 ? Number(settings.backendPort) : await findAvailableBackendPort();

    const resolvedBackendType = resolveBackendType(currentSettings.useGpu, currentSettings.backendType, currentSettings.model);
    currentSettings.backendType = resolvedBackendType;
    currentSettings.useGpu = resolvedBackendType !== "cpu";
    const backendPath = selectBackendPath(currentSettings.useGpu, currentSettings.backendType, currentSettings.model);
    if (!backendPath) {
      const setupHint = IS_MAC_INTEL
        ? MAC_INTEL_IMAGE_MESSAGE
        : resolvedBackendType === "apple-npu"
        ? "CoreML Python environment is not set up. Run scripts/setup/setup-coreml-npu.sh first."
        : resolvedBackendType === "cpu" && osPlatform === "win32"
          ? "Windows CPU backend is not installed. Run scripts/setup.ps1 again so app/backend/win/cpu is created."
          : "No compatible backend executable was found.";
      throw new Error(setupHint);
    }
    const backendMode = getBackendMode(backendPath, currentSettings.useGpu, currentSettings.backendType);
    currentSettings.backendMode = backendMode;
    currentSettings.backendBinary = path.basename(backendPath);

    backendLoadState = {
      active: true,
      phase: "Starting backend...",
      progress: 0,
      current: 0,
      total: 0,
      speed: "",
      model: path.basename(currentSettings.model),
      backendMode,
      backendBinary: path.basename(backendPath),
      device: "",
    };

    let runThreads = parseInt(currentSettings.threads) || 4;
    if (currentSettings.useGpu) {
      runThreads = Math.min(4, runThreads);
    }
    // Never run more compute threads than logical CPUs: on a 4-core Mac the default 8 threads made
    // sd ~5x slower (measured on macos-15-intel: 430 s/it at -t 8 vs 84 s/it at -t 4).
    runThreads = Math.max(1, Math.min(runThreads, os.cpus().length || runThreads));

    let args = [];
    const requestedBackend = resolveBackendType(currentSettings.useGpu, currentSettings.backendType, currentSettings.model);
    const selectedVulkanBackend = requestedBackend === "vulkan" ? getPreferredVulkanBackendName() : "";

    const supportsFlags = backendSupportsFlags[backendPath] !== false;

    if (requestedBackend === "apple-npu") {
      args = [
        path.join(ROOT, "scripts", "workers", "coreml_server.py"),
        "--listen-port", String(PORT_BACKEND),
        "--model",       currentSettings.model,
        "--steps",       String(currentSettings.steps),
        "--cfg-scale",   String(currentSettings.cfgScale),
      ];
    } else {
      args = [
        "--listen-port", String(PORT_BACKEND),
        "--model",       currentSettings.model,
        "--steps",       String(currentSettings.steps),
        "--cfg-scale",   String(currentSettings.cfgScale),
        "--sampling-method", currentSettings.sampler,
        "--threads",     String(runThreads),
      ];

      if (requestedBackend === "cpu") {
        if (supportsFlags) {
          args.push("--backend", "cpu", "--params-backend", "cpu");
        }
        args.push("--rng", "cpu", "--sampler-rng", "cpu");
    } else if (requestedBackend === "vulkan") {
      if (supportsFlags) {
        args.push("--backend", selectedVulkanBackend, "--params-backend", selectedVulkanBackend);
      }
      args.push("--rng", "cpu", "--sampler-rng", "cpu");
    } else if (requestedBackend === "cuda") {
      if (supportsFlags) {
        args.push("--backend", "cuda0", "--params-backend", "cuda0");
      }
      args.push("--rng", "cuda", "--sampler-rng", "cuda");
    } else if (requestedBackend === "rocm") {
      if (supportsFlags) {
        args.push("--backend", "rocm0", "--params-backend", "rocm0");
      }
      args.push("--rng", "cpu", "--sampler-rng", "cpu");
    } else if (requestedBackend === "metal") {
      args.push("--rng", "cpu", "--sampler-rng", "cpu");
    }

    }

    if (requestedBackend === "vulkan" && selectedVulkanBackend) {
      currentSettings.backendDevice = selectedVulkanBackend;
      backendLoadState.device = selectedVulkanBackend;
    }

    if (requestedBackend !== "apple-npu") {
      if (currentSettings.vaeTiling) {
        args.push("--vae-tiling");
      }
      if (currentSettings.vaeOnCpu) {
        args.push("--vae-on-cpu");
      }
      if (currentSettings.flashAttn) {
        if (requestedBackend === "cuda") {
          args.push("--diffusion-fa");
        } else {
          args.push("--fa");
        }
      }
    }

    // Build environment for Linux backends so bundled .so libraries are found.
    // Official Linux releases ship libstable-diffusion.so next to the executable.
    const spawnEnv = { ...process.env };
    if (osPlatform === "linux") {
      const extraLibs = [];
      if (requestedBackend === "rocm") {
        extraLibs.push(path.dirname(BACKEND_PATHS.linuxRocm));
      } else if (requestedBackend === "vulkan") {
        extraLibs.push(path.dirname(BACKEND_PATHS.linuxVulkan));
      } else if (requestedBackend === "cpu") {
        extraLibs.push(path.dirname(BACKEND_PATHS.linuxCpu));
      } else if (requestedBackend === "cuda") {
        extraLibs.push(path.dirname(BACKEND_PATHS.linuxCuda));
      }
      if (extraLibs.length > 0) {
        const existing = spawnEnv.LD_LIBRARY_PATH || "";
        spawnEnv.LD_LIBRARY_PATH = extraLibs.join(":") + (existing ? ":" + existing : "");
      }
    } else if (osPlatform === "darwin" && requestedBackend !== "apple-npu") {
      const existing = spawnEnv.DYLD_LIBRARY_PATH || "";
      const backendDir = path.dirname(BACKEND_PATHS.mac);
      spawnEnv.DYLD_LIBRARY_PATH = backendDir + (existing ? ":" + existing : "");
    }

    // Step 9.9d: warn-only memory check (optional dependency). It only records and logs; it can't refuse,
    // delay or change this start, and anything it throws is ignored. Core ML models (folders) are not assessed.
    if (deps.memoryAdvisor && requestedBackend !== "apple-npu") {
      try {
        deps.memoryAdvisor.beforeLoad("image", { modelPath: currentSettings.model, useGpu: requestedBackend !== "cpu" && Boolean(currentSettings.useGpu) });
      } catch (_) { /* advisory only */ }
    }

    console.log("  [backend] Starting:", path.basename(backendPath), args.join(" "));
    backendReady = false;

    const procSeq = ++backendProcSeq;
    const proc = supervisor.spawnSupervised(backendPath, args, { stdio: "pipe", env: spawnEnv }, { label: "image" });
    backendProc = proc;
    startBackendReadyPoll();
    const coremlLoadHeartbeat = startCoreMLLoadHeartbeat(proc);

    proc.stdout.on("data", d => {
      const output = d.toString();
      process.stdout.write("  [sd] " + output);
      updateCoreMLLoadProgress(output);
      const cleanOutput = stripAnsi(output);
      if (cleanOutput.includes("listening on")) {
        markBackendReady();
      }
      
      const lines = output.split(/[\r\n]+/);
      for (const line of lines) {
        const cleanLine = stripAnsi(line);
        if (!cleanLine.trim()) continue;
        
        if (cleanLine.includes("listening on")) {
          markBackendReady();
        }

        if (cleanLine.includes("loading model from")) {
          backendLoadState.active = true;
          backendLoadState.phase = "Loading model weights...";
          backendLoadState.progress = Math.max(backendLoadState.progress, 1);
        }

        if (cleanLine.includes("model files processing completed")) {
          backendLoadState.active = true;
          backendLoadState.phase = "Initializing model...";
          backendLoadState.progress = Math.max(backendLoadState.progress, 95);
        }

        const loadMatch = cleanLine.match(/\|\s*(\d+)\/(\d+)\s*-\s*([^|]+)$/);
        if (loadMatch && !cleanLine.includes("it/s") && !cleanLine.includes("s/it")) {
          const current = parseInt(loadMatch[1], 10);
          const total = parseInt(loadMatch[2], 10);
          const progress = total > 0 ? Math.round((current / total) * 100) : 0;
          const isCoreML = currentSettings.backendType === "apple-npu" || total <= 10;
          const phaseDesc = isCoreML ? stripAnsi(loadMatch[3]).trim() : "Loading model weights...";
          const speedDesc = isCoreML ? "" : stripAnsi(loadMatch[3]).trim();
          backendLoadState = {
            ...backendLoadState,
            active: !backendReady,
            phase: phaseDesc,
            progress: Math.max(backendLoadState.progress, Math.min(99, progress)),
            current,
            total,
            speed: speedDesc,
          };
        }
        
        if (cleanLine.includes("generate_image") || cleanLine.includes("generating image")) {
          generationState.active = true;
          generationState.step = 0;
          generationState.steps = 0;
          generationState.speed = "";
          generationState.decoding = false;
        }
        
        if (cleanLine.includes("decoding") && generationState.active) {
          generationState.decoding = true;
        }
        
        const match = cleanLine.match(/\|\s*[^|]*\s*\|\s*(\d+)\/(\d+)\s*-\s*([\d.]+\s*(?:it\/s|s\/it))/);
        if (match) {
          generationState.active = true;
          if (!generationState.decoding) {
            generationState.step = parseInt(match[1], 10);
            generationState.steps = parseInt(match[2], 10);
            generationState.speed = match[3].trim();
          }
        }
        
        if (cleanLine.includes("generate_image completed")) {
          generationState.active = false;
          generationState.step = 0;
          generationState.steps = 0;
          generationState.speed = "";
          generationState.decoding = false;
        }
      }
    });

    proc.stderr.on("data", d => {
      const output = d.toString();
      process.stderr.write("  [sd-err] " + output);
      updateCoreMLLoadProgress(output);
      const cleanOutput = stripAnsi(output);
      const runtimeLinkerError = describeLinuxRuntimeLinkerError(cleanOutput);
      if (runtimeLinkerError) {
        backendError = runtimeLinkerError;
        backendLoadState.phase = "Linux runtime is too old for this backend";
      }
      const deviceMatch = cleanOutput.match(/Device\s+\d+:\s*([^,\r\n]+)/);
      if (deviceMatch) {
        backendLoadState.device = deviceMatch[1].trim();
        currentSettings.backendDevice = backendLoadState.device;
      }
      const metalDeviceMatch = cleanOutput.match(/GPU name:\s*([^\r\n]+)/);
      if (metalDeviceMatch) {
        backendLoadState.device = metalDeviceMatch[1].trim();
        currentSettings.backendDevice = backendLoadState.device;
      }
      if (cleanOutput.includes("ggml_cuda_init")) {
        backendLoadState.backendMode = "CUDA GPU";
        currentSettings.backendMode = "CUDA GPU";
      }
      if (cleanOutput.includes("ggml_vulkan")) {
        backendLoadState.backendMode = "Vulkan GPU";
        currentSettings.backendMode = "Vulkan GPU";
      }
      if (cleanOutput.includes("ggml_hip") || cleanOutput.includes("ggml_rocm")) {
        backendLoadState.backendMode = "ROCm GPU";
        currentSettings.backendMode = "ROCm GPU";
      }
      // ggml lists the Metal device even when sd runs with --backend cpu; keep the CPU label then.
      if (cleanOutput.includes("ggml_metal") && requestedBackend !== "cpu") {
        backendLoadState.backendMode = "Metal GPU";
        currentSettings.backendMode = "Metal GPU";
      }
      if (cleanOutput.includes("[ERROR]")) {
        const nextError = describeBackendError(cleanOutput.trim(), currentSettings.model);
        const hasSpecificFileError = String(backendError || "").includes("incomplete or corrupted");
        const isGenericContextError = cleanOutput.includes("new_sd_ctx_t failed");
        if (!(hasSpecificFileError && isGenericContextError)) {
          backendError = nextError;
        }
      }
    });
    // #68: a launch failure (EACCES and the like) is an "error" event, not an exit; without a listener it
    // stopped the whole server. Now the start fails with a clear message and the server keeps running.
    proc.on("error", (err) => {
      if (!isLaunchFailure(proc)) { console.warn("  [backend] engine process error:", err.message); return; }
      if (coremlLoadHeartbeat) clearInterval(coremlLoadHeartbeat);
      console.error("  [backend] Could not start", backendPath, "-", err.code || "", err.message);
      if (backendProc !== proc) return;
      backendError = describeSpawnError(err, "image engine (stable-diffusion.cpp)");
      backendReady = false;
      backendProc = null;
      backendLoadState.active = false;
    });
    proc.on("exit", (code, signal) => {
      if (coremlLoadHeartbeat) clearInterval(coremlLoadHeartbeat);
      if (backendProc !== proc) {
        console.log("  [backend] stale process exited with code", code, signal ? `(signal ${signal})` : "", `(process ${procSeq})`);
        return;
      }
      backendReady = false;
      backendProc  = null;
      console.log("  [backend] exited with code", code, signal ? `(signal ${signal})` : "", `(process ${procSeq})`);
      if (code !== null && code !== 0) {
        if (!backendError) {
          backendError = describeBackendExitCode(code, currentSettings.backendBinary || getBackendPath());
        }
      } else if (signal && signal !== "SIGTERM" && signal !== "SIGKILL" && !backendError) {
        // e.g. SIGABRT from an unsupported Metal operation: say so instead of a later "socket hang up".
        backendError = `The image engine stopped unexpectedly (signal ${signal}). Try the CPU backend, or a smaller image size.`;
      }
      backendLoadState.active = false;
      generationState.active = false;
      generationState.step = 0;
      generationState.steps = 0;
      generationState.speed = "";
      generationState.decoding = false;

      // Force a VRAM poll to update free memory space
      setTimeout(() => pollNvidiaVram(true), 1000);
    });
  }

  let generationState = {
    active: false,
    step: 0,
    steps: 0,
    speed: "",
    decoding: false,
    backendMode: "",
    backendDevice: "",
  };

  function resetGenerationState() {
    generationState = {
      active: false,
      step: 0,
      steps: 0,
      speed: "",
      decoding: false,
      backendMode: "",
      backendDevice: "",
    };
  }

  function describeBackendError(rawError, modelPath) {
    const raw = String(rawError || "").trim();
    const filename = path.basename(modelPath || "");
    const lower = filename.toLowerCase();

    if (raw.includes("read tensor data failed") || raw.includes("load tensors from file failed")) {
      return `${raw}\n\n${filename || "The selected model"} is present but appears incomplete or corrupted. Delete it from Local Models and download/import it again.`;
    }

    if (!raw.includes("new_sd_ctx_t failed")) return raw;

    if (lower.endsWith(".gguf")) {
      if (lower === "stable-diffusion-xl-base-1.0-q4_0.gguf" || lower.includes("stable-diffusion-xl-base-1.0")) {
        return `${raw}\n\n${filename} is not supported as a one-click model in this app. This SDXL GGUF is a diffusion-only component and needs matching VAE/text encoder files instead of being loaded with --model. Use one of the recommended Safetensors SDXL/SD 1.5 checkpoints, or import a complete single-file GGUF checkpoint.`;
      }
      return `${raw}\n\n${filename} could not be loaded as a single checkpoint. Some GGUF files are only the diffusion part of a larger workflow and need separate VAE/text encoder files. Try a recommended SD 1.5/SDXL model, or re-download/import the file if this is meant to be a single-file SD/SDXL GGUF.`;
    }

    return `${raw}\n\nThe backend could not create the model context. Common causes are a corrupt/incomplete model file, unsupported checkpoint type, or not enough free RAM/VRAM. Delete and re-download the model, then try CPU or Vulkan mode at 512x512.`;
  }

  function describeBackendExitCode(code, backendPath) {
    const numericCode = Number(code);
    if (osPlatform === "win32" && numericCode === 3221225501) {
      const backendName = path.basename(backendPath || getBackendPath() || "backend");
      return `exited with code ${code} (0xC000001D: illegal CPU instruction).\n\nThe model is not the cause. Windows stopped ${backendName} because the backend used a CPU instruction that this processor does not support. Run scripts/setup/setup.ps1 to replace the old machine-specific build with the runtime-dispatched Windows backend and matching CUDA 12.8 runtime. RTX 50-series users should then retry CUDA mode; CPU mode remains available as a fallback.`;
    }
    if (osPlatform === "win32" && numericCode === 3221225781) {
      const backendName = path.basename(backendPath || getBackendPath() || "backend");
      const lowerBackend = backendName.toLowerCase();
      const isVulkan = lowerBackend.includes("vulkan");
      const isCuda = lowerBackend.includes("cuda");
      const likelyMissing = isVulkan
        ? "a Microsoft Visual C++ runtime DLL (such as VCOMP140.dll) or the Vulkan driver DLL (vulkan-1.dll)"
        : isCuda
          ? "a CUDA runtime DLL or NVIDIA driver component"
          : "a required backend DLL";
      const driverHint = isVulkan
        ? "Run scripts/setup/setup.ps1 to install the Microsoft runtime and repair the Vulkan backend, then update the GPU driver if vulkan-1.dll is still unavailable."
        : isCuda
          ? "Install or update the NVIDIA driver, then run setup again so the CUDA backend folder is repaired."
          : "Update the GPU driver, then run setup again so the backend folder is repaired.";

      return `exited with code ${code} (0xC0000135: required DLL not found).\n\nWindows could not start ${backendName} because ${likelyMissing} is missing or not loadable. ${driverHint}\n\nCPU mode remains available if Vulkan still cannot start.`;
    }

    return `exited with code ${code}`;
  }

  function saveGeneratedOutput(imageDataUrl, metadata = {}) {
    const match = String(imageDataUrl || "").match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/);
    if (!match) {
      throw badRequest("INVALID_IMAGE", "Expected a real base64 PNG, JPEG, or WebP image data URL");
    }

    const mime = match[1];
    const extByMime = {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/jpg": ".jpg",
      "image/webp": ".webp",
    };
    const ext = extByMime[mime] || ".png";
    const imageBuffer = Buffer.from(match[2], "base64");
    const isPng = imageBuffer.length > 8 &&
      imageBuffer[0] === 0x89 &&
      imageBuffer[1] === 0x50 &&
      imageBuffer[2] === 0x4e &&
      imageBuffer[3] === 0x47;
    const isJpeg = imageBuffer.length > 3 &&
      imageBuffer[0] === 0xff &&
      imageBuffer[1] === 0xd8 &&
      imageBuffer[2] === 0xff;
    const isWebp = imageBuffer.length > 12 &&
      imageBuffer.toString("ascii", 0, 4) === "RIFF" &&
      imageBuffer.toString("ascii", 8, 12) === "WEBP";
    if ((mime === "image/png" && !isPng) ||
        ((mime === "image/jpeg" || mime === "image/jpg") && !isJpeg) ||
        (mime === "image/webp" && !isWebp)) {
      throw new Error("Generated image payload did not match its declared image format.");
    }
    const createdAt = new Date().toISOString();
    const stamp = createdAt.replace(/[:.]/g, "-");
    const seed = metadata.seed !== undefined && metadata.seed !== null ? `-${safeOutputName(metadata.seed)}` : "";
    const baseName = `output-${stamp}${seed}`;
    const imageFilename = `${baseName}${ext}`;
    const metadataFilename = `${baseName}.json`;
    const imagePath = path.join(OUTPUTS, imageFilename);
    const metadataPath = path.join(OUTPUTS, metadataFilename);

    fs.writeFileSync(imagePath, imageBuffer);
    const savedMetadata = {
      ...metadata,
      createdAt,
      image: imageFilename,
      metadata: metadataFilename,
    };
    fs.writeFileSync(metadataPath, JSON.stringify(savedMetadata, null, 2), "utf8");
    console.log(`  [api] Saved generated output: ${imageFilename}`);
    return savedMetadata;
  }

  function listGeneratedOutputs() {
    try {
      return readdirVisible(OUTPUTS)
        .filter(file => file.toLowerCase().endsWith(".json"))
        .map(file => {
          try {
            const metadata = JSON.parse(fs.readFileSync(path.join(OUTPUTS, file), "utf8"));
            return {
              ...metadata,
              url: `/api/output-file?filename=${encodeURIComponent(metadata.image)}`,
            };
          } catch (_) {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    } catch (_) {
      return [];
    }
  }

  function deleteGeneratedOutputs(outputs = []) {
    const deleted = [];
    for (const output of outputs) {
      const imageFilename = path.basename(output?.image || output?.filename || "");
      const metadataFilename = path.basename(output?.metadata || "");
      if (!imageFilename && !metadataFilename) continue;

      const targets = new Set();
      if (imageFilename) targets.add(imageFilename);
      if (metadataFilename) targets.add(metadataFilename);

      if (!metadataFilename && imageFilename) {
        const stem = imageFilename.replace(/\.[^.]+$/, "");
        targets.add(`${stem}.json`);
      }

      for (const filename of targets) {
        const filePath = path.join(OUTPUTS, filename);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          deleted.push(filename);
        }
      }
    }
    return deleted;
  }

  const state = Object.freeze({
      get PORT_BACKEND() { return PORT_BACKEND; },
      get backendProc() { return backendProc; },
      get backendProcSeq() { return backendProcSeq; },
      get backendReady() { return backendReady; },
      get backendError() { return backendError; },
      get openvinoProc() { return openvinoProc; },
      get openvinoReady() { return openvinoReady; },
      get openvinoError() { return openvinoError; },
      get openvinoPort() { return openvinoPort; },
      get openvinoModel() { return openvinoModel; },
      get openvinoWidth() { return openvinoWidth; },
      get openvinoHeight() { return openvinoHeight; },
      get backendLoadState() { return backendLoadState; },
      get backendUnloadState() { return backendUnloadState; },
      get currentSettings() { return currentSettings; },
      get cachedCoreMLPythonPath() { return cachedCoreMLPythonPath; },
      get cachedCoreMLAvailable() { return cachedCoreMLAvailable; },
      get generationState() { return generationState; },
  });
  return {
    state,
    routeState: Object.freeze({
      get PORT_BACKEND() { return PORT_BACKEND; },
      get backendProc() { return backendProc; },
      get backendProcSeq() { return backendProcSeq; },
      get backendReady() { return backendReady; },
      get backendError() { return backendError; },
      get openvinoProc() { return openvinoProc; },
      get openvinoReady() { return openvinoReady; },
      get openvinoError() { return openvinoError; },
      get openvinoPort() { return openvinoPort; },
      get openvinoModel() { return openvinoModel; },
      get openvinoWidth() { return openvinoWidth; },
      get openvinoHeight() { return openvinoHeight; },
      get backendLoadState() { return backendLoadState; },
      get backendUnloadState() { return backendUnloadState; },
      get currentSettings() { return currentSettings; },
      get cachedCoreMLPythonPath() { return cachedCoreMLPythonPath; },
      get cachedCoreMLAvailable() { return cachedCoreMLAvailable; },
      get generationState() { return generationState; },
      set currentSettings(value) { currentSettings = value; },
      set backendError(value) { backendError = value; },
      set backendLoadState(value) { backendLoadState = value; },
      set PORT_BACKEND(value) { PORT_BACKEND = value; },
    }),
    fns: { backendSupportsFlags, BACKEND_RESTART_SETTING_KEYS, normalizeBackendSettingValue, backendSettingsMatch, setBackendLoadStage, updateCoreMLLoadProgress, findAvailableBackendPort, getCoreMLPythonPath, backendAccepts, selectBackendPath, resolveBackendType, getBackendMode, markBackendReady, pingBackendReady, proxyImageBackendRequest, killOpenVinoWorker, getOpenVinoResolution, startOpenVinoWorker, generateWithOpenVino, startBackendReadyPoll, startCoreMLLoadHeartbeat, killBackend, startBackend, resetGenerationState, describeBackendError, describeBackendExitCode, saveGeneratedOutput, listGeneratedOutputs, deleteGeneratedOutputs },
  };
}

module.exports = { createImageEngine };
