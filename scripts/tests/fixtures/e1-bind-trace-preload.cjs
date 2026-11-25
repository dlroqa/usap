// E1 (#170) test-only preload, loaded with NODE_OPTIONS=--require into ONE test studio (serve.cjs) started with
// USAP_TEST_E1_TRACE=<file>. Records, from inside the studio, every listen the studio itself makes on the image
// engine's port (SD_BACKEND_PORT): start, bound or error, and close, with the calling function names (no paths).
// Example: GET /api/diagnostics -> getHealth -> checkPort binds and closes that port. One JSON line per event.
// With USAP_TEST_E1_INJECT=<ms> (control only): when the studio spawns a process whose arguments contain
// "--listen-port <that port>" (every such spawn after the first), the preload itself binds the port at once and holds it for <ms>, like a diagnostics
// probe landing at the worst moment. It is recorded as kind "inject". Nothing else changes; in other processes, or
// without the variable, it does nothing.
"use strict";
const file = process.env.USAP_TEST_E1_TRACE;
const port = Number(process.env.SD_BACKEND_PORT || process.env.BACKEND_PORT || 0);
if (file && port && /[\\/]serve\.cjs$/.test(process.argv[1] || "")) {
  const fs = require("node:fs");
  const net = require("node:net");
  let n = 0, lines = 0;
  const log = (ev) => { if (lines >= 3000) return; lines += 1; try { fs.appendFileSync(file, JSON.stringify({ ...ev, t: Date.now() }) + "\n"); } catch (_) { /* diagnostics only */ } };
  const callers = () => String(new Error().stack || "").split("\n").slice(3, 10)
    .map((l) => (l.match(/^\s*at (?:async )?([\w$.<>]{1,60}) \(/) || [])[1]).filter((x) => x && !/^(Server|listen|net)/.test(x)).slice(0, 3);
  const portOf = (a) => (typeof a[0] === "number" ? a[0] : a[0] && typeof a[0] === "object" ? Number(a[0].port) : NaN);
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function tracedListen(...a) {
    if (portOf(a) === port && !this.__e1) {
      const id = (n += 1), kind = this.__e1kind || "studio";
      this.__e1 = id;
      log({ ev: "bind-start", id, kind, by: callers() });
      this.once("listening", () => log({ ev: "bound", id, kind }));
      this.once("error", (e) => log({ ev: "bind-error", id, kind, code: String((e && e.code) || "error").slice(0, 20) }));
      this.once("close", () => log({ ev: "closed", id, kind }));
    }
    return listen.apply(this, a);
  };
  const holdMs = Number(process.env.USAP_TEST_E1_INJECT || 0);
  let spawns = 0; // the first engine spawn (the initial load) is never injected: the control replaces a running engine
  const cp = require("node:child_process");
  const spawn = cp.spawn;
  cp.spawn = function tracedSpawn(cmd, args, ...rest) {
    const i = Array.isArray(args) ? args.indexOf("--listen-port") : -1;
    const target = i >= 0 && Number(args[i + 1]) === port;
    if (target) { spawns += 1; log({ ev: "engine-spawn", port, n: spawns }); }
    const child = spawn.call(this, cmd, args, ...rest);
    if (target && holdMs > 0 && spawns > 1) {
      const s = net.createServer(); s.__e1kind = "inject"; s.on("error", () => {});
      s.listen(port, "127.0.0.1", () => setTimeout(() => s.close(), holdMs));
    }
    return child;
  };
}
