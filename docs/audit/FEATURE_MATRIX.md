# Feature matrix & compatibility contract

Ev: R = verified by run · C = verified by code · U = unverified (needs hardware/models)

| Feature | UI (tab / component) | API surface | Linux | Windows | macOS | Ev |
|---|---|---|---|---|---|---|
| App shell, sidebar, top bar, 8 themes, font size | `App.jsx`, `Sidebar.jsx`, `TopStatusBar.jsx`, `Settings.jsx`, `themes.js` | static | boots | U | U | R (boot) / C |
| GGUF chat + streaming, reasoning blocks, KaTeX, PDF attach | `#/chat` `TextChat.jsx` | `/api/llm/{start,stop,chat,status,models,stats,model-settings}` (SSE) | U | U | U | C |
| Vision (mmproj) | `TextChat.jsx` | `/api/llm/start` with projector | U | U | U | C |
| Saved conversations | sidebar | `/api/llm/{conversations,save-conversation,delete-conversation}` | list R | U | U | R/C |
| Web search in chat | `TextChat.jsx` | `/api/web-search{,/config}` | U | U | U | C + unit test |
| Image generation (txt2img/img2img), history | `#/images` `Generator.jsx` | `/sdapi/v1/*`, `/api/{outputs,output-file,save-output,delete-outputs,generation-progress,restart-backend,stop-backend}` | U | U | U | C + unit test |
| OpenVINO / Core ML NPU image gen | `Generator.jsx` | `/api/openvino-{generate,models}`, `/api/download-openvino-model` | U | U | U | C |
| Whisper transcription | `#/transcribe` `SpeechTranscriber.jsx` | `/api/speech/*` | U | U | U | C |
| Kokoro TTS | `#/voice` `TextToSpeech.jsx` | `/api/tts/*`, `/tts-outputs/*` | U | U | U | C |
| Model manager: HF search, download, import, link, move, delete | `#/models` `ModelManager.jsx` | `/api/{models,download-model,import-model,link-model,move-model,delete-model,pick-model-file,download-progress,cancel-download}`, `/api/llm/*-model`, `/api/huggingface/models` | U | U | U | C |
| Diagnostics, hardware, telemetry, cleanup | `Settings.jsx` | `/api/{health,diagnostics,hardware-specs,backend-options,telemetry,cleanup,cleanup-candidates}` | health R | U | U | R/C |
| CPU/GPU backend selection | `Settings.jsx`, `Generator.jsx` | `/api/{backend-options,download-backend,llm/backends}` | U | U | U | C |

## Frozen compatibility contract (must not change without owner approval)
* **Ports & env:** see ARCHITECTURE.md. Default bind is `127.0.0.1:1420`.
* **Routes:** every path listed above, with the same methods (GET/POST) and JSON response shapes.
* **Hash routes:** `#/chat`, `#/chat/<id>`, `#/images`, `#/transcribe`, `#/voice`, `#/models`, `#/settings`.
* **localStorage keys:** `theme`, `textSettings`, `speechSettings`, `ttsSettings`, `sidebarVisible`, `fontSize`, `active-model`, `selectedLlmModel`, `imported-models`, `imagesHistoryOpen`, `chat_conversations` (legacy; migrated to server).
* **Themes:** `light`, `light-nord`, `light-sakura`, `dark`, `dark-dracula`, `dark-cyberpunk`, `dark-forest`, `dark-oled`.
* **On-disk layout:** the `app/*` directories in ARCHITECTURE.md; launcher entry points `linux.sh`, `mac.sh`, `windows.bat`.
