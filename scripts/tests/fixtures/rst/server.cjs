// #151 transport diagnostics (test-only): a minimal server that never reads (pauseOnConnect), answers each connection
// with the studio's 413 shape after ANSWER_MS, then destroys it after GRACE_MS. Every byte the client sent is still
// unread, so the close is a reset (RST). Prints one JSON line when listening ({ port }) and one per connection
// ({ conn, acceptedAt, answerFlushedAt, destroyedAt, bytesRead }); times are Date.now() ms on this host.
"use strict";
const net = require("node:net");
const [ANSWER_MS, GRACE_MS] = process.argv.slice(2).map(Number);
const BODY = JSON.stringify({ ok: false, error: "Request body too large." });
let k = 0;
const server = net.createServer({ pauseOnConnect: true }, (c) => {
  const rec = { conn: (k += 1), acceptedAt: Date.now(), answerFlushedAt: null, destroyedAt: null, bytesRead: null };
  c.on("error", () => {});
  setTimeout(() => {
    c.write(`HTTP/1.1 413 Payload Too Large\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(BODY)}\r\nConnection: close\r\n\r\n${BODY}`, () => { rec.answerFlushedAt = Date.now(); });
    setTimeout(() => { rec.bytesRead = c.bytesRead; c.destroy(); rec.destroyedAt = Date.now(); process.stdout.write(`${JSON.stringify(rec)}\n`); }, GRACE_MS);
  }, ANSWER_MS);
});
server.listen(0, "127.0.0.1", () => process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`));
process.stdin.on("end", () => process.exit(0)); process.stdin.resume();
