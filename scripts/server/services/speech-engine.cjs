// services/speech-engine.cjs — whisper.cpp speech recognition service (Step 9.8c).
//
// Moved unchanged from serve.cjs: the Whisper model catalog, backend discovery (CPU / Vulkan /
// Metal per OS), engine state, the serialized operation queue, model listing and resolution,
// starting/stopping, transcription and translation through whisper-cli (started via the engine
// supervisor) and saved transcripts. The code below the state section is the original code; only
// its free variables now come from `deps`. No HTTP here (see routes/speech.cjs).
"use strict";

const { describeSpawnError, isLaunchFailure } = require("../spawn-error.cjs");

const os = require("os");

const SPEECH_MODEL_CATALOG = [
  { id: "tiny.en", name: "Whisper Tiny English", filename: "ggml-tiny.en.bin", size: "75 MB", language: "English", recommended: false },
  { id: "tiny.en-q5_1", name: "Whisper Tiny English Q5", filename: "ggml-tiny.en-q5_1.bin", size: "31 MB", language: "English", recommended: false },
  { id: "base.en", name: "Whisper Base English", filename: "ggml-base.en.bin", size: "142 MB", language: "English", recommended: true },
  { id: "base.en-q5_1", name: "Whisper Base English Q5", filename: "ggml-base.en-q5_1.bin", size: "57 MB", language: "English", recommended: true },
  { id: "small.en", name: "Whisper Small English", filename: "ggml-small.en.bin", size: "466 MB", language: "English", recommended: false },
  { id: "small.en-q5_1", name: "Whisper Small English Q5", filename: "ggml-small.en-q5_1.bin", size: "181 MB", language: "English", recommended: false },
  { id: "tiny", name: "Whisper Tiny Multilingual", filename: "ggml-tiny.bin", size: "75 MB", language: "Multilingual", recommended: false },
  { id: "base", name: "Whisper Base Multilingual", filename: "ggml-base.bin", size: "142 MB", language: "Multilingual", recommended: false },
  { id: "base-q5_1", name: "Whisper Base Multilingual Q5", filename: "ggml-base-q5_1.bin", size: "57 MB", language: "Multilingual", recommended: false },
  { id: "small", name: "Whisper Small Multilingual", filename: "ggml-small.bin", size: "466 MB", language: "Multilingual", recommended: false },
];

const REQUIRED_HELPERS = ["describeLinkedModel", "detectedKindFor", "findAvailableSpeechPort", "findExistingFile", "formatBytes", "getPathSize", "isWaveBuffer", "pathInside", "readdirVisible", "safeOutputName"];

function createSpeechService(deps) {
  const { paths, osPlatform, fs, path, supervisor, errors, helpers, preferredPort } = deps;
  // Step 9.9e (optional): the thread budget may lower this job's count while another workload is busy. Off, absent
  // or failing, the requested count is used unchanged. It can only lower the count, never raise it.
  // The logical-CPU cap (services/whisper-thread-cap.cjs, default on) runs first, then the budget. Each step can only
  // lower the count; a step that is absent, off or failing passes its input through unchanged.
  const lowerOnly = (step, n) => {
    if (!step) return n;
    try {
      const t = step.forTranscription(n);
      return Number.isInteger(t) && t >= 1 && t <= n ? t : n;
    } catch (_) {
      return n;
    }
  };
  const jobThreads = (requested) => lowerOnly(deps.threadBudget, lowerOnly(deps.whisperThreadCap, requested));
  const { ROOT, SPEECH_MODELS, SPEECH_BACKEND_ROOT, SPEECH_BACKEND_PATHS, TRANSCRIPTIONS } = paths;
  const { badRequest, notFound, notInstalled } = errors;
  for (const name of REQUIRED_HELPERS) {
    if (typeof helpers[name] !== "function") throw new Error(`speech-engine: missing dependency ${name}`);
  }
  for (const [name, fn] of Object.entries({ badRequest, notFound, notInstalled })) {
    if (typeof fn !== "function") throw new Error(`speech-engine: missing dependency ${name}`);
  }
  const { describeLinkedModel, detectedKindFor, findAvailableSpeechPort, findExistingFile, formatBytes, getPathSize, isWaveBuffer, pathInside, readdirVisible, safeOutputName } = helpers;
  let PORT_SPEECH = preferredPort;

  // ── State ────────────────────────────────────────────────────────────────
  let speechReady = false;
  let speechError = null;
  let speechOperationQueue = Promise.resolve();
  let speechSettings = {
    model: null,
    language: "auto",
    threads: Math.max(1, Math.min(8, os.cpus().length || 4)),
    backendPreference: "auto",
    backendBinary: "",
    backendMode: "",
  };
  let speechTranscriptionState = {
    active: false,
    phase: "",
    progress: 0,
    model: "",
    filename: "",
  };

  // ── Original code ────────────────────────────────────────────────────────
  function getSpeechBackendCandidates() {
    if (osPlatform === "win32") {
      return [
        {
          key: "vulkan",
          label: "Vulkan GPU",
          mode: "whisper.cpp Vulkan GPU",
          cli: findExistingFile([SPEECH_BACKEND_PATHS.winVulkanCli, path.join(SPEECH_BACKEND_ROOT, "win", "vulkan", "main.exe")]),
          server: findExistingFile([SPEECH_BACKEND_PATHS.winVulkanServer, path.join(SPEECH_BACKEND_ROOT, "win", "vulkan", "server.exe")]),
          pathHint: path.join(SPEECH_BACKEND_ROOT, "win", "vulkan"),
        },
        {
          key: "cpu",
          label: "CPU",
          mode: "whisper.cpp CPU",
          cli: findExistingFile([SPEECH_BACKEND_PATHS.winCpuCli, SPEECH_BACKEND_PATHS.winCli, path.join(SPEECH_BACKEND_ROOT, "win", "cpu", "main.exe"), path.join(SPEECH_BACKEND_ROOT, "win", "main.exe")]),
          server: findExistingFile([SPEECH_BACKEND_PATHS.winCpuServer, SPEECH_BACKEND_PATHS.winServer, path.join(SPEECH_BACKEND_ROOT, "win", "cpu", "server.exe"), path.join(SPEECH_BACKEND_ROOT, "win", "server.exe")]),
          pathHint: path.join(SPEECH_BACKEND_ROOT, "win", "cpu"),
        },
      ];
    }
    if (osPlatform === "darwin") {
      return [
        {
          key: "metal",
          label: "Metal GPU",
          mode: "whisper.cpp Metal GPU",
          cli: findExistingFile([SPEECH_BACKEND_PATHS.macMetalCli, path.join(SPEECH_BACKEND_ROOT, "mac", "metal", "main")]),
          server: findExistingFile([SPEECH_BACKEND_PATHS.macMetalServer, path.join(SPEECH_BACKEND_ROOT, "mac", "metal", "server")]),
          pathHint: path.join(SPEECH_BACKEND_ROOT, "mac", "metal"),
        },
        {
          key: "cpu",
          label: "CPU",
          mode: "whisper.cpp CPU",
          cli: findExistingFile([SPEECH_BACKEND_PATHS.macCpuCli, SPEECH_BACKEND_PATHS.macCli, path.join(SPEECH_BACKEND_ROOT, "mac", "cpu", "main"), path.join(SPEECH_BACKEND_ROOT, "mac", "main")]),
          server: findExistingFile([SPEECH_BACKEND_PATHS.macCpuServer, SPEECH_BACKEND_PATHS.macServer, path.join(SPEECH_BACKEND_ROOT, "mac", "cpu", "server"), path.join(SPEECH_BACKEND_ROOT, "mac", "server")]),
          pathHint: path.join(SPEECH_BACKEND_ROOT, "mac", "cpu"),
        },
      ];
    }
    return [
      {
        key: "vulkan",
        label: "Vulkan GPU",
        mode: "whisper.cpp Vulkan GPU",
        cli: findExistingFile([SPEECH_BACKEND_PATHS.linuxVulkanCli, path.join(SPEECH_BACKEND_ROOT, "linux", "vulkan", "main")]),
        server: findExistingFile([SPEECH_BACKEND_PATHS.linuxVulkanServer, path.join(SPEECH_BACKEND_ROOT, "linux", "vulkan", "server")]),
        pathHint: path.join(SPEECH_BACKEND_ROOT, "linux", "vulkan"),
      },
      {
        key: "cpu",
        label: "CPU",
        mode: "whisper.cpp CPU",
        cli: findExistingFile([SPEECH_BACKEND_PATHS.linuxCpuCli, SPEECH_BACKEND_PATHS.linuxCli, path.join(SPEECH_BACKEND_ROOT, "linux", "cpu", "main"), path.join(SPEECH_BACKEND_ROOT, "linux", "main")]),
        server: findExistingFile([SPEECH_BACKEND_PATHS.linuxCpuServer, SPEECH_BACKEND_PATHS.linuxServer, path.join(SPEECH_BACKEND_ROOT, "linux", "cpu", "server"), path.join(SPEECH_BACKEND_ROOT, "linux", "server")]),
        pathHint: path.join(SPEECH_BACKEND_ROOT, "linux", "cpu"),
      },
    ];
  }

  function normalizeSpeechBackendPreference(value) {
    const raw = String(value || "auto").trim().toLowerCase();
    if (["auto", "cpu", "vulkan", "metal"].includes(raw)) return raw;
    return "auto";
  }

  function getSpeechBackend(preference = speechSettings.backendPreference) {
    const candidates = getSpeechBackendCandidates().map((candidate) => ({
      ...candidate,
      installed: Boolean(candidate.cli),
    }));
    const preferred = normalizeSpeechBackendPreference(preference);
    const selected = preferred === "auto"
      ? candidates.find((candidate) => candidate.installed) || candidates[candidates.length - 1]
      : candidates.find((candidate) => candidate.key === preferred) || candidates.find((candidate) => candidate.installed) || candidates[candidates.length - 1];
    return {
      ...(selected || { key: "cpu", label: "CPU", mode: "whisper.cpp CPU", cli: "", server: "" }),
      preference: preferred,
      candidates,
    };
  }

  function getSpeechModels() {
    const catalog = SPEECH_MODEL_CATALOG.map((model) => {
      const modelPath = path.join(SPEECH_MODELS, model.filename);
      const installed = fs.existsSync(modelPath);
      return {
        ...model,
        installed,
        sizeBytes: installed ? getPathSize(modelPath) : 0,
        localSize: installed ? formatBytes(getPathSize(modelPath)) : "",
        url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${model.filename}`,
      };
    });

    const known = new Set(catalog.map((model) => model.filename.toLowerCase()));
    let custom = [];
    try {
      custom = readdirVisible(SPEECH_MODELS)
        .filter((filename) => filename.toLowerCase().endsWith(".bin") && !known.has(filename.toLowerCase()))
        .map((filename) => {
          const fullPath = path.join(SPEECH_MODELS, filename);
          const link = describeLinkedModel(fullPath);
          const sizeBytes = link.missing ? 0 : getPathSize(fullPath);
          return {
            ...link,
            detectedKind: detectedKindFor(fullPath, link),
            id: filename,
            name: filename,
            filename,
            size: formatBytes(sizeBytes),
            localSize: formatBytes(sizeBytes),
            sizeBytes,
            language: "Custom",
            installed: true,
            recommended: false,
            custom: true,
          };
        });
    } catch (_) {}
    return [...catalog, ...custom];
  }

  function resolveSpeechModel(value) {
    const raw = String(value || "").trim();
    const model = getSpeechModels().find((item) => item.id === raw || item.filename === raw) ||
      getSpeechModels().find((item) => item.installed);
    if (!model) throw notFound("MODEL_NOT_FOUND", "Download or import a Whisper model first.");
    const modelPath = path.join(SPEECH_MODELS, path.basename(model.filename));
    if (!pathInside(modelPath, SPEECH_MODELS) || !fs.existsSync(modelPath)) {
      throw notFound("MODEL_NOT_FOUND", `Speech model is not installed: ${model.filename}`);
    }
    return { ...model, path: modelPath };
  }

  let pendingOperations = 0;
  function runExclusiveSpeechOperation(operation) {
    const run = speechOperationQueue.catch(() => {}).then(operation);
    speechOperationQueue = run.catch(() => {});
    // Step 9.9b: counted for GET /api/resources only (running + waiting); order and timing are unchanged.
    pendingOperations += 1;
    speechOperationQueue.then(() => { pendingOperations -= 1; });
    return run;
  }

  async function startSpeech(settings = {}) {
    const backendPreference = normalizeSpeechBackendPreference(settings.backendPreference || speechSettings.backendPreference);
    const backend = getSpeechBackend(backendPreference);
    if (!backend.cli) {
      throw notInstalled(`${backend.label || "Selected"} whisper.cpp backend is not installed. Run setup or copy a compatible binary to ${backend.pathHint || "app/speech-backend"}.`);
    }
    const model = resolveSpeechModel(settings.model);
    PORT_SPEECH = await findAvailableSpeechPort();
    speechError = null;
    speechReady = true;
    speechSettings = {
      ...speechSettings,
      model: model.filename,
      language: settings.language || speechSettings.language || "auto",
      threads: Math.max(1, Math.min(32, Number(settings.threads) || speechSettings.threads || 4)),
      backendPreference,
      backendBinary: path.basename(backend.cli),
      backendMode: backend.mode,
    };
  }

  async function stopSpeech() {
    speechReady = false;
    speechError = null;
    speechTranscriptionState = { active: false, phase: "", progress: 0, model: "", filename: "" };
  }

  function saveTranscript(result) {
    const createdAt = new Date().toISOString();
    const stamp = createdAt.replace(/[:.]/g, "-");
    const base = `transcript-${stamp}-${safeOutputName(result.sourceFilename || "audio")}`;
    const textFilename = `${base}.txt`;
    const jsonFilename = `${base}.json`;
    fs.writeFileSync(path.join(TRANSCRIPTIONS, textFilename), result.text || "", "utf8");
    const metadata = {
      ...result,
      createdAt,
      textFile: textFilename,
      metadata: jsonFilename,
    };
    fs.writeFileSync(path.join(TRANSCRIPTIONS, jsonFilename), JSON.stringify(metadata, null, 2), "utf8");
    return metadata;
  }

  function listTranscriptions() {
    try {
      return readdirVisible(TRANSCRIPTIONS)
        .filter((file) => file.toLowerCase().endsWith(".json"))
        .map((file) => {
          const filePath = path.join(TRANSCRIPTIONS, file);
          try {
            const metadata = JSON.parse(fs.readFileSync(filePath, "utf8"));
            const stat = fs.statSync(filePath);
            return {
              ...metadata,
              filename: file,
              displayName: metadata.sourceFilename || metadata.textFile || file,
              sizeBytes: stat.size,
              size: formatBytes(stat.size),
              modifiedAt: stat.mtime.toISOString(),
              createdAt: metadata.createdAt || stat.mtime.toISOString(),
              url: `/transcriptions/${encodeURIComponent(file)}`,
              textUrl: metadata.textFile ? `/transcriptions/${encodeURIComponent(metadata.textFile)}` : "",
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

  function transcribeWavBuffer(buffer, options = {}) {
    return new Promise((resolve, reject) => {
      if (!isWaveBuffer(buffer)) {
        reject(new Error("Speech transcription currently accepts WAV audio only."));
        return;
      }
      const backendPreference = normalizeSpeechBackendPreference(options.backendPreference || speechSettings.backendPreference);
      const backend = getSpeechBackend(backendPreference);
      if (!backend.cli) {
        reject(new Error(`${backend.label || "Selected"} whisper.cpp CLI backend is not installed.`));
        return;
      }
      const model = resolveSpeechModel(options.model || speechSettings.model);
      const language = String(options.language || speechSettings.language || "auto");
      const sourceFilename = safeOutputName(options.filename || "recording.wav") || "recording.wav";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const tempBase = path.join(TRANSCRIPTIONS, `.speech-${stamp}-${sourceFilename.replace(/\.[^.]+$/, "")}`);
      const wavPath = `${tempBase}.wav`;
      const outBase = `${tempBase}-out`;
      fs.writeFileSync(wavPath, buffer);

      speechTranscriptionState = {
        active: true,
        phase: "Transcribing audio...",
        progress: -1,
        model: model.filename,
        filename: sourceFilename,
      };

      const args = [
        "-m", model.path,
        "-f", wavPath,
        "-otxt",
        "-oj",
        "-of", outBase,
        "-t", String(jobThreads(Math.max(1, Math.min(32, Number(options.threads) || speechSettings.threads || 4)))),
      ];
      if (language && language !== "auto") {
        args.push("-l", language);
      } else {
        args.push("-l", "auto");
      }
      if (options.translate) {
        args.push("-tr");
      }

      const startedAt = Date.now();
      console.log("  [speech] Starting:", backend.cli, args.join(" "));
      const proc = supervisor.spawnSupervised(backend.cli, args, {
        stdio: "pipe",
        windowsHide: true,
        env: {
          ...process.env,
          ...(osPlatform === "win32" ? { PATH: path.dirname(backend.cli) + (process.env.PATH ? `;${process.env.PATH}` : "") } : {}),
          ...(osPlatform === "linux" ? { LD_LIBRARY_PATH: path.dirname(backend.cli) + (process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : "") } : {}),
          ...(osPlatform === "darwin" ? { DYLD_LIBRARY_PATH: path.dirname(backend.cli) + (process.env.DYLD_LIBRARY_PATH ? `:${process.env.DYLD_LIBRARY_PATH}` : "") } : {}),
        },
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (data) => {
        stdout += data.toString();
        process.stdout.write("  [speech] " + data.toString());
      });
      proc.stderr.on("data", (data) => {
        stderr += data.toString();
        process.stderr.write("  [speech-err] " + data.toString());
      });
      // #68: a launch failure (EACCES and the like) is an "error" event, not an exit; without a listener it
      // stopped the whole server. Now the transcription fails with a clear message.
      proc.on("error", (err) => {
        if (!isLaunchFailure(proc)) { console.warn("  [speech] engine process error:", err.message); return; }
        console.error("  [speech] Could not start", backend.cli, "-", err.code || "", err.message);
        try { fs.unlinkSync(wavPath); } catch (_) {}
        speechTranscriptionState = { active: false, phase: "Failed", progress: 0, model: model.filename, filename: sourceFilename };
        speechError = describeSpawnError(err, "speech engine (whisper.cpp)");
        reject(new Error(speechError));
      });
      proc.on("exit", (code) => {
        try { fs.unlinkSync(wavPath); } catch (_) {}
        speechTranscriptionState = { active: false, phase: code === 0 ? "Complete" : "Failed", progress: code === 0 ? 100 : 0, model: model.filename, filename: sourceFilename };
        if (code !== 0) {
          const message = (stderr || stdout || `whisper.cpp exited with code ${code}`).trim().slice(-1200);
          speechError = message;
          reject(new Error(message));
          return;
        }
        const txtPath = `${outBase}.txt`;
        const jsonPath = `${outBase}.json`;
        const text = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, "utf8").trim() : stdout.trim();
        let raw = null;
        try {
          raw = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, "utf8")) : null;
        } catch (_) {}
        try { fs.unlinkSync(txtPath); } catch (_) {}
        try { fs.unlinkSync(jsonPath); } catch (_) {}
        // Dictation (the Voice screen's mic) only wants the text, not a saved transcript
        if (options.save === false) {
          speechError = null;
          resolve({ text, model: model.filename, language, durationMs: Date.now() - startedAt });
          return;
        }
        const saved = saveTranscript({
          text,
          model: model.filename,
          modelName: model.name,
          language,
          backend: backend.key,
          backendMode: backend.mode,
          sourceFilename,
          durationMs: Date.now() - startedAt,
          raw,
        });
        speechError = null;
        resolve(saved);
      });
    });
  }

  return {
    // state (read-only views; routes report these exactly as before)
    isReady: () => speechReady,
    getError: () => speechError,
    setError: (message) => { speechError = message; },
    getSettings: () => speechSettings,
    getTranscriptionState: () => speechTranscriptionState,
    getPort: () => PORT_SPEECH,
    preferredPort,
    catalog: SPEECH_MODEL_CATALOG,
    // operations
    getSpeechBackendCandidates, normalizeSpeechBackendPreference, getSpeechBackend, getSpeechModels, resolveSpeechModel,
    getPendingOperations: () => pendingOperations,
    runExclusiveSpeechOperation, startSpeech, stopSpeech, saveTranscript, listTranscriptions, transcribeWavBuffer,
  };
}

module.exports = { createSpeechService };
