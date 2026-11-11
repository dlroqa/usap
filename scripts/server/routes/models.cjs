// routes/models.cjs — model management and download HTTP routes (Step 9.8f). Moved unchanged from
// serve.cjs; files and downloads come from services/model-store.cjs and services/downloads.cjs.
// Reached only through the request pipeline (Host, Origin, sign-in, error boundary). Server state the
// routes read (loaded models, engine processes) comes through getters, and
// `cachedBackendOptions = null` became invalidateBackendOptions().
//
//   GET  /api/models, /api/llm/models, /api/openvino-models, /api/download-progress,
//        /api/huggingface/models (prefix)
//   POST /api/download-model, /api/llm/download-model, /api/download-openvino-model,
//        /api/download-backend, /api/cancel-download, /api/delete-model, /api/llm/delete-model,
//        /api/move-model, /api/link-model, /api/pick-model-file,
//        /api/import-model, /api/llm/import-model (prefix; streamed upload)
"use strict";

const REQUIRED = ["IMAGE_BACKEND_DOWNLOADS","LLM_MODELS","MODELS","OPENVINO_MODELS","SPEECH_MODELS","addHuggingFaceFileSize","cancelModelDownload","describeLinkedModel","detectModelKindCached","downloadBlockReason","errorBody","errorStatus","execFile","findOpenVinoModel","fs","getBackendProc","getCurrentSettings","getDownloadProgress","getDownloadState","getLlmModels","getLlmProc","getLlmSettings","getModelDownloadUrlIssue","getModelInfo","getOpenVinoModelInfo","getOpenVinoNpuInfo","invalidateBackendOptions","isModelFile","json","killLlm","modelFolderFor","os","path","pathInside","publicMessage","readJsonBody","readdirVisible","resolveHuggingFaceProjector","searchHuggingFaceModels","speech","startImageBackendDownload","startModelDownload","startOpenVinoModelDownload","streamModelUpload"];

function modelRoutes(deps) {
  for (const name of REQUIRED) {
    if (deps[name] === undefined || deps[name] === null) throw new Error(`routes/models: missing dependency ${name}`);
  }
  const { IMAGE_BACKEND_DOWNLOADS, LLM_MODELS, MODELS, OPENVINO_MODELS, SPEECH_MODELS, addHuggingFaceFileSize, cancelModelDownload, describeLinkedModel, detectModelKindCached, downloadBlockReason, errorBody, errorStatus, execFile, findOpenVinoModel, fs, getBackendProc, getCurrentSettings, getDownloadProgress, getDownloadState, getLlmModels, getLlmProc, getLlmSettings, getModelDownloadUrlIssue, getModelInfo, getOpenVinoModelInfo, getOpenVinoNpuInfo, invalidateBackendOptions, isModelFile, json, killLlm, modelFolderFor, os, path, pathInside, publicMessage, readJsonBody, readdirVisible, resolveHuggingFaceProjector, searchHuggingFaceModels, speech, startImageBackendDownload, startModelDownload, startOpenVinoModelDownload, streamModelUpload } = deps;
  return (r) => {
    r.get("/api/llm/models", async (req, res) => {
    return json(res, 200, { models: getLlmModels() });
    });

    r.getPrefix("/api/huggingface/models", async (req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const query = String(parsed.searchParams.get("query") || "").slice(0, 120);
    const filters = String(parsed.searchParams.get("filters") || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => ["vision", "uncensored"].includes(value));
    const page = Math.max(1, Math.min(20, Number(parsed.searchParams.get("page")) || 1));
    const pageSize = 9;
    try {
      const rankedModels = await searchHuggingFaceModels(query, [...new Set(filters)]);
      const start = (page - 1) * pageSize;
      const pageModels = rankedModels.slice(start, start + pageSize);
      const models = await Promise.all(pageModels.map(addHuggingFaceFileSize));
      return json(res, 200, {
        ok: true,
        source: "huggingface",
        models,
        page,
        hasMore: start + models.length < rankedModels.length,
      });
    } catch (err) {
      return json(res, 502, { ok: false, error: err.message || "Hugging Face search failed." });
    }
    });

  // GET /api/models — list available model files
    r.get("/api/models", async (req, res) => {
    try {
      let files = readdirVisible(MODELS).filter(isModelFile).map(getModelInfo);
      if (getDownloadState().active && getDownloadState().filename) {
        files = files.filter(model => model.filename !== getDownloadState().filename);
      }
      return json(res, 200, { models: files });
    } catch (_) { return json(res, 200, { models: [] }); }
    });

    r.get("/api/openvino-models", async (req, res) => {
    const npuInfo = getOpenVinoNpuInfo();
    return json(res, 200, {
      supported: npuInfo.supported,
      reason: npuInfo.reason || "",
      npu: npuInfo.npu || null,
      python: npuInfo.python || "",
      models: npuInfo.supported ? getOpenVinoModelInfo() : [],
    });
    });

  // POST /api/download-backend
    r.post("/api/download-backend", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    if (getDownloadState().active) return json(res, 409, { ok: false, error: "Another download is already active." });
    try {
      const backendId = String(body.backend_id || body.backendId || body.id || "");
      startImageBackendDownload(backendId);
      return json(res, 200, { ok: true, message: "Backend download started", backendId });
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message || String(err) });
    }
    });

  // POST /api/download-model
    r.post("/api/download-model", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const { url } = body;
    if (!url) return json(res, 400, { error: "URL is required" });
    // Catalog entries pass a filename for URLs that don't end in one (e.g. Civitai API links).
    const overrideFilename = body.filename ? path.basename(String(body.filename)) : null;
    if (overrideFilename && !/\.(safetensors|gguf|ckpt)$/i.test(overrideFilename)) {
      return json(res, 400, { ok: false, error: "Image model filename must end in .safetensors, .gguf or .ckpt." });
    }
    const urlIssue = overrideFilename
      ? (/^https?:\/\//i.test(String(url)) ? downloadBlockReason(url) : "Only http(s) download URLs are supported.")
      : getModelDownloadUrlIssue(url);
    if (urlIssue) return json(res, 400, { ok: false, error: urlIssue });
    // startModelDownload only guards against concurrent downloads when no filename is passed.
    if (overrideFilename && getDownloadState().active) return json(res, 409, { ok: false, error: "Another model download is already active." });

    startModelDownload(url, overrideFilename);
    return json(res, 200, { ok: true, message: "Download started" });
    });

    r.post("/api/llm/download-model", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const url = String(body.url || "");
    if (!url) return json(res, 400, { ok: false, error: "URL is required" });
    if (getDownloadState().active) return json(res, 409, { ok: false, error: "Another model download is already active." });
    try {
      const directUrl = url.includes("huggingface.co") ? url.replace("/blob/", "/resolve/") : url;
      const blocked = downloadBlockReason(directUrl);
      if (blocked) return json(res, 400, { ok: false, error: blocked });
      const overrideFilename = body.filename ? path.basename(String(body.filename)) : null;
      const filename = overrideFilename || path.basename(new URL(directUrl).pathname);
      if (!filename.toLowerCase().endsWith(".gguf")) {
        return json(res, 400, { ok: false, error: "Text model URL must point to a .gguf file." });
      }
      const projector = body.projectorUrl && body.projectorFilename
        ? { url: String(body.projectorUrl), filename: path.basename(String(body.projectorFilename)) }
        : await resolveHuggingFaceProjector(directUrl, filename);
      startModelDownload(directUrl, filename, LLM_MODELS, "text");
      return json(res, 200, {
        ok: true,
        message: "Text model download started",
        filename,
        projectorUrl: projector?.url || "",
        projectorFilename: projector?.filename || "",
      });
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message || String(err) });
    }
    });

    r.post("/api/download-openvino-model", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const modelId = String(body.model_id || body.modelId || "");
    if (!modelId) return json(res, 400, { ok: false, error: "model_id is required" });
    try {
      startOpenVinoModelDownload(modelId);
      return json(res, 200, { ok: true, message: "OpenVINO model download started" });
    } catch (err) {
      return json(res, errorStatus(err), errorBody(err));
    }
    });

  // GET /api/download-progress
    r.get("/api/download-progress", async (req, res) => {
    return json(res, 200, getDownloadProgress());
    });

  // POST /api/cancel-download
    r.post("/api/cancel-download", async (req, res) => {
    const cancelled = cancelModelDownload();
    return json(res, 200, { ok: true, cancelled });
    });

  // POST /api/import-model?filename=...
    r.postPrefix("/api/import-model", async (req, res) => {
    try {
      const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const result = await streamModelUpload(req, parsed.searchParams.get("filename"));
      return json(res, 200, { ok: true, message: `Imported ${result.filename}`, model: result, filename: result.filename });
    } catch (err) {
      console.error("  [api] Failed to import model:", err);
      return json(res, errorStatus(err), errorBody(err));
    }
    });

    r.postPrefix("/api/llm/import-model", async (req, res) => {
    try {
      const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const result = await streamModelUpload(req, parsed.searchParams.get("filename"), LLM_MODELS, "text");
      return json(res, 200, { ok: true, message: `Imported ${result.filename}`, model: result });
    } catch (err) {
      console.error("  [api] Failed to import text model:", err);
      return json(res, errorStatus(err), errorBody(err));
    }
    });

    r.post("/api/llm/delete-model", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const filename = path.basename(String(body.filename || ""));
    const modelPath = path.join(LLM_MODELS, filename);
    if (!filename || !pathInside(modelPath, LLM_MODELS)) {
      return json(res, 400, { ok: false, error: "Invalid filename" });
    }
    if (getLlmSettings().model === filename && getLlmProc()) await killLlm();
    try {
      fs.unlinkSync(modelPath);
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, err.code === "ENOENT" ? 404 : 500, {
        ok: false,
        error: err.code === "ENOENT" ? "Text model not found" : err.message,
      });
    }
    });

  // POST /api/move-model { filename, from, to }: refile a model under the right type (a text GGUF
  // sitting with the image models). Moving a linked model moves only the link.
    r.post("/api/move-model", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const filename = path.basename(String(body.filename || ""));
    const fromDir = modelFolderFor(String(body.from || ""));
    const toDir = modelFolderFor(String(body.to || ""));
    if (!filename || !fromDir || !toDir || fromDir === toDir) {
      return json(res, 400, { ok: false, error: "Choose a model and where to move it." });
    }
    const loaded = (body.from === "image" && getCurrentSettings().model === filename && getBackendProc())
      || (body.from === "text" && getLlmSettings().model === filename && getLlmProc())
      || (body.from === "speech" && speech.getSettings().model === filename && speech.isReady());
    if (loaded) return json(res, 409, { ok: false, error: "Unload the model before moving it." });
    const fromPath = path.join(fromDir, filename);
    const toPath = path.join(toDir, filename);
    if (!fs.existsSync(fromPath) && !describeLinkedModel(fromPath).linkedFrom) {
      return json(res, 404, { ok: false, error: "Model not found." });
    }
    if (fs.existsSync(toPath) || describeLinkedModel(toPath).linkedFrom) {
      return json(res, 409, { ok: false, error: `${filename} is already there.` });
    }
    try {
      fs.mkdirSync(toDir, { recursive: true });
      fs.renameSync(fromPath, toPath);
      invalidateBackendOptions();
      console.log(`  [api] Moved model ${filename} from ${body.from} to ${body.to}`);
      return json(res, 200, { ok: true, filename });
    } catch (err) {
      return json(res, errorStatus(err), errorBody(err, { error: `Couldn't move the model: ${publicMessage(err)}` }));
    }
    });

  // POST /api/pick-model-file { type }: open the system's own file dialog and return the chosen path.
  // The page can't learn a file's real location from a browser picker, but this server runs on the same machine.
    r.post("/api/pick-model-file", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const extensions = { image: ["safetensors", "ckpt", "gguf"], text: ["gguf"], speech: ["bin"] }[String(body.type || "image")];
    if (!extensions) return json(res, 400, { ok: false, error: "Browsing is available for image, text and speech models." });
    const prompt = "Choose a model file to use from where it is";
    let command;
    let args;
    if (process.platform === "darwin") {
      // "activate" brings the dialog in front of the browser
      command = "osascript";
      args = ["-e", "activate", "-e", `POSIX path of (choose file with prompt ${JSON.stringify(prompt)})`];
    } else if (process.platform === "win32") {
      const filter = `Model files (${extensions.map((ext) => `*.${ext}`).join(", ")})|${extensions.map((ext) => `*.${ext}`).join(";")}`;
      command = "powershell";
      args = ["-NoProfile", "-STA", "-Command", [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$d = New-Object System.Windows.Forms.OpenFileDialog",
        `$d.Title = '${prompt}'`,
        `$d.Filter = '${filter}'`,
        "$f = New-Object System.Windows.Forms.Form -Property @{TopMost = $true}",
        "if ($d.ShowDialog($f) -eq 'OK') { [Console]::Out.Write($d.FileName) }",
      ].join("; ")];
    } else {
      command = "zenity";
      args = ["--file-selection", `--title=${prompt}`, `--file-filter=Model files | ${extensions.map((ext) => `*.${ext}`).join(" ")}`];
    }
    execFile(command, args, { timeout: 10 * 60 * 1000, windowsHide: false }, (err, stdout) => {
      const picked = String(stdout || "").trim();
      if (picked) return json(res, 200, { ok: true, path: picked });
      // Closing the dialog is not an error; a missing helper (no zenity on Linux) is
      if (err && err.code === "ENOENT") {
        return json(res, 501, { ok: false, error: "This system has no file dialog helper. Paste the path instead." });
      }
      return json(res, 200, { ok: true, path: "", cancelled: true });
    });
    return;
    });

  // POST /api/link-model { path, type }: use a model file where it already is, without copying it
    r.post("/api/link-model", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const type = String(body.type || "image");
    const targets = {
      image: { dir: MODELS, valid: (name) => /\.(safetensors|ckpt|gguf)$/i.test(name), hint: ".safetensors, .ckpt or .gguf" },
      text: { dir: LLM_MODELS, valid: (name) => /\.gguf$/i.test(name), hint: ".gguf" },
      speech: { dir: SPEECH_MODELS, valid: (name) => /\.bin$/i.test(name), hint: ".bin" },
    };
    const target = targets[type];
    if (!target) return json(res, 400, { ok: false, error: "Linking is available for image, text and speech models." });

    // Accept what Finder (Option-Command-C) or Explorer ("Copy as path") puts on the clipboard
    let source = String(body.path || "").trim().replace(/^["']|["']$/g, "");
    if (source.startsWith("file://")) source = decodeURIComponent(new URL(source).pathname);
    if (source.startsWith("~")) source = path.join(os.homedir(), source.slice(1));
    if (!source || !path.isAbsolute(source)) {
      return json(res, 400, { ok: false, error: "Paste the full path to the file, starting from the drive or your home folder." });
    }
    let stats;
    try {
      stats = fs.statSync(source);
    } catch (_) {
      return json(res, 404, { ok: false, error: `Nothing was found at ${source}.` });
    }
    const filename = path.basename(source);
    // File it by what it actually is, not by the tab it was added from
    const detected = stats.isFile() ? detectModelKindCached(source) : { kind: "unknown" };
    const kind = targets[detected.kind] && targets[detected.kind].valid(filename) ? detected.kind : type;
    const chosen = targets[kind];
    if (!stats.isFile() || !chosen.valid(filename)) {
      return json(res, 400, { ok: false, error: `That isn't a ${type} model file. Choose a ${target.hint} file.` });
    }
    if (pathInside(source, chosen.dir)) {
      return json(res, 400, { ok: false, error: "That file is already in the app's models folder." });
    }
    const dest = path.join(chosen.dir, filename);
    if (fs.existsSync(dest) || describeLinkedModel(dest).linkedFrom) {
      return json(res, 409, { ok: false, error: `A model named ${filename} is already in the app.` });
    }
    try {
      fs.mkdirSync(chosen.dir, { recursive: true });
      try {
        fs.symlinkSync(source, dest, "file");
      } catch (err) {
        // Windows only allows symlinks in Developer Mode; a hard link also uses no extra space on the same drive
        if (err.code !== "EPERM" && err.code !== "EACCES") throw err;
        fs.linkSync(source, dest);
      }
      invalidateBackendOptions();
      console.log(`  [api] Linked ${kind} model in place: ${source}`);
      return json(res, 200, { ok: true, filename, linkedFrom: source, kind, detail: detected.detail || "" });
    } catch (err) {
      const crossDrive = err.code === "EXDEV";
      return json(res, errorStatus(err), errorBody(err, {
        error: crossDrive
          ? "This system can't link to a file on another drive. Use Import a copy instead."
          : `Couldn't link the file: ${publicMessage(err)}`,
      }));
    }
    });

  // POST /api/delete-model
    r.post("/api/delete-model", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const { filename } = body;
    if (!filename) return json(res, 400, { error: "Filename is required" });
    
    const openvinoModel = findOpenVinoModel(filename);
    const safeFilename = path.basename(filename);
    const modelPath = path.join(MODELS, safeFilename);
    
    try {
      if (openvinoModel?.installed && openvinoModel.path && pathInside(openvinoModel.path, OPENVINO_MODELS)) {
        fs.rmSync(openvinoModel.path, { recursive: true, force: true });
        invalidateBackendOptions();
        console.log(`  [api] Deleted OpenVINO model: ${openvinoModel.id}`);
        return json(res, 200, { ok: true, message: `Deleted ${openvinoModel.name}` });
      } else if (fs.existsSync(modelPath) || describeLinkedModel(modelPath).linkedFrom) {
        // For a linked model this removes only the link; the original file stays where it is
        fs.unlinkSync(modelPath);
        console.log(`  [api] Deleted model file: ${safeFilename}`);
        return json(res, 200, { ok: true, message: `Deleted ${safeFilename}` });
      } else {
        return json(res, 404, { error: "Model file not found" });
      }
    } catch (err) {
      console.error(`  [api] Failed to delete model ${safeFilename}:`, err);
      return json(res, errorStatus(err), errorBody(err));
    }
    });
  };
}

module.exports = { modelRoutes };
