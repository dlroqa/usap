// #151 transport diagnostics (test-only): a Node client whose main thread is blocked (Atomics.wait) while the
// server's answer and then its reset arrive, as in the CI records. Args: port mode(fits|flood) block_ms.
// fits: request head + 32 KiB (all accepted by the kernel at once, no write left pending); flood: head + 16 MiB
// (writes still pending in Node when the reset arrives). After the block it records, in order, every event Node
// delivers: data (bytes, 413 status line), end, error (code), close, and a failed write callback. Prints one JSON object.
"use strict";
const net = require("node:net");
const [port, mode, blockMs] = [Number(process.argv[2]), process.argv[3], Number(process.argv[4])];
const ev = [], t0 = Date.now();
const add = (...e) => { if (ev.length < 400) ev.push([Date.now(), ...e]); }; // folded when printed
const s = net.connect(port, "127.0.0.1");
let blockedAt = null, unblockedAt = null, pendingAtBlock = null;
s.on("data", (d) => add("data", d.length, d.subarray(0, 12).toString("latin1") === "HTTP/1.1 413"));
s.on("end", () => add("end"));
s.on("error", (e) => add("error", e.code || "?"));
s.on("close", () => { add("close"); process.stdout.write(JSON.stringify({ t0, mode, blockedAt, unblockedAt, pendingAtBlock, ev })); });
s.on("connect", () => {
  s.write("POST /api/cleanup HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 104857600\r\n\r\n");
  const total = mode === "flood" ? 16 * 1024 * 1024 : 32768;
  const chunk = Buffer.alloc(65536, 0x61);
  for (let sent = 0; sent < total; sent += chunk.length) s.write(sent + chunk.length > total ? chunk.subarray(0, total - sent) : chunk, (err) => { if (err) add("write-callback-error", err.code || "?"); });
  pendingAtBlock = s.writableLength;
  blockedAt = Date.now();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, blockMs); // the main thread does not run
  unblockedAt = Date.now();
});
setTimeout(() => s.destroy(), blockMs + 5000).unref();
