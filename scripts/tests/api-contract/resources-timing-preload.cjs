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
//
// With USAP_TEST_GPU_PROBE_TIMING=1 as well (#181 GPU-probe measurement, opt-in, test-only) it also times, without
// changing them, the parts snapshot() reads and the process's synchronous child processes:
//   - the scheduler's inputs (budget.totalVramBytes, budget.freeRamBytes, cpu.physicalCores, engines.text, ...): each
//     is wrapped in a function that calls the original with the same arguments and returns its value or throws its
//     error; a /api/resources record then gains parts: [[name, ms], ...] (the slowest 8, >= 1 ms) and probe: the
//     GPU-memory calls (budget.totalVramBytes / freeVramBytes) with their entry and exit times;
//   - child_process.execSync / spawnSync / execFileSync (the GPU-information probes use them: system_profiler on macOS,
//     PowerShell and the engines' --list-devices on Windows): one { e: "sync-child", fn, cmd (program name only, no
//     path or arguments), startAt, endAt, ms, code, gpuInfo (called from the GPU-information code), inResources }
//     line per call (at most 200), and the record of a /api/resources request they ran inside lists them;
//   - one { e: "gpu-probe", fn, entryAt, exitAt, ms, inResources } line for the first call of each GPU-memory input
//     and for any call taking >= 5 ms (at most 50).
// No caching, no timeout, no retry, no change of order: the measured code runs exactly as without the variable.
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
  // A gap still open when the record is written (the request itself blocked the loop, and its socket closed before the
  // timer could run again) is included as it stands then.
  const loopOf = (from, to) => {
    const now = Date.now();
    const open = now - last >= 60 ? [[last, now - last]] : [];
    return {
      gaps: [...gaps, ...open].filter(([at, ms]) => at + ms >= from - 100 && at <= to + 100).slice(-10),
      delayP99Ms: Math.round(hist.percentile(99) / 1e6), delayMaxMs: Math.round(hist.max / 1e6),
    };
  };

  // snapshot() timing, attributed to the request whose handler called it (AsyncLocalStorage, entered in the
  // request listener below, which runs before the server's own handler).
  const als = new AsyncLocalStorage();

  // #181 GPU-probe measurement (opt-in, see the header).
  const probeOn = process.env.USAP_TEST_GPU_PROBE_TIMING === "1";
  const cleanCode = (c) => String(c ?? "?").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "?";
  const nameOf = (v) => (String(v || "").trim().match(/^"([^"]*)"|^'([^']*)'|^(\S+)/) || []).slice(1).find(Boolean)?.split(/[\\/]/).pop()
    .replace(/[^A-Za-z0-9._-]/g, "").slice(0, 32) || "?";
  const inResources = () => { const r = als.getStore(); return r && r.e === "resources" && r.endAt === null ? r : null; };
  let childLines = 0, probeLines = 0;
  if (probeOn) {
    const cp = require("node:child_process");
    for (const fn of ["execSync", "spawnSync", "execFileSync"]) {
      const orig = cp[fn];
      if (typeof orig !== "function") continue;
      cp[fn] = function (cmd, ...rest) {
        const startAt = Date.now();
        const gpuInfo = /getGpuInfo|detectLlama\w*Gpu|VramBytes/.test(String(new Error().stack || ""));
        let code = "?";
        try {
          const r = orig.call(this, cmd, ...rest);
          code = r && typeof r === "object" && !Buffer.isBuffer(r) && "status" in r ? (r.error ? r.error.code || "error" : r.status ?? r.signal ?? "?") : 0;
          return r;
        } catch (err) { code = (err && (err.code || err.status)) || "error"; throw err; } finally {
          const endAt = Date.now();
          const rec = inResources();
          const c = { e: "sync-child", fn, cmd: nameOf(cmd), startAt, endAt, ms: endAt - startAt, code: cleanCode(code), gpuInfo, inResources: Boolean(rec) };
          if (rec) { rec.children = rec.children || []; if (rec.children.length < 8) rec.children.push({ cmd: c.cmd, startAt, ms: c.ms, code: c.code, gpuInfo }); }
          if (childLines < 200) { childLines += 1; write(c); }
        }
      };
    }
  }
  const firstSeen = new Set();
  const timed = (name, f) => function (...b) {
    const rec = inResources();
    const entryAt = Date.now();
    try { return f.apply(this, b); } finally {
      const exitAt = Date.now(), ms = exitAt - entryAt;
      if (rec) { rec.parts = rec.parts || {}; rec.parts[name] = (rec.parts[name] || 0) + ms; }
      if (/VramBytes$/.test(name)) {
        if (rec) { rec.probe = rec.probe || []; if (rec.probe.length < 4) rec.probe.push({ fn: name, entryAt, exitAt }); }
        if ((!firstSeen.has(name) || ms >= 5) && probeLines < 50) { firstSeen.add(name); probeLines += 1; write({ e: "gpu-probe", fn: name, entryAt, exitAt, ms, inResources: Boolean(rec) }); }
      }
    }
  };
  const plain = (o) => o && typeof o === "object" && (Object.getPrototypeOf(o) === Object.prototype || Object.getPrototypeOf(o) === null);
  // Shallow copies: the server's own objects (hardware.budget is shared) are never changed.
  const wrapDeps = (d) => {
    if (!probeOn || !plain(d)) return d;
    const out = {};
    for (const [k, v] of Object.entries(d)) {
      if (typeof v === "function") out[k] = timed(k, v);
      else if (plain(v)) { const o = {}; for (const [k2, v2] of Object.entries(v)) o[k2] = typeof v2 === "function" ? timed(`${k}.${k2}`, v2) : v2; out[k] = o; }
      else out[k] = v;
    }
    return out;
  };
  // Compared by real path: Node resolves modules through symlinks (macOS temp folders are under /var -> /private/var)
  // while argv[1] keeps the path it was given.
  const real = (f) => { try { return fs.realpathSync(f); } catch (_) { return f; } };
  const schedulerFile = real(path.join(path.dirname(process.argv[1]), "services", "scheduler.cjs"));
  const load = Module._load;
  let patched = false;
  Module._load = function (request, parent, ...rest) {
    const exp = load.call(this, request, parent, ...rest);
    if (!patched && exp && typeof exp.createScheduler === "function") {
      let resolved = null;
      try { resolved = Module._resolveFilename(request, parent); } catch (_) { /* not a file */ }
      if (resolved && real(resolved) === schedulerFile) {
        patched = true;
        const create = exp.createScheduler;
        exp.createScheduler = function (...a) {
          const s = create.apply(this, a.length ? [wrapDeps(a[0]), ...a.slice(1)] : a);
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
        if (rec.parts) rec.parts = Object.entries(rec.parts).filter(([, ms]) => ms >= 1).sort((x, y) => y[1] - x[1]).slice(0, 8);
        write(rec);
      };
      if (!sock || sock.destroyed) flush(); else sock.once("close", flush);
    });
    return server;
  };
}
