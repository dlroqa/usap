// The calls covered by the API contract (hand-maintained). Responses are recorded into
// contract.json by record.cjs and compared by api-contract.test.cjs.
//   depth: how deep the response shape is pinned (1 = top-level keys only, for payloads whose
//          nested content depends on the OS/hardware).
// Excluded on purpose: routes that need the network (downloads, Hugging Face search), open native
// dialogs (pick-model-file), or need real engines/hardware (covered by native-runtime.yml).
"use strict";

const GET_ROUTES = [
  ["/api/health", { depth: 1 }],
  ["/api/backend-options", { depth: 1 }],
  ["/api/backend-status", {}],
  ["/api/diagnostics", { depth: 1 }],
  ["/api/hardware-specs", { depth: 1 }],
  ["/api/telemetry", { depth: 1 }],
  ["/api/models", {}],
  ["/api/outputs", {}],
  ["/api/llm/models", {}],
  ["/api/llm/status", { depth: 2 }],
  ["/api/llm/backends", { depth: 1 }],
  ["/api/llm/conversations", {}],
  ["/api/llm/stats", { depth: 2 }],
  ["/api/llm/model-settings", { depth: 1 }],
  ["/api/llm/recommend", { depth: 1 }],
  ["/api/speech/models", {}],
  ["/api/speech/status", { depth: 1 }],
  ["/api/speech/transcriptions", {}],
  ["/api/tts/models", {}],
  ["/api/tts/status", { depth: 1 }],
  ["/api/tts/outputs", {}],
  ["/api/web-search/config", { depth: 2 }],
  ["/api/download-progress", {}],
  ["/api/generation-progress", {}],
  ["/api/cleanup-candidates", {}],
  ["/api/openvino-models", { depth: 1 }],
].map(([path, o]) => ({ method: "GET", path, ...o }));

// Invalid input and "engine not installed" behaviour (no models, no engines in the temp root).
const ERROR_CALLS = [
  ["POST", "/api/llm/start", {}],
  ["POST", "/api/llm/chat", {}],
  ["POST", "/api/llm/delete-conversation", {}],
  ["POST", "/api/llm/delete-model", {}],
  ["POST", "/api/llm/download-model", {}],
  ["POST", "/api/llm/import-model", {}],
  ["POST", "/api/llm/benchmark", {}],
  ["POST", "/api/speech/start", {}],
  ["POST", "/api/speech/delete-model", {}],
  ["POST", "/api/speech/download-model", {}],
  ["POST", "/api/speech/delete-transcription", {}],
  ["POST", "/api/tts/start", {}],
  ["POST", "/api/tts/speak", {}],
  ["POST", "/api/tts/delete-model", {}],
  ["POST", "/api/tts/delete-output", {}],
  ["POST", "/api/delete-model", {}],
  ["POST", "/api/move-model", {}],
  ["POST", "/api/link-model", {}],
  ["POST", "/api/import-model", {}],
  ["POST", "/api/save-output", {}],
  ["POST", "/api/download-model", {}],
  ["POST", "/api/openvino-generate", {}],
  ["POST", "/sdapi/v1/txt2img", {}],
  ["GET", "/api/does-not-exist", undefined],
  ["POST", "/api/does-not-exist", {}],
  ["GET", "/api/llm/start", undefined],
  ["POST", "/api/llm/start", "{not json"],
  ["POST", "/api/llm/save-conversation", "{not json"],
].map(([method, path, body]) => ({ method, path, body, depth: 1 }));

// Successful operations that are safe in an empty temp root (stateful ones run last).
const OK_CALLS = [
  ["POST", "/api/llm/stop", {}],
  ["POST", "/api/speech/stop", {}],
  ["POST", "/api/tts/stop", {}],
  ["POST", "/api/stop-backend", {}],
  ["POST", "/api/cancel-download", {}],
  ["POST", "/api/delete-outputs", {}],
  ["POST", "/api/cleanup", {}],
].map(([method, path, body]) => ({ method, path, body }));

module.exports = { GET_ROUTES, ERROR_CALLS, OK_CALLS };
