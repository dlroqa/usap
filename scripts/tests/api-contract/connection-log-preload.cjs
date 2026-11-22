// Test-only preload (issue #131). Loaded with NODE_OPTIONS=--require into a test server started with
// USAP_TEST_CONN_LOG=<file>. It records, from inside the server, what happened to each transcription request (or, with
// USAP_TEST_CONN_LOG_PREFIX=<path prefix>, to each request whose URL starts with that prefix), so tests
// judge admission and refusal from the server's own events rather than from client timing:
//   one JSON line per request to /api/speech/transcribe when its socket closes:
//   { url (first 200 characters), remotePort, arrivedAt, status, body (first 300 characters of the answer), finishAt (answer handed to the OS),
//     resCloseAt (the response closed: the gate's release point), sockCloseAt, bytesRead }
// Times are wall-clock Date.now(). Nothing is changed: the listener runs first only to wrap res.write/res.end so the
// answer's first bytes can be copied. Without the variable, or in any other process (engines, guards), it does nothing.
//
// With USAP_TEST_CONN_LOG_LIMIT=<bytes> (issue #154) each record also says when the server's request stream delivered
// the body byte that took it past that many bytes, so a body-size refusal is timed from the moment the server could
// know the limit was exceeded, not from when the client started sending:
//   limitAt (wall-clock ms, null if never passed), bytesReadAtLimit (the socket's bytesRead then),
//   bodyAtAnswer (body bytes delivered when the answer was written: res.end), bodyBytes (delivered in total).
// Counting wraps only this request's own emit() for 'data': it adds no listener and does not change flowing mode, so
// the route reads exactly as it would without the preload.
//
// With USAP_TEST_CONN_LOG_LOOP=1 (#151 diagnostics, message only) each record also gets
//   loop: { gaps: [[atMs, gapMs], ...] (the server's own 10 ms timer missing >= 50 ms around this connection, at most 10),
//           delayP99Ms, delayMaxMs (perf_hooks event-loop delay since the server started) }
// so a failure can show whether the server process was running when it should have closed the connection. One unref'd
// 10 ms timer and the built-in delay histogram; nothing else changes.
"use strict";

const file = process.env.USAP_TEST_CONN_LOG;
const prefix = process.env.USAP_TEST_CONN_LOG_PREFIX || "/api/speech/transcribe";
const limit = /^\d+$/.test(process.env.USAP_TEST_CONN_LOG_LIMIT || "") ? Number(process.env.USAP_TEST_CONN_LOG_LIMIT) : null;
const watchLoop = process.env.USAP_TEST_CONN_LOG_LOOP === "1";
if (file && /[\\/]serve\.cjs$/.test(process.argv[1] || "")) {
  const fs = require("node:fs");
  let loopOf = () => undefined;
  if (watchLoop) {
    const { monitorEventLoopDelay } = require("node:perf_hooks");
    const hist = monitorEventLoopDelay({ resolution: 10 }); hist.enable();
    const gaps = []; let last = Date.now();
    setInterval(() => { const now = Date.now(); if (now - last >= 50) { gaps.push([last, now - last]); if (gaps.length > 200) gaps.shift(); } last = now; }, 10).unref();
    loopOf = (from, to) => ({
      gaps: gaps.filter(([at, ms]) => at + ms >= from - 100 && at <= to + 100).slice(0, 10),
      delayP99Ms: Math.round(hist.percentile(99) / 1e6), delayMaxMs: Math.round(hist.max / 1e6),
    });
  }
  const http = require("node:http");
  const create = http.createServer;
  http.createServer = function (...args) {
    const server = create.apply(this, args);
    server.prependListener("request", (req, res) => {
      if (!String(req.url || "").startsWith(prefix)) return;
      const rec = { url: String(req.url).slice(0, 200), remotePort: req.socket.remotePort, arrivedAt: Date.now(), status: null, body: "", finishAt: null, resCloseAt: null, sockCloseAt: null, bytesRead: null };
      const copy = (chunk) => { if (chunk && rec.body.length < 300 && typeof chunk !== "function") rec.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk); rec.body = rec.body.slice(0, 300); };
      if (limit !== null) {
        Object.assign(rec, { limitAt: null, bytesReadAtLimit: null, bodyAtAnswer: null, bodyBytes: 0 });
        const emit = req.emit;
        req.emit = function (ev, chunk, ...rest) {
          if (ev === "data" && chunk && typeof chunk.length === "number") {
            rec.bodyBytes += chunk.length;
            if (rec.limitAt === null && rec.bodyBytes > limit) { rec.limitAt = Date.now(); rec.bytesReadAtLimit = req.socket ? req.socket.bytesRead : null; }
          }
          return emit.call(this, ev, chunk, ...rest);
        };
      }
      const write = res.write, end = res.end;
      res.write = function (chunk, ...rest) { copy(chunk); return write.call(this, chunk, ...rest); };
      res.end = function (chunk, ...rest) { copy(chunk); if (limit !== null && rec.bodyAtAnswer === null) rec.bodyAtAnswer = rec.bodyBytes; return end.call(this, chunk, ...rest); };
      res.once("finish", () => { rec.status = res.statusCode; rec.finishAt = Date.now(); });
      res.once("close", () => { rec.resCloseAt = Date.now(); if (rec.status === null && res.headersSent) rec.status = res.statusCode; });
      const sock = req.socket;
      const flush = () => { rec.sockCloseAt = Date.now(); rec.bytesRead = sock.bytesRead; if (watchLoop) { try { rec.loop = loopOf(rec.arrivedAt, rec.sockCloseAt); } catch (_) { rec.loop = null; } } try { fs.appendFileSync(file, JSON.stringify(rec) + "\n"); } catch (_) { /* best effort */ } };
      if (sock.destroyed) flush(); else sock.once("close", flush);
    });
    return server;
  };
}
