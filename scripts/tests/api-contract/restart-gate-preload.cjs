// Test-only preload (issue #125). Loaded with NODE_OPTIONS=--require into a test server started with
// USAP_TEST_RESTART_GATE=<file>. It replaces the WAIT of the text engine's automatic restart with a file gate:
// the restart stays pending until <file> exists. Nothing else changes: the same decision, the same callback, the same
// cancellation (clearTimeout). No production file is edited; without the variable, or in any other process (engine
// guard, fake engines), this file does nothing.
//
// Why injection: the product waits a fixed 1 s (restart-policy.cjs) before restarting a crashed text engine. A test
// that must act "while the restart is pending" then has to win a 1 s window, which a slow runner loses (#125). The
// real 1 s wait stays covered by the tests that don't load this file.
"use strict";

const gate = process.env.USAP_TEST_RESTART_GATE;
if (gate && /[\\/]serve\.cjs$/.test(process.argv[1] || "")) {
  const fs = require("node:fs");
  const path = require("node:path");
  const policy = require(path.join(path.dirname(process.argv[1]), "restart-policy.cjs"));
  const SENTINEL = 2147480001; // a delay no product code uses; marks "the automatic restart's wait"
  const decide = policy.decideRestart;
  policy.decideRestart = (o) => { const d = decide(o); return d && d.restart ? { ...d, delayMs: SENTINEL } : d; };
  const realSet = global.setTimeout;
  const realClear = global.clearTimeout;
  global.setTimeout = function (fn, ms, ...rest) {
    if (ms !== SENTINEL) return realSet(fn, ms, ...rest);
    const handle = { usapRestartGate: true, poll: null };
    handle.poll = setInterval(() => {
      if (!fs.existsSync(gate)) return;
      clearInterval(handle.poll); handle.poll = null;
      fn(...rest);
    }, 25);
    return handle;
  };
  global.clearTimeout = function (handle) {
    if (handle && handle.usapRestartGate) { if (handle.poll) clearInterval(handle.poll); handle.poll = null; return; }
    return realClear(handle);
  };
}
