// Test-only preload (#181 diagnostics, message only). Loaded with NODE_OPTIONS=--require into a studio server that a
// native validator starts with USAP_TEST_RESOURCES_TIMING=<file>. Without the variable, or in any other process
// (engines, guards, workers), it does nothing. It is never loaded by the product: only the validators add it.
// It records, from inside the server, the life of each GET /api/resources request, one JSON line per request when
// its socket closes:
//   { e: "resources", acceptAt (the server's 'connection' event for the socket: when this process handled it, not
//     when the kernel queued it), receivedAt (its 'request' event),
//     handlerAt / snapshotDoneAt (the route's scheduler.snapshot() call: the handler's first operation), endAt
//     (res.end called), finishAt (answer handed to the OS), closeAt (socket closed), status, bytesWritten,
//     loop: { gaps: [[atMs, gapMs], ...] (this process's 10 ms timer late by >= 50 ms within the request's window, at
//     most 10), delayP99Ms, delayMaxMs (perf_hooks event-loop delay since the preload started) } }
// a line { e: "conn", acceptAt, closeAt } for a connection that closed without any request reaching the server (at
// most 200 per process), and one { e: "loaded", at } line at start, so "not recorded" can be told from "not loaded".
// Times are wall-clock Date.now(). Nothing in the answer changes: listeners run first only to note times, res.end is
// wrapped only to note when it is called, and snapshot() is wrapped to note when it starts and returns, returning the
// same value or throwing the same error. One unref'd 10 ms timer and the built-in delay histogram.
"use strict";

const file = process.env.USAP_TEST_RESOURCES_TIMING;
if (file && /[\\/]serve\.cjs$/.test(process.argv[1] || "")) {
  const fs = require("node:fs");
  const path = require("node:path");
  const Module = require("node:module");
  const { AsyncLocalStorage } = require("node:async_hooks");
  const { monitorEventLoopDelay } = require("node:perf_hooks");
  const write = (o) => { try { fs.appendFileSync(file, JSON.stringify(o) + "\n"); } catch (_) { /* best effort */ } };
  write({ e: "loaded", at: Date.now() });

  const hist = monitorEventLoopDelay({ resolution: 10 }); hist.enable();
  const gaps = []; let last = Date.now();
  setInterval(() => { const now = Date.now(); if (now - last >= 60) { gaps.push([last, now - last]); if (gaps.length > 300) gaps.shift(); } last = now; }, 10).unref();
  const loopOf = (from, to) => ({
    gaps: gaps.filter(([at, ms]) => at + ms >= from - 100 && at <= to + 100).slice(-10),
    delayP99Ms: Math.round(hist.percentile(99) / 1e6), delayMaxMs: Math.round(hist.max / 1e6),
  });

  // snapshot() timing, attributed to the request whose handler called it (AsyncLocalStorage, entered in the
  // request listener below, which runs before the server's own handler).
  const als = new AsyncLocalStorage();
  const schedulerFile = path.join(path.dirname(process.argv[1]), "services", "scheduler.cjs");
  const load = Module._load;
  let patched = false;
  Module._load = function (request, parent, ...rest) {
    const exp = load.call(this, request, parent, ...rest);
    if (!patched && exp && typeof exp.createScheduler === "function") {
      let resolved = null;
      try { resolved = Module._resolveFilename(request, parent); } catch (_) { /* not a file */ }
      if (resolved === schedulerFile) {
        patched = true;
        const create = exp.createScheduler;
        exp.createScheduler = function (...a) {
          const s = create.apply(this, a);
          if (s && typeof s.snapshot === "function") {
            const snap = s.snapshot;
            s.snapshot = function (...b) {
              const rec = als.getStore();
              const mine = rec && rec.handlerAt === null && rec.endAt === null;
              if (mine) rec.handlerAt = Date.now();
              try { return snap.apply(this, b); } finally { if (mine) rec.snapshotDoneAt = Date.now(); }
            };
          }
          return s;
        };
      }
    }
    return exp;
  };

  const http = require("node:http");
  const create = http.createServer;
  let connLines = 0;
  http.createServer = function (...args) {
    const server = create.apply(this, args);
    server.prependListener("connection", (sock) => {
      const acceptAt = Date.now();
      sock.__usapTiming = { acceptAt, requests: 0 };
      sock.once("close", () => {
        if (sock.__usapTiming.requests === 0 && connLines < 200) { connLines += 1; write({ e: "conn", acceptAt, closeAt: Date.now() }); }
      });
    });
    server.prependListener("request", (req, res) => {
      const sock = req.socket;
      if (sock && sock.__usapTiming) sock.__usapTiming.requests += 1;
      if (req.method !== "GET" || !/^\/api\/resources(?:\?|$)/.test(String(req.url || ""))) return;
      const rec = { e: "resources", acceptAt: sock && sock.__usapTiming ? sock.__usapTiming.acceptAt : null, receivedAt: Date.now(),
        handlerAt: null, snapshotDoneAt: null, endAt: null, finishAt: null, closeAt: null, status: null, bytesWritten: null };
      als.enterWith(rec);
      const end = res.end;
      res.end = function (...a) { if (rec.endAt === null) rec.endAt = Date.now(); return end.apply(this, a); };
      res.once("finish", () => { rec.finishAt = Date.now(); rec.status = res.statusCode; });
      const flush = () => {
        rec.closeAt = Date.now();
        rec.bytesWritten = sock ? sock.bytesWritten : null;
        if (rec.status === null && res.headersSent) rec.status = res.statusCode;
        try { rec.loop = loopOf(rec.acceptAt ?? rec.receivedAt, rec.closeAt); } catch (_) { rec.loop = null; }
        write(rec);
      };
      if (!sock || sock.destroyed) flush(); else sock.once("close", flush);
    });
    return server;
  };
}
