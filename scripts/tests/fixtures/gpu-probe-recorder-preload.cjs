// #197/#181 test-only preload: loaded with NODE_OPTIONS=--require into ONE test studio (argv[1] = serve.cjs) started
// with USAP_TEST_GPU_PROBE_LOG=<file>. Records every child process the studio starts whose command is
// system_profiler: which API started it (execSync / spawnSync / execFileSync / execFile / exec) and when. One JSON
// line per call; nothing else is changed (the original function runs unchanged). Inert without the variable.
"use strict";
const file = process.env.USAP_TEST_GPU_PROBE_LOG;
if (file && /[\\/]serve\.cjs$/.test(process.argv[1] || "")) {
  const fs = require("node:fs"), cp = require("node:child_process");
  for (const fn of ["execSync", "spawnSync", "execFileSync", "execFile", "exec"]) {
    const orig = cp[fn];
    cp[fn] = function recorded(cmd, ...rest) {
      if (/system_profiler/.test(String(cmd))) { try { fs.appendFileSync(file, JSON.stringify({ fn, at: Date.now() }) + "\n"); } catch (_) { /* diagnostics only */ } }
      return orig.call(this, cmd, ...rest);
    };
  }
}
