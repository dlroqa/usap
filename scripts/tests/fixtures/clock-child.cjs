// Clock calibration child (#170, test-only). Every stamp carries three clocks: th = process.hrtime.bigint() in ms
// (machine-wide monotonic counter on Linux/macOS/Windows), tp = performance.timeOrigin + performance.now() (per-process
// anchor), t = Date.now(). Modes (argv[2]):
//   pingpong          for each line on stdin, reply at once with this process's stamps (NTP-style offset bounds)
//   hold <port> <n> <holdMs>  n cycles on <port>: listen -> 'listening' (bound) -> wait holdMs -> closeCall -> close
//                     (closed). The port is certainly held during [bound, closeCall] and at most during [start, closed].
//   try <port> <n>    n bind attempts on <port>; prints each [attempt, result time, result] (EADDRINUSE or ok)
// Output: one JSON line at the end (hold/try), or one line per ping (pingpong). Bounded; exits on its own.
"use strict";
const net = require("node:net");
const stamp = () => ({ th: Number(process.hrtime.bigint()) / 1e6, tp: performance.timeOrigin + performance.now(), t: Date.now() });
const [mode, a1, a2, a3] = process.argv.slice(2);
const holdMs = Number(a3 || 0);
if (mode === "pingpong") {
  let buf = "";
  process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { buf = buf.slice(i + 1); process.stdout.write(JSON.stringify(stamp()) + "\n"); } });
  process.stdin.on("end", () => process.exit(0));
  setTimeout(() => process.exit(2), 20000).unref();
} else if (mode === "hold" || mode === "try") {
  const port = Number(a1), n = Number(a2), out = [];
  const once = () => new Promise((resolve) => {
    const s = net.createServer(); const start = stamp();
    s.once("error", (e) => resolve({ start, res: stamp(), result: String(e.code || "error") }));
    s.once("listening", () => {
      const bound = stamp();
      if (mode === "try") { s.close(() => resolve({ start, res: bound, result: "ok" })); return; }
      const end = () => { const closeCall = stamp(); s.close(() => resolve({ start, bound, closeCall, closed: stamp(), result: "ok" })); };
      if (holdMs > 0) setTimeout(end, holdMs); else end();
    });
    s.listen(port, "127.0.0.1");
  });
  (async () => { for (let i = 0; i < n; i += 1) { out.push(await once()); if (mode === "try") await new Promise((r) => setImmediate(r)); } process.stdout.write(JSON.stringify(out) + "\n"); process.exit(0); })();
  setTimeout(() => process.exit(3), 20000).unref();
}
