// Bench-only: does a refused, still-sending client lose the answer when its event loop is blocked longer than the
// server's grace period? Server = the real pipeline-style refusal with closeAfterAnswer (403 to a foreign Origin).
// The client sends a large chunked body, and once it is writing, blocks its own event loop for BLOCK_MS (in a child
// process so the server keeps running). Prints one JSON line per trial.
"use strict";
const http = require("http"), path = require("path"), { execFile } = require("child_process");
const target = process.argv[2]; // path to the checked-out repo
if (process.argv[3] === "client") {
  const net = require("net"); const port = Number(process.argv[4]); const block = Number(process.argv[5]);
  const s = net.connect(port, "127.0.0.1"); const st = { status: null, error: null, errorFirst: null, sent: 0 };
  let buf = ""; const CH = Buffer.alloc(64 * 1024, 0x61);
  s.on("data", (d) => { buf += d.toString("latin1"); const m = buf.match(/^HTTP\/1\.1 (\d{3})/); if (m && st.status === null) { st.status = Number(m[1]); if (!st.errorFirst) st.errorFirst = "answer"; } });
  s.on("error", (e) => { st.error = e.code; if (!st.errorFirst) st.errorFirst = "error"; });
  s.on("close", () => { process.stdout.write(JSON.stringify(st)); });
  s.on("connect", () => {
    s.write("POST /x HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://evil.example\r\nTransfer-Encoding: chunked\r\n\r\n");
    let blocked = false;
    const pump = () => { while (st.sent < 64 * 1024 * 1024) { s.write(CH.length.toString(16) + "\r\n"); const ok = s.write(CH); s.write("\r\n"); st.sent += CH.length; if (!ok) { if (!blocked) { blocked = true; setTimeout(() => { const e = Date.now() + block; while (Date.now() < e) {} }, 50); } s.once("drain", pump); return; } } };
    pump();
  });
  setTimeout(() => s.destroy(), block + 15000).unref();
  return;
}
const { closeAfterAnswer } = require(path.join(target, "scripts/server/http/refusal-close.cjs"));
const server = http.createServer((req, res) => { closeAfterAnswer(req, res); res.writeHead(403, { "Content-Type": "application/json" }); res.end("{\"ok\":false}"); });
server.listen(0, "127.0.0.1", async () => {
  const port = server.address().port;
  for (const block of [0, 1000, 3000, 3000, 3000, 3000, 3000]) {
    const out = await new Promise((r) => execFile(process.execPath, [__filename, target, "client", String(port), String(block)], (e, so) => r(so)));
    console.log(JSON.stringify({ platform: process.platform, block, ...JSON.parse(out || "{}") }));
  }
  server.close(); process.exit(0);
});
