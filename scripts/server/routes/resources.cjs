// routes/resources.cjs — GET /api/resources (Step 9.9b, read-only). Reached only through the request
// pipeline (Host, Origin, sign-in, error boundary). Registered only when the scheduler isn't "off".
"use strict";

// ready (optional, #197/#181): resolves when the GPU info is cached, so the snapshot never probes synchronously.
function resourceRoutes({ scheduler, json, ready = null }) {
  if (!scheduler || !json) throw new Error("routes/resources: missing dependency");
  return (r) => {
    r.get("/api/resources", async (req, res) => { if (ready) await ready(); json(res, 200, scheduler.snapshot()); });
  };
}

module.exports = { resourceRoutes };
