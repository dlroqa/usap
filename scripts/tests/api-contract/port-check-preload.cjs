// Test-only preload (#170). Loaded with NODE_OPTIONS=--require into a test server started with
// USAP_TEST_PORT_CHECK_LOG=<file>. It records every port check the studio server makes, i.e. every listen() of a plain
// net.Server (the product's checkPort() tester; the studio's own HTTP server is an http.Server and is not recorded), as
// one JSON line { port, result: "free" | <error code>, t } in <file>. Nothing is changed: the same listen() call, the
// same events; the recording listeners only append to the file. Without the variable, or in any other process (engine
// guard, fake engines), this file does nothing.
//
// Why: the #170 tests must act on, and measure from, the moment the product finds the old port busy, not from the
// request (a slow runner spends a varying time before that point, which made an elapsed-time bound fail).
"use strict";

const file = process.env.USAP_TEST_PORT_CHECK_LOG;
if (file && /[\\/]serve\.cjs$/.test(process.argv[1] || "")) {
  const fs = require("node:fs");
  const net = require("node:net");
  const http = require("node:http");
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    if (!(this instanceof http.Server)) {
      const port = typeof args[0] === "number" ? args[0] : (args[0] && typeof args[0] === "object" ? args[0].port : undefined);
      const rec = (result) => { try { fs.appendFileSync(file, JSON.stringify({ port, result, t: Date.now() }) + "\n"); } catch (_) { /* test aid only */ } };
      // Recorded before the product's own handlers run (prepended); they still run exactly as before.
      this.prependOnceListener("listening", () => rec("free"));
      this.prependOnceListener("error", (err) => rec((err && err.code) || "error"));
    }
    return listen.apply(this, args);
  };
}
