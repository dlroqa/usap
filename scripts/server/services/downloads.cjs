// services/downloads.cjs — model and engine downloads (Step 9.8f).
//
// Moved unchanged from serve.cjs: the single download slot and its status (downloadState), verified
// model downloads (Step 9.4 downloader: allow-listed destinations, re-validated redirects, staged
// .part files, checksums), cancellation, OpenVINO model downloads, and the Windows image-engine
// download with its staged install. The code below is the original code; only its free variables now
// come from `deps`, and `cachedBackendOptions = null` became invalidateBackendOptions().
// getDownloadProgress() is the body of the old GET /api/download-progress handler. No HTTP here
// (see routes/models.cjs).
// Since the move, one change: downloaded archives are installed through archive-guard.cjs.
"use strict";

const archiveGuard = require("../archive-guard.cjs");

const REQUIRED = ["DOWNLOAD_POLICY","LLM_MODELS","MODELS","OPENVINO_MODELS","OPENVINO_NPU_MODELS","ROOT","SPEECH_MODELS","TOOLS","TTS_MODELS","downloadBlockReason","downloader","fs","getOpenVinoNpuInfo","getPathSize","integrity","osPlatform","path","spawn","spawnSync","invalidateBackendOptions"];

function createDownloadService(deps) {
  for (const name of REQUIRED) {
    if (deps[name] === undefined || deps[name] === null) throw new Error(`downloads: missing dependency ${name}`);
  }
  const { DOWNLOAD_POLICY, LLM_MODELS, MODELS, OPENVINO_MODELS, OPENVINO_NPU_MODELS, ROOT, SPEECH_MODELS, TOOLS, TTS_MODELS, downloadBlockReason, downloader, fs, getOpenVinoNpuInfo, getPathSize, integrity, osPlatform, path, spawn, spawnSync, invalidateBackendOptions } = deps;

  let downloadState = {
    active: false,
    filename: "",
    progress: 0,
    speed: "0 MB/s",
    eta: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    error: null
  };

  let activeDownload = null;

  function startOpenVinoModelDownload(modelId) {
    if (downloadState.active) return;
    const npuInfo = getOpenVinoNpuInfo();
    if (!npuInfo.supported) throw new Error(npuInfo.reason || "OpenVINO NPU runtime is not available.");
    const model = OPENVINO_NPU_MODELS.find((item) => item.id === modelId);
    if (!model) throw new Error("Unknown OpenVINO model.");

    const destDir = path.join(OPENVINO_MODELS, model.folder);
    fs.mkdirSync(destDir, { recursive: true });
    downloadState = {
      active: true,
      filename: model.name,
      progress: -1,
      speed: "Downloading snapshot",
      eta: 0,
      totalBytes: 0,
      downloadedBytes: 0,
      error: null,
    };

    const script = [
      "from huggingface_hub import snapshot_download",
      `snapshot_download(repo_id=${JSON.stringify(model.repo)}, local_dir=${JSON.stringify(destDir)}, ignore_patterns=['safety_checker/*','feature_extractor/*','*.safetensors'])`,
      "print('DONE')",
    ].join("\n");
    console.log(`  [openvino-download] Downloading ${model.repo} -> ${destDir}`);
    const proc = spawn(npuInfo.python, ["-c", script], { stdio: "pipe" });
    activeDownload = { process: proc, destPath: destDir, openvino: true };
    proc.stdout.on("data", (data) => process.stdout.write("  [openvino-download] " + data.toString()));
    proc.stderr.on("data", (data) => process.stderr.write("  [openvino-download] " + data.toString()));
    proc.on("exit", (code) => {
      activeDownload = null;
      if (String(downloadState.error || "").toLowerCase().includes("cancelled")) {
        return;
      }
      downloadState.active = false;
      if (code === 0) {
        downloadState.progress = 100;
        downloadState.downloadedBytes = getPathSize(destDir);
        downloadState.totalBytes = downloadState.downloadedBytes;
        downloadState.speed = "Complete";
        invalidateBackendOptions();
      } else {
        downloadState.error = `OpenVINO model download failed with code ${code}`;
      }
    });
  }

  const IMAGE_BACKEND_DOWNLOADS = {
    "cpu": {
      id: "cpu",
      label: "CPU",
      url: "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-782-b290693/sd-master-b290693-bin-win-cpu-x64.zip",
      destDir: path.join(ROOT, "app", "backend", "win", "cpu"),
      exeName: "sd-cpu.exe",
      requiredDll: "stable-diffusion.dll",
    },
    "vulkan": {
      id: "vulkan",
      label: "Vulkan GPU",
      url: "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-685-19bdfe2/sd-master-19bdfe2-bin-win-vulkan-x64.zip",
      destDir: path.join(ROOT, "app", "backend", "win", "vulkan"),
      exeName: "sd-vulkan.exe",
      requiredDll: "stable-diffusion.dll",
    },
    "cuda": {
      id: "cuda",
      label: "CUDA GPU",
      url: "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-782-b290693/sd-master-b290693-bin-win-cuda12-x64.zip",
      // The CUDA build does not bundle cudart64_12.dll / cublas; without it sd-cuda.exe fails to start.
      runtimeUrl: "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-782-b290693/cudart-sd-bin-win-cu12-x64.zip",
      destDir: path.join(ROOT, "app", "backend", "win", "cuda"),
      exeName: "sd-cuda.exe",
      requiredDll: "stable-diffusion.dll",
    },
  };

  function listFilesRecursive(dir) {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...listFilesRecursive(full));
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
    return out;
  }

  function installImageBackendArchive(zipPath, backend, runtimeOnly = false) {
    // Extract into a temporary folder, build the complete new engine folder next to the live one, check
    // that the executable is built for this CPU, then swap folders in one step. If anything fails, the
    // installed engine is left exactly as it was (Step 9.4).
    const stamp = Date.now();
    const tempDir = path.join(TOOLS, `image-backend-${backend.id}-extract-${stamp}`);
    const stagingDir = `${backend.destDir}.staging-${stamp}`;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.mkdirSync(tempDir, { recursive: true });
      fs.rmSync(stagingDir, { recursive: true, force: true });
      if (fs.existsSync(backend.destDir)) fs.cpSync(backend.destDir, stagingDir, { recursive: true });
      else fs.mkdirSync(stagingDir, { recursive: true });

      const tar = spawnSync("tar.exe", ["-xf", zipPath, "-C", tempDir], { encoding: "utf8" });
      if (tar.status !== 0) {
        throw new Error((tar.stderr || tar.stdout || "Could not extract backend archive.").trim());
      }

      const files = listFilesRecursive(tempDir);
      if (runtimeOnly) {
        const dlls = files.filter((file) => path.extname(file).toLowerCase() === ".dll");
        if (dlls.length === 0) throw new Error("CUDA runtime archive did not contain any DLL files.");
        for (const file of dlls) fs.copyFileSync(file, path.join(stagingDir, path.basename(file)));
      } else {
        const exeSource = files.find((file) => ["sd-server.exe", "sd.exe"].includes(path.basename(file).toLowerCase()));
        const dllSource = files.find((file) => path.basename(file).toLowerCase() === backend.requiredDll.toLowerCase());
        if (!exeSource || !dllSource) {
          throw new Error("Backend archive did not contain the expected stable-diffusion executable and DLL.");
        }

        fs.copyFileSync(exeSource, path.join(stagingDir, backend.exeName));
        fs.copyFileSync(dllSource, path.join(stagingDir, backend.requiredDll));
        for (const file of files) {
          const ext = path.extname(file).toLowerCase();
          if (ext !== ".dll" && ext !== ".exe") continue;
          if (file === exeSource) continue;
          fs.copyFileSync(file, path.join(stagingDir, path.basename(file)));
        }

        if (!fs.existsSync(path.join(stagingDir, backend.exeName)) || !fs.existsSync(path.join(stagingDir, backend.requiredDll))) {
          throw new Error(`Backend install did not create ${backend.exeName} and ${backend.requiredDll}.`);
        }
        // Windows on Arm runs these x64 builds through its built-in emulation; every other host must match.
        integrity.assertNativeBinary(path.join(stagingDir, backend.exeName), {
          accept: process.arch === "arm64" ? ["arm64", "x64"] : [process.arch],
        });
      }
      try {
        integrity.atomicReplaceDir(stagingDir, backend.destDir);
      } catch (err) {
        throw new Error(`${err.message} Stop image generation (the engine may be running) and try again.`);
      }
      invalidateBackendOptions();
    } finally {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // Bumped on every new download and on cancel, so a superseded transfer never overwrites the status.
  let downloadGeneration = 0;

  const DOWNLOAD_USER_AGENT = "Uncensored-AI-Studio/1.0 (+https://github.com/techjarves/Uncensored-AI-Studio)";

  function downloadProgressUpdater() {
    let lastTime = Date.now();
    let lastBytes = 0;
    return ({ bytes, totalBytes }) => {
      if (bytes < lastBytes) lastBytes = 0; // a retry restarted from byte zero
      downloadState.downloadedBytes = bytes;
      downloadState.totalBytes = totalBytes;
      const now = Date.now();
      const elapsed = (now - lastTime) / 1000;
      if (elapsed < 0.5) return;
      const speed = (bytes - lastBytes) / elapsed; // bytes/sec
      lastBytes = bytes;
      lastTime = now;
      downloadState.speed = `${(speed / (1024 * 1024)).toFixed(1)} MB/s`;
      if (totalBytes > 0) {
        downloadState.progress = Math.round((bytes / totalBytes) * 100);
        downloadState.eta = Math.round((totalBytes - bytes) / Math.max(1, speed));
      } else {
        downloadState.progress = -1; // Indeterminate
        downloadState.eta = -1;
      }
    };
  }

  function describeDownloadFailure(err, label) {
    if (!err) return `Download of ${label} failed.`;
    if (err.name === "BlockedRequestError" || err.name === "IntegrityError" || err.code === "USAP_HTTP") return err.message;
    if (err.code === "USAP_INTERRUPTED" || err.code === "USAP_STALLED" || downloader.TRANSIENT.has(err.code)) {
      return `Download interrupted before ${label} finished: ${err.message} Retry the download.`;
    }
    if (err.code === "USAP_WRITE") return `Could not write ${label}: ${err.message}`;
    return err.message || String(err);
  }

  // The redirect arguments are unused since Step 9.4 (the downloader follows redirects); the signature is kept.
  function startImageBackendDownload(backendId, _redirectCount = 0, _redirectUrl = "", stage = "main") {
    const isRuntimeStage = stage === "runtime";
    if (downloadState.active && !isRuntimeStage) {
      throw new Error("Another download is already active.");
    }
    if (osPlatform !== "win32") {
      throw new Error(osPlatform === "linux"
        ? "In-app backend downloads are only available on Windows. On Linux, run `bash scripts/setup/setup.sh` (it installs the Vulkan/CUDA/ROCm backends that match your GPU), or build them with scripts/build/build_from_source.sh if the prebuilt binaries do not run on your distribution."
        : "In-app backend downloads are only available on Windows. Run the platform setup script again to install or repair backends.");
    }
    const backend = IMAGE_BACKEND_DOWNLOADS[String(backendId || "").toLowerCase()];
    if (!backend) {
      throw new Error("This backend cannot be installed from the app yet. Use the platform setup script.");
    }

    fs.mkdirSync(TOOLS, { recursive: true });
    const url = isRuntimeStage ? backend.runtimeUrl : backend.url;
    const filename = isRuntimeStage ? `${backend.id}-runtime.zip` : `${backend.id}-backend.zip`;
    const destPath = path.join(TOOLS, filename);
    const label = `${backend.label} backend`;
    downloadState = {
      active: true,
      filename: isRuntimeStage ? `${backend.label} runtime` : backend.label,
      progress: 0,
      speed: "0 MB/s",
      eta: 0,
      totalBytes: 0,
      downloadedBytes: 0,
      error: null,
      kind: "backend",
      backendId: backend.id,
      integrity: null,
      sha256: null,
    };
    const generation = ++downloadGeneration;
    const failDownload = (message, err = null) => {
      if (generation !== downloadGeneration) return;
      downloadState.active = false;
      downloadState.error = message;
      if (err) console.error("  [backend-download]", message, err.code || "");
      else console.error("  [backend-download] Failed:", message);
      activeDownload = null;
    };

    const blockedReason = downloadBlockReason(url);
    if (blockedReason) return failDownload(blockedReason);
    console.log(`  [backend-download] Downloading ${backend.label} backend from ${url}`);
    const controller = new AbortController();
    const progress = downloadProgressUpdater();
    activeDownload = { abort: () => controller.abort(), destPath, tempPath: `${destPath}.part` };
    downloader.downloadVerified(url, destPath, {
      policy: DOWNLOAD_POLICY,
      signal: controller.signal,
      label,
      requirePinned: true, // engines are only installed when they match a reviewed digest
      headers: { "User-Agent": DOWNLOAD_USER_AGENT, "Accept": "application/zip, application/octet-stream, */*" },
      checkResponse: (res, current) => (res.statusCode === 200 ? null : describeDownloadHttpError(res.statusCode, current, res.headers)),
      onRedirect: () => { if (generation === downloadGeneration) downloadState.speed = "Following redirect"; },
      onProgress: (p) => { if (generation === downloadGeneration) progress(p); },
      onRetry: ({ attempt, error }) => {
        console.warn(`  [backend-download] ${label}: ${error.message} Retrying (attempt ${attempt + 1}).`);
        if (generation === downloadGeneration) downloadState.speed = "Retrying";
      },
    }).then((result) => {
      if (generation !== downloadGeneration) { try { fs.rmSync(destPath, { force: true }); } catch (_) {} return; }
      downloadState.speed = "Installing";
      downloadState.progress = 95;
      try {
        installImageBackendArchive(destPath, backend, isRuntimeStage);
      } catch (err) {
        return failDownload(`Could not install ${backend.label} backend: ${err.message}`, err);
      } finally {
        try { fs.unlinkSync(destPath); } catch (_) {}
      }
      console.log(`  [backend-download] ${filename}: ${result.status}, sha256 ${result.sha256}`);
      if (!isRuntimeStage && backend.runtimeUrl) {
        activeDownload = null;
        console.log(`  [backend-download] Installed ${backend.label} backend, fetching runtime libraries`);
        startImageBackendDownload(backend.id, 0, "", "runtime");
        return;
      }
      downloadState.active = false;
      downloadState.progress = 100;
      downloadState.downloadedBytes = result.bytes;
      downloadState.error = null;
      downloadState.speed = "Complete";
      downloadState.integrity = result.status;
      downloadState.sha256 = result.sha256;
      activeDownload = null;
      console.log(`  [backend-download] Installed ${backend.label} backend`);
    }, (err) => failDownload(describeDownloadFailure(err, label), err));
  }

  function describeDownloadHttpError(statusCode, url, headers = {}) {
    const host = (() => {
      try { return new URL(url).hostname; } catch (_) { return ""; }
    })();
    const isHuggingFace = host.includes("huggingface.co") || host.includes("hf.co");
    const hfErrorCode = headers["x-error-code"];
    const hfErrorMessage = headers["x-error-message"];

    if (isHuggingFace && hfErrorCode === "GatedRepo") {
      return `HTTP ${statusCode}: Hugging Face says this model is gated. Open the model page in your browser, accept access/login, then use a Hugging Face token or download the file manually.`;
    }
    if (isHuggingFace && hfErrorMessage) {
      return `HTTP ${statusCode}: Hugging Face rejected the download request: ${hfErrorMessage}`;
    }

    if (statusCode === 401 || statusCode === 403) {
      return isHuggingFace
        ? `HTTP ${statusCode}: Hugging Face rejected the download request. If this model is public, retry after restarting the app; otherwise open the model page in your browser and accept any license/login requirement.`
        : `HTTP ${statusCode}: This download URL requires authorization or permission. Use a public direct download URL.`;
    }
    if (statusCode === 404) {
      return `HTTP 404: Model file not found. Check that the URL points directly to a .safetensors, .gguf, or .ckpt file.`;
    }
    return `HTTP ${statusCode}`;
  }

  const MODEL_FILE_URL_HINT = "Use a direct link to a single model file ending in .safetensors, .gguf or .ckpt. On Hugging Face, open the repository's Files tab and copy the download link of one file.";

  // Rejects URLs that point at a web page instead of a downloadable file, e.g. a
  // Hugging Face repository page, which otherwise "downloads" as a small HTML file.
  function getModelDownloadUrlIssue(url) {
    let parsed;
    try {
      parsed = new URL(String(url || "").trim());
    } catch (_) {
      return "That is not a valid URL.";
    }
    if (!/^https?:$/.test(parsed.protocol)) return "Only http(s) download URLs are supported.";
    const blocked = downloadBlockReason(parsed.toString());
    if (blocked) return blocked;
    if (/(^|\.)huggingface\.co$/i.test(parsed.hostname)) {
      const parts = parsed.pathname.split("/").filter(Boolean);
      const isFileUrl = parts.includes("resolve") || parts.includes("blob");
      if (!isFileUrl) return `That URL is a Hugging Face repository page, not a model file. ${MODEL_FILE_URL_HINT}`;
    }
    if (!path.extname(path.basename(parsed.pathname))) {
      return `That URL does not point to a model file (no file extension). ${MODEL_FILE_URL_HINT}`;
    }
    return "";
  }

  function startModelDownload(url, overrideFilename = null, targetDir = MODELS, kind = "image") {
    if (downloadState.active && !overrideFilename) {
      console.log("  [download] Already downloading a model");
      return;
    }

    // Convert HuggingFace viewer URL (/blob/) to direct download URL (/resolve/)
    if (url.includes("huggingface.co") && url.includes("/blob/")) {
      url = url.replace("/blob/", "/resolve/");
    }

    let filename = overrideFilename;
    if (!filename) {
      filename = "model.gguf";
      try {
        const parsed = new URL(url);
        filename = path.basename(parsed.pathname);
      } catch (e) {
        console.error("Failed to parse URL filename:", e);
      }
    }

    const destPath = path.join(targetDir, filename);
    const tempPath = `${destPath}.part`;
    downloadState = {
      active: true,
      filename: filename,
      progress: 0,
      speed: "0 MB/s",
      eta: 0,
      totalBytes: 0,
      downloadedBytes: 0,
      error: null,
      kind,
      // Step 9.4 (additive): "verified" | "source-checksum" | "unverified" once finished.
      integrity: null,
      sha256: null,
    };
    const generation = ++downloadGeneration;

    const blockedReason = downloadBlockReason(url);
    if (blockedReason) {
      downloadState.active = false;
      downloadState.error = blockedReason;
      console.error("  [download] Refused:", blockedReason);
      return;
    }

    console.log(`  [download] Starting download of ${filename} from ${url}`);
    const controller = new AbortController();
    activeDownload = { abort: () => controller.abort(), destPath, tempPath };
    const progress = downloadProgressUpdater();
    downloader.downloadVerified(url, destPath, {
      tempPath,
      policy: DOWNLOAD_POLICY,
      signal: controller.signal,
      label: filename,
      headers: {
        "User-Agent": DOWNLOAD_USER_AGENT,
        "Accept": "application/octet-stream, application/x-safetensors, */*",
        "Referer": "https://huggingface.co/",
      },
      checkResponse: (res, current) => {
        if (res.statusCode !== 200) return describeDownloadHttpError(res.statusCode, current, res.headers);
        // Repository pages, login walls and error pages come back as 200 + text/html.
        if (String(res.headers["content-type"] || "").toLowerCase().includes("text/html")) {
          return `That URL returned a web page, not a model file. ${MODEL_FILE_URL_HINT}`;
        }
        return null;
      },
      // Handle redirects (HuggingFace resolve URLs redirect to Cloudfront/S3); each hop is re-validated.
      onRedirect: () => {
        console.log(`  [download] Following redirect for ${filename}`);
        if (generation === downloadGeneration) downloadState.speed = "Following redirect";
      },
      onProgress: (p) => { if (generation === downloadGeneration) progress(p); },
      onRetry: ({ attempt, error }) => {
        console.warn(`  [download] ${filename}: ${error.message} Retrying from the start (attempt ${attempt + 1}).`);
        if (generation === downloadGeneration) downloadState.speed = "Retrying";
      },
    }).then((result) => {
      console.log(`  [download] ${filename}: ${result.status} (${result.message}) sha256 ${result.sha256}`);
      if (generation !== downloadGeneration) return; // cancelled or superseded; status already set
      if (destPath.toLowerCase().endsWith(".zip")) {
        try {
          // Checked entry by entry, unpacked into a hidden staging folder, then moved into place.
          archiveGuard.extractZipSafely(destPath, path.dirname(destPath));
          fs.unlinkSync(destPath);
        } catch(err) {
          if (err.name === "ArchiveError") {
            // An unsafe archive is not kept; the models folder is unchanged.
            try { fs.unlinkSync(destPath); } catch (_) {}
            downloadState.active = false;
            downloadState.error = `${filename} can't be installed: ${err.message}`;
            activeDownload = null;
            console.error("  [download] Refused archive:", downloadState.error);
            return;
          }
          console.error("Failed to unzip", err);
        }
      }
      downloadState.active = false;
      downloadState.progress = 100;
      downloadState.downloadedBytes = result.bytes;
      downloadState.error = null;
      downloadState.integrity = result.status;
      downloadState.sha256 = result.sha256;
      activeDownload = null;
      console.log(`  [download] Completed download of ${filename}`);
    }, (err) => {
      if (generation !== downloadGeneration) return;
      downloadState.active = false;
      downloadState.error = describeDownloadFailure(err, filename);
      activeDownload = null;
      console.error("  [download] Failed:", downloadState.error);
    });
  }

  function cancelModelDownload() {
    if (!downloadState.active) {
      return false;
    }
    const filename = downloadState.filename;
    if (activeDownload) {
      if (activeDownload.process) {
        try { activeDownload.process.kill("SIGTERM"); } catch (_) {}
        setTimeout(() => { try { activeDownload?.process?.kill("SIGKILL"); } catch (_) {} }, 1000);
      } else if (activeDownload.abort) {
        downloadGeneration++; // the aborted transfer must not overwrite the "cancelled" status
        try { activeDownload.abort(); } catch (_) {} // the downloader removes its partial file
      }
    } else if (filename) {
      const targetDir = downloadState.kind === "text"
        ? LLM_MODELS
        : downloadState.kind === "speech"
          ? SPEECH_MODELS
          : downloadState.kind === "tts"
            ? TTS_MODELS
            : MODELS;
      try { fs.unlinkSync(`${path.join(targetDir, filename)}.part`); } catch (_) {}
    }
    activeDownload = null;
    downloadState = {
      active: false,
      filename,
      progress: 0,
      speed: "0 MB/s",
      eta: 0,
      totalBytes: 0,
      downloadedBytes: 0,
      error: "Download cancelled",
      kind: downloadState.kind || "image",
    };
    console.log(`  [download] Cancelled download of ${filename}`);
    return true;
  }

  function getDownloadProgress() {
    if (!downloadState.active && downloadState.kind === "backend" && downloadState.backendId) {
      const backend = IMAGE_BACKEND_DOWNLOADS[downloadState.backendId];
      const installed = backend &&
        fs.existsSync(path.join(backend.destDir, backend.exeName)) &&
        fs.existsSync(path.join(backend.destDir, backend.requiredDll));
      if (installed && !downloadState.error) {
        invalidateBackendOptions();
        downloadState = {
          active: false,
          filename: "",
          progress: 0,
          speed: "0 MB/s",
          eta: 0,
          totalBytes: 0,
          downloadedBytes: 0,
          error: null,
        };
      }
    }
    return downloadState;
  }

  return {
    getState: () => downloadState,
    getDownloadProgress,
    fns: { startOpenVinoModelDownload, IMAGE_BACKEND_DOWNLOADS, listFilesRecursive, installImageBackendArchive, DOWNLOAD_USER_AGENT, downloadProgressUpdater, describeDownloadFailure, startImageBackendDownload, describeDownloadHttpError, MODEL_FILE_URL_HINT, getModelDownloadUrlIssue, startModelDownload, cancelModelDownload },
  };
}

module.exports = { createDownloadService };
