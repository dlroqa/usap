# Architecture (as imported, a55c42c)

```
 Browser (React 19 SPA, hash routes #/chat #/images #/transcribe #/voice #/models #/settings)
   │  same-origin fetch / SSE (app/frontend/src/services/api.js, 1352 lines)
   ▼
 scripts/server/serve.cjs  (Node, CommonJS, 7733 lines, one http.createServer handler)
   ├─ static: app/dist/ (Vite build output) with SPA fallback to index.html
   ├─ /api/*  management + inference API (~80 routes, exact-match if-chain, lines 6141–7693)
   ├─ /v1/*, /sdapi/*  → proxy to the active image backend (stable-diffusion.cpp server)
   ├─ /tts-outputs/*  → saved audio (Range support)
   └─ child processes (spawn/execFile), one per engine, on loopback ports:
        llama-server  (LLM, :10086)      app/llm-backend/<os>/<accel>/
        sd-server     (image, :8080)     app/backend/<os>/<accel>/
        whisper.cpp   (speech, :10088)   app/speech-backend/
        Kokoro worker (TTS, :10089)      scripts/workers/tts-kokoro-worker.mjs (Node, onnx)
        OpenVINO NPU  (Python)           scripts/workers/openvino_npu_worker.py
        Core ML       (Python, macOS)    scripts/workers/coreml_server.py
 scripts/search/*  web search (DuckDuckGo HTML) + page fetch with SSRF guard
 scripts/server/model-kind.cjs  GGUF/safetensors model-type detection (unit tested)
```

## Responsibility map

| Concern | Location | Notes |
|---|---|---|
| Launch / first-run setup | `linux.sh`, `mac.sh`, `windows.bat` → `scripts/setup/setup.{sh,ps1}` | Downloads portable Node 22.12.0, runs `npm install` + `vite build`, then starts `serve.cjs`. Picks a free frontend port 1420–1499. |
| Runtime download | `scripts/setup/setup-{llama,whisper,tts,openvino-npu,coreml-npu}.*`, `scripts/config/llm-backends.json` | GitHub releases of ggml-org / leejet / leaxer-ai |
| Hardware detection & backend choice | `serve.cjs` top-level (runs `nvidia-smi` at import), ~L540–2100 | Runs at module load, so the server can't be imported side-effect-free. |
| Model storage | `app/models`, `app/llm-models`, `app/speech-models`, `app/tts-models`, `app/openvino-models` | Directories are created at module load. |
| Persistence | `app/chat-history/*.json`, `app/outputs/`, `app/transcriptions/`, `app/tts-outputs/`, `app/config/*.json`; browser `localStorage` (11 keys, see FEATURE_MATRIX) | |
| Request body | `readBody` (64 MB cap, JSON.parse regardless of Content-Type) | |
| Binding | `server.listen(PORT, UAIS_HOST \|\| "127.0.0.1")` | LAN is opt-in via `UAIS_HOST`; there is no auth |

## Environment variables (verified by code)
`PORT`/`FRONTEND_PORT` (1420), `BACKEND_PORT`/`SD_BACKEND_PORT` (8080), `LLM_PORT` (10086), `SPEECH_PORT` (10088), `TTS_PORT` (10089),
`UAIS_HOST`, `SD_VULKAN_DEVICE`/`UAIS_VULKAN_DEVICE`, `LOCALAI_LLM_SYSTEM_SERVER`/`LLAMA_SERVER_PATH`, `LOCALAI_LLM_ALLOW_FULL_SYCL`,
`LOCALAI_LLM_TRY_UNDETECTED_GPU`, `OPENVINO_PYTHON`, `COREML_PYTHON`, `TAURI_DEV_HOST` (vite dev only).

## Constraints for refactoring (P1)
* Import-time side effects (mkdir, `nvidia-smi`, backend probing) have to move behind a `start()` before the server can be unit-tested in-process. Until then, tests drive it as a subprocess on a random port.
* The route chain is ordered: `/v1/` and `/sdapi/` are proxied **before** `/api/*`, and the static fallback comes last. Extraction must keep that order.
