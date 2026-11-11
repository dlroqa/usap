// routes/search.cjs — web search HTTP routes (Step 9.8d). Moved unchanged from serve.cjs; the work is
// done by services/web-search.cjs. Reached only through the request pipeline.
//
//   GET  /api/web-search/config
//   POST /api/web-search        { query | q, timeFilter, resultLimit, fetchLimit }
//
// The response's `context` and `sources` contain UNTRUSTED text from the web (see
// docs/security/WEB_CONTENT_TRUST.md).
"use strict";

function searchRoutes(deps) {
  for (const name of ["webSearch", "json", "readJsonBody", "errorStatus", "errorBody"]) {
    if (!deps[name]) throw new Error(`routes/search: missing dependency ${name}`);
  }
  const { webSearch, json, readJsonBody, errorStatus, errorBody } = deps;
  return (r) => {
    r.get("/api/web-search/config", async (req, res) => json(res, 200, webSearch.config()));
    r.post("/api/web-search", async (req, res) => {
      const body = await readJsonBody(req, res);
      if (!body) return;
      try {
        const result = await webSearch.runSearch(body);
        return json(res, 200, { ok: true, ...result });
      } catch (err) {
        return json(res, errorStatus(err), errorBody(err));
      }
    });
  };
}

module.exports = { searchRoutes };
