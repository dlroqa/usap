// GET endpoints the UI calls on load and navigation (observed from the original
// UI at a55c42c with a real server). Each one has a recorded fixture.
export const FIXTURE_ENDPOINTS = [
  "/api/backend-status", "/api/llm/status", "/api/speech/status", "/api/tts/status",
  "/api/llm/models", "/api/speech/models", "/api/tts/models", "/api/backend-options",
  "/api/llm/conversations", "/api/speech/transcriptions", "/api/tts/outputs",
  "/api/hardware-specs", "/api/health", "/api/outputs", "/api/telemetry",
  "/api/cleanup-candidates", "/api/llm/backends", "/api/llm/stats", "/api/download-progress",
  "/api/models", "/api/openvino-models", "/api/llm/model-settings", "/api/web-search/config",
  "/api/diagnostics",
];

export const fixtureFileFor = (endpoint) => endpoint.replace(/^\/api\//, "").replace(/\//g, "_") + ".json";
