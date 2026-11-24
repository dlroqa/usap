// #170 diagnostics (test-only, messages only): loaded with `--require` through NODE_OPTIONS ONLY by the engine-slot
// tests R1b and R5 (fixtures/lifecycle-trace.cjs portTraceEnv). With USAP_TEST_PORT_TRACE set, every Node process of
// that test server (the studio, its engine guards and the stand-in engines) appends one JSON line per listen attempt
// on the preferred image port (SD_BACKEND_PORT) or the backup range 28088-28120, and when it listens, fails (error
// code) or closes. It never binds, connects or retries anything itself, and it adds no event listener: it wraps the
// server's emit(), so a server without an "error" listener still fails exactly as before. Without the variable it does
// nothing. At most 200 attempts per process.
"use strict";
const fs = require("node:fs");
const net = require("node:net");

const file = process.env.USAP_TEST_PORT_TRACE;
if (file) {
  const preferred = Number(process.env.SD_BACKEND_PORT || process.env.BACKEND_PORT);
  const FIRST = 28088, LAST = 28120;
  const label = (p) => (p === preferred ? "preferred" : p >= FIRST && p <= LAST ? `backup+${p - FIRST}` : null);
  const rec = (o) => { try { fs.appendFileSync(file, `${JSON.stringify({ t: Date.now(), pid: process.pid, ppid: process.ppid, ...o })}\n`); } catch (_) { /* best effort */ } };
  let n = 0;
  const original = net.Server.prototype.listen;
  net.Server.prototype.listen = function listen(...args) {
    try {
      const a = args[0];
      const port = typeof a === "number" ? a : typeof a === "string" && /^\d+$/.test(a) ? Number(a) : a && typeof a === "object" && a.port != null ? Number(a.port) : null;
      const which = port === null ? null : label(port);
      if (which && n < 200) {
        n += 1;
        const id = n;
        rec({ ev: "listen-attempt", id, port: which });
        const emit = this.emit;
        this.emit = function traced(ev, ...rest) {
          if (ev === "listening") rec({ ev: "listening", id, port: which });
          else if (ev === "error") rec({ ev: "listen-error", id, port: which, code: (rest[0] && rest[0].code) || "?" });
          else if (ev === "close") rec({ ev: "closed", id, port: which });
          return emit.call(this, ev, ...rest);
        };
      }
    } catch (_) { /* diagnostics must never change the listen */ }
    return original.apply(this, args);
  };

  // #170 R5 ordering (same variable, same file): which process this is, when it started and (if it exits normally)
  // when it exited; in the studio and the engine guards, every child process they spawn (with the child's pid); in
  // the studio, when it wrote the answer to POST /api/restart-backend. A process killed by the OS records no exit.
  const script = String(process.argv[1] || "").replace(/\\/g, "/");
  const kind = /\/serve\.cjs$/.test(script) ? "studio" : /\/engine-guard\.cjs$/.test(script) ? "guard" : /sd-cpu\.cjs$|fake-sd-server\.cjs$|\/sd-server-cpu$|\/sd$/.test(script) ? "stand-in" : "other";
  rec({ ev: "process-start", kind });
  process.on("exit", (code) => rec({ ev: "process-exit", kind, code }));
  if (kind === "studio" || kind === "guard") {
    const cp = require("node:child_process");
    const spawn = cp.spawn;
    cp.spawn = function tracedSpawn(...a) {
      const child = spawn.apply(this, a);
      try {
        const argv = [a[0], ...(Array.isArray(a[1]) ? a[1] : [])].map(String);
        const what = argv.some((x) => /engine-guard\.cjs$/.test(x)) ? "guard" : kind === "guard" ? "engine" : null;
        if (what && child && child.pid) rec({ ev: "spawned", what, child: child.pid });
      } catch (_) { /* messages only */ }
      return child;
    };
  }
  if (kind === "studio") {
    const http = require("node:http");
    const end = http.ServerResponse.prototype.end;
    http.ServerResponse.prototype.end = function tracedEnd(...a) {
      try { if (this.req && this.req.method === "POST" && this.req.url === "/api/restart-backend" && !this.__usapTraced) { this.__usapTraced = true; rec({ ev: "answer", route: "restart-backend", status: this.statusCode }); } } catch (_) { /* messages only */ }
      return end.apply(this, a);
    };
  }
}
