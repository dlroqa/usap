// services/model-store.cjs — the model folders on disk (Step 9.8f).
//
// Moved unchanged from serve.cjs: listing image, text and OpenVINO models, models linked in place
// (symlink or hard link; their target is reported as linkedFrom), filing a model under its detected
// type, model file names, and streamed imports (staged as .part, then replaced in one step). The code
// below is the original code; only its free variables now come from `deps`. No HTTP here (see
// routes/models.cjs).
"use strict";

const REQUIRED = ["LLM_MODELS","MODELS","OPENVINO_MODELS","OPENVINO_NPU_MODELS","SPEECH_MODELS","badRequest","describeStorageError","detectModelKindCached","ensureStorageCapacity","formatBytes","fs","getPathSize","path","replaceFileWithRetry","withFileRetrySync"];

function createModelStore(deps) {
  for (const name of REQUIRED) {
    if (deps[name] === undefined || deps[name] === null) throw new Error(`model-store: missing dependency ${name}`);
  }
  const { LLM_MODELS, MODELS, OPENVINO_MODELS, OPENVINO_NPU_MODELS, SPEECH_MODELS, badRequest, describeStorageError, detectModelKindCached, ensureStorageCapacity, formatBytes, fs, getPathSize, path, replaceFileWithRetry, withFileRetrySync } = deps;

  function getOpenVinoModelInfo() {
    return OPENVINO_NPU_MODELS.map((model) => {
      const modelPath = path.join(OPENVINO_MODELS, model.folder);
      const requiredFiles = [
        path.join(modelPath, "model_index.json"),
        path.join(modelPath, "text_encoder", "openvino_model.xml"),
        path.join(modelPath, "unet", "openvino_model.xml"),
        path.join(modelPath, "vae_decoder", "openvino_model.xml"),
      ];
      const installed = requiredFiles.every((file) => fs.existsSync(file));
      return {
        ...model,
        filename: model.id,
        path: modelPath,
        installed,
        sizeBytes: getPathSize(modelPath),
        size: formatBytes(getPathSize(modelPath)),
        format: "OpenVINO",
      };
    });
  }

  function findOpenVinoModel(modelId) {
    return getOpenVinoModelInfo().find((model) => model.id === modelId || model.folder === modelId || model.name === modelId);
  }

  // macOS writes "._name" AppleDouble files next to real files on exFAT and FAT drives.
  // They are never models or user data, so listings of the app's data folders skip them.
  function readdirVisible(dir) {
    return fs.readdirSync(dir).filter((name) => !name.startsWith("._"));
  }

  // Models can be linked in place from elsewhere on disk instead of copied in (POST /api/link-model).
  // A link reports where its file lives, and whether that file has since been moved or deleted.
  function describeLinkedModel(fullPath) {
    try {
      if (!fs.lstatSync(fullPath).isSymbolicLink()) return {};
      const target = path.resolve(path.dirname(fullPath), fs.readlinkSync(fullPath));
      return { linkedFrom: target, missing: !fs.existsSync(target) };
    } catch (_) {
      return {};
    }
  }

  // The app's folder for each model type, and which loaded model would block moving a file out of it
  function modelFolderFor(kind) {
    return { image: MODELS, text: LLM_MODELS, speech: SPEECH_MODELS }[kind] || null;
  }

  // "detectedKind" lets the UI spot a model filed under the wrong type (a text GGUF on the Image tab)
  function detectedKindFor(fullPath, link = {}) {
    return link.missing ? "unknown" : detectModelKindCached(fullPath).kind;
  }

  function getLlmModels() {
    try {
      return readdirVisible(LLM_MODELS)
        .filter((filename) => filename.toLowerCase().endsWith(".gguf"))
        .map((filename) => {
          const fullPath = path.join(LLM_MODELS, filename);
          const link = describeLinkedModel(fullPath);
          const sizeBytes = link.missing ? 0 : fs.statSync(fullPath).size;
          const lower = filename.toLowerCase();
          return {
            filename,
            name: filename,
            sizeBytes,
            size: link.missing ? "" : formatBytes(sizeBytes),
            format: "GGUF",
            isProjector: lower.includes("mmproj"),
            detectedKind: detectedKindFor(fullPath, link),
            ...link,
          };
        });
    } catch (_) {
      return [];
    }
  }

  function isModelFile(filename) {
    const lower = String(filename || "").toLowerCase();
    if (lower.endsWith(".safetensors") || lower.endsWith(".gguf") || lower.endsWith(".ckpt") || lower.endsWith(".coreml") || lower.endsWith(".coreml.zip")) {
      return true;
    }
    const fullPath = path.join(MODELS, filename);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        const files = fs.readdirSync(fullPath).map(f => f.toLowerCase());
        const hasTextEncoder = files.includes("text_encoder.mlpackage") || 
                               files.includes("text_encoder.mlmodelc") ||
                               files.includes("textencoder.mlpackage") || 
                               files.includes("textencoder.mlmodelc");
        
        const hasUnet = files.includes("unet.mlpackage") || 
                        files.includes("unet.mlmodelc");
                        
        if (hasTextEncoder && hasUnet) return true;
        
        const checkSubdirs = ["split_einsum/packages", "split_einsum/compiled", "original/packages", "original/compiled", "split_einsum", "original"];
        for (const subdir of checkSubdirs) {
          const subPath = path.join(fullPath, subdir);
          if (fs.existsSync(subPath)) {
            const subFiles = fs.readdirSync(subPath).map(f => f.toLowerCase());
            const subTextEncoder = subFiles.includes("text_encoder.mlpackage") || 
                                   subFiles.includes("text_encoder.mlmodelc") ||
                                   subFiles.includes("textencoder.mlpackage") || 
                                   subFiles.includes("textencoder.mlmodelc");
            const subUnet = subFiles.includes("unet.mlpackage") || 
                            subFiles.includes("unet.mlmodelc");
            if (subTextEncoder && subUnet) return true;
          }
        }
      }
    } catch (_) {}
    return false;
  }

  function getModelInfo(filename) {
    const safeFilename = path.basename(filename || "");
    const fullPath = path.join(MODELS, safeFilename);
    const link = describeLinkedModel(fullPath);
    if (link.missing) {
      return { filename: safeFilename, sizeBytes: 0, size: "", ...link };
    }
    const stats = fs.statSync(fullPath);
    
    if (stats.isDirectory()) {
      const dirSize = getPathSize(fullPath);
      return {
        filename: safeFilename,
        sizeBytes: dirSize,
        size: formatBytes(dirSize),
        format: "CoreML",
      };
    }

    return {
      filename: safeFilename,
      sizeBytes: stats.size,
      size: formatBytes(stats.size),
      detectedKind: detectedKindFor(fullPath, link),
      ...link,
    };
  }

  function streamModelUpload(req, filename, targetDir = MODELS, mode = "image") {
    return new Promise((resolve, reject) => {
      const safeFilename = path.basename(filename || "");
      const lowerName = safeFilename.toLowerCase();
      const valid = mode === "text"
        ? lowerName.endsWith(".gguf")
        : mode === "speech"
          ? lowerName.endsWith(".bin")
          : mode === "tts"
            ? lowerName.endsWith(".json")
          : isModelFile(lowerName);
      if (!safeFilename || !valid) {
        reject(badRequest("INVALID_FILENAME", mode === "text"
          ? "Filename must end with .gguf"
          : mode === "speech"
            ? "Filename must end with .bin"
            : mode === "tts"
              ? "Filename must end with .json"
              : "Filename must end with .gguf, .safetensors, or .ckpt"));
        return;
      }

      const destPath = path.join(targetDir, safeFilename);
      const tempPath = `${destPath}.part`;
      try {
        ensureStorageCapacity(targetDir, req.headers?.["content-length"]);
      } catch (err) {
        reject(new Error(describeStorageError(err, destPath)));
        return;
      }

      let fileDescriptor;
      try {
        fileDescriptor = withFileRetrySync(() => fs.openSync(tempPath, "w"));
      } catch (err) {
        reject(new Error(describeStorageError(err, tempPath)));
        return;
      }
      const out = fs.createWriteStream(tempPath, { fd: fileDescriptor, autoClose: true });
      let finished = false;

      const cleanupPartial = () => {
        if (finished) return;
        out.destroy();
        try { fs.unlinkSync(tempPath); } catch (_) {}
      };

      req.pipe(out);
      req.on("error", err => {
        cleanupPartial();
        reject(err);
      });
      req.on("aborted", () => {
        cleanupPartial();
        reject(new Error("Import cancelled by user"));
      });
      req.on("close", () => {
        if (!finished && req.aborted) {
          cleanupPartial();
        }
      });
      out.on("error", err => {
        cleanupPartial();
        reject(new Error(describeStorageError(err, tempPath)));
      });
      out.on("finish", () => {
        try {
          finished = true;
          replaceFileWithRetry(tempPath, destPath);
          console.log(`  [api] Imported model file: ${safeFilename}`);
          if (mode === "text" || mode === "speech") {
            const stats = fs.statSync(destPath);
            resolve({ filename: safeFilename, name: safeFilename, sizeBytes: stats.size, size: formatBytes(stats.size), format: mode === "speech" ? "Whisper GGML" : "GGUF" });
          } else {
            resolve(getModelInfo(safeFilename));
          }
        } catch (err) {
          try { fs.unlinkSync(tempPath); } catch (_) {}
          reject(new Error(describeStorageError(err, destPath)));
        }
      });
    });
  }

  return { fns: { getOpenVinoModelInfo, findOpenVinoModel, readdirVisible, describeLinkedModel, modelFolderFor, detectedKindFor, getLlmModels, isModelFile, getModelInfo, streamModelUpload } };
}

module.exports = { createModelStore };
