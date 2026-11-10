// routes/system.cjs — read-only system routes (Step 9.8, first route module).
//
//   GET /api/health            overall status
//   GET /api/diagnostics       one snapshot for troubleshooting (no secrets)
//   GET /api/cleanup-candidates
//   GET /api/hardware-specs
//   GET /api/backend-options
//   GET /api/telemetry
//
// Moved unchanged from serve.cjs. Everything the routes read is passed in as functions, because the
// underlying server state is reassigned at runtime; the module holds no state of its own.
"use strict";

/**
 * @param {object} deps
 * @param {(res, status: number, body: object) => void} deps.json
 * @param {() => Promise<object>} deps.getHealth
 * @param {() => Promise<object>} deps.getDiagnostics
 * @param {() => object[]} deps.getCleanupCandidates
 * @param {() => object} deps.getHardwareSpecs
 * @param {() => object} deps.getBackendOptions
 * @param {() => object} deps.getTelemetry
 */
function systemRoutes(deps) {
  const required = ["json", "getHealth", "getDiagnostics", "getCleanupCandidates", "getHardwareSpecs", "getBackendOptions", "getTelemetry"];
  for (const name of required) {
    if (typeof deps[name] !== "function") throw new Error(`routes/system: missing dependency ${name}`);
  }
  const { json } = deps;
  return (r) => {
    r.get("/api/health", async (req, res) => json(res, 200, await deps.getHealth()));
    r.get("/api/diagnostics", async (req, res) => json(res, 200, await deps.getDiagnostics()));
    r.get("/api/cleanup-candidates", async (req, res) => json(res, 200, { candidates: deps.getCleanupCandidates() }));
    r.get("/api/hardware-specs", async (req, res) => json(res, 200, deps.getHardwareSpecs()));
    r.get("/api/backend-options", async (req, res) => json(res, 200, deps.getBackendOptions()));
    r.get("/api/telemetry", async (req, res) => json(res, 200, deps.getTelemetry()));
  };
}

module.exports = { systemRoutes };
