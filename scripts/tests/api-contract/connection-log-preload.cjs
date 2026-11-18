// Test-only preload (issue #131). Loaded with NODE_OPTIONS=--require into a test server started with
// USAP_TEST_CONN_LOG=<file>. It records, from inside the server, what happened to each transcription request (or, with
// USAP_TEST_CONN_LOG_PREFIX=<path prefix>, to each request whose URL starts with that prefix), so tests
// judge admission and refusal from the server's own events rather than from client timing:
//   one JSON line per request to /api/speech/transcribe when its socket closes:
//   { url (first 200 characters), remotePort, arrivedAt, status, body (first 300 characters of the answer), finishAt (answer handed to the OS),
//     resCloseAt (the response closed: the gate's release point), sockCloseAt, bytesRead }
// Times are wall-clock Date.now(). Nothing is changed: the listener runs first only to wrap res.write/res.end so the
// answer's first bytes can be copied. Without the variable, or in any other process (engines, guards), it does nothing.
"use strict";

const file = process.env.USAP_TEST_CONN_LOG;
const prefix = process.env.USAP_TEST_CONN_LOG_PREFIX || "/api/speech/transcribe";
if (file && /[\\/]serve\.cjs$/.test(process.argv[1] || "")) {
  const fs = require("node:fs");
  const http = require("node:http");
  const create = http.createServer;
  http.createServer = function (...args) {
    const server = create.apply(this, args);
    server.prependListener("request", (req, res) => {
      if (!String(req.url || "").startsWith(prefix)) return;
      const rec = { url: String(req.url).slice(0, 200), remotePort: req.socket.remotePort, arrivedAt: Date.now(), status: null, body: "", finishAt: null, resCloseAt: null, sockCloseAt: null, bytesRead: null };
      const copy = (chunk) => { if (chunk && rec.body.length < 300 && typeof chunk !== "function") rec.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk); rec.body = rec.body.slice(0, 300); };
      const write = res.write, end = res.end;
      res.write = function (chunk, ...rest) { copy(chunk); return write.call(this, chunk, ...rest); };
      res.end = function (chunk, ...rest) { copy(chunk); return end.call(this, chunk, ...rest); };
      res.once("finish", () => { rec.status = res.statusCode; rec.finishAt = Date.now(); });
      res.once("close", () => { rec.resCloseAt = Date.now(); if (rec.status === null && res.headersSent) rec.status = res.statusCode; });
      const sock = req.socket;
      const flush = () => { rec.sockCloseAt = Date.now(); rec.bytesRead = sock.bytesRead; try { fs.appendFileSync(file, JSON.stringify(rec) + "\n"); } catch (_) { /* best effort */ } };
      if (sock.destroyed) flush(); else sock.once("close", flush);
    });
    return server;
  };
}
