// #151 diagnostics (probe; reports, asserts nothing about the platform). When a client socket becomes readable (an
// answer arrived) and writable (its pending write can complete) during the same pause of its event loop, which does
// Node run first after the pause: the 'data' (read) or the 'drain' (write completion)?
//
// Why it matters: fixtures/refusal-judge.cjs treats a 'drain' inside a refusal's grace window as proof the client
// could also read its answer, on the premise that a socket's read is handled before its write in the same event-loop
// pass. libuv's epoll backend (Linux) passes both to one callback that reads first; its kqueue backend (macOS) passes
// them as separate entries in the kernel's order (libuv v1.49.1, as bundled with Node 22.12.0, src/unix/linux.c, kqueue.c, stream.c). This probe
// measures what the packaged Node actually does on each OS.
//
// Setup per trial: a server in a separate process takes a 4-byte delay, stops reading, and after the delay writes a
// short answer and reads everything. The client fills its send buffers until write() returns false, then blocks its
// own event loop across the server's answer, so both events are ready when it resumes. Only the events of the first
// I/O phase after the block are classified (a setImmediate marks its end).
"use strict";
const assert = require("node:assert/strict");
const net = require("node:net");
const { spawn } = require("node:child_process");
const test = require("node:test");

const SERVER = `const net = require("node:net");
const srv = net.createServer((s) => {
  s.on("error", () => {});
  let got = Buffer.alloc(0);
  const onData = (d) => {
    got = Buffer.concat([got, d]);
    if (got.length < 4) return;
    s.removeListener("data", onData); s.pause();
    setTimeout(() => { s.write("ANSWER"); s.on("data", () => {}); s.resume(); }, got.readUInt32BE(0));
  };
  s.on("data", onData);
});
srv.listen(0, "127.0.0.1", () => console.log(srv.address().port));`;

const TRIALS = 30;
const DELAY_MS = 150; // server answers and starts reading this long after the header
const BLOCK_FROM_MS = 90, BLOCK_UNTIL_MS = 320; // client event loop blocked across the answer

function trial(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    const events = []; let firstPhase = null; let t0 = 0;
    const finish = (why) => { clearTimeout(guard); s.destroy(); resolve({ firstPhase, events: events.slice(0, 6), why }); };
    const guard = setTimeout(() => finish("timeout"), 5000);
    s.on("error", () => {});
    s.on("data", () => { events.push("data"); if (events.includes("drain")) setImmediate(() => finish("both")); });
    s.on("drain", () => { events.push("drain"); if (events.includes("data")) setImmediate(() => finish("both")); });
    s.on("connect", () => {
      t0 = Date.now();
      const h = Buffer.alloc(4); h.writeUInt32BE(DELAY_MS); s.write(h);
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      for (let i = 0; i < 4096 && s.write(chunk); i += 1) { /* fill until backpressure */ }
      setTimeout(() => {
        const until = t0 + BLOCK_UNTIL_MS;
        while (Date.now() < until) { /* event loop blocked across the server's answer and resume */ }
        const mark = events.length;
        setImmediate(() => { firstPhase = events.slice(mark); });
      }, BLOCK_FROM_MS);
    });
  });
}

test("probe (#151): after a pause, does a socket's write completion ('drain') run before the read ('data') of an answer that arrived during the pause?", { timeout: 120000 }, async (t) => {
  const server = spawn(process.execPath, ["-e", SERVER], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const port = await new Promise((resolve, reject) => { server.stdout.once("data", (d) => resolve(Number(String(d).trim()))); server.once("exit", () => reject(new Error("probe server exited"))); });
    const counts = { dataFirst: 0, drainFirst: 0, onlyData: 0, onlyDrain: 0, neither: 0, timeout: 0 };
    for (let i = 0; i < TRIALS; i += 1) {
      const r = await trial(port);
      if (r.why === "timeout") counts.timeout += 1;
      const f = r.firstPhase || [];
      if (f[0] === "data" && f.includes("drain")) counts.dataFirst += 1;
      else if (f[0] === "drain" && f.includes("data")) counts.drainFirst += 1;
      else if (f.includes("data")) counts.onlyData += 1;
      else if (f.includes("drain")) counts.onlyDrain += 1;
      else counts.neither += 1;
    }
    t.diagnostic(`io-event-order ${process.platform}-${process.arch} node ${process.version} libuv ${process.versions.uv}: ${JSON.stringify(counts)} (first I/O phase after the pause; ${TRIALS} trials)`);
    assert.equal(Object.values(counts).reduce((a, b) => a + b, 0) - counts.timeout, TRIALS, "every trial classified");
  } finally { server.kill(); }
});
