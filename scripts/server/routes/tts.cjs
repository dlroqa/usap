// routes/tts.cjs — text-to-speech HTTP routes (Step 9.8b). Moved unchanged from serve.cjs; state
// and operations come from services/tts-engine.cjs. Reached only through the request pipeline.
//
//   GET  /api/tts/status, /api/tts/models, /api/tts/outputs
//   POST /api/tts/start, /api/tts/stop, /api/tts/speak, /api/tts/download-model,
//        /api/tts/import-model (prefix), /api/tts/delete-model, /api/tts/delete-output
//   GET  /tts-outputs/<file> (prefix; audio with range requests)
"use strict";
const { publicPaths } = require("../public-paths.cjs"); // issue #52: no absolute host paths in status

const REQUIRED = ["tts", "json", "readJsonBody", "jsonErrorStatus", "errorStatus", "errorBody", "streamModelUpload", "pathInside", "fs", "path", "MIME", "TTS_MODELS", "TTS_OUTPUTS"];

function ttsRoutes(deps) {
  for (const name of REQUIRED) {
    if (deps[name] === undefined || deps[name] === null) throw new Error(`routes/tts: missing dependency ${name}`);
  }
  const { tts, json, readJsonBody, jsonErrorStatus, errorStatus, errorBody, streamModelUpload, pathInside, fs, path, MIME, TTS_MODELS, TTS_OUTPUTS } = deps;
  return (r) => {
    r.get("/api/tts/status", async (req, res) => {
    const runtime = tts.getTtsRuntimeStatus();
    return json(res, 200, publicPaths({
      ok: true,
      ready: tts.isReady(),
      running: tts.isReady(),
      port: tts.getPort(),
      preferredPort: tts.preferredPort,
      runtimeInstalled: runtime.installed,
      runtimePath: runtime.runtime,
      workerPath: runtime.worker,
      cachePath: runtime.cache,
      backendMode: runtime.backendMode,
      error: tts.getError(),
      settings: tts.getSettings(),
      generation: tts.getGenerationState(),
      voices: tts.voices,
    }));
    });

    r.get("/api/tts/models", async (req, res) => {
    return json(res, 200, { ok: true, models: tts.getTtsModels(), voices: tts.voices });
    });

    r.post("/api/tts/start", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      await tts.runExclusiveTtsOperation(() => tts.startTts(body));
      return json(res, 200, { ok: true, ready: tts.isReady(), settings: tts.getSettings(), port: tts.getPort() });
    } catch (err) {
      tts.setError(err.message || String(err));
      return json(res, jsonErrorStatus(err), errorBody(err, { error: tts.getError(), code: err.code || "", activeRuntime: err.activeRuntime || null }));
    }
    });

    r.post("/api/tts/stop", async (req, res) => {
    await tts.stopTts();
    return json(res, 200, { ok: true });
    });

    r.post("/api/tts/speak", async (req, res) => {
    const body = await readJsonBody(req, res, 512 * 1024);
    if (!body) return;
    try {
      if (!tts.isReady() || (body.model && tts.getSettings().model !== body.model)) {
        await tts.runExclusiveTtsOperation(() => tts.startTts(body));
      }
      const output = await tts.runExclusiveTtsOperation(() => tts.synthesizeTts(body.text, body));
      return json(res, 200, { ok: true, output });
    } catch (err) {
      tts.setError(err.message || String(err));
      return json(res, jsonErrorStatus(err), errorBody(err, { error: tts.getError(), code: err.code || "", activeRuntime: err.activeRuntime || null }));
    }
    });

    r.post("/api/tts/download-model", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      const model = tts.installTtsCatalogModel(body.modelId || body.model_id || body.model || body.filename);
      return json(res, 200, { ok: true, message: "TTS model manifest installed", filename: model.filename, model });
    } catch (err) {
      return json(res, errorStatus(err), errorBody(err));
    }
    });

    r.postPrefix("/api/tts/import-model", async (req, res) => {
    try {
      const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const result = await streamModelUpload(req, parsed.searchParams.get("filename"), TTS_MODELS, "tts");
      return json(res, 200, { ok: true, message: `Imported ${result.filename}`, model: result });
    } catch (err) {
      console.error("  [api] Failed to import TTS model:", err);
      return json(res, errorStatus(err), errorBody(err));
    }
    });

    r.post("/api/tts/delete-model", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const filename = path.basename(String(body.filename || ""));
    const modelPath = path.join(TTS_MODELS, filename);
    if (!filename || !filename.endsWith(".json") || !pathInside(modelPath, TTS_MODELS)) {
      return json(res, 400, { ok: false, error: "Invalid filename" });
    }
    if (tts.getSettings().model === filename) await tts.stopTts();
    try {
      fs.unlinkSync(modelPath);
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, err.code === "ENOENT" ? 404 : 500, { ok: false, error: err.code === "ENOENT" ? "TTS model not found" : err.message });
    }
    });

    r.get("/api/tts/outputs", async (req, res) => {
    return json(res, 200, { ok: true, outputs: tts.listTtsOutputs() });
    });

    r.post("/api/tts/delete-output", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const filename = path.basename(String(body.filename || ""));
    if (!filename || !filename.endsWith(".json")) {
      return json(res, 400, { ok: false, error: "Invalid filename" });
    }
    const jsonPath = path.join(TTS_OUTPUTS, filename);
    if (!pathInside(jsonPath, TTS_OUTPUTS)) {
      return json(res, 400, { ok: false, error: "Invalid path" });
    }
    try {
      if (!fs.existsSync(jsonPath)) {
        return json(res, 404, { ok: false, error: "TTS output metadata not found" });
      }
      const metadata = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      const audioFile = metadata.audioFile ? path.basename(String(metadata.audioFile)) : "";
      fs.unlinkSync(jsonPath);
      if (audioFile) {
        const audioPath = path.join(TTS_OUTPUTS, audioFile);
        if (pathInside(audioPath, TTS_OUTPUTS) && fs.existsSync(audioPath)) {
          fs.unlinkSync(audioPath);
        }
      }
      return json(res, 200, { ok: true });
    } catch (err) {
      console.error("  [api] Failed to delete TTS output:", err);
      return json(res, errorStatus(err), errorBody(err));
    }
    });

    r.getPrefix("/tts-outputs/", async (req, res) => {
    const filename = path.basename(decodeURIComponent(req.url.replace(/^\/tts-outputs\//, "").split("?")[0] || ""));
    const filePath = path.join(TTS_OUTPUTS, filename);
    if (!filename || !pathInside(filePath, TTS_OUTPUTS) || !fs.existsSync(filePath)) {
      return json(res, 404, { ok: false, error: "TTS output not found" });
    }
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".wav") tts.ensureBrowserCompatibleTtsWav(filePath);
    const stat = fs.statSync(filePath);
    const contentType = MIME[ext] || "application/octet-stream";
    const range = req.headers.range;

    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) {
        res.writeHead(416, {
          "Content-Range": `bytes */${stat.size}`,
          "Accept-Ranges": "bytes",
        });
        res.end();
        return;
      }

      let start = match[1] ? Number(match[1]) : 0;
      let end = match[2] ? Number(match[2]) : stat.size - 1;
      if (!match[1] && match[2]) {
        const suffixLength = Math.min(Number(match[2]) || 0, stat.size);
        start = stat.size - suffixLength;
        end = stat.size - 1;
      }

      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end >= stat.size || start > end) {
        res.writeHead(416, {
          "Content-Range": `bytes */${stat.size}`,
          "Accept-Ranges": "bytes",
        });
        res.end();
        return;
      }

      res.writeHead(206, {
        "Content-Type": contentType,
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stat.size,
      "Accept-Ranges": "bytes",
    });
    fs.createReadStream(filePath).pipe(res);
    return;
    });
  };
}

module.exports = { ttsRoutes };
