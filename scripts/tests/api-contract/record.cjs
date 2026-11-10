#!/usr/bin/env node
// Re-record contract.json from the current server: node scripts/tests/api-contract/record.cjs
// Only for a deliberate, reviewed API change. Explain every changed entry in the PR, and never
// re-record to make a failing contract test pass without understanding why it failed.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { makeRoot, startServer, stopServer, request, shapeOf } = require("./harness.cjs");
const { GET_ROUTES, ERROR_CALLS, OK_CALLS } = require("./routes.cjs");

(async () => {
  const root = makeRoot();
  const srv = await startServer(root);
  const calls = [];
  try {
    for (const c of [...GET_ROUTES, ...ERROR_CALLS, ...OK_CALLS]) {
      const r = await request(srv.port, c.method, c.path, { body: c.body });
      if (r.json === undefined) throw new Error(`${c.method} ${c.path}: response is not JSON (${r.status} ${r.headers["content-type"]})`);
      calls.push({
        method: c.method, path: c.path, ...(c.body !== undefined ? { body: c.body } : {}),
        status: r.status,
        contentType: String(r.headers["content-type"] || "").split(";")[0],
        ...(c.depth ? { depth: c.depth } : {}),
        shape: shapeOf(r.json, c.depth || Infinity),
      });
    }
  } finally {
    stopServer(srv);
    fs.rmSync(root, { recursive: true, force: true });
  }
  const out = { recordedWith: `node ${process.version} on ${process.platform}-${process.arch}`, calls };
  fs.writeFileSync(path.join(__dirname, "contract.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`recorded ${calls.length} calls`);
})().catch((e) => { console.error(e); process.exit(1); });
