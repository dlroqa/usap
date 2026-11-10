// routes/speech.cjs — speech-recognition HTTP routes (Step 9.8c). Moved unchanged from serve.cjs;
// state and operations come from services/speech-engine.cjs. Reached only through the request
// pipeline (Host, Origin, sign-in, error boundary).
//
//   GET  /api/speech/status, /api/speech/models, /api/speech/transcriptions
//   POST /api/speech/start, /api/speech/stop, /api/speech/download-model, /api/speech/delete-model,
//        /api/speech/delete-transcription
//   POST /api/speech/transcribe (prefix; raw WAV body), /api/speech/import-model (prefix; upload)
"use strict";

const REQUIRED = ["speech", "SPEECH_MODELS", "TRANSCRIPTIONS", "downloadBlockReason", "getDownloadState", "errorBody", "errorStatus", "fs", "json", "jsonErrorStatus", "path", "pathInside", "readBinaryBody", "readJsonBody", "startModelDownload", "streamModelUpload"];

function speechRoutes(deps) {
  for (const name of REQUIRED) {
    if (deps[name] === undefined || deps[name] === null) throw new Error(`routes/speech: missing dependency ${name}`);
  }
  const { speech, SPEECH_MODELS, TRANSCRIPTIONS, downloadBlockReason, getDownloadState, errorBody, errorStatus, fs, json, jsonErrorStatus, path, pathInside, readBinaryBody, readJsonBody, startModelDownload, streamModelUpload } = deps;
  return (r) => {
    r.get("/api/speech/status", async (req, res) => {
    const backend = speech.getSpeechBackend();
    return json(res, 200, {
      ok: true,
      ready: speech.isReady(),
      running: speech.isReady(),
      port: speech.getPort(),
      preferredPort: speech.preferredPort,
      backendInstalled: Boolean(backend.cli),
      backendPath: backend.cli || "",
      serverPath: backend.server || "",
      backendMode: backend.mode,
      backendPreference: backend.preference,
      backends: backend.candidates,
      error: speech.getError(),
      settings: speech.getSettings(),
      transcription: speech.getTranscriptionState(),
    });
    });

    r.get("/api/speech/models", async (req, res) => {
    return json(res, 200, { ok: true, models: speech.getSpeechModels() });
    });

    r.post("/api/speech/start", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      await speech.runExclusiveSpeechOperation(() => speech.startSpeech(body));
      return json(res, 200, { ok: true, ready: speech.isReady(), settings: speech.getSettings(), port: speech.getPort() });
    } catch (err) {
      speech.setError(err.message || String(err));
      return json(res, jsonErrorStatus(err), errorBody(err, { error: speech.getError(), code: err.code || "", activeRuntime: err.activeRuntime || null }));
    }
    });

    r.post("/api/speech/stop", async (req, res) => {
    await speech.stopSpeech();
    return json(res, 200, { ok: true });
    });

    r.postPrefix("/api/speech/transcribe", async (req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    try {
      const audio = await readBinaryBody(req);
      const result = await speech.runExclusiveSpeechOperation(() => speech.transcribeWavBuffer(audio, {
        model: parsed.searchParams.get("model") || speech.getSettings().model,
        language: parsed.searchParams.get("language") || "auto",
        filename: parsed.searchParams.get("filename") || req.headers["x-filename"] || "recording.wav",
        threads: parsed.searchParams.get("threads") || speech.getSettings().threads,
        backendPreference: parsed.searchParams.get("backendPreference") || speech.getSettings().backendPreference,
        translate: parsed.searchParams.get("translate") === "true",
        save: parsed.searchParams.get("save") !== "false",
      }));
      return json(res, 200, { ok: true, transcription: result });
    } catch (err) {
      speech.setError(err.message || String(err));
      return json(res, err.message?.includes("too large") ? 413 : 500, { ok: false, error: speech.getError() });
    }
    });

    r.post("/api/speech/download-model", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    if (getDownloadState().active) return json(res, 409, { ok: false, error: "Another model download is already active." });
    const modelId = String(body.modelId || body.model_id || body.model || "");
    const catalogModel = speech.catalog.find((model) => model.id === modelId || model.filename === modelId);
    const url = body.url ? String(body.url) : (catalogModel ? `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${catalogModel.filename}` : "");
    const filename = path.basename(String(body.filename || catalogModel?.filename || ""));
    if (!url || !filename || !filename.toLowerCase().endsWith(".bin")) {
      return json(res, 400, { ok: false, error: "A speech model .bin URL or catalog model id is required." });
    }
    const blocked = downloadBlockReason(url);
    if (blocked) return json(res, 400, { ok: false, error: blocked });
    startModelDownload(url, filename, SPEECH_MODELS, "speech");
    return json(res, 200, { ok: true, message: "Speech model download started", filename });
    });

    r.postPrefix("/api/speech/import-model", async (req, res) => {
    try {
      const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const result = await streamModelUpload(req, parsed.searchParams.get("filename"), SPEECH_MODELS, "speech");
      return json(res, 200, { ok: true, message: `Imported ${result.filename}`, model: result });
    } catch (err) {
      console.error("  [api] Failed to import speech model:", err);
      return json(res, errorStatus(err), errorBody(err));
    }
    });

    r.post("/api/speech/delete-model", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const filename = path.basename(String(body.filename || ""));
    const modelPath = path.join(SPEECH_MODELS, filename);
    if (!filename || !pathInside(modelPath, SPEECH_MODELS)) {
      return json(res, 400, { ok: false, error: "Invalid filename" });
    }
    if (speech.getSettings().model === filename) await speech.stopSpeech();
    try {
      fs.unlinkSync(modelPath);
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, err.code === "ENOENT" ? 404 : 500, { ok: false, error: err.code === "ENOENT" ? "Speech model not found" : err.message });
    }
    });

    r.get("/api/speech/transcriptions", async (req, res) => {
    return json(res, 200, { ok: true, transcriptions: speech.listTranscriptions() });
    });

    r.post("/api/speech/delete-transcription", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const filename = path.basename(String(body.filename || ""));
    if (!filename || !filename.endsWith(".json")) {
      return json(res, 400, { ok: false, error: "Invalid filename" });
    }
    const jsonPath = path.join(TRANSCRIPTIONS, filename);
    if (!pathInside(jsonPath, TRANSCRIPTIONS)) {
      return json(res, 400, { ok: false, error: "Invalid path" });
    }
    try {
      if (!fs.existsSync(jsonPath)) {
        return json(res, 404, { ok: false, error: "Transcription metadata not found" });
      }
      
      const metadata = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      const textFile = metadata.textFile ? path.basename(String(metadata.textFile)) : "";
      
      fs.unlinkSync(jsonPath);
      
      if (textFile) {
        const textPath = path.join(TRANSCRIPTIONS, textFile);
        if (pathInside(textPath, TRANSCRIPTIONS) && fs.existsSync(textPath)) {
          fs.unlinkSync(textPath);
        }
      }
      
      return json(res, 200, { ok: true });
    } catch (err) {
      console.error("  [api] Failed to delete transcription:", err);
      return json(res, errorStatus(err), errorBody(err));
    }
    });
  };
}

module.exports = { speechRoutes };
