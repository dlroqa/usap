// services/tts-engine.cjs — Kokoro text-to-speech service (Step 9.8b).
//
// Moved unchanged from serve.cjs: the model catalog and voices, engine state, model manifests,
// starting/stopping, synthesis through the Kokoro worker (started via the engine supervisor, which
// passes the job on stdin), and saved outputs. The code below the state section is the original
// code; only its free variables now come from `deps`. No HTTP here (see routes/tts.cjs).
"use strict";

const TTS_MODEL_CATALOG = [
  {
    id: "kokoro-onnx-q8",
    name: "Kokoro 82M ONNX Q8",
    filename: "kokoro-onnx-q8.json",
    modelId: "onnx-community/Kokoro-82M-v1.0-ONNX",
    dtype: "q8",
    size: "Model cache managed by kokoro-js",
    format: "Kokoro ONNX",
    recommended: true,
  },
  {
    id: "kokoro-onnx-fp32",
    name: "Kokoro 82M ONNX FP32",
    filename: "kokoro-onnx-fp32.json",
    modelId: "onnx-community/Kokoro-82M-v1.0-ONNX",
    dtype: "fp32",
    size: "Model cache managed by kokoro-js",
    format: "Kokoro ONNX",
    recommended: false,
  },
];

const TTS_VOICES = [
  { id: "af_heart", name: "Heart", language: "en-us", gender: "Female", recommended: true },
  { id: "af_bella", name: "Bella", language: "en-us", gender: "Female", recommended: false },
  { id: "af_nicole", name: "Nicole", language: "en-us", gender: "Female", recommended: false },
  { id: "af_sarah", name: "Sarah", language: "en-us", gender: "Female", recommended: false },
  { id: "am_michael", name: "Michael", language: "en-us", gender: "Male", recommended: false },
  { id: "am_fenrir", name: "Fenrir", language: "en-us", gender: "Male", recommended: false },
  { id: "bf_emma", name: "Emma", language: "en-gb", gender: "Female", recommended: false },
  { id: "bm_george", name: "George", language: "en-gb", gender: "Male", recommended: false },
];

/**
 * @param {object} deps
 * @param {{ROOT: string, TTS_MODELS: string, TTS_OUTPUTS: string, TTS_CACHE: string, TTS_RUNTIME: string, TTS_WORKER: string}} deps.paths
 * @param {number} deps.preferredPort
 * @param {object} deps.fs
 * @param {object} deps.path
 * @param {{spawnSupervised: Function}} deps.supervisor
 * @param {{badRequest: Function, notFound: Function, notInstalled: Function}} deps.errors
 * @param {{formatBytes: Function, getPathSize: Function, isWaveBuffer: Function, pathInside: Function, readdirVisible: Function, safeOutputName: Function}} deps.helpers
 */
function createTtsService(deps) {
  const { paths, preferredPort, fs, path, supervisor, errors, helpers } = deps;
  const { ROOT, TTS_MODELS, TTS_OUTPUTS, TTS_CACHE, TTS_RUNTIME, TTS_WORKER } = paths;
  const PREFERRED_TTS_PORT = preferredPort;
  const { badRequest, notFound, notInstalled } = errors;
  const { formatBytes, getPathSize, isWaveBuffer, pathInside, readdirVisible, safeOutputName } = helpers;
  for (const [name, fn] of Object.entries({ formatBytes, getPathSize, isWaveBuffer, pathInside, readdirVisible, safeOutputName, badRequest, notFound, notInstalled })) {
    if (typeof fn !== "function") throw new Error(`tts-engine: missing dependency ${name}`);
  }
  let PORT_TTS = PREFERRED_TTS_PORT;

  // ── State ────────────────────────────────────────────────────────────────
  let ttsReady = false;
  let ttsError = null;
  let ttsOperationQueue = Promise.resolve();
  let ttsSettings = {
    model: null,
    voice: "af_heart",
    speed: 1,
    dtype: "q8",
    backendMode: "Kokoro ONNX",
  };
  let ttsGenerationState = {
    active: false,
    phase: "",
    progress: 0,
    model: "",
    voice: "",
    output: "",
  };

  // ── Original code ────────────────────────────────────────────────────────
  function getTtsManifestPath(filename) {
    const manifestPath = path.join(TTS_MODELS, path.basename(String(filename || "")));
    return pathInside(manifestPath, TTS_MODELS) ? manifestPath : "";
  }

  function readTtsManifest(filename) {
    const manifestPath = getTtsManifestPath(filename);
    if (!manifestPath || !fs.existsSync(manifestPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (_) {
      return null;
    }
  }

  function installTtsCatalogModel(modelIdOrFilename) {
    const raw = String(modelIdOrFilename || "").trim();
    const catalogModel = TTS_MODEL_CATALOG.find((model) => model.id === raw || model.filename === raw) || TTS_MODEL_CATALOG[0];
    if (!catalogModel) throw new Error("Unknown TTS model.");
    const manifestPath = getTtsManifestPath(catalogModel.filename);
    const manifest = {
      ...catalogModel,
      installed: true,
      createdAt: new Date().toISOString(),
      notes: "Kokoro model files are cached under app/tts-cache by kokoro-js on first generation.",
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    return manifest;
  }

  function getTtsModels() {
    const catalog = TTS_MODEL_CATALOG.map((model) => {
      const manifest = readTtsManifest(model.filename);
      const installed = Boolean(manifest);
      const manifestPath = getTtsManifestPath(model.filename);
      const sizeBytes = installed ? getPathSize(manifestPath) : 0;
      return {
        ...model,
        ...(manifest || {}),
        installed,
        sizeBytes,
        localSize: installed ? formatBytes(sizeBytes) : "",
        url: `kokoro://install/${model.id}`,
      };
    });

    const known = new Set(catalog.map((model) => model.filename.toLowerCase()));
    let custom = [];
    try {
      custom = readdirVisible(TTS_MODELS)
        .filter((filename) => filename.toLowerCase().endsWith(".json") && !known.has(filename.toLowerCase()))
        .map((filename) => {
          const manifest = readTtsManifest(filename) || {};
          const sizeBytes = getPathSize(path.join(TTS_MODELS, filename));
          return {
            id: manifest.id || filename,
            name: manifest.name || filename,
            filename,
            modelId: manifest.modelId || "onnx-community/Kokoro-82M-v1.0-ONNX",
            dtype: manifest.dtype || "q8",
            format: manifest.format || "Kokoro ONNX",
            size: formatBytes(sizeBytes),
            localSize: formatBytes(sizeBytes),
            sizeBytes,
            installed: true,
            recommended: false,
            custom: true,
          };
        });
    } catch (_) {}
    return [...catalog, ...custom];
  }

  function resolveTtsModel(value) {
    const raw = String(value || "").trim();
    const model = getTtsModels().find((item) => item.id === raw || item.filename === raw) ||
      getTtsModels().find((item) => item.installed);
    if (!model) throw notFound("MODEL_NOT_FOUND", "Download or import a Kokoro TTS model from Model Manager first.");
    const manifestPath = getTtsManifestPath(model.filename);
    if (!manifestPath || !fs.existsSync(manifestPath)) {
      throw notFound("MODEL_NOT_FOUND", `TTS model is not installed: ${model.filename}`);
    }
    return { ...model, path: manifestPath };
  }

  function getTtsRuntimeStatus() {
    const nodeModules = path.join(TTS_RUNTIME, "node_modules");
    const installed = fs.existsSync(path.join(nodeModules, "kokoro-js"));
    return {
      installed: installed && fs.existsSync(TTS_WORKER),
      worker: TTS_WORKER,
      runtime: TTS_RUNTIME,
      cache: TTS_CACHE,
      backendMode: "Kokoro ONNX",
    };
  }

  function runExclusiveTtsOperation(operation) {
    const run = ttsOperationQueue.catch(() => {}).then(operation);
    ttsOperationQueue = run.catch(() => {});
    return run;
  }

  async function startTts(settings = {}) {
    const runtime = getTtsRuntimeStatus();
    if (!runtime.installed) {
      throw notInstalled("Kokoro TTS runtime is not installed. Run scripts/setup/setup-tts for this platform.");
    }
    const model = resolveTtsModel(settings.model || ttsSettings.model);
    PORT_TTS = PREFERRED_TTS_PORT;
    ttsError = null;
    ttsReady = true;
    ttsSettings = {
      ...ttsSettings,
      model: model.filename,
      voice: settings.voice || ttsSettings.voice || "af_heart",
      speed: Math.max(0.5, Math.min(2, Number(settings.speed) || ttsSettings.speed || 1)),
      dtype: model.dtype || settings.dtype || ttsSettings.dtype || "q8",
      backendMode: runtime.backendMode,
    };
  }

  async function stopTts() {
    ttsReady = false;
    ttsError = null;
    ttsGenerationState = { active: false, phase: "", progress: 0, model: "", voice: "", output: "" };
  }

  function convertFloatWavToPcm16(buffer) {
    if (!isWaveBuffer(buffer)) return buffer;

    let offset = 12;
    let fmt = null;
    let data = null;

    while (offset + 8 <= buffer.length) {
      const id = buffer.toString("ascii", offset, offset + 4);
      const size = buffer.readUInt32LE(offset + 4);
      const start = offset + 8;
      const end = start + size;
      if (end > buffer.length) break;

      if (id === "fmt ") {
        fmt = {
          audioFormat: buffer.readUInt16LE(start),
          channels: buffer.readUInt16LE(start + 2),
          sampleRate: buffer.readUInt32LE(start + 4),
          bitsPerSample: buffer.readUInt16LE(start + 14),
        };
      } else if (id === "data") {
        data = { start, size };
      }

      offset = end + (size % 2);
    }

    if (!fmt || !data || fmt.audioFormat !== 3 || fmt.bitsPerSample !== 32 || fmt.channels < 1) {
      return buffer;
    }

    const samples = Math.floor(data.size / 4);
    const pcmDataSize = samples * 2;
    const output = Buffer.alloc(44 + pcmDataSize);
    output.write("RIFF", 0, "ascii");
    output.writeUInt32LE(36 + pcmDataSize, 4);
    output.write("WAVE", 8, "ascii");
    output.write("fmt ", 12, "ascii");
    output.writeUInt32LE(16, 16);
    output.writeUInt16LE(1, 20);
    output.writeUInt16LE(fmt.channels, 22);
    output.writeUInt32LE(fmt.sampleRate, 24);
    output.writeUInt32LE(fmt.sampleRate * fmt.channels * 2, 28);
    output.writeUInt16LE(fmt.channels * 2, 32);
    output.writeUInt16LE(16, 34);
    output.write("data", 36, "ascii");
    output.writeUInt32LE(pcmDataSize, 40);

    for (let i = 0; i < samples; i += 1) {
      const floatValue = buffer.readFloatLE(data.start + i * 4);
      const clamped = Math.max(-1, Math.min(1, Number.isFinite(floatValue) ? floatValue : 0));
      const intValue = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
      output.writeInt16LE(intValue, 44 + i * 2);
    }

    return output;
  }

  function ensureBrowserCompatibleTtsWav(filePath) {
    try {
      const original = fs.readFileSync(filePath);
      const converted = convertFloatWavToPcm16(original);
      if (converted !== original) {
        fs.writeFileSync(filePath, converted);
      }
    } catch (_) {}
  }

  function saveTtsOutput(result) {
    const createdAt = new Date().toISOString();
    const stamp = createdAt.replace(/[:.]/g, "-");
    const base = `tts-${stamp}-${safeOutputName(result.voice || "voice")}`;
    const wavFilename = `${base}.wav`;
    const jsonFilename = `${base}.json`;
    const wavPath = path.join(TTS_OUTPUTS, wavFilename);
    const wavBuffer = convertFloatWavToPcm16(fs.readFileSync(result.wavPath));
    fs.writeFileSync(wavPath, wavBuffer);
    const metadata = {
      text: result.text || "",
      model: result.model,
      modelName: result.modelName,
      voice: result.voice,
      voiceName: result.voiceName,
      speed: result.speed,
      durationMs: result.durationMs,
      sampleRate: result.sampleRate || 24000,
      createdAt,
      audioFile: wavFilename,
      metadata: jsonFilename,
      displayName: result.displayName || `${result.voiceName || result.voice} - ${createdAt}`,
      // Where each sentence starts and ends in the audio, for word highlighting during playback
      ...(Array.isArray(result.segments) && result.segments.length ? { segments: result.segments } : {}),
    };
    fs.writeFileSync(path.join(TTS_OUTPUTS, jsonFilename), JSON.stringify(metadata, null, 2), "utf8");
    return {
      ...metadata,
      filename: jsonFilename,
      url: `/tts-outputs/${encodeURIComponent(wavFilename)}`,
    };
  }

  function listTtsOutputs() {
    try {
      return readdirVisible(TTS_OUTPUTS)
        .filter((file) => file.toLowerCase().endsWith(".json"))
        .map((file) => {
          const filePath = path.join(TTS_OUTPUTS, file);
          try {
            const metadata = JSON.parse(fs.readFileSync(filePath, "utf8"));
            const stat = fs.statSync(filePath);
            if (metadata.audioFile) {
              const audioPath = path.join(TTS_OUTPUTS, path.basename(String(metadata.audioFile)));
              if (pathInside(audioPath, TTS_OUTPUTS) && fs.existsSync(audioPath)) {
                ensureBrowserCompatibleTtsWav(audioPath);
              }
            }
            return {
              ...metadata,
              filename: file,
              displayName: metadata.displayName || metadata.text?.slice(0, 48) || metadata.audioFile || file,
              sizeBytes: stat.size,
              size: formatBytes(stat.size),
              modifiedAt: stat.mtime.toISOString(),
              createdAt: metadata.createdAt || stat.mtime.toISOString(),
              url: metadata.audioFile ? `/tts-outputs/${encodeURIComponent(metadata.audioFile)}` : "",
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

  function synthesizeTts(text, options = {}) {
    return new Promise((resolve, reject) => {
      const cleanedText = String(text || "").trim();
      if (!cleanedText) {
        reject(badRequest("INVALID_REQUEST", "Enter text to synthesize."));
        return;
      }
      if (cleanedText.length > 5000) {
        reject(badRequest("TEXT_TOO_LONG", "TTS text is too long. Limit is 5000 characters for V1."));
        return;
      }
      const runtime = getTtsRuntimeStatus();
      if (!runtime.installed) {
        reject(notInstalled("Kokoro TTS runtime is not installed."));
        return;
      }
      const model = resolveTtsModel(options.model || ttsSettings.model);
      const voice = String(options.voice || ttsSettings.voice || "af_heart");
      const voiceInfo = TTS_VOICES.find((item) => item.id === voice) || { id: voice, name: voice };
      const speed = Math.max(0.5, Math.min(2, Number(options.speed) || ttsSettings.speed || 1));
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const tempWav = path.join(TTS_OUTPUTS, `.tts-${stamp}.wav`);
      const payload = {
        text: cleanedText,
        modelId: model.modelId || "onnx-community/Kokoro-82M-v1.0-ONNX",
        dtype: model.dtype || "q8",
        voice,
        speed,
        output: tempWav,
        cacheDir: TTS_CACHE,
      };

      const startedAt = Date.now();
      ttsGenerationState = {
        active: true,
        phase: "Loading voice model",
        progress: -1,
        done: 0,
        total: 0,
        startedAt,
        model: model.filename,
        voice,
        output: "",
      };
      const proc = supervisor.spawnSupervised(process.execPath, [TTS_WORKER], {
        cwd: ROOT,
        stdio: "pipe",
        windowsHide: true,
        env: {
          ...process.env,
          NODE_PATH: path.join(TTS_RUNTIME, "node_modules"),
          TTS_RUNTIME,
        },
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (data) => { stdout += data.toString(); });
      // The worker reports "@@progress {...}" lines on stderr; everything else is ordinary log output
      let stderrLine = "";
      proc.stderr.on("data", (data) => {
        stderrLine += data.toString();
        const lines = stderrLine.split("\n");
        stderrLine = lines.pop();
        for (const line of lines) {
          if (line.startsWith("@@progress ")) {
            try {
              const update = JSON.parse(line.slice("@@progress ".length));
              const total = Number(update.total) || 0;
              const done = Number(update.done) || 0;
              ttsGenerationState = {
                ...ttsGenerationState,
                phase: update.phase === "loading" ? "Loading voice model" : update.phase === "saving" ? "Saving" : "Generating speech",
                progress: update.phase === "loading" || total === 0 ? -1 : Math.min(99, Math.round((done / total) * 100)),
                done,
                total,
              };
            } catch (_) {}
            continue;
          }
          stderr += line + "\n";
          process.stderr.write("  [tts] " + line + "\n");
        }
      });
      proc.on("error", (err) => {
        ttsGenerationState = { active: false, phase: "Failed", progress: 0, model: model.filename, voice, output: "" };
        reject(err);
      });
      proc.on("exit", (code) => {
        // An error stack usually arrives without a trailing newline
        if (stderrLine) stderr += stderrLine;
        ttsGenerationState = { active: false, phase: code === 0 ? "Complete" : "Failed", progress: code === 0 ? 100 : 0, model: model.filename, voice, output: "" };
        if (code !== 0) {
          try { fs.unlinkSync(tempWav); } catch (_) {}
          const message = (stderr || stdout || `Kokoro TTS exited with code ${code}`).trim().slice(-1400);
          ttsError = message;
          reject(new Error(message));
          return;
        }
        try {
          const workerResult = JSON.parse(stdout.trim() || "{}");
          if (!workerResult.ok || !fs.existsSync(tempWav)) {
            throw new Error(workerResult.error || "Kokoro TTS did not produce a WAV file.");
          }
          const saved = saveTtsOutput({
            text: cleanedText,
            model: model.filename,
            modelName: model.name,
            voice,
            voiceName: voiceInfo.name,
            speed,
            // Length of the audio itself; older workers only let us time the generation
            durationMs: workerResult.durationMs || Date.now() - startedAt,
            sampleRate: workerResult.sampleRate || 24000,
            wavPath: tempWav,
            segments: workerResult.segments,
            displayName: `${voiceInfo.name || voice} - ${cleanedText.slice(0, 40)}`,
          });
          try { fs.unlinkSync(tempWav); } catch (_) {}
          ttsError = null;
          resolve(saved);
        } catch (err) {
          try { fs.unlinkSync(tempWav); } catch (_) {}
          ttsError = err.message || String(err);
          reject(err);
        }
      });
      proc.stdin.end(JSON.stringify(payload));
    });
  }

  return {
    // state (read-only views; routes report these exactly as before)
    isReady: () => ttsReady,
    getError: () => ttsError,
    setError: (message) => { ttsError = message; },
    getSettings: () => ttsSettings,
    getGenerationState: () => ttsGenerationState,
    getPort: () => PORT_TTS,
    preferredPort: PREFERRED_TTS_PORT,
    voices: TTS_VOICES,
    catalog: TTS_MODEL_CATALOG,
    // operations
    getTtsModels, resolveTtsModel, getTtsRuntimeStatus, installTtsCatalogModel, readTtsManifest,
    runExclusiveTtsOperation, startTts, stopTts, synthesizeTts, saveTtsOutput, listTtsOutputs,
    convertFloatWavToPcm16, ensureBrowserCompatibleTtsWav,
  };
}

module.exports = { createTtsService };
