// Raw HTTP clients for scripts/tests/refusal-close.test.cjs. Used in-process, and as a separate process for the
// concurrency test, so twenty clients writing as fast as they can never share an event loop with the server they
// measure (on a slow runner that load delayed the server's own answer).
//   node refusal-clients.cjs '{"port":1234,"n":20,"opts":{...}}'  → prints {"clients":[...],"ticks":[...]}
// `ticks` are the wall-clock times (Date.now()) at which this process's event loop ran a 10 ms interval timer. A gap in
// them is a time when the process did not run at all (seen for seconds under full-suite load on macOS Intel CI); the
// test uses it to tell a client that was not running from a server that misbehaved.
// With "cpuDiag": true in the argument (#151 diagnostics, message only, never judged), the output also has "proc":
// { samples: [[t, userMs, systemMs, voluntarySwitches, involuntarySwitches, [sentKiB per client]], ...] taken at
// each tick, watchdog: { samples, maxGapMs, gaps: [[at, ms]] } from a timer thread inside this process, or null }.
// Without it the output is exactly as before.
"use strict";
const net = require("node:net");
const MiB = 1024 * 1024;
const CHUNK = Buffer.alloc(64 * 1024, 0x61);

function dechunk(raw) { // decode a chunked body (complete chunks only)
  let out = "", i = 0;
  for (;;) {
    const j = raw.indexOf("\r\n", i); if (j < 0) break;
    const n = parseInt(raw.slice(i, j), 16); if (!Number.isFinite(n) || n === 0) break;
    out += raw.slice(j + 2, j + 2 + n); i = j + 2 + n + 2;
    if (i > raw.length) break;
  }
  return out;
}

// ── a raw HTTP client that keeps sending ─────────────────────────────────────────────────────────────────────────
// mode: "stream" (chunked, as fast as allowed), "silent" (headers only, large Content-Length), "drip" (1 KiB every
// 200 ms), "small" (complete 2 KiB body), "pipelined" (finished chunked body, then a second request).
// contentLength (mode "stream" only): declare this Content-Length and send the body unframed instead of chunked.
// pause (mode "stream" only): { atBytes, ms } stop sending for ms once atBytes have been sent, then go on (an upload
// that is slow for reasons on the client's side; #154).
function rawRequest(port, { method = "POST", url = "/api/echo", headers = "", mode = "stream", capBytes = 32 * MiB, maxMs = 8000, contentType = "application/json", second = "", ignoreFin = false, contentLength = null, pause = null } = {}, live = null) {
  // live (#151 diagnostics): an array this request's state is added to, so a sampler can read `sent` while it runs
  return new Promise((resolve) => {
    // ignoreFin: keep the sending side open after the server's FIN and go on sending (a client that ignores the answer)
    const s = net.connect({ port, host: "127.0.0.1", allowHalfOpen: ignoreFin });
    const st = { status: null, head: "", body: "", sent: 0, closedAt: null, answeredAt: null, error: null, t0: Date.now(), connectionHeader: null, drainsAt: [],
      // io (#151 diagnostics): wall-clock times of this socket's read-side events, for judge failure messages
      io: { firstDataAt: null, dataEvents: 0, endAt: null, errorAt: null, closeAt: null,
        // #151 diagnostics (message only, never judged): for each recorded drain, when the check phase of the same
        // event-loop iteration ran (setImmediate scheduled in the drain handler). A value before the server's close
        // means the loop got past the I/O phase that handled the drain, where a ready read would also have run.
        drainChecksAt: [], firstDataCheckAt: null } };
    if (Array.isArray(live)) live.push(st);
    // #151 write accounting (diagnostics runs only; DD-201-PEND): `pendingAtError` (writableLength in 'error', below) is
    // known to read 0 once write callbacks have failed, because Node empties its queue and fails every callback before
    // it emits 'error'. Counted here from the write callbacks instead: bytes submitted to s.write, bytes whose callback
    // succeeded (libuv wrote them into the kernel's send buffer: accepted by the kernel, NOT acknowledged or received)
    // and bytes whose callback failed. Snapshots at the first failed callback and at 'error' (before any other listener).
    // Kernel send-buffer occupancy is not visible from Node. Backpressure is unchanged: s.write's own result is returned.
    if (Array.isArray(live)) {
      const W = st.io.writes = { subBytes: 0, subCalls: 0, okBytes: 0, okCalls: 0, failBytes: 0, failCalls: 0, failCodes: {}, atFirstFail: null, atError: null };
      let seq = 0;
      const snap = (e) => ({ seq: (seq += 1), t: Date.now(), code: (e && e.code) || null, syscall: (e && e.syscall) || null, queuedInNode: s.writableLength,
        notAcceptedBytes: W.subBytes - W.okBytes, callbackPendingBytes: W.subBytes - W.okBytes - W.failBytes, failCalls: W.failCalls });
      const write = s.write;
      s.write = function accountedWrite(chunk, enc, cb) {
        if (typeof enc === "function") { cb = enc; enc = undefined; }
        const n = typeof chunk === "string" ? Buffer.byteLength(chunk, enc) : chunk.length;
        W.subBytes += n; W.subCalls += 1;
        return write.call(this, chunk, enc, (e) => {
          if (e) { if (!W.atFirstFail) W.atFirstFail = snap(e); W.failBytes += n; W.failCalls += 1; const k = String(e.code || "error").slice(0, 20); W.failCodes[k] = (W.failCodes[k] || 0) + 1; }
          else { W.okBytes += n; W.okCalls += 1; }
          if (cb) cb(e);
        });
      };
      s.prependListener("error", (e) => { if (!W.atError) W.atError = snap(e); });
    }
    let buf = Buffer.alloc(0), stopped = false, timer = null;
    const parse = () => {
      const text = buf.toString("latin1"); const i = text.indexOf("\r\n\r\n");
      if (i < 0) return;
      st.head = text.slice(0, i); const m = st.head.match(/^HTTP\/1\.1 (\d{3})/); if (m && st.status === null) { st.status = Number(m[1]); st.answeredAt = Date.now() - st.t0; }
      const c = st.head.match(/\r\nconnection: ([^\r]+)/i); st.connectionHeader = c ? c[1].toLowerCase() : null;
      const raw = text.slice(i + 4);
      st.body = /\r\ntransfer-encoding: chunked/i.test(st.head) ? dechunk(raw) : raw;
    };
    s.on("data", (d) => {
      if (st.io.firstDataAt === null) { st.io.firstDataAt = Date.now(); setImmediate(() => { st.io.firstDataCheckAt = Date.now(); }); }
      st.io.dataEvents += 1; buf = Buffer.concat([buf, d]); parse();
    });
    s.on("end", () => { if (st.io.endAt === null) st.io.endAt = Date.now(); });
    s.on("error", (e) => {
      if (st.io.errorAt === null) st.io.errorAt = Date.now(); st.error = e.code || e.message;
      // #151 diagnostics (cpuDiag runs only): bytes this client had queued in Node but not yet written when the error came.
      // KNOWN INVALID (DD-201-PEND): reads 0 after failed write callbacks; kept unchanged for comparison with earlier
      // records. Use io.writes (above) instead.
      if (Array.isArray(live) && st.io.pendingAtError === undefined) st.io.pendingAtError = s.writableLength;
    });
    s.on("close", () => { st.io.closeAt = Date.now(); st.closedAt = Date.now() - st.t0; stopped = true; clearTimeout(timer); resolve(st); });
    const end = setTimeout(() => { stopped = true; st.clientGaveUp = true; s.destroy(); }, maxMs);
    s.on("close", () => clearTimeout(end));
    s.on("connect", () => {
      st.localPort = s.localPort; // matches the server's remotePort for this connection
      const host = /\bHost:/i.test(headers) ? "" : "Host: 127.0.0.1\r\n";
      if (mode === "small") {
        const body = Buffer.alloc(2048, 0x61);
        s.write(`${method} ${url} HTTP/1.1\r\n${host}${headers}Content-Type: ${contentType}\r\nContent-Length: ${body.length}\r\n\r\n`); s.write(body); st.sent = body.length;
        return;
      }
      if (mode === "small-stalled") { // declares a small body, sends only part of it, then nothing
        s.write(`${method} ${url} HTTP/1.1\r\n${host}${headers}Content-Type: ${contentType}\r\nContent-Length: 2048\r\n\r\n`); s.write(Buffer.alloc(100, 0x61)); st.sent = 100;
        return;
      }
      if (mode === "silent") { s.write(`${method} ${url} HTTP/1.1\r\n${host}${headers}Content-Type: ${contentType}\r\nContent-Length: ${10 * MiB}\r\n\r\n`); return; }
      const declared = mode === "stream" && contentLength !== null;
      s.write(`${method} ${url} HTTP/1.1\r\n${host}${headers}Content-Type: ${contentType}\r\n${declared ? `Content-Length: ${contentLength}` : "Transfer-Encoding: chunked"}\r\n\r\n`);
      const send = declared
        ? (b) => { st.sent += b.length; return s.write(b); }
        : (b) => { const ok = s.write(b.length.toString(16) + "\r\n"); s.write(b); s.write("\r\n"); st.sent += b.length; return ok; };
      if (mode === "pipelined") { send(Buffer.from("{}")); s.write("0\r\n\r\n"); s.write(second); return; }
      if (mode === "drip") { const tick = () => { if (stopped || s.destroyed) return; send(CHUNK.subarray(0, 1024)); timer = setTimeout(tick, 200); }; tick(); return; }
      // drainsAt: wall-clock times this socket's I/O was processed after backpressure (evidence the client was running
      // and handling this very connection; used by fixtures-based judges)
      let paused = false;
      const pump = () => { while (!stopped && !s.destroyed && st.sent < capBytes) {
        if (pause && !paused && st.sent >= pause.atBytes) { paused = true; st.pausedAt = Date.now() - st.t0; timer = setTimeout(pump, pause.ms); return; }
        if (!send(CHUNK)) { s.once("drain", () => {
          if (st.drainsAt.length < 500) {
            st.drainsAt.push(Date.now());
            const k = st.io.drainChecksAt.push(null) - 1; // same bound as drainsAt
            setImmediate(() => { st.io.drainChecksAt[k] = Date.now(); });
          }
          pump();
        }); return; } } };
      pump();
    });
  });
}

module.exports = { rawRequest, dechunk };

// #151 diagnostics: a timer thread inside this process. It keeps running while the main thread is busy or waiting,
// and stops only when the whole process does not run. Records its own gaps >= 50 ms (at most 50). Never throws:
// any problem gives null.
const WATCHDOG_SRC = `
const { parentPort } = require("node:worker_threads");
let last = Date.now(), samples = 0, maxGapMs = 0; const gaps = [];
const iv = setInterval(() => { const now = Date.now(), g = now - last; samples += 1; if (g > maxGapMs) maxGapMs = g;
  if (g >= 50 && gaps.length < 50) gaps.push([last, g]); last = now; if (samples === 1) parentPort.postMessage({ ready: true }); }, 10);
parentPort.on("message", () => { clearInterval(iv); parentPort.postMessage({ samples, maxGapMs, gaps }); parentPort.close(); });`;
// onReady (optional) runs once, when the watchdog thread's first timer tick has run: proof that it is measuring.
function startWatchdog(onReady) {
  let w = null;
  try { w = new (require("node:worker_threads").Worker)(WATCHDOG_SRC, { eval: true }); w.on("error", () => {}); w.unref(); }
  catch (_) { return { stop: async () => null }; }
  const onFirst = (m) => { if (m && m.ready) { w.off("message", onFirst); if (onReady) onReady(); } };
  w.on("message", onFirst);
  return {
    stop: () => new Promise((resolve) => {
      const t = setTimeout(() => { try { w.terminate(); } catch (_) {} resolve(null); }, 2000);
      const onResult = (m) => { if (m && m.ready) return; w.off("message", onResult); clearTimeout(t); resolve(m); };
      w.on("message", onResult);
      w.once("exit", () => { clearTimeout(t); resolve(null); });
      try { w.postMessage("stop"); } catch (_) { clearTimeout(t); resolve(null); }
    }),
  };
}
const MAX_PROC_SAMPLES = 6000;
// One sample of this process: wall time, CPU time (user, system; ms), context switches (voluntary, involuntary) and
// each client's bytes sent (KiB). Returns null if the platform does not provide it.
function procSample(live) {
  try {
    const r = process.resourceUsage();
    return [Date.now(), Math.round(r.userCPUTime / 1000), Math.round(r.systemCPUTime / 1000), r.voluntaryContextSwitches, r.involuntaryContextSwitches, live.map((st) => Math.round(st.sent / 1024))];
  } catch (_) { return null; }
}

module.exports.startWatchdog = startWatchdog;
module.exports.procSample = procSample;

if (require.main === module) {
  const { port, n, opts, cpuDiag, readySignal, stackSample } = JSON.parse(process.argv[2]);
  // stackSample (#151 diagnostics, opt-in, macOS): main-thread stack sampling of this process, started and confirmed
  // running BEFORE any request is sent (fixtures/stack-sampler.cjs); its summary goes into proc.stack. Absent: as before.
  const stack = stackSample && cpuDiag ? require("./stack-sampler.cjs").startStackSampler({ pid: process.pid, ...stackSample }) : null;
  const begin = () => {
  const live = cpuDiag ? [] : null;
  // #151 diagnostics (cpuDiag only): GC pauses of this process (>= 5 ms, at most 60) and the event loop's delay.
  const gcs = [], perf = cpuDiag ? require("node:perf_hooks") : null;
  let gcObs = null, eld = null;
  if (perf) {
    try { gcObs = new perf.PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.duration >= 5 && gcs.length < 60) gcs.push([Math.round(perf.performance.timeOrigin + e.startTime), Math.round(e.duration), (e.detail && e.detail.kind) || e.kind || 0]); }); gcObs.observe({ entryTypes: ["gc"] }); } catch (_) { gcObs = null; }
    try { eld = perf.monitorEventLoopDelay({ resolution: 10 }); eld.enable(); } catch (_) { eld = null; }
  }
  let proc = cpuDiag ? [] : null;
  // readySignal (test synchronization only): one line on stderr once the watchdog thread is running; stdout unchanged.
  const watchdog = cpuDiag ? startWatchdog(readySignal ? () => process.stderr.write("watchdog-ready\n") : null) : null;
  const sample = () => { if (!proc || proc.length >= MAX_PROC_SAMPLES) return; const p = procSample(live); if (p) proc.push(p); else proc = null; };
  const ticks = [Date.now()];
  sample();
  const tick = setInterval(() => { ticks.push(Date.now()); sample(); }, 10);
  Promise.all(Array.from({ length: n }, () => rawRequest(port, opts, live))).then(async (clients) => {
    clearInterval(tick); ticks.push(Date.now());
    if (!cpuDiag) { process.stdout.write(JSON.stringify({ clients, ticks })); return; }
    sample();
    const wd = await watchdog.stop();
    const st = stack ? await stack.finish().catch(() => "summary failed") : undefined;
    try { if (gcObs) gcObs.disconnect(); if (eld) eld.disable(); } catch (_) { /* diagnostics only */ }
    const loop = eld ? { maxMs: Math.round(eld.max / 1e6), p99Ms: Math.round(eld.percentile(99) / 1e6) } : null;
    process.stdout.write(JSON.stringify({ clients, ticks, proc: { samples: proc, watchdog: wd, gc: gcs, loop, ...(stack ? { stack: st } : {}) } }));
  });
  };
  if (stack) stack.ready.then(begin, begin); else begin();
}
